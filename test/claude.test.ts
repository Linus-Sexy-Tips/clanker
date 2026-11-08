// SPDX-License-Identifier: AGPL-3.0-or-later
import type Anthropic from "@anthropic-ai/sdk";
import {
	AnthropicError,
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIUserAbortError,
} from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildParams,
	ClaudeError,
	ClaudeRunner,
	callDeadlineMs,
	classifyError,
	createTransport,
	type RunHooks,
	type RunnerOptions,
} from "../src/claude.js";
import { createLogger } from "../src/log.js";
import type {
	ApiMessage,
	ClaudeStream,
	ClaudeTransport,
	ContentBlock,
	MessageCreateParams,
	MessageParam,
	StreamEvent,
	ToolStatus,
	Usage,
} from "../src/types.js";
import { loadTestConfig, quietLog, testClock } from "./helpers.js";

// ---------------------------------------------------------------- builders

type StopReason = Anthropic.Messages.StopReason;
type Citation = Anthropic.Messages.TextCitation;
type RefusalCategory = Anthropic.Messages.RefusalStopDetails["category"];
type BlockDelta = Anthropic.Messages.RawContentBlockDelta;
type StartBlock = Anthropic.Messages.RawContentBlockStartEvent["content_block"];

const USER: MessageParam[] = [{ role: "user", content: "What's new with Fluxer bots?" }];

function usage(o: Partial<Usage> = {}): Usage {
	return {
		input_tokens: 100,
		output_tokens: 50,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
		server_tool_use: null,
		inference_geo: null,
		output_tokens_details: null,
		service_tier: "standard",
		speed: null,
		...o,
	};
}

const text = (t: string, citations: Citation[] | null = null): ContentBlock => ({ type: "text", text: t, citations });
const thinking = (signature = "EqQBsig"): ContentBlock => ({ type: "thinking", thinking: "", signature });
const toolUse = (id: string, name: "web_search" | "web_fetch" | "code_execution", input: object): ContentBlock => ({
	type: "server_tool_use",
	id,
	name,
	input,
	caller: { type: "direct" },
});
const searchResult = (toolUseId: string): ContentBlock => ({
	type: "web_search_tool_result",
	tool_use_id: toolUseId,
	caller: { type: "direct" },
	content: [
		{ type: "web_search_result", url: "https://example.com/a", title: "A", encrypted_content: "Eq", page_age: null },
	],
});
const fetchResult = (toolUseId: string, url: string): ContentBlock => ({
	type: "web_fetch_tool_result",
	tool_use_id: toolUseId,
	caller: { type: "direct" },
	content: {
		type: "web_fetch_result",
		url,
		retrieved_at: "2026-11-01T12:00:00Z",
		content: {
			type: "document",
			title: "Doc",
			citations: { enabled: true },
			source: { type: "text", media_type: "text/plain", data: "Body text" },
		},
	},
});
const searchCitation: Citation = {
	type: "web_search_result_location",
	url: "https://example.com/a",
	title: "A",
	encrypted_index: "Eo8B",
	cited_text: "Fluxer bots can now…",
};

let messageNumber = 0;

function apiMessage(
	content: ContentBlock[],
	o: {
		stop?: StopReason | null;
		usage?: Partial<Usage>;
		category?: RefusalCategory;
		model?: string;
		container?: ApiMessage["container"];
	} = {},
): ApiMessage {
	const stop = o.stop === undefined ? "end_turn" : o.stop;
	return {
		id: `msg_${++messageNumber}`,
		type: "message",
		role: "assistant",
		model: o.model ?? "claude-haiku-5-5",
		content,
		stop_reason: stop,
		stop_details: stop === "refusal" ? { type: "refusal", category: o.category ?? null, explanation: null } : null,
		stop_sequence: null,
		container: o.container ?? null,
		diagnostics: null,
		usage: usage(o.usage),
	};
}

/** Splits s into about n pieces (at least one). */
function chunks(s: string, n: number): string[] {
	const size = Math.max(1, Math.ceil(s.length / n));
	const out: string[] = [];
	for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
	return out.length > 0 ? out : [""];
}

/** The events the API streams for one content block. */
function blockEvents(block: ContentBlock, index: number): StreamEvent[] {
	const start = (content_block: StartBlock): StreamEvent => ({ type: "content_block_start", index, content_block });
	const delta = (d: BlockDelta): StreamEvent => ({ type: "content_block_delta", index, delta: d });
	const stop: StreamEvent = { type: "content_block_stop", index };
	switch (block.type) {
		case "text":
			return [
				start({ type: "text", text: "", citations: null }),
				...(block.citations ?? []).map((citation) => delta({ type: "citations_delta", citation })),
				...chunks(block.text, 2).map((t) => delta({ type: "text_delta", text: t })),
				stop,
			];
		case "thinking":
			return [
				start({ type: "thinking", thinking: "", signature: "" }),
				delta({ type: "thinking_delta", thinking: block.thinking }),
				delta({ type: "signature_delta", signature: block.signature }),
				stop,
			];
		case "server_tool_use":
			return [
				start({ ...block, input: {} }),
				...chunks(JSON.stringify(block.input), 3).map((p) => delta({ type: "input_json_delta", partial_json: p })),
				stop,
			];
		default:
			// Tool results arrive complete in their start event.
			return [start(block), stop];
	}
}

const messageStart = (message: ApiMessage): StreamEvent => ({
	type: "message_start",
	message: {
		...message,
		content: [],
		stop_reason: null,
		stop_details: null,
		container: null, // arrives with message_delta
		usage: { ...message.usage, output_tokens: 1 },
	},
});

/** A realistic event sequence for a whole message: start, blocks, delta with stop reason and usage, stop. */
function streamEvents(message: ApiMessage): StreamEvent[] {
	const u = message.usage;
	return [
		messageStart(message),
		...message.content.flatMap(blockEvents),
		{
			type: "message_delta",
			delta: {
				stop_reason: message.stop_reason,
				stop_details: message.stop_details,
				stop_sequence: null,
				container: message.container,
			},
			usage: {
				input_tokens: u.input_tokens,
				output_tokens: u.output_tokens,
				cache_creation_input_tokens: u.cache_creation_input_tokens,
				cache_read_input_tokens: u.cache_read_input_tokens,
				server_tool_use: u.server_tool_use,
				output_tokens_details: u.output_tokens_details,
			},
		},
		{ type: "message_stop" },
	];
}

// ---------------------------------------------------------------- SDK errors

const errorBody = (type: string, message: string) => ({ type: "error", error: { type, message } });
const MISMATCH =
	"messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block.";
const SPEND_LIMIT =
	"You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.";
const TIER_CAP =
	"You have reached your API usage limits: your organization has crossed its monthly API usage threshold.";
const NO_CREDIT =
	"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

function httpError(status: number, type: string, message = "Something failed", details?: object): APIError {
	const body = { type: "error", error: { type, message, ...(details ? { details } : {}) } };
	return APIError.generate(status, body, undefined, new Headers({ "request-id": "req_123" }));
}

/** What the SDK throws for an SSE `error` event: no status, the type from the body. */
function streamError(type: string, message = "Overloaded"): APIError {
	return new APIError(undefined, errorBody(type, message), undefined, new Headers(), type as APIError["type"]);
}

// ---------------------------------------------------------------- fake transport

type Script =
	| { kind: "ok"; message: ApiMessage; events?: StreamEvent[] }
	/** Streams `events`, then fails; `quiet`: the iteration ends normally and only finalMessage() rejects. */
	| { kind: "fail"; events: StreamEvent[]; error: unknown; quiet?: boolean }
	/** Streams `events`, then waits until aborted (or forever with ignoreAbort); `late` events come after a delay regardless. */
	| { kind: "hang"; events: StreamEvent[]; ignoreAbort?: boolean; late?: { afterMs: number; events: StreamEvent[] } }
	/** transport.stream() itself throws. */
	| { kind: "throw"; error: unknown };

const ok = (message: ApiMessage): Script => ({ kind: "ok", message });
const fail = (error: unknown, events: StreamEvent[] = []): Script => ({ kind: "fail", events, error });

class FakeStream implements ClaudeStream {
	aborted = false;
	private readonly abortListeners: Array<() => void> = [];

	constructor(private readonly script: Exclude<Script, { kind: "throw" }>) {}

	async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
		const s = this.script;
		const events = s.kind === "ok" ? (s.events ?? streamEvents(s.message)) : s.events;
		for (const event of events) {
			await Promise.resolve();
			if (this.aborted) throw new APIUserAbortError();
			yield event;
		}
		if (s.kind === "fail" && !s.quiet) throw s.error;
		if (s.kind === "hang") {
			if (s.late) {
				await new Promise((resolve) => setTimeout(resolve, s.late?.afterMs));
				yield* s.late.events;
			}
			await this.untilAborted();
		}
	}

	finalMessage(): Promise<ApiMessage> {
		const s = this.script;
		if (this.aborted) return Promise.reject(new APIUserAbortError());
		if (s.kind === "ok") return Promise.resolve(s.message);
		if (s.kind === "fail") return Promise.reject(s.error);
		return this.untilAborted();
	}

	abort(): void {
		this.aborted = true;
		for (const listener of this.abortListeners.splice(0)) listener();
	}

	private untilAborted(): Promise<never> {
		const ignore = this.script.kind === "hang" && this.script.ignoreAbort;
		return new Promise((_resolve, reject) => {
			if (!ignore) this.abortListeners.push(() => reject(new APIUserAbortError()));
		});
	}
}

class FakeTransport implements ClaudeTransport {
	readonly params: MessageCreateParams[] = [];
	readonly streams: FakeStream[] = [];
	onStream: () => void = () => {};

	constructor(private readonly scripts: Script[]) {}

	stream(params: MessageCreateParams): ClaudeStream {
		this.params.push(params);
		this.onStream();
		const script = this.scripts.shift();
		if (!script) throw new Error("FakeTransport: no scripted response left");
		if (script.kind === "throw") throw script.error;
		const stream = new FakeStream(script);
		this.streams.push(stream);
		return stream;
	}
}

/** Records every hook call. */
class Recorder {
	readonly texts: string[] = [];
	readonly statuses: Array<ToolStatus | null> = [];
	readonly calls: Array<{ usage: Usage | null; model: string }> = [];
	readonly order: string[] = [];
	readonly hooks: RunHooks;

	constructor() {
		this.hooks = {
			progress: {
				onText: (t) => {
					this.texts.push(t);
					this.order.push("text");
				},
				onToolStatus: (s) => {
					this.statuses.push(s);
					this.order.push(s ? `status:${s.tool}` : "status:null");
				},
			},
			onCallEnd: (u, model) => {
				this.calls.push({ usage: u, model });
				this.order.push("callEnd");
			},
		};
	}
}

function setup(scripts: Script[], opts: Partial<Omit<RunnerOptions, "transport" | "log">> & { toml?: string } = {}) {
	const { toml, ...runnerOpts } = opts;
	const lines: string[] = [];
	const log = createLogger({ level: "info", write: (line) => lines.push(line) });
	const loaded = runnerOpts.loaded ?? loadTestConfig(toml ?? "");
	const transport = new FakeTransport(scripts);
	const runner = new ClaudeRunner({ retryDelayMs: 0, ...runnerOpts, loaded, transport, log });
	const logs = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
	return { runner, transport, loaded, lines, logs };
}

// ---------------------------------------------------------------- buildParams

describe("buildParams", () => {
	it("uses the pro tier's model, effort, output limit, tool budgets and prompt", () => {
		const loaded = loadTestConfig("[pro]\nenabled = true\n[limits]\nmonthly_usd = 150");
		const pro = loaded.pro!;
		const params = buildParams(pro, USER);
		expect(params).toMatchObject({
			model: "claude-sonnet-5-5",
			max_tokens: 16_000,
			output_config: { effort: "high" },
			system: [{ text: pro.systemPrompt }],
			tools: [
				{ name: "web_search", max_uses: 10 },
				{ name: "web_fetch", max_uses: 5, max_content_tokens: 10_000 },
			],
		});
		expect(callDeadlineMs(pro.config)).toBe(60_000 + 16_000 * 20 + 15 * 10_000);
	});

	it("builds the default request with a fixed key order", () => {
		const loaded = loadTestConfig();
		const params = buildParams(loaded, USER);
		const expected = {
			model: "claude-haiku-5-5",
			max_tokens: 8000,
			thinking: { type: "adaptive", display: "omitted" },
			output_config: { effort: "medium" },
			system: [{ type: "text", text: loaded.systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } }],
			tools: [
				{ type: "web_search_20260318", name: "web_search", max_uses: 3, allowed_callers: ["direct"] },
				{
					type: "web_fetch_20260318",
					name: "web_fetch",
					max_uses: 3,
					max_content_tokens: 10_000,
					citations: { enabled: true },
					allowed_callers: ["direct"],
				},
			],
			cache_control: { type: "ephemeral" },
			messages: USER,
			stream: true,
		};
		// Comparing the JSON text also checks the key order, which the prompt cache depends on.
		expect(JSON.stringify(params)).toBe(JSON.stringify(expected));
		expect(params.messages).toBe(USER);
		expect(loaded.systemPrompt.length).toBeGreaterThan(0);
	});

	it("serializes identically on every call", () => {
		const loaded = loadTestConfig();
		expect(JSON.stringify(buildParams(loaded, USER))).toBe(JSON.stringify(buildParams(loaded, USER)));
	});

	it("leaves out disabled tools, and the tools key when no tool is enabled", () => {
		const onlyFetch = buildParams(loadTestConfig("[tools.web_search]\nenabled = false"), USER);
		expect(onlyFetch.tools?.map((t) => t.type)).toEqual(["web_fetch_20260318"]);

		const onlySearch = buildParams(loadTestConfig("[tools.web_fetch]\nenabled = false"), USER);
		expect(onlySearch.tools?.map((t) => t.type)).toEqual(["web_search_20260318"]);

		const none = buildParams(
			loadTestConfig("[tools.web_search]\nenabled = false\n[tools.web_fetch]\nenabled = false"),
			USER,
		);
		expect("tools" in none).toBe(false);
		expect(Object.keys(none)).toEqual([
			"model",
			"max_tokens",
			"thinking",
			"output_config",
			"system",
			"cache_control",
			"messages",
			"stream",
		]);
	});

	it("adds domain filters, user location and options only when they're set", () => {
		const loaded = loadTestConfig(
			[
				"[model]",
				'effort = "high"',
				"max_tokens = 4000",
				"[cache]",
				'system_ttl = "5m"',
				"[tools.web_search]",
				"max_uses = 5",
				'allowed_domains = ["example.com", "docs.example.org/blog"]',
				'user_location = { country = "CA", timezone = "America/Vancouver" }',
				"[tools.web_fetch]",
				"max_uses = 2",
				"max_content_tokens = 5000",
				'blocked_domains = ["bad.example"]',
				"citations = false",
			].join("\n"),
		);
		const params = buildParams(loaded, USER);
		expect(params.max_tokens).toBe(4000);
		expect(params.output_config).toEqual({ effort: "high" });
		expect(JSON.stringify(params.system)).toBe(
			JSON.stringify([{ type: "text", text: loaded.systemPrompt, cache_control: { type: "ephemeral", ttl: "5m" } }]),
		);
		expect(JSON.stringify(params.tools)).toBe(
			JSON.stringify([
				{
					type: "web_search_20260318",
					name: "web_search",
					max_uses: 5,
					allowed_domains: ["example.com", "docs.example.org/blog"],
					user_location: { type: "approximate", country: "CA", timezone: "America/Vancouver" },
					allowed_callers: ["direct"],
				},
				{
					type: "web_fetch_20260318",
					name: "web_fetch",
					max_uses: 2,
					max_content_tokens: 5000,
					blocked_domains: ["bad.example"],
					allowed_callers: ["direct"],
				},
			]),
		);
	});

	it("writes every user location field in a fixed order", () => {
		const loaded = loadTestConfig(
			'[tools.web_search]\nuser_location = { timezone = "Europe/Berlin", country = "DE", region = "Berlin", city = "Berlin" }',
		);
		const search = buildParams(loaded, USER).tools?.[0] as Anthropic.Messages.WebSearchTool20260318;
		expect(JSON.stringify(search.user_location)).toBe(
			JSON.stringify({
				type: "approximate",
				city: "Berlin",
				region: "Berlin",
				country: "DE",
				timezone: "Europe/Berlin",
			}),
		);
	});

	it("uses the configured model and never sends sampling or beta-only fields", () => {
		const params = buildParams(loadTestConfig('[model]\nname = "claude-sonnet-5-5"'), USER);
		expect(params.model).toBe("claude-sonnet-5-5");
		for (const key of ["temperature", "top_p", "top_k", "fallbacks", "metadata"]) expect(key in params).toBe(false);
	});
});

// ---------------------------------------------------------------- classifyError

describe("classifyError", () => {
	it.each([
		["400 thinking mismatch", httpError(400, "invalid_request_error", MISMATCH), "thinking_mismatch", 400],
		["400", httpError(400, "invalid_request_error", "max_tokens: too large"), "invalid_request", 400],
		["400 spend limit", httpError(400, "invalid_request_error", SPEND_LIMIT), "spend_limit", 400],
		["400 no credit left", httpError(400, "invalid_request_error", NO_CREDIT), "spend_limit", 400],
		[
			"400 mentioning a spend limit later in the text",
			httpError(400, "invalid_request_error", `messages.0: ${SPEND_LIMIT}`),
			"invalid_request",
			400,
		],
		[
			"429 tier spend cap",
			httpError(429, "rate_limit_error", TIER_CAP, { error_code: "enforced_spend_limit_reached" }),
			"spend_limit",
			429,
		],
		[
			"429 with another error code",
			httpError(429, "rate_limit_error", "slow down", { error_code: "x" }),
			"rate_limited",
			429,
		],
		["401", httpError(401, "authentication_error", "invalid x-api-key"), "auth", 401],
		["403", httpError(403, "permission_error"), "auth", 403],
		["404", httpError(404, "not_found_error", "model: claude-nope"), "invalid_request", 404],
		["413", httpError(413, "request_too_large"), "invalid_request", 413],
		["402 billing", httpError(402, "billing_error"), "spend_limit", 402],
		["409", httpError(409, "conflict_error"), "other", 409],
		["408", httpError(408, "timeout_error"), "timeout", 408],
		["429", httpError(429, "rate_limit_error"), "rate_limited", 429],
		["500", httpError(500, "api_error"), "server", 500],
		["504", httpError(504, "timeout_error"), "server", 504],
		["529", httpError(529, "overloaded_error", "Overloaded"), "overloaded", 529],
		["stream overloaded_error", streamError("overloaded_error"), "overloaded", null],
		["stream api_error", streamError("api_error"), "server", null],
		["stream rate_limit_error", streamError("rate_limit_error"), "rate_limited", null],
		["stream invalid_request_error", streamError("invalid_request_error", MISMATCH), "thinking_mismatch", null],
		["stream billing_error", streamError("billing_error", "billing"), "spend_limit", null],
		["stream authentication_error", streamError("authentication_error", "bad key"), "auth", null],
		["stream error of an unknown type", streamError("brand_new_error", "?"), "server", null],
		["connection error", new APIConnectionError({ message: "fetch failed" }), "network", null],
		["connection timeout", new APIConnectionTimeoutError(), "timeout", null],
		["user abort", new APIUserAbortError(), "other", null],
		[
			"body read failure",
			Object.assign(new AnthropicError("terminated"), { cause: new TypeError("x") }),
			"network",
			null,
		],
		["other SDK error", new AnthropicError("request ended without sending any chunks"), "other", null],
		["plain error", new Error("bug"), "other", null],
		["not an error", "weird", "other", null],
	])("%s", (_name, err, kind, status) => {
		const e = classifyError(err);
		expect(e).toBeInstanceOf(ClaudeError);
		expect(e.kind).toBe(kind);
		expect(e.status).toBe(status);
		expect(e.cause).toBe(err);
	});

	it("uses the API's own message and keeps the request ID", () => {
		const e = classifyError(httpError(400, "invalid_request_error", MISMATCH));
		expect(e.message).toBe(MISMATCH);
		expect(e.requestId).toBe("req_123");
		expect(e.name).toBe("ClaudeError");
	});

	it("keeps the quoted input of a JSON parse error out of the message", () => {
		let syntax: unknown;
		try {
			JSON.parse('{"text":Private words}');
		} catch (e) {
			syntax = e;
		}
		expect(String(syntax)).toContain("Private");
		// What the SDK's MessageStream makes of it.
		const wrapped = Object.assign(new AnthropicError((syntax as Error).message), { cause: syntax });
		const e = classifyError(wrapped);
		expect(e).toMatchObject({ kind: "network", status: null, message: "the API sent an event that isn't valid JSON" });
		expect(e.cause).toBe(wrapped);
	});

	it("passes a ClaudeError through unchanged", () => {
		const e = new ClaudeError("late", "timeout", null);
		expect(classifyError(e)).toBe(e);
	});
});

// ---------------------------------------------------------------- ClaudeRunner

describe("ClaudeRunner", () => {
	it("streams the text, returns an end_turn answer and reports the call once", async () => {
		const msg = apiMessage([thinking(), text("Hello "), text("world.", [searchCitation])], {
			usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 },
		});
		const t = setup([ok(msg)]);
		const r = new Recorder();
		const result = await t.runner.run(USER, r.hooks);

		expect(result).toEqual({
			stop: "end_turn",
			content: msg.content,
			pieces: [msg.content],
			refusalCategory: null,
			lastUsage: msg.usage,
		});
		// Full text so far on every delta, across blocks.
		expect(r.texts).toEqual(["Hel", "Hello ", "Hello wor", "Hello world."]);
		expect(r.calls).toEqual([{ usage: msg.usage, model: "claude-haiku-5-5" }]);
		expect(r.statuses).toEqual([]);
		expect(t.transport.params).toEqual([buildParams(t.loaded, USER)]);
	});

	it("logs one info line per call with counts and never the content", async () => {
		const clock = testClock();
		const msg = apiMessage([text("Secret answer text")], {
			usage: {
				input_tokens: 120,
				output_tokens: 30,
				cache_read_input_tokens: 2000,
				cache_creation_input_tokens: 500,
				server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
			},
		});
		const t = setup([ok(msg)], { clock });
		t.transport.onStream = () => clock.advance(1500);
		await t.runner.run(USER, new Recorder().hooks);

		const calls = t.logs().filter((l) => l.msg === "claude call");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			level: "info",
			model: "claude-haiku-5-5",
			messageId: msg.id,
			stopReason: "end_turn",
			inputTokens: 120,
			outputTokens: 30,
			cacheReadTokens: 2000,
			cacheWriteTokens: 500,
			webSearches: 2,
			webFetches: 1,
			durationMs: 1500,
		});
		const all = t.lines.join("\n");
		expect(all).not.toContain("Secret answer");
		expect(all).not.toContain("Fluxer bots");
	});

	it("shows web search and fetch status while the tools run", async () => {
		const msg = apiMessage(
			[
				text("Let me check. "),
				toolUse("srv_1", "web_search", { query: "fluxer bots" }),
				searchResult("srv_1"),
				toolUse("srv_2", "web_fetch", { url: "https://example.com/a" }),
				fetchResult("srv_2", "https://example.com/a"),
				text("Done."),
			],
			{ usage: { server_tool_use: { web_search_requests: 1, web_fetch_requests: 1 } } },
		);
		const t = setup([ok(msg)]);
		const r = new Recorder();
		const result = await t.runner.run(USER, r.hooks);

		expect(result.stop).toBe("end_turn");
		expect(r.statuses).toEqual([
			{ tool: "web_search", query: "fluxer bots" },
			null,
			{ tool: "web_fetch", url: "https://example.com/a" },
			null,
		]);
		expect(r.order).toEqual([
			"text",
			"text",
			"status:web_search",
			"status:null",
			"status:web_fetch",
			"status:null",
			"text",
			"text",
			"callEnd",
		]);
		expect(r.texts.at(-1)).toBe("Let me check. Done.");
	});

	it("puts a paragraph break between text on either side of a tool call, like the final render", async () => {
		const msg = apiMessage(
			[
				text("I'll search for that."),
				toolUse("srv_1", "web_search", { query: "q" }),
				searchResult("srv_1"),
				text("Based on it, yes."),
			],
			{ usage: { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } } },
		);
		const t = setup([ok(msg)]);
		const r = new Recorder();
		await t.runner.run(USER, r.hooks);
		expect(r.texts.at(-1)).toBe("I'll search for that.\n\nBased on it, yes.");
	});

	it("shows a tool status as soon as its input parses, before the block ends", async () => {
		const msg = apiMessage([toolUse("srv_1", "web_search", { query: "q" })]);
		const events: StreamEvent[] = [
			messageStart(msg),
			{
				type: "content_block_start",
				index: 0,
				content_block: { ...(msg.content[0] as object), input: {} } as StartBlock,
			},
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query": "q"}' } },
		];
		const t = setup([{ kind: "fail", events, error: httpError(500, "api_error") }]);
		const r = new Recorder();
		await expect(t.runner.run(USER, r.hooks)).rejects.toMatchObject({ kind: "server" });
		// Shown from the delta, then cleared when the turn ended without a result.
		expect(r.statuses).toEqual([{ tool: "web_search", query: "q" }, null]);
	});

	it("shows no status for code execution or for input without a query or URL", async () => {
		const msg = apiMessage([
			toolUse("srv_1", "code_execution", { code: "print(1)" }),
			toolUse("srv_2", "web_search", {}),
			toolUse("srv_3", "web_fetch", { url: "" }),
			text("ok"),
		]);
		const t = setup([ok(msg)]);
		const r = new Recorder();
		expect((await t.runner.run(USER, r.hooks)).stop).toBe("end_turn");
		expect(r.statuses).toEqual([]);
	});

	it("keeps the status of the newest tool when two run back to back", async () => {
		const msg = apiMessage([
			toolUse("srv_1", "web_search", { query: "one" }),
			toolUse("srv_2", "web_search", { query: "two" }),
			searchResult("srv_1"),
			searchResult("srv_2"),
			text("Both."),
		]);
		const t = setup([ok(msg)]);
		const r = new Recorder();
		await t.runner.run(USER, r.hooks);
		// The first result doesn't clear the second tool's status; the second result does.
		expect(r.statuses).toEqual([{ tool: "web_search", query: "one" }, { tool: "web_search", query: "two" }, null]);
	});

	it("ignores event, delta and block types it doesn't know", async () => {
		const msg = apiMessage([text("Known.")]);
		const events = streamEvents(msg);
		const unknown = [
			{ type: "brand_new_event", data: "Should not be shown" },
			{ type: "content_block_start", index: 1, content_block: { type: "brand_new_block", text: "Nor this" } },
			{ type: "content_block_delta", index: 1, delta: { type: "brand_new_delta", text: "Nor this" } },
			{ type: "content_block_stop", index: 1 },
		] as unknown as StreamEvent[]; // shapes newer than the SDK types, on purpose
		const t = setup([{ kind: "ok", message: msg, events: [...events.slice(0, -2), ...unknown, ...events.slice(-2)] }]);
		const r = new Recorder();
		const result = await t.runner.run(USER, r.hooks);
		expect(result.stop).toBe("end_turn");
		expect(r.texts.at(-1)).toBe("Known.");
		expect(r.statuses).toEqual([]);
	});

	it("uses tool input that's already complete in the block start event", async () => {
		const msg = apiMessage([
			toolUse("srv_1", "web_fetch", { url: "https://e.com" }),
			fetchResult("srv_1", "https://e.com"),
		]);
		const events: StreamEvent[] = [
			messageStart(msg),
			{ type: "content_block_start", index: 0, content_block: msg.content[0] as StartBlock },
			{ type: "content_block_stop", index: 0 },
			...blockEvents(msg.content[1] as ContentBlock, 1),
			...streamEvents(msg).slice(-2), // message_delta, message_stop
		];
		const t = setup([{ kind: "ok", message: msg, events }]);
		const r = new Recorder();
		await t.runner.run(USER, r.hooks);
		expect(r.statuses).toEqual([{ tool: "web_fetch", url: "https://e.com" }, null]);
	});

	it("continues a paused turn with the paused content as the last message", async () => {
		const first = apiMessage([text("Searching. "), toolUse("srv_1", "web_search", { query: "q" })], {
			stop: "pause_turn",
			usage: { input_tokens: 10 },
		});
		const second = apiMessage([searchResult("srv_1"), text("Found it.")], { usage: { input_tokens: 20 } });
		const t = setup([ok(first), ok(second)]);
		const r = new Recorder();
		const messages = [...USER];
		const result = await t.runner.run(messages, r.hooks);

		expect(t.transport.params).toHaveLength(2);
		const [p0, p1] = t.transport.params as [MessageCreateParams, MessageCreateParams];
		expect(p0.messages).toEqual(USER);
		expect(p1.messages).toHaveLength(USER.length + 1);
		expect(p1.messages.slice(0, -1)).toEqual(USER);
		expect(p1.messages.at(-1)).toEqual({ role: "assistant", content: first.content });
		expect((p1.messages.at(-1) as { content: unknown }).content).toBe(first.content);
		// Same request otherwise, and the caller's array is untouched.
		expect({ ...p1, messages: [] }).toEqual({ ...p0, messages: [] });
		expect(messages).toEqual(USER);

		expect(result).toEqual({
			stop: "end_turn",
			content: [...first.content, ...second.content],
			pieces: [first.content, second.content],
			refusalCategory: null,
			lastUsage: second.usage,
		});
		expect(r.calls.map((c) => c.usage)).toEqual([first.usage, second.usage]);
		expect(r.order.filter((e) => e === "callEnd")).toHaveLength(2);
		expect(r.texts.at(-1)).toBe("Searching. Found it.");
		// The status spans the pause and clears when the result arrives in the next call.
		expect(r.statuses).toEqual([{ tool: "web_search", query: "q" }, null]);
	});

	it("sends a paused call's container back with the continuation", async () => {
		const container = { id: "cntr_1", expires_at: "2026-11-01T13:00:00Z", skills: null };
		const first = apiMessage([text("a")], { stop: "pause_turn", container });
		const second = apiMessage([text("b")], { stop: "pause_turn" }); // no container: keep the known one
		const t = setup([ok(first), ok(second), ok(apiMessage([text("c")]))]);
		await t.runner.run(USER, new Recorder().hooks);
		const [p0, p1, p2] = t.transport.params;
		expect(p0 && "container" in p0).toBe(false);
		expect(p1?.container).toBe("cntr_1");
		expect(p2?.container).toBe("cntr_1");
		expect(p1 && { ...p1, container: undefined, messages: [] }).toEqual({ ...p0, messages: [] });
	});

	it("stops with pause_limit after the last continuation pauses again", async () => {
		const paused = () => apiMessage([text("more ")], { stop: "pause_turn" });
		const pieces = [paused(), paused(), paused()];
		const t = setup([...pieces.map(ok), ok(apiMessage([text("never")]))], { maxContinuations: 2 });
		const r = new Recorder();
		const result = await t.runner.run(USER, r.hooks);

		expect(result.stop).toBe("pause_limit");
		expect(result.pieces).toEqual(pieces.map((p) => p.content));
		expect(t.transport.params).toHaveLength(3);
		expect(t.transport.params[2]?.messages).toHaveLength(3);
		expect(r.calls).toHaveLength(3);
		expect(r.texts.at(-1)).toBe("more more more ");
	});

	it("defaults to three continuations, and zero means none", async () => {
		const paused = () => ok(apiMessage([text("x")], { stop: "pause_turn" }));
		const t = setup([paused(), paused(), paused(), paused(), paused()]);
		const result = await t.runner.run(USER, new Recorder().hooks);
		expect(result.stop).toBe("pause_limit");
		expect(t.transport.params).toHaveLength(4);

		const none = setup([paused()], { maxContinuations: 0 });
		const r = new Recorder();
		expect((await none.runner.run(USER, r.hooks)).stop).toBe("pause_limit");
	});

	it("discards partial output on a refusal and returns its category", async () => {
		const msg = apiMessage([text("Sure, here is how")], { stop: "refusal", category: "cyber" });
		const t = setup([ok(msg)]);
		const r = new Recorder();
		const result = await t.runner.run(USER, r.hooks);

		expect(result).toEqual({
			stop: "refusal",
			content: [],
			pieces: [],
			refusalCategory: "cyber",
			lastUsage: msg.usage,
		});
		expect(r.texts.length).toBeGreaterThan(0);
		expect(r.calls).toEqual([{ usage: msg.usage, model: "claude-haiku-5-5" }]);
		expect(t.logs()).toContainEqual(expect.objectContaining({ stopReason: "refusal", refusalCategory: "cyber" }));
	});

	it("discards earlier pieces too when a continuation is refused", async () => {
		const first = apiMessage([text("Part one")], { stop: "pause_turn" });
		const refused = apiMessage([text("Part two")], { stop: "refusal" });
		const t = setup([ok(first), ok(refused)]);
		const result = await t.runner.run(USER, new Recorder().hooks);
		expect(result).toMatchObject({ stop: "refusal", content: [], pieces: [], refusalCategory: null });
	});

	it("returns max_tokens with the content so far and clears a status left by an unrun tool", async () => {
		const msg = apiMessage([text("Long answer"), toolUse("srv_1", "web_fetch", { url: "https://e.com/x" })], {
			stop: "max_tokens",
		});
		const t = setup([ok(msg)]);
		const r = new Recorder();
		const result = await t.runner.run(USER, r.hooks);

		expect(result).toMatchObject({ stop: "max_tokens", content: msg.content, pieces: [msg.content] });
		expect(r.statuses).toEqual([{ tool: "web_fetch", url: "https://e.com/x" }, null]);
	});

	it.each(["stop_sequence", "model_context_window_exceeded"] as const)(
		"returns %s as unexpected with the content so far and warns",
		async (stop) => {
			const msg = apiMessage([text("Some text")], { stop });
			const t = setup([ok(msg)]);
			const result = await t.runner.run(USER, new Recorder().hooks);
			expect(result).toMatchObject({ stop: "unexpected", content: msg.content });
			expect(result.replayable).toBeUndefined();
			expect(t.logs()).toContainEqual(expect.objectContaining({ level: "warn", stopReason: stop, blocks: ["text"] }));
		},
	);

	it("answers a stray client tool call with an error result and continues", async () => {
		const stray: ContentBlock = {
			type: "tool_use",
			id: "toolu_1",
			name: "read_pdf",
			input: { page: 1 },
			caller: { type: "direct" },
		} as ContentBlock;
		const first = apiMessage([stray], { stop: "tool_use" });
		const second = apiMessage([text("The tiers differ.")]);
		const t = setup([ok(first), ok(second)]);
		const r = new Recorder();
		const result = await t.runner.run(USER, r.hooks);

		expect(t.transport.params).toHaveLength(2);
		const p1 = t.transport.params[1] as MessageCreateParams;
		expect(p1.messages).toEqual([
			...USER,
			{ role: "assistant", content: first.content },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						is_error: true,
						content: expect.stringContaining('no "read_pdf" tool'),
					},
				],
			},
		]);
		expect(result).toMatchObject({
			stop: "end_turn",
			pieces: [first.content, second.content],
			replayable: false,
		});
		expect(r.calls).toHaveLength(2);
		expect(r.texts.at(-1)).toBe("The tiers differ.");
		expect(t.logs()).toContainEqual(
			expect.objectContaining({ level: "warn", blocks: ["tool_use:read_pdf"], stray: 1 }),
		);
	});

	it("re-sends a tool_use stop without client calls unchanged, like a pause", async () => {
		const first = apiMessage([toolUse("srv_1", "web_fetch", { url: "https://e.com/a.pdf" })], { stop: "tool_use" });
		const second = apiMessage([fetchResult("srv_1", "https://e.com/a.pdf"), text("Done.")]);
		const t = setup([ok(first), ok(second)]);
		const result = await t.runner.run(USER, new Recorder().hooks);

		expect(t.transport.params[1]?.messages).toEqual([...USER, { role: "assistant", content: first.content }]);
		expect(result).toMatchObject({ stop: "end_turn", pieces: [first.content, second.content] });
		expect(result.replayable).toBeUndefined();
	});

	it("stops as unexpected when stray tool calls go past the continuation limit", async () => {
		const stray = () =>
			apiMessage(
				[{ type: "tool_use", id: "toolu_x", name: "x", input: {}, caller: { type: "direct" } } as ContentBlock],
				{
					stop: "tool_use",
				},
			);
		const t = setup([ok(stray()), ok(stray()), ok(apiMessage([text("never")]))], { maxContinuations: 1 });
		const result = await t.runner.run(USER, new Recorder().hooks);
		expect(result).toMatchObject({ stop: "unexpected", replayable: false });
		expect(t.transport.params).toHaveLength(2);
	});

	it("passes the model that answered to onCallEnd", async () => {
		const t = setup([ok(apiMessage([text("hi")], { model: "claude-opus-5-5" }))]);
		const r = new Recorder();
		await t.runner.run(USER, r.hooks);
		expect(r.calls[0]?.model).toBe("claude-opus-5-5");
	});

	it("keeps going when a progress callback throws", async () => {
		const t = setup([ok(apiMessage([text("fine")]))]);
		const r = new Recorder();
		r.hooks.progress.onText = () => {
			throw new Error("Fluxer edit failed");
		};
		const result = await t.runner.run(USER, r.hooks);
		expect(result.stop).toBe("end_turn");
		expect(t.logs()).toContainEqual(expect.objectContaining({ level: "warn", msg: "progress callback failed" }));
	});

	describe("errors", () => {
		it.each([
			["a thinking mismatch", httpError(400, "invalid_request_error", MISMATCH), "thinking_mismatch", 400],
			["a spend limit", httpError(400, "invalid_request_error", SPEND_LIMIT), "spend_limit", 400],
			["a bad request", httpError(400, "invalid_request_error", "bad"), "invalid_request", 400],
			["a bad key", httpError(401, "authentication_error"), "auth", 401],
			["a rate limit", httpError(429, "rate_limit_error"), "rate_limited", 429],
			["an overload", httpError(529, "overloaded_error"), "overloaded", 529],
			["a server error", httpError(500, "api_error"), "server", 500],
		])("throws %s without retrying (the SDK already retried HTTP errors)", async (_name, err, kind, status) => {
			const t = setup([fail(err), ok(apiMessage([text("never")]))]);
			const r = new Recorder();
			await expect(t.runner.run(USER, r.hooks)).rejects.toMatchObject({ name: "ClaudeError", kind, status });
			expect(t.transport.params).toHaveLength(1);
			expect(r.calls).toEqual([{ usage: null, model: "claude-haiku-5-5" }]);
			expect(t.logs()).toContainEqual(
				expect.objectContaining({
					level: "warn",
					msg: "claude call failed",
					kind,
					status,
					requestId: "req_123",
					retry: false,
				}),
			);
		});

		it("retries a network error once when nothing had started, ", async () => {
			const msg = apiMessage([text("Recovered")]);
			const t = setup([fail(new APIConnectionError({ message: "fetch failed" })), ok(msg)]);
			const r = new Recorder();
			const result = await t.runner.run(USER, r.hooks);

			expect(result).toMatchObject({ stop: "end_turn", content: msg.content, pieces: [msg.content] });
			expect(t.transport.params).toHaveLength(2);
			expect(t.transport.params[1]).toEqual(t.transport.params[0]);
			expect(r.calls).toEqual([
				{ usage: null, model: "claude-haiku-5-5" },
				{ usage: msg.usage, model: "claude-haiku-5-5" },
			]);
			expect(r.order.filter((e) => e === "callEnd")).toHaveLength(2);
			expect(t.logs()).toContainEqual(expect.objectContaining({ kind: "network", retry: true }));
		});

		it("retries a mid-stream overload before any block, accounting for the failed call's usage", async () => {
			const failed = apiMessage([], { usage: { input_tokens: 500 } });
			const msg = apiMessage([text("Second try")]);
			const t = setup([fail(streamError("overloaded_error"), [messageStart(failed)]), ok(msg)]);
			const r = new Recorder();
			const result = await t.runner.run(USER, r.hooks);

			expect(result.stop).toBe("end_turn");
			expect(r.calls).toHaveLength(2);
			expect(r.calls[0]?.usage).toMatchObject({ input_tokens: 500, output_tokens: 1 });
			expect(r.texts).toEqual(["Secon", "Second try"]);
		});

		it("retries when only finalMessage() reports the error", async () => {
			const t = setup([
				{ kind: "fail", events: [], error: streamError("overloaded_error"), quiet: true },
				ok(apiMessage([text("ok")])),
			]);
			const result = await t.runner.run(USER, new Recorder().hooks);
			expect(result.stop).toBe("end_turn");
			expect(t.transport.params).toHaveLength(2);
		});

		it("doesn't retry once content had started", async () => {
			const partial = apiMessage([text("Half an ans")]);
			const events = streamEvents(partial).slice(0, 3); // message_start, text start, first delta
			const t = setup([fail(streamError("overloaded_error"), events), ok(apiMessage([text("never")]))]);
			const r = new Recorder();
			await expect(t.runner.run(USER, r.hooks)).rejects.toMatchObject({ kind: "overloaded", status: null });
			expect(t.transport.params).toHaveLength(1);
			expect(r.texts).toEqual(["Half a"]);
			expect(r.calls).toHaveLength(1);
			expect(r.calls[0]?.usage).not.toBeNull();
		});

		it("adds message_delta counts to the usage of a call that fails late", async () => {
			const msg = apiMessage([toolUse("srv_1", "web_search", { query: "q" }), searchResult("srv_1")], {
				usage: {
					input_tokens: 300,
					output_tokens: 42,
					server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
				},
			});
			const events = streamEvents(msg).slice(0, -1); // everything but message_stop
			const t = setup([fail(new AnthropicError("terminated"), events), ok(apiMessage([text("never")]))]);
			const r = new Recorder();
			// The SDK's bare error for a stream that stopped early counts as a dropped connection.
			await expect(t.runner.run(USER, r.hooks)).rejects.toMatchObject({ kind: "network", status: null });
			expect(t.transport.params).toHaveLength(1); // content had started
			expect(r.calls[0]?.usage).toEqual({
				...msg.usage,
				output_tokens: 42,
				server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
			});
		});

		it("retries a stream that ended before anything started", async () => {
			const t = setup([
				fail(new AnthropicError("request ended without sending any chunks")),
				ok(apiMessage([text("ok")])),
			]);
			const r = new Recorder();
			const result = await t.runner.run(USER, r.hooks);
			expect(result.stop).toBe("end_turn");
			expect(t.transport.params).toHaveLength(2);
			expect(r.calls).toHaveLength(2);
			expect(t.logs()).toContainEqual(expect.objectContaining({ kind: "network", retry: true }));
		});

		it("keeps a bare SDK error after a complete message as other", async () => {
			const msg = apiMessage([text("Fine")]);
			const t = setup([
				{ kind: "fail", events: streamEvents(msg), error: new AnthropicError("odd"), quiet: true },
				ok(apiMessage([text("never")])),
			]);
			await expect(t.runner.run(USER, new Recorder().hooks)).rejects.toMatchObject({ kind: "other" });
			expect(t.transport.params).toHaveLength(1);
		});

		it("retries only once", async () => {
			const t = setup([
				fail(streamError("overloaded_error")),
				fail(streamError("api_error")),
				ok(apiMessage([text("never")])),
			]);
			const r = new Recorder();
			await expect(t.runner.run(USER, r.hooks)).rejects.toMatchObject({ kind: "server", status: null });
			expect(t.transport.params).toHaveLength(2);
			expect(r.calls).toHaveLength(2);
		});

		it("gives each continuation its own retry", async () => {
			const first = apiMessage([text("a")], { stop: "pause_turn" });
			const t = setup([
				fail(new APIConnectionError({})),
				ok(first),
				fail(new APIConnectionError({})),
				ok(apiMessage([text("b")])),
			]);
			const r = new Recorder();
			const result = await t.runner.run(USER, r.hooks);
			expect(result.pieces).toHaveLength(2);
			expect(r.calls).toHaveLength(4);
		});

		it("treats a stream that ends without a stop reason as a network error", async () => {
			const t = setup([ok(apiMessage([text("Cut")], { stop: null })), ok(apiMessage([text("never")]))]);
			const r = new Recorder();
			await expect(t.runner.run(USER, r.hooks)).rejects.toMatchObject({ kind: "network", status: null });
			expect(t.transport.params).toHaveLength(1); // text had started
			expect(r.calls).toHaveLength(1);
		});

		it("reports a call that the transport couldn't even start", async () => {
			const t = setup([{ kind: "throw", error: new Error("boom") }]);
			const r = new Recorder();
			await expect(t.runner.run(USER, r.hooks)).rejects.toMatchObject({ kind: "other", message: "boom" });
			expect(r.calls).toEqual([{ usage: null, model: "claude-haiku-5-5" }]);
		});
	});

	describe("deadline", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("scales the default deadline with max_tokens and the tool uses, never below 180 s", () => {
			// 60 s + 8000 tokens x 20 ms + 6 tool uses x 10 s
			expect(callDeadlineMs(loadTestConfig().config)).toBe(280_000);
			expect(callDeadlineMs(loadTestConfig("[model]\nmax_tokens = 64000").config)).toBe(60_000 + 1_280_000 + 60_000);
			const noTools = "[tools.web_search]\nenabled = false\n[tools.web_fetch]\nenabled = false";
			expect(callDeadlineMs(loadTestConfig(`${noTools}\n[model]\nmax_tokens = 4000`).config)).toBe(180_000);
			expect(callDeadlineMs(loadTestConfig(`${noTools}\n[model]\nmax_tokens = 8000`).config)).toBe(220_000);
		});

		it("aborts a call that runs past the deadline and doesn't retry it", async () => {
			const slow = apiMessage([text("Slow answer")]);
			const t = setup([{ kind: "hang", events: streamEvents(slow).slice(0, 3) }, ok(apiMessage([text("never")]))]);
			const r = new Recorder();
			const run = t.runner.run(USER, r.hooks);
			const settled = expect(run).rejects.toMatchObject({ name: "ClaudeError", kind: "timeout", status: null });

			// The default config's deadline: 280 s.
			await vi.advanceTimersByTimeAsync(279_999);
			expect(t.transport.streams[0]?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await settled;

			expect(t.transport.streams[0]?.aborted).toBe(true);
			expect(t.transport.params).toHaveLength(1);
			expect(r.calls).toHaveLength(1);
			expect(r.calls[0]?.usage).toMatchObject({ input_tokens: 100, output_tokens: 1 });
		});

		it("times out even when the stream ignores abort()", async () => {
			const t = setup([{ kind: "hang", events: [], ignoreAbort: true }], { deadlineMs: 5_000 });
			const r = new Recorder();
			const run = t.runner.run(USER, r.hooks);
			const settled = expect(run).rejects.toMatchObject({ kind: "timeout" });
			await vi.advanceTimersByTimeAsync(5_000);
			await settled;
			expect(r.calls).toEqual([{ usage: null, model: "claude-haiku-5-5" }]);
		});

		it("ignores events that still arrive after the deadline", async () => {
			const all = streamEvents(apiMessage([text("Too late")]));
			const late = { afterMs: 6_000, events: all.slice(2) }; // the text deltas and the end
			const t = setup([{ kind: "hang", events: all.slice(0, 2), ignoreAbort: true, late }], { deadlineMs: 5_000 });
			const r = new Recorder();
			const settled = expect(t.runner.run(USER, r.hooks)).rejects.toMatchObject({ kind: "timeout" });
			await vi.advanceTimersByTimeAsync(5_000);
			await settled;
			await vi.advanceTimersByTimeAsync(2_000);
			expect(r.texts).toEqual([]);
			expect(r.calls).toHaveLength(1);
		});

		it("clears a shown tool status when the call times out", async () => {
			const msg = apiMessage([toolUse("srv_1", "web_search", { query: "slow" })]);
			const events = streamEvents(msg).slice(0, -2); // stops after the tool block
			const t = setup([{ kind: "hang", events }]);
			const r = new Recorder();
			const settled = expect(t.runner.run(USER, r.hooks)).rejects.toMatchObject({ kind: "timeout" });
			await vi.advanceTimersByTimeAsync(280_000);
			await settled;
			expect(r.statuses).toEqual([{ tool: "web_search", query: "slow" }, null]);
		});
	});
});

// ---------------------------------------------------------------- createTransport (real SDK, fake fetch)

/** Answer text that must never reach a log above debug level. */
const SECRET = "Secret";

type FakeResponse = (signal: AbortSignal | undefined) => Response;

function sseText(events: StreamEvent[]): string {
	return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const sse =
	(body: string): FakeResponse =>
	() =>
		new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_sse" } });

const jsonError =
	(status: number, type: string, message: string): FakeResponse =>
	() =>
		new Response(JSON.stringify(errorBody(type, message)), {
			status,
			headers: { "content-type": "application/json", "request-id": "req_http" },
		});

/** Sends `first`, then either errors the body with `error` or keeps it open until the request is aborted. */
const openStream =
	(first: string, error?: Error): FakeResponse =>
	(signal) =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(first));
					if (error) controller.error(error);
					else signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);

function fakeFetch(responses: FakeResponse[]) {
	const requests: Array<{ url: string; headers: Headers; body: string; signal: AbortSignal | undefined }> = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const signal = init?.signal ?? undefined;
		requests.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body), signal });
		const next = responses.shift();
		if (!next) throw new Error("fakeFetch: no response left");
		return next(signal);
	};
	return { fetch, requests };
}

describe("createTransport", () => {
	it("sends the params unchanged with the key, and the SDK assembles the same message", async () => {
		const msg = apiMessage(
			[
				thinking(),
				text("Checking. "),
				toolUse("srv_1", "web_search", { query: "fluxer" }),
				searchResult("srv_1"),
				text("Fluxer has bots.", [searchCitation]),
			],
			{ usage: { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } } },
		);
		const { fetch, requests } = fakeFetch([sse(sseText(streamEvents(msg)))]);
		const transport = createTransport("sk-ant-test", { fetch, maxRetries: 0 });
		const params = buildParams(loadTestConfig(), USER);

		const stream = transport.stream(params);
		const types: string[] = [];
		for await (const event of stream) types.push(event.type);
		const final = await stream.finalMessage();

		expect(requests).toHaveLength(1);
		const req = requests[0]!;
		expect(req.url).toBe("https://api.anthropic.com/v1/messages");
		expect(req.headers.get("authorization")).toBe("Bearer sk-ant-test");
		expect(req.headers.get("anthropic-beta")).toBeNull();
		expect(req.body).toBe(JSON.stringify(params));
		expect(types).toEqual(streamEvents(msg).map((e) => e.type));
		// The fake event sequence assembles into the same message in the real SDK (which adds parsed_output).
		expect(final).toEqual({ ...msg, parsed_output: null });
	});

	it("refuses an empty API key (the SDK would send it and get 401s)", () => {
		expect(() => createTransport("")).toThrow(/empty/);
	});

	describe("SDK log lines", () => {
		// An event that isn't valid JSON: the SDK logs the raw data, then fails the stream with a
		// SyntaxError whose message quotes part of it.
		const broken = `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${SECRET} answer}}\n\n`;

		async function runBroken(level: "info" | "debug" | null) {
			const lines: string[] = [];
			const log = level ? createLogger({ level, write: (line) => lines.push(line) }) : undefined;
			const { fetch } = fakeFetch([sse(sseText([messageStart(apiMessage([]))]) + broken)]);
			const transport = createTransport("sk-ant-test", { fetch, maxRetries: 0, ...(log ? { log } : {}) });
			const stream = transport.stream(buildParams(loadTestConfig(), USER));
			await expect(stream.finalMessage()).rejects.toThrow();
			return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
		}

		it("go to our log without the raw stream data", async () => {
			const logs = await runBroken("info");
			expect(logs).toContainEqual(
				expect.objectContaining({ level: "error", msg: "anthropic sdk: Could not parse message into JSON:" }),
			);
			expect(JSON.stringify(logs)).not.toContain(SECRET);
		});

		it("keep the raw data at debug level", async () => {
			const logs = await runBroken("debug");
			expect(JSON.stringify(logs)).toContain(SECRET);
		});

		it("go to the console without the raw data when no log is given", async () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				await runBroken(null);
				expect(spy).toHaveBeenCalledWith("anthropic sdk: Could not parse message into JSON:");
				expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
			} finally {
				spy.mockRestore();
			}
		});
	});

	describe("with ClaudeRunner", () => {
		const runnerWith = (responses: FakeResponse[], opts: { maxRetries?: number; deadlineMs?: number } = {}) => {
			const { fetch, requests } = fakeFetch(responses);
			const transport = createTransport("sk-ant-test", { fetch, maxRetries: opts.maxRetries ?? 0, log: quietLog });
			const log = createLogger({ level: "error", write: () => {} });
			const runner = new ClaudeRunner({
				loaded: loadTestConfig(),
				transport,
				log,
				retryDelayMs: 0,
				...(opts.deadlineMs ? { deadlineMs: opts.deadlineMs } : {}),
			});
			return { runner, requests };
		};

		it("answers end to end with progress", async () => {
			const msg = apiMessage([
				text("Looking. "),
				toolUse("srv_1", "web_fetch", { url: "https://e.com" }),
				fetchResult("srv_1", "https://e.com"),
				text("Done."),
			]);
			const { runner } = runnerWith([sse(sseText(streamEvents(msg)))]);
			const r = new Recorder();
			const result = await runner.run(USER, r.hooks);

			expect(result).toEqual({
				stop: "end_turn",
				content: msg.content,
				pieces: [msg.content],
				refusalCategory: null,
				lastUsage: msg.usage,
			});
			expect(r.statuses).toEqual([{ tool: "web_fetch", url: "https://e.com" }, null]);
			expect(r.texts.at(-1)).toBe("Looking. Done.");
			expect(r.calls).toEqual([{ usage: msg.usage, model: "claude-haiku-5-5" }]);
		});

		it("classifies an SSE error event as overloaded and retries it once", async () => {
			const failed = apiMessage([], { usage: { input_tokens: 700 } });
			const errorEvent = `event: error\ndata: ${JSON.stringify(errorBody("overloaded_error", "Overloaded"))}\n\n`;
			const msg = apiMessage([text("ok")]);
			const { runner, requests } = runnerWith([
				sse(sseText([messageStart(failed)]) + errorEvent),
				sse(sseText(streamEvents(msg))),
			]);
			const r = new Recorder();
			const result = await runner.run(USER, r.hooks);

			expect(result.stop).toBe("end_turn");
			expect(requests).toHaveLength(2);
			expect(r.calls[0]?.usage).toMatchObject({ input_tokens: 700 });
		});

		it("treats a dropped connection mid-stream as a network error", async () => {
			const failed = apiMessage([]);
			const msg = apiMessage([text("ok")]);
			const { runner, requests } = runnerWith([
				openStream(sseText([messageStart(failed)]), new TypeError("terminated")),
				sse(sseText(streamEvents(msg))),
			]);
			const r = new Recorder();
			const result = await runner.run(USER, r.hooks);
			expect(result.stop).toBe("end_turn");
			expect(requests).toHaveLength(2);
		});

		it("retries a body that ends after message_start without a message_stop", async () => {
			const failed = apiMessage([], { usage: { input_tokens: 900 } });
			const msg = apiMessage([text("ok")]);
			const { runner, requests } = runnerWith([sse(sseText([messageStart(failed)])), sse(sseText(streamEvents(msg)))]);
			const r = new Recorder();
			const result = await runner.run(USER, r.hooks);
			expect(result.stop).toBe("end_turn");
			expect(requests).toHaveLength(2);
			expect(r.calls[0]?.usage).toMatchObject({ input_tokens: 900 });
		});

		it("retries an empty response body", async () => {
			const msg = apiMessage([text("ok")]);
			const { runner, requests } = runnerWith([sse(""), sse(sseText(streamEvents(msg)))]);
			const r = new Recorder();
			expect((await runner.run(USER, r.hooks)).stop).toBe("end_turn");
			expect(requests).toHaveLength(2);
			expect(r.calls[0]).toEqual({ usage: null, model: "claude-haiku-5-5" });
		});

		it("fails as a network error when the body stops in the middle of the answer", async () => {
			const msg = apiMessage([text("Half an answer")]);
			const { runner, requests } = runnerWith([
				sse(sseText(streamEvents(msg).slice(0, -2))), // no message_delta, no message_stop
				sse(sseText(streamEvents(apiMessage([text("never")])))),
			]);
			const r = new Recorder();
			await expect(runner.run(USER, r.hooks)).rejects.toMatchObject({ kind: "network", status: null });
			expect(requests).toHaveLength(1);
			expect(r.texts.at(-1)).toBe("Half an answer");
			expect(r.calls).toHaveLength(1);
		});

		it("retries an event that isn't JSON, keeping its text out of the logs", async () => {
			const lines: string[] = [];
			const { fetch, requests } = fakeFetch([
				sse(`${sseText([messageStart(apiMessage([]))])}event: message_delta\ndata: {"text":${SECRET} answer}\n\n`),
				sse(sseText(streamEvents(apiMessage([text("ok")])))),
			]);
			const log = createLogger({ level: "info", write: (line) => lines.push(line) });
			const runner = new ClaudeRunner({
				loaded: loadTestConfig(),
				transport: createTransport("sk-ant-test", { fetch, maxRetries: 0, log }),
				log,
				retryDelayMs: 0,
			});
			expect((await runner.run(USER, new Recorder().hooks)).stop).toBe("end_turn");
			expect(requests).toHaveLength(2);
			const logs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
			expect(logs).toContainEqual(
				expect.objectContaining({ kind: "network", error: "the API sent an event that isn't valid JSON" }),
			);
			expect(lines.join("\n")).not.toContain(SECRET);
		});

		it("reports a 402 billing error as spend_limit", async () => {
			const { runner } = runnerWith([jsonError(402, "billing_error", "Check your payment details.")]);
			await expect(runner.run(USER, new Recorder().hooks)).rejects.toMatchObject({ kind: "spend_limit", status: 402 });
		});

		it("doesn't let the SDK retry a thinking mismatch", async () => {
			const { runner, requests } = runnerWith([jsonError(400, "invalid_request_error", MISMATCH)], { maxRetries: 2 });
			const r = new Recorder();
			await expect(runner.run(USER, r.hooks)).rejects.toMatchObject({
				kind: "thinking_mismatch",
				status: 400,
				requestId: "req_http",
			});
			expect(requests).toHaveLength(1);
			expect(r.calls).toEqual([{ usage: null, model: "claude-haiku-5-5" }]);
		});

		it("reports an HTTP 529 as overloaded", async () => {
			const { runner } = runnerWith([jsonError(529, "overloaded_error", "Overloaded")]);
			await expect(runner.run(USER, new Recorder().hooks)).rejects.toMatchObject({ kind: "overloaded", status: 529 });
		});

		it("aborts the HTTP request when the deadline passes", async () => {
			const msg = apiMessage([text("never ends")]);
			const { runner, requests } = runnerWith([openStream(sseText(streamEvents(msg).slice(0, 3)))], {
				deadlineMs: 50,
			});
			const r = new Recorder();
			await expect(runner.run(USER, r.hooks)).rejects.toMatchObject({ kind: "timeout" });
			expect(requests[0]?.signal?.aborted).toBe(true);
			expect(r.texts).toEqual(["never"]);
			expect(r.calls).toHaveLength(1);
		});
	});
});
