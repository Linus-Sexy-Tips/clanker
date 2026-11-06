// SPDX-License-Identifier: AGPL-3.0-or-later
// Talking to Claude: request parameters from the config, the SDK transport, error classification,
// and ClaudeRunner, which streams one answer (with pause_turn continuations) and reports progress.

import Anthropic, {
	AnthropicError,
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIUserAbortError,
	type ClientOptions,
} from "@anthropic-ai/sdk";
import type { Config, LoadedConfig, Tier } from "./config.js";
import {
	type ApiMessage,
	type ClaudeStream,
	type ClaudeTransport,
	type Clock,
	type ContentBlock,
	type Logger,
	type MessageCreateParams,
	type MessageParam,
	type StreamEvent,
	systemClock,
	type ToolStatus,
	type TurnProgress,
	type TurnResult,
	type TurnStop,
	type Usage,
} from "./types.js";

/** Fixed, so a stray ANTHROPIC_BASE_URL in the environment can't redirect requests. */
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** Part of the 400 message when a replayed thinking block doesn't match its prefix. */
const THINKING_MISMATCH_TEXT = "bound to a different conversation";
/**
 * Starts of 400 messages that mean the account can't be charged: an org or workspace spend limit set
 * in the Console (documented, api/rate-limits), and prepaid credit used up (not in the docs; the text
 * the API has long returned).
 */
const ACCOUNT_LIMIT_PREFIXES = ["You have reached your specified", "Your credit balance is too low"];
/** `error.details.error_code` of the 429 when the usage tier's monthly spend cap is reached. */
const TIER_CAP_CODE = "enforced_spend_limit_reached";
/** Message of the error for a response that stopped before the message was complete. */
const ENDED_EARLY = "the response stream ended before the message was complete";

const DEFAULT_MAX_CONTINUATIONS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** Floor of the per-call deadline. */
const MIN_DEADLINE_MS = 180_000;
/** Time to first token, prefill and API overhead per call. */
const DEADLINE_BASE_MS = 60_000;
/** 50 output tokens a second: slow enough for Sonnet and Opus at high effort (thinking counts toward max_tokens). */
const DEADLINE_PER_TOKEN_MS = 20;
/** Per allowed web search or fetch. */
const DEADLINE_PER_TOOL_USE_MS = 10_000;

/** Overall time limit of one API call, scaled to how long a full-length answer can take. */
export function callDeadlineMs(config: Config): number {
	const { web_search: search, web_fetch: fetch } = config.tools;
	const toolUses = (search.enabled ? search.max_uses : 0) + (fetch.enabled ? fetch.max_uses : 0);
	return Math.max(
		MIN_DEADLINE_MS,
		DEADLINE_BASE_MS + config.model.max_tokens * DEADLINE_PER_TOKEN_MS + toolUses * DEADLINE_PER_TOOL_USE_MS,
	);
}

// ---------------------------------------------------------------- errors

export type ClaudeErrorKind =
	| "invalid_request"
	| "thinking_mismatch"
	/**
	 * The account can't be charged: a Console spend limit, the tier's monthly cap, no credit left, or a
	 * billing problem. Fails until the owner acts or the period resets.
	 */
	| "spend_limit"
	| "auth"
	| "rate_limited"
	| "overloaded"
	| "server"
	| "network"
	| "timeout"
	| "other";

/** A failed call to Claude. `status` is the HTTP status, or null (stream errors, network, timeouts). */
export class ClaudeError extends Error {
	override name = "ClaudeError";
	/** Anthropic's request ID, for support requests and logs. */
	readonly requestId: string | null;

	constructor(
		message: string,
		readonly kind: ClaudeErrorKind,
		readonly status: number | null,
		opts: { cause?: unknown; requestId?: string | null } = {},
	) {
		super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
		this.requestId = opts.requestId ?? null;
	}
}

interface ErrorBody {
	type: string | null;
	message: string | null;
	/** `error.details.error_code`, when present. */
	code: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The `{ type: "error", error: { type, message, details? } }` body of an API error, as far as it's present. */
function errorBody(body: unknown): ErrorBody {
	const inner = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
	if (typeof inner !== "object" || inner === null) return { type: null, message: null, code: null };
	const { type, message, details } = inner as { type?: unknown; message?: unknown; details?: unknown };
	const code =
		typeof details === "object" && details !== null ? (details as { error_code?: unknown }).error_code : null;
	return { type: str(type), message: str(message), code: str(code) };
}

function apiErrorKind(
	status: number | null,
	type: string | null,
	message: string,
	code: string | null,
): ClaudeErrorKind {
	if (type === "overloaded_error" || status === 529) return "overloaded";
	if (type === "billing_error" || status === 402 || code === TIER_CAP_CODE) return "spend_limit";
	const invalid = status === 400 || (status === null && type === "invalid_request_error");
	if (invalid) {
		if (ACCOUNT_LIMIT_PREFIXES.some((prefix) => message.startsWith(prefix))) return "spend_limit";
		return message.includes(THINKING_MISMATCH_TEXT) ? "thinking_mismatch" : "invalid_request";
	}
	if (status === null) {
		// An error event in the middle of a stream: only the body type says what happened.
		if (type === "authentication_error" || type === "permission_error") return "auth";
		if (type === "rate_limit_error") return "rate_limited";
		return "server";
	}
	if (status === 401 || status === 403) return "auth";
	if (status === 429) return "rate_limited";
	if (status === 408) return "timeout";
	if (status >= 500) return "server";
	if (status === 404 || status === 413 || status === 422) return "invalid_request";
	return "other";
}

/** Maps anything thrown by the SDK (or a transport) to a ClaudeError. */
export function classifyError(err: unknown): ClaudeError {
	if (err instanceof ClaudeError) return err;
	// Order matters: the abort and connection errors are APIError subclasses without a status.
	if (err instanceof APIUserAbortError) {
		return new ClaudeError("the request was aborted", "other", null, { cause: err });
	}
	if (err instanceof APIConnectionTimeoutError) {
		return new ClaudeError("the API didn't respond in time", "timeout", null, { cause: err });
	}
	if (err instanceof APIConnectionError) {
		return new ClaudeError(`can't reach the API: ${err.message}`, "network", null, { cause: err });
	}
	if (err instanceof APIError) {
		const status = err.status ?? null;
		const body = errorBody(err.error);
		const message = body.message ?? err.message;
		const kind = apiErrorKind(status, err.type ?? body.type, message, body.code);
		return new ClaudeError(message, kind, status, { cause: err, requestId: err.requestID ?? null });
	}
	if (err instanceof AnthropicError) {
		// The SDK wraps errors from reading the response body (a dropped connection, an event that
		// isn't JSON) with a cause.
		if (err.cause instanceof SyntaxError) {
			// V8's JSON.parse messages quote the input, which can be answer text: keep it out of logs.
			return new ClaudeError("the API sent an event that isn't valid JSON", "network", null, { cause: err });
		}
		const kind = err.cause === undefined ? "other" : "network";
		return new ClaudeError(err.message, kind, null, { cause: err });
	}
	const message = err instanceof Error ? err.message : String(err);
	return new ClaudeError(message, "other", null, { cause: err });
}

/**
 * The SDK reports a body that ended early (before message_start or message_stop) as a bare
 * AnthropicError: not an APIError, and without a cause.
 */
function isBareSdkError(err: unknown): boolean {
	return err instanceof AnthropicError && !(err instanceof APIError) && err.cause === undefined;
}

/** Errors worth one more try: they happened mid-stream or on the wire, after the SDK's own retries. */
function isRetryable(err: ClaudeError): boolean {
	return err.status === null && (err.kind === "overloaded" || err.kind === "server" || err.kind === "network");
}

// ---------------------------------------------------------------- request parameters

type WebSearchTool = Anthropic.Messages.WebSearchTool20260318;
type WebFetchTool = Anthropic.Messages.WebFetchTool20260318;
type UserLocation = Anthropic.Messages.UserLocation;

/** Only the non-empty domain list (config validation rejects setting both). */
function domainFilter(t: { allowed_domains: string[]; blocked_domains: string[] }) {
	return {
		...(t.allowed_domains.length > 0 ? { allowed_domains: [...t.allowed_domains] } : {}),
		...(t.blocked_domains.length > 0 ? { blocked_domains: [...t.blocked_domains] } : {}),
	};
}

function userLocation(loc: Config["tools"]["web_search"]["user_location"]): UserLocation | null {
	if (!loc) return null;
	const fields = {
		...(loc.city ? { city: loc.city } : {}),
		...(loc.region ? { region: loc.region } : {}),
		...(loc.country ? { country: loc.country } : {}),
		...(loc.timezone ? { timezone: loc.timezone } : {}),
	};
	// The API wants at least one field.
	return Object.keys(fields).length > 0 ? { type: "approximate", ...fields } : null;
}

function webSearchTool(t: Config["tools"]["web_search"]): WebSearchTool {
	const location = userLocation(t.user_location);
	return {
		type: "web_search_20260318",
		name: "web_search",
		max_uses: t.max_uses,
		...domainFilter(t),
		...(location ? { user_location: location } : {}),
		// Direct calls only: no dynamic filtering through code execution, so no extra blocks or containers.
		allowed_callers: ["direct"],
	};
}

function webFetchTool(t: Config["tools"]["web_fetch"]): WebFetchTool {
	return {
		type: "web_fetch_20260318",
		name: "web_fetch",
		max_uses: t.max_uses,
		max_content_tokens: t.max_content_tokens,
		...domainFilter(t),
		...(t.citations ? { citations: { enabled: true } } : {}),
		allowed_callers: ["direct"],
	};
}

/**
 * The request body for one call. Built the same way every time (fixed key order) so the cached
 * prefix stays byte-identical across requests.
 */
export function buildParams(tier: Tier, messages: MessageParam[]): MessageCreateParams {
	const { config } = tier;
	const tools: Anthropic.Messages.ToolUnion[] = [];
	if (config.tools.web_search.enabled) tools.push(webSearchTool(config.tools.web_search));
	if (config.tools.web_fetch.enabled) tools.push(webFetchTool(config.tools.web_fetch));

	return {
		model: config.model.name,
		max_tokens: config.model.max_tokens,
		thinking: { type: "adaptive", display: "omitted" },
		output_config: { effort: config.model.effort },
		system: [
			{
				type: "text",
				text: tier.systemPrompt,
				cache_control: { type: "ephemeral", ttl: config.cache.system_ttl },
			},
		],
		...(tools.length > 0 ? { tools } : {}),
		// Automatic caching: a 5-minute breakpoint on the last cacheable block.
		cache_control: { type: "ephemeral" },
		messages,
		stream: true,
	};
}

// ---------------------------------------------------------------- transport

export interface TransportOptions {
	/** SDK retries before the response starts (408, 409, 429, 5xx, connection errors). Default 2. */
	maxRetries?: number;
	/** SDK timeout until response headers arrive, per attempt. Default 60 s. */
	timeoutMs?: number;
	/** Replaces the HTTP client (tests). */
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	/** Receives the SDK's own warnings and errors. Without it they go to the console (message only). */
	log?: Logger;
}

type SdkLogger = NonNullable<ClientOptions["logger"]>;
type SdkLogLevel = keyof SdkLogger;

/**
 * The SDK's own log lines. Their extra arguments can hold raw stream data (an unparsable event with
 * message text in it), so those are only kept when the log level is debug.
 */
function sdkLogger(log: Logger | undefined): SdkLogger {
	const forward =
		(level: SdkLogLevel) =>
		(message: string, ...rest: unknown[]): void => {
			const msg = `anthropic sdk: ${message}`;
			if (!log) console[level](msg);
			else if (log.level === "debug" && rest.length > 0) log[level](msg, { details: rest });
			else log[level](msg);
		};
	return { error: forward("error"), warn: forward("warn"), info: forward("info"), debug: forward("debug") };
}

/** The real transport: the SDK's streaming helper on the non-beta Messages API. */
export function createTransport(apiKey: string, opts: TransportOptions = {}): ClaudeTransport {
	// The SDK treats "" as a given key and would fail every request with a 401.
	if (!apiKey) throw new Error("createTransport: the Anthropic API key is empty");
	const client = new Anthropic({
		// Passed explicitly, so the SDK reads no other credential from the environment or disk.
		apiKey,
		baseURL: ANTHROPIC_BASE_URL,
		maxRetries: opts.maxRetries ?? 2,
		timeout: opts.timeoutMs ?? 60_000,
		// No tracing spans (they can carry message content) and no request logging from ANTHROPIC_LOG.
		openTelemetry: false,
		logLevel: "warn",
		logger: sdkLogger(opts.log),
		...(opts.fetch ? { fetch: opts.fetch } : {}),
	});
	return {
		stream(params: MessageCreateParams): ClaudeStream {
			const stream = client.messages.stream(params);
			// Errors reach the runner through iteration and finalMessage(). Without a listener the SDK
			// would also raise an unhandled rejection once nobody iterates any more (after a timeout).
			stream.on("error", () => {});
			stream.on("abort", () => {});
			return stream;
		},
	};
}

// ---------------------------------------------------------------- runner

export interface RunHooks {
	progress: TurnProgress;
	/** Exactly once per started API call, success or failure (null = no usage known). `model` answered the call. */
	onCallEnd(usage: Usage | null, model: string): void;
}

export interface RunnerOptions {
	loaded: LoadedConfig;
	transport: ClaudeTransport;
	log: Logger;
	/** pause_turn continuations per turn. Default 3. */
	maxContinuations?: number;
	/** Overall time limit of one API call, from request to final event. Default: callDeadlineMs(tier config). */
	deadlineMs?: number;
	/** Wait before retrying a call that failed mid-stream. Default 1 s. */
	retryDelayMs?: number;
	clock?: Clock;
}

type MessageDeltaUsage = Anthropic.Messages.MessageDeltaUsage;

/** message_delta counts are cumulative: overwrite what's present, never add (like the SDK's helper). */
function mergeUsage(usage: Usage, delta: MessageDeltaUsage): Usage {
	return {
		...usage,
		output_tokens: delta.output_tokens,
		...(delta.input_tokens != null ? { input_tokens: delta.input_tokens } : {}),
		...(delta.cache_creation_input_tokens != null
			? { cache_creation_input_tokens: delta.cache_creation_input_tokens }
			: {}),
		...(delta.cache_read_input_tokens != null ? { cache_read_input_tokens: delta.cache_read_input_tokens } : {}),
		...(delta.server_tool_use != null ? { server_tool_use: delta.server_tool_use } : {}),
		...(delta.output_tokens_details != null ? { output_tokens_details: delta.output_tokens_details } : {}),
	};
}

/** What one API call has shown so far, for the accounting of calls that fail. */
class CallState {
	usage: Usage | null = null;
	contentStarted = false;
	/** message_stop arrived: the stream delivered the whole message. */
	complete = false;

	constructor(public model: string) {}

	observe(event: StreamEvent): void {
		if (event.type === "message_start") {
			this.model = event.message.model;
			this.usage = { ...event.message.usage };
		} else if (event.type === "content_block_start") {
			this.contentStarted = true;
		} else if (event.type === "message_delta" && this.usage) {
			this.usage = mergeUsage(this.usage, event.usage);
		} else if (event.type === "message_stop") {
			this.complete = true;
		}
	}
}

interface PendingTool {
	id: string;
	name: "web_search" | "web_fetch";
	json: string;
	reported: boolean;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function toolStatus(name: PendingTool["name"], input: unknown): ToolStatus | null {
	if (typeof input !== "object" || input === null) return null;
	const { query, url } = input as { query?: unknown; url?: unknown };
	if (name === "web_search" && typeof query === "string" && query) return { tool: "web_search", query };
	if (name === "web_fetch" && typeof url === "string" && url) return { tool: "web_fetch", url };
	return null;
}

/** Turns stream events of a whole turn into progress callbacks: visible text and tool status. */
class ProgressTracker {
	/** Text of the earlier calls of this turn. */
	private earlier = "";
	private current = "";
	/** Web search/fetch blocks of the running call, by block index (indices restart every call). */
	private readonly tools = new Map<number, PendingTool>();
	/** The tool whose status is on screen; it can span a pause_turn continuation. */
	private shownToolId: string | null = null;
	/** A non-text block came after the last text, so the next text may need a paragraph break. */
	private separated = false;

	constructor(
		private readonly progress: TurnProgress,
		private readonly log: Logger,
	) {}

	startCall(): void {
		this.current = "";
		this.tools.clear();
	}

	endCall(): void {
		this.earlier += this.current;
		this.current = "";
		this.tools.clear();
	}

	/** Clears a status that's still shown when the turn ends (for example a tool cut off by max_tokens). */
	finish(): void {
		if (this.shownToolId === null) return;
		this.shownToolId = null;
		this.call(() => this.progress.onToolStatus(null));
	}

	observe(event: StreamEvent): void {
		switch (event.type) {
			case "content_block_start":
				this.blockStart(event.index, event.content_block);
				break;
			case "content_block_delta":
				if (event.delta.type === "text_delta") this.addText(event.delta.text);
				else if (event.delta.type === "input_json_delta") this.toolInput(event.index, event.delta.partial_json);
				break;
			case "content_block_stop":
				this.blockStop(event.index);
				break;
		}
	}

	private blockStart(index: number, block: ContentBlock): void {
		if (block.type !== "text") this.separated = true;
		switch (block.type) {
			case "text":
				if (block.text) this.addText(block.text);
				break;
			case "server_tool_use":
				// Other server tools (code execution) don't get a status line.
				if (block.name === "web_search" || block.name === "web_fetch") {
					const pending: PendingTool = { id: block.id, name: block.name, json: "", reported: false };
					this.tools.set(index, pending);
					this.report(pending, block.input);
				}
				break;
			case "web_search_tool_result":
			case "web_fetch_tool_result":
				if (block.tool_use_id === this.shownToolId) {
					this.shownToolId = null;
					this.call(() => this.progress.onToolStatus(null));
				}
				break;
		}
	}

	private toolInput(index: number, partialJson: string): void {
		const pending = this.tools.get(index);
		if (!pending || pending.reported) return;
		pending.json += partialJson;
		this.report(pending, parseJson(pending.json));
	}

	private blockStop(index: number): void {
		const pending = this.tools.get(index);
		if (pending && !pending.reported) {
			this.report(pending, parseJson(pending.json));
			if (!pending.reported) this.log.debug("server tool input has no query or URL", { tool: pending.name });
		}
		this.tools.delete(index);
	}

	private report(pending: PendingTool, input: unknown): void {
		if (pending.reported) return;
		const status = toolStatus(pending.name, input);
		if (!status) return;
		pending.reported = true;
		this.shownToolId = pending.id;
		this.call(() => this.progress.onToolStatus(status));
	}

	private addText(text: string): void {
		if (text === "") return;
		if (this.separated) {
			// Same rule as render.formatAnswer, so the live view matches the final text.
			const before = this.earlier + this.current;
			if (before !== "" && !/\s$/.test(before) && !/^\s/.test(text)) this.current += "\n\n";
			this.separated = false;
		}
		this.current += text;
		const full = this.earlier + this.current;
		this.call(() => this.progress.onText(full));
	}

	/** Progress is cosmetic: a failing callback must not cost the answer. */
	private call(fn: () => void): void {
		try {
			fn();
		} catch (err) {
			this.log.warn("progress callback failed", { err });
		}
	}
}

type Attempt = { ok: true; message: ApiMessage; call: CallState } | { ok: false; error: ClaudeError; call: CallState };

function turnResult(stop: TurnStop, pieces: ContentBlock[][], lastUsage: Usage): TurnResult {
	return { stop, content: pieces.flat(), pieces, refusalCategory: null, lastUsage };
}

/** Streams one answer from Claude, continuing paused turns, and reports progress on the way. */
export class ClaudeRunner {
	private readonly loaded: LoadedConfig;
	private readonly transport: ClaudeTransport;
	private readonly log: Logger;
	private readonly clock: Clock;
	private readonly maxContinuations: number;
	/** Set in the options (tests); otherwise per tier. */
	private readonly fixedDeadlineMs: number | null;
	private readonly retryDelayMs: number;

	constructor(opts: RunnerOptions) {
		this.loaded = opts.loaded;
		this.transport = opts.transport;
		this.log = opts.log;
		this.clock = opts.clock ?? systemClock;
		this.maxContinuations = opts.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
		this.fixedDeadlineMs = opts.deadlineMs ?? null;
		this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	}

	/**
	 * Runs one turn with the tier's model and budgets (default: the standard tier). `messages` must
	 * end with the user turn; it isn't modified. Throws ClaudeError.
	 */
	async run(messages: MessageParam[], hooks: RunHooks, tier: Tier = this.loaded): Promise<TurnResult> {
		const progress = new ProgressTracker(hooks.progress, this.log);
		const pieces: ContentBlock[][] = [];
		let conversation = messages;
		let container: string | null = null;
		try {
			for (let continuation = 0; ; continuation++) {
				const message = await this.call(tier, conversation, container, progress, hooks);
				pieces.push(message.content);
				if (message.stop_reason !== "pause_turn") return this.result(message, pieces);

				if (continuation >= this.maxContinuations) return turnResult("pause_limit", pieces, message.usage);
				// The paused content goes back unchanged as the last message; the API picks up from there.
				conversation = [...conversation, { role: "assistant", content: message.content }];
				// So does the code-execution container, if the paused call had one (not expected with direct tool calls).
				container = message.container?.id ?? container;
			}
		} finally {
			progress.finish();
		}
	}

	private result(message: ApiMessage, pieces: ContentBlock[][]): TurnResult {
		switch (message.stop_reason) {
			case "end_turn":
				return turnResult("end_turn", pieces, message.usage);
			case "max_tokens":
				return turnResult("max_tokens", pieces, message.usage);
			case "refusal":
				// A refusal can arrive after partial output; that output must not be shown or kept.
				return {
					stop: "refusal",
					content: [],
					pieces: [],
					refusalCategory: message.stop_details?.category ?? null,
					lastUsage: message.usage,
				};
			default:
				// tool_use, stop_sequence, model_context_window_exceeded: not expected here; show what we have.
				this.log.warn("unexpected stop reason; treating the answer as cut off", { stopReason: message.stop_reason });
				return turnResult("max_tokens", pieces, message.usage);
		}
	}

	/** One API call, retried once if it failed mid-stream or on the wire before any content arrived. */
	private async call(
		tier: Tier,
		messages: MessageParam[],
		container: string | null,
		progress: ProgressTracker,
		hooks: RunHooks,
	): Promise<ApiMessage> {
		const base = buildParams(tier, messages);
		const deadlineMs = this.fixedDeadlineMs ?? callDeadlineMs(tier.config);
		const params: MessageCreateParams = container ? { ...base, container } : base;
		for (let attempt = 1; ; attempt++) {
			const started = this.clock.now();
			progress.startCall();
			const outcome = await this.attempt(params, progress, deadlineMs);
			const durationMs = this.clock.now() - started;
			const { call } = outcome;

			if (outcome.ok) {
				hooks.onCallEnd(outcome.message.usage, outcome.message.model);
				progress.endCall();
				this.logCall(outcome.message, durationMs);
				return outcome.message;
			}

			hooks.onCallEnd(call.usage, call.model);
			const { error } = outcome;
			const retry = attempt === 1 && !call.contentStarted && isRetryable(error);
			this.log.warn("claude call failed", {
				model: call.model,
				kind: error.kind,
				status: error.status,
				requestId: error.requestId,
				error: error.message,
				contentStarted: call.contentStarted,
				retry,
				durationMs,
			});
			if (!retry) throw error;
			await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
		}
	}

	/** Streams one request under the deadline. Never throws; the caller does the accounting. */
	private async attempt(params: MessageCreateParams, progress: ProgressTracker, deadlineMs: number): Promise<Attempt> {
		const call = new CallState(params.model);
		let stream: ClaudeStream | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		try {
			const s = this.transport.stream(params);
			stream = s;
			// Racing the deadline (not just aborting) also covers a stream that ignores abort().
			const deadline = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					timedOut = true;
					s.abort();
					reject(new ClaudeError(`no complete answer within ${deadlineMs / 1000} s`, "timeout", null));
				}, deadlineMs);
			});
			// Events that still arrive after the deadline are ignored.
			const consuming = this.consume(s, call, progress, () => timedOut);
			const message = await Promise.race([consuming, deadline]);
			return { ok: true, message, call };
		} catch (err) {
			stream?.abort();
			return { ok: false, error: classifyError(err), call };
		} finally {
			clearTimeout(timer);
		}
	}

	private async consume(
		stream: ClaudeStream,
		call: CallState,
		progress: ProgressTracker,
		stopped: () => boolean,
	): Promise<ApiMessage> {
		let message: ApiMessage;
		try {
			for await (const event of stream) {
				if (stopped()) break;
				call.observe(event);
				progress.observe(event);
			}
			// Rejects with the API error if the stream failed (the iterator doesn't always throw).
			message = await stream.finalMessage();
		} catch (err) {
			// A body that just stopped (a proxy or the server closing early) is a dropped connection.
			if (!call.complete && isBareSdkError(err)) throw new ClaudeError(ENDED_EARLY, "network", null, { cause: err });
			throw err;
		}
		// Not seen with the SDK (it only completes a message at message_stop); guards other transports.
		if (message.stop_reason === null) throw new ClaudeError(ENDED_EARLY, "network", null);
		return message;
	}

	private logCall(message: ApiMessage, durationMs: number): void {
		const u = message.usage;
		this.log.info("claude call", {
			model: message.model,
			messageId: message.id,
			stopReason: message.stop_reason,
			inputTokens: u.input_tokens,
			outputTokens: u.output_tokens,
			cacheReadTokens: u.cache_read_input_tokens ?? 0,
			cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
			webSearches: u.server_tool_use?.web_search_requests ?? 0,
			webFetches: u.server_tool_use?.web_fetch_requests ?? 0,
			...(message.stop_details ? { refusalCategory: message.stop_details.category } : {}),
			durationMs,
		});
	}
}
