// SPDX-License-Identifier: AGPL-3.0-or-later
// Fluxer client: REST through @fluxerjs/rest, the gateway through @fluxerjs/ws, raw payloads checked
// with zod and turned into the shared types. Deliberately not @fluxerjs/core: no caches we didn't
// choose, and raw fields (channel_type, member, absent vs null referenced_message) stay available.

import { randomUUID } from "node:crypto";
import { closeSharedFetch, REST } from "@fluxerjs/rest";
import { GatewayOpcodes, type GatewayPresenceUpdateData, type GatewaySendPayload, Routes } from "@fluxerjs/types";
import { GatewayCloseCodes, shouldReconnectOnClose, WebSocketManager } from "@fluxerjs/ws";
import { type ClientOptions, WebSocket } from "ws";
import { z } from "zod";
import {
	type ChatAttachment,
	type ChatMessage,
	type ChatUser,
	type Clock,
	type ConnectionState,
	type EditOptions,
	type FluxerClient,
	type FluxerEvents,
	FluxerRequestError,
	type GuildInfo,
	type Logger,
	type MemberInfo,
	type MessageRef,
	type SendOptions,
	systemClock,
} from "./types.js";

// ---------------------------------------------------------------- constants

/** Fluxer message types Clanker answers: an ordinary message and a reply. */
export const MESSAGE_TYPE_DEFAULT = 0;
export const MESSAGE_TYPE_REPLY = 19;

const CHANNEL_TYPE_DM = 1;
const CHANNEL_TYPE_GROUP_DM = 3;
const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);
const FLAG_SUPPRESS_EMBEDS = 1 << 2;
const CUSTOM_STATUS_MAX = 128;

/** No READY (or RESUMED) this long after connect() or after a close: give up and let the process restart. */
const READY_TIMEOUT_MS = 90_000;
const RECENT_MESSAGE_IDS = 1000;
const MAX_RATE_LIMIT_RETRIES = 3;
/** A 429 asking us to wait longer than this fails the call instead of holding a reply for minutes. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** Retries of a send after a 5xx, a timeout or a network error, waiting 1 s, then 2 s. */
const MAX_FAILURE_RETRIES = 2;
const FAILURE_RETRY_MS = 1_000;
const REST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_CHANNEL_TYPES = 10_000;
const MAX_DM_CHANNELS = 10_000;
/** Channel -> guild and thread -> parent entries. Archived threads pile up; the oldest are looked up again. */
export const MAX_CACHED_CHANNELS = 50_000;
const DEFAULT_USER_AGENT = "Clanker (+https://github.com/Linus-Sexy-Tips/clanker)";

/**
 * Dispatches Clanker never uses, dropped by the gateway (Identify `ignored_events`). Messages, guilds,
 * members, channels and threads are kept: they feed triggers, the allowlist and the name caches.
 */
export const IGNORED_EVENTS: readonly string[] = [
	"TYPING_START",
	"PRESENCE_UPDATE",
	"PRESENCE_UPDATE_BULK",
	"MESSAGE_REACTION_ADD",
	"MESSAGE_REACTION_ADD_MANY",
	"MESSAGE_REACTION_REMOVE",
	"MESSAGE_REACTION_REMOVE_ALL",
	"MESSAGE_REACTION_REMOVE_EMOJI",
	"MESSAGE_DELETE",
	"MESSAGE_DELETE_BULK",
	"MESSAGE_UPDATE",
	"VOICE_STATE_UPDATE",
	"VOICE_SERVER_UPDATE",
	"CHANNEL_PINS_UPDATE",
	"WEBHOOKS_UPDATE",
	"INVITE_CREATE",
	"INVITE_DELETE",
	"GUILD_EMOJIS_UPDATE",
	"GUILD_STICKERS_UPDATE",
	"GUILD_AUDIT_LOG_ENTRY_CREATE",
	"PASSIVE_UPDATES",
	"CALL_CREATE",
	"CALL_UPDATE",
	"CALL_DELETE",
	"ENTRANCE_SOUND_PLAY",
];

// ---------------------------------------------------------------- seams (real @fluxerjs objects satisfy these)

export interface RestRequest {
	body?: unknown;
	signal?: AbortSignal;
}

/** The part of @fluxerjs/rest's `REST` that Clanker uses. Responses are unchecked JSON. */
export interface RestLike {
	get(route: string, options?: { signal?: AbortSignal }): Promise<unknown>;
	post(route: string, options?: RestRequest): Promise<unknown>;
	patch(route: string, options?: RestRequest): Promise<unknown>;
	put(route: string, options?: RestRequest): Promise<unknown>;
	delete(route: string, options?: RestRequest): Promise<unknown>;
}

/** The shard object; it emits `ping` (round trip in ms) on every heartbeat ACK. */
export interface ShardLike {
	on(event: "ping", listener: (rttMs: unknown) => void): unknown;
}

/** The part of @fluxerjs/ws's `WebSocketManager` that Clanker uses. Event arguments are checked here. */
export interface GatewayLike {
	on(event: "dispatch" | "close" | "error" | "debug", listener: (arg: unknown) => void): unknown;
	connect(): Promise<void>;
	send(shardId: number, payload: GatewaySendPayload): void;
	destroy(): void;
	getShard(shardId: number): ShardLike | undefined;
}

export interface GatewayFactoryOptions {
	/** Raw token, without the `Bot ` prefix. */
	token: string;
	/** Used by the gateway for `GET /gateway/bot` only. */
	rest: { get(route: string): Promise<unknown> };
	ignoredEvents: readonly string[];
	/** Sent with Identify. Re-sent as opcode 3 after every READY anyway. */
	presence: GatewayPresenceUpdateData | null;
}

export type GatewayFactory = (opts: GatewayFactoryOptions) => GatewayLike;

export type PresenceStatus = "online" | "idle" | "dnd" | "invisible";

export interface FluxerClientOptions {
	token: string;
	/** REST base, with or without the trailing `/v1`. */
	apiUrl: string;
	/** Skip `GET /gateway/bot` discovery and use this URL. */
	gatewayUrl?: string;
	log: Logger;
	clock?: Clock;
	presence?: { status: PresenceStatus; customStatus: string | null };
	userAgent?: string;
	/** Test seams. Defaults: @fluxerjs/rest, @fluxerjs/ws with a `ws` socket, global fetch. */
	rest?: RestLike;
	gatewayFactory?: GatewayFactory;
	fetch?: typeof fetch;
}

// ---------------------------------------------------------------- small helpers

/** Strips whitespace and a leading `Bot ` (Identify wants the raw `<app_id>.<secret>`). */
export function normalizeToken(token: string): string {
	return token
		.trim()
		.replace(/^bot(?:\s+|$)/i, "")
		.trim();
}

/** `https://api.fluxer.app/v1/` -> `https://api.fluxer.app`. REST appends `/v1` itself. */
export function normalizeApiUrl(apiUrl: string): string {
	let url: URL;
	try {
		url = new URL(apiUrl.trim());
	} catch {
		throw new Error(`api_url is not a valid URL: ${apiUrl}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`api_url must be http(s): ${apiUrl}`);
	if (url.search || url.hash) throw new Error(`api_url must not have a query or fragment: ${apiUrl}`);
	const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
	return `${url.origin}${path}`;
}

/** Checks gateway_url. No query: the gateway library appends `?v=1&encoding=json` blindly. */
export function normalizeGatewayUrl(gatewayUrl: string): string {
	let url: URL;
	try {
		url = new URL(gatewayUrl.trim());
	} catch {
		throw new Error(`gateway_url is not a valid URL: ${gatewayUrl}`);
	}
	if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error(`gateway_url must be ws(s): ${gatewayUrl}`);
	if (url.search || url.hash || gatewayUrl.includes("?")) {
		throw new Error(`gateway_url must not have a query or fragment: ${gatewayUrl}`);
	}
	return `${url.origin}${url.pathname}`;
}

const PRESENCE_STATUSES: ReadonlySet<string> = new Set(["online", "idle", "dnd", "invisible"]);

/** Opcode 3 payload. Custom status text is trimmed and cut to 128 chars; empty clears it. */
export function presencePayload(status: PresenceStatus, customStatus: string | null): GatewayPresenceUpdateData {
	if (!PRESENCE_STATUSES.has(status)) throw new RangeError(`unknown presence status: ${String(status)}`);
	const text = truncate(customStatus?.trim() ?? "", CUSTOM_STATUS_MAX);
	return { status, afk: false, custom_status: text ? { text } : null };
}

/** Cuts to `max` UTF-16 units without leaving half a surrogate pair. */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const ID_PATTERN = /^\d{1,20}$/;

function assertId(value: string, what: string): void {
	if (!ID_PATTERN.test(value)) throw new FluxerRequestError(`invalid ${what} ID`, null, null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return isRecord(value) && typeof value.then === "function";
}

function describe(err: unknown): string {
	const text = isRecord(err) && typeof err.message === "string" ? err.message : String(err);
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Maps @fluxerjs/rest errors to FluxerRequestError. Matches on `name`, not `instanceof`, because a second
 * copy of the package would break `instanceof`.
 */
function toRequestError(op: string, err: unknown): FluxerRequestError {
	if (err instanceof FluxerRequestError) return err;
	const name = isRecord(err) && typeof err.name === "string" ? err.name : "";
	const status = isRecord(err) && typeof err.statusCode === "number" ? err.statusCode : null;
	if (name === "FluxerAPIError" || name === "RateLimitError") {
		const raw = isRecord(err) ? err.code : undefined;
		const code = typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
		return new FluxerRequestError(`${op} failed (${status ?? "?"} ${code ?? "?"}): ${describe(err)}`, status, code);
	}
	if (name === "HTTPError") return new FluxerRequestError(`${op} failed: ${describe(err)}`, status, null);
	if (name === "AbortError" || name === "TimeoutError") {
		return new FluxerRequestError(`${op} was aborted or timed out`, null, null);
	}
	return new FluxerRequestError(`${op} failed: ${describe(err)}`, null, null);
}

/** Milliseconds to wait for a RateLimitError, or null for any other error. */
function rateLimitWaitMs(err: unknown): number | null {
	if (!isRecord(err) || err.name !== "RateLimitError") return null;
	const s = err.retryAfter;
	const seconds = typeof s === "number" && Number.isFinite(s) && s >= 0 ? s : 1;
	return Math.ceil(seconds * 1000);
}

/**
 * A 5xx, a timeout or a network error: the request may never have reached Fluxer. 4xx answers and 429s
 * are not transient (429s are waited out separately).
 */
function isTransient(err: unknown): boolean {
	if (!(err instanceof Error) || err instanceof FluxerRequestError) return false;
	if (err.name === "FluxerAPIError" || err.name === "HTTPError") {
		const status = (err as Error & { statusCode?: unknown }).statusCode;
		return typeof status === "number" && status >= 500;
	}
	// Our REST timeout surfaces as an AbortError (shutdown is checked before this); the rest is network trouble.
	return err.name !== "RateLimitError";
}

function isUnknownMessage(err: unknown): boolean {
	return err instanceof FluxerRequestError && err.status === 404 && err.code === "UNKNOWN_MESSAGE";
}

function destroyedError(): FluxerRequestError {
	return new FluxerRequestError("the Fluxer client was destroyed", null, null);
}

/** Sets a key at the end of a Map and drops the oldest entries above `max`. */
function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > max) {
		const oldest = map.keys().next();
		if (oldest.done) break;
		map.delete(oldest.value);
	}
}

/** Remembers the last `max` message IDs (the gateway can deliver a dispatch twice; research §7.3). */
class RecentIds {
	private readonly ids = new Set<string>();
	constructor(private readonly max: number) {}

	/** True if the ID is new (and now remembered). */
	add(id: string): boolean {
		if (this.ids.has(id)) return false;
		this.ids.add(id);
		if (this.ids.size > this.max) {
			const oldest = this.ids.values().next();
			if (!oldest.done) this.ids.delete(oldest.value);
		}
		return true;
	}
}

function newNonce(): string {
	return randomUUID().replaceAll("-", ""); // 32 chars, Fluxer's maximum
}

/** Only the replied-to author may be pinged, and only when asked. Must be sent on every edit too. */
function allowedMentions(pingReplied: boolean | undefined): { parse: []; replied_user: boolean } {
	return { parse: [], replied_user: pingReplied === true };
}

/** The media type without parameters, lowercased: `image/PNG; q=1` -> `image/png`. */
function mediaType(header: string | null): string | null {
	const type = header?.split(";")[0]?.trim().toLowerCase();
	return type ? type : null;
}

// ---------------------------------------------------------------- payload schemas

const Id = z.string().regex(ID_PATTERN);

// The lenient helpers put .optional() before .transform() so zod 4 runs the transform for a missing key
// too (otherwise an undefined result fails with "expected nonoptional").

/** Parses each item on its own and drops malformed ones; a missing or non-array value gives []. */
function lenientArray<T extends z.ZodType>(item: T) {
	return z
		.unknown()
		.optional()
		.transform((value): z.output<T>[] => {
			if (!Array.isArray(value)) return [];
			const out: z.output<T>[] = [];
			for (const entry of value) {
				const parsed = item.safeParse(entry);
				if (parsed.success) out.push(parsed.data);
			}
			return out;
		});
}

/** Parses the value, or gives undefined when it is missing or malformed. */
function lenient<T extends z.ZodType>(schema: T) {
	return z
		.unknown()
		.optional()
		.transform((value): z.output<T> | undefined => {
			const parsed = schema.safeParse(value);
			return parsed.success ? parsed.data : undefined;
		});
}

const UserSchema = z.object({
	id: Id,
	username: z.string(),
	global_name: z.string().nullish(),
	bot: z.boolean().nullish(),
	system: z.boolean().nullish(),
});

const MentionSchema = UserSchema.extend({ member: lenient(z.object({ nick: z.string().nullish() })) });

const MemberSchema = z.object({ roles: z.array(Id), nick: z.string().nullish() });

const ReferenceSchema = z.object({
	message_id: Id.nullish(),
	channel_id: Id.nullish(),
	guild_id: Id.nullish(),
	type: z.number().nullish(),
});

const AttachmentSchema = z.object({
	id: Id,
	filename: z.string(),
	url: z.string().nullish(),
	proxy_url: z.string().nullish(),
	content_type: z.string().nullish(),
	size: z.number().nonnegative().nullish(),
	width: z.number().nullish(),
	height: z.number().nullish(),
});

const MessageSchema = z.object({
	id: Id,
	channel_id: Id,
	guild_id: Id.nullish(),
	channel_type: lenient(z.number().int()),
	author: UserSchema,
	member: lenient(MemberSchema),
	webhook_id: Id.nullish(),
	type: z.number().int(),
	content: z.string().nullish(),
	timestamp: z.string(),
	edited_timestamp: z.string().nullish(),
	mentions: lenientArray(MentionSchema),
	users: lenientArray(MentionSchema),
	mention_roles: lenientArray(Id),
	mention_everyone: z.boolean().nullish(),
	message_reference: lenient(ReferenceSchema),
	attachments: lenientArray(AttachmentSchema),
});

const ChannelSchema = z.object({
	id: Id,
	type: z.number().int(),
	guild_id: Id.nullish(),
	name: z.string().nullish(),
	parent_id: Id.nullish(),
});
type Channel = z.output<typeof ChannelSchema>;

const DispatchSchema = z.object({ payload: z.object({ t: z.string(), d: z.unknown() }) });
const ReadySchema = z.object({ user: UserSchema, guilds: lenientArray(z.object({ id: Id })) });
const GuildCreateSchema = z.object({
	id: Id,
	unavailable: z.boolean().nullish(),
	name: z.string().nullish(),
	properties: lenient(z.object({ name: z.string() })),
	channels: lenientArray(ChannelSchema),
	threads: lenientArray(ChannelSchema),
});
const GuildUpdateSchema = z.object({ id: Id.nullish(), guild_id: Id.nullish(), name: z.string() });
const GuildDeleteSchema = z.object({ id: Id, unavailable: z.boolean().nullish() });
const ChannelListSchema = z.object({
	guild_id: Id,
	channels: lenientArray(ChannelSchema),
	threads: lenientArray(ChannelSchema),
});
const ChannelDeleteSchema = z.object({ id: Id });
const MemberUpdateSchema = z.object({
	guild_id: Id,
	user: z.object({ id: Id }),
	roles: z.array(Id),
	nick: z.string().nullish(),
});
const MemberRemoveSchema = z.object({ guild_id: Id, user: z.object({ id: Id }) });
const ApplicationSchema = z.object({
	id: Id,
	bot_public: z.boolean().nullish(),
	owner: lenient(z.object({ id: Id })),
});
const MessageIdSchema = z.object({ id: Id });

function issuesOf(error: z.ZodError): string[] {
	return error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.code}`);
}

// ---------------------------------------------------------------- message normalization

export interface NormalizeOptions {
	/** For payloads without `channel_type` (REST): whether the channel is a 1:1 DM. */
	isDm?: boolean;
	/** For payloads without `channel_type` (REST): whether the channel is a group DM. */
	isGroupDm?: boolean;
	/** For payloads without `guild_id` (REST, nested replies): the channel's guild. */
	guildId?: string | null;
}

type Parsed = { ok: true; msg: ChatMessage; channelType: number | null } | { ok: false; issues: string[] };

/**
 * Maps a raw Fluxer message (MESSAGE_CREATE `d` or a REST message) to a ChatMessage.
 * Returns null when a required field (id, channel_id, author id/username, type, timestamp) is missing or malformed.
 */
export function normalizeMessage(raw: unknown, opts: NormalizeOptions = {}): ChatMessage | null {
	const parsed = parseMessage(raw, opts, false);
	return parsed.ok ? parsed.msg : null;
}

function parseMessage(raw: unknown, ctx: NormalizeOptions, nested: boolean): Parsed {
	const result = MessageSchema.safeParse(raw);
	if (!result.success) return { ok: false, issues: issuesOf(result.error) };
	const d = result.data;
	const channelType = d.channel_type ?? null;
	// Type 1 is a DM and type 3 a group DM; neither belongs to a guild.
	const isDm = !d.guild_id && (channelType !== null ? channelType === CHANNEL_TYPE_DM : ctx.isDm === true);
	const isGroupDm =
		!d.guild_id && (channelType !== null ? channelType === CHANNEL_TYPE_GROUP_DM : ctx.isGroupDm === true);
	const guildId = isDm || isGroupDm ? null : (d.guild_id ?? ctx.guildId ?? null);
	const msg: ChatMessage = {
		id: d.id,
		channelId: d.channel_id,
		guildId,
		isDm,
		isGroupDm,
		author: toUser(d.author),
		memberNick: d.member?.nick ?? null,
		memberRoles: d.member ? [...d.member.roles] : null,
		webhookId: d.webhook_id ?? null,
		type: d.type,
		isUserMessage: (d.type === MESSAGE_TYPE_DEFAULT || d.type === MESSAGE_TYPE_REPLY) && d.author.system !== true,
		content: d.content ?? "",
		timestamp: d.timestamp,
		editedTimestamp: d.edited_timestamp ?? null,
		mentions: mergeMentions(d.mentions, d.users),
		mentionRoleIds: d.mention_roles,
		mentionEveryone: d.mention_everyone === true,
		reference: toReference(d.message_reference, d.channel_id),
		// One hop only: the replied-to message's own referenced_message is ignored.
		referenced: nested ? undefined : referencedOf(raw, { isDm, isGroupDm, guildId }),
		attachments: d.attachments.map(toAttachment),
	};
	return { ok: true, msg, channelType };
}

function toUser(u: z.output<typeof UserSchema>): ChatUser {
	return { id: u.id, username: u.username, globalName: u.global_name ?? null, bot: u.bot === true };
}

/**
 * `mentions` (pinged) and `users` (mentioned but not pinged, including users mentioned in embeds and
 * forwarded messages) together, deduped by ID. Used for display names only, never as a trigger.
 */
function mergeMentions(
	mentions: z.output<typeof MentionSchema>[],
	users: z.output<typeof MentionSchema>[],
): ChatMessage["mentions"] {
	const byId = new Map<string, ChatMessage["mentions"][number]>();
	for (const m of [...mentions, ...users]) {
		if (!byId.has(m.id)) byId.set(m.id, { ...toUser(m), nick: m.member?.nick ?? null });
	}
	return [...byId.values()];
}

/** Replies only: a forward (type 1) is not part of a reply chain. */
function toReference(ref: z.output<typeof ReferenceSchema> | undefined, channelId: string): MessageRef | null {
	if (!ref?.message_id) return null;
	if (ref.type !== null && ref.type !== undefined && ref.type !== 0) return null;
	return { messageId: ref.message_id, channelId: ref.channel_id ?? channelId, guildId: ref.guild_id ?? null };
}

/** undefined = key absent (not a reply, or malformed); null = the target is gone. */
function referencedOf(raw: unknown, ctx: NormalizeOptions): ChatMessage | null | undefined {
	if (!isRecord(raw) || !Object.hasOwn(raw, "referenced_message")) return undefined;
	const value = raw.referenced_message;
	if (value === undefined) return undefined;
	if (value === null) return null;
	// A reply's target is in the same channel, so it shares the DM flag and guild.
	const parsed = parseMessage(value, ctx, true);
	return parsed.ok ? parsed.msg : undefined;
}

/** Expired attachments have no URL; they get "" so they can still be listed by name. */
function toAttachment(a: z.output<typeof AttachmentSchema>): ChatAttachment {
	return {
		id: a.id,
		filename: a.filename,
		url: a.url ?? a.proxy_url ?? "",
		contentType: a.content_type ?? null,
		size: a.size ?? 0,
		width: a.width ?? null,
		height: a.height ?? null,
	};
}

// ---------------------------------------------------------------- the real gateway

// @types/ws 8.18 lacks closeTimeout; ws 8.22.1 supports it (lib/websocket.js).
const SOCKET_OPTIONS: ClientOptions & { closeTimeout: number } = { handshakeTimeout: 15_000, closeTimeout: 10_000 };

/**
 * `ws` with explicit timeouts. With Node's built-in WebSocket a zombie connection can hang for ~15 min
 * because close() has no timer; ws destroys the socket after closeTimeout (research note §7).
 */
class GatewaySocket extends WebSocket {
	constructor(url: string) {
		super(url, SOCKET_OPTIONS);
	}
}

/** One shard (Fluxer always reports one), no `shard` field on Identify, so DMs arrive too. */
export function createGateway(opts: GatewayFactoryOptions): GatewayLike {
	return new WebSocketManager({
		token: opts.token,
		rest: opts.rest,
		version: "1",
		shardCount: 1,
		ignoredEvents: [...opts.ignoredEvents],
		...(opts.presence ? { presence: opts.presence } : {}),
		e2eeCapable: false,
		debug: true,
		WebSocket: GatewaySocket,
	});
}

/**
 * GETs keep the library's retries (429, 5xx, timeouts). Mutations get none there: the library would wait
 * out any `retry_after`, however long, so the client's mutate() handles 429s and send retries itself.
 */
function createRest(token: string, api: string, userAgent: string): RestLike {
	return new REST({ api, version: "1", userAgent, timeout: REST_TIMEOUT_MS, retries: 2 }).setToken(token);
}

// ---------------------------------------------------------------- the client

type Listener = (...args: never[]) => unknown;

interface CreateMessageBody {
	content: string;
	nonce: string;
	allowed_mentions: { parse: []; replied_user: boolean };
	message_reference?: { message_id: string; channel_id: string; guild_id?: string };
	flags?: number;
}

interface EditMessageBody {
	content: string;
	allowed_mentions: { parse: []; replied_user: boolean };
	flags?: number;
}

export function createFluxerClient(opts: FluxerClientOptions): FluxerClient {
	return new Client(opts);
}

class Client implements FluxerClient {
	private readonly log: Logger;
	private readonly clock: Clock;
	private readonly rest: RestLike;
	private readonly ownsRest: boolean;
	private readonly gw: GatewayLike;
	private readonly fetchFn: typeof fetch;
	private readonly shutdown = new AbortController();
	private readonly listeners = new Map<keyof FluxerEvents, Listener[]>();

	private user: ChatUser | null = null;
	private state: ConnectionState = "disconnected";
	private presence: GatewayPresenceUpdateData | null;
	/** setPresence() was called while the session wasn't live. */
	private presencePending = false;
	private pending: { resolve: () => void; reject: (err: Error) => void } | null = null;
	private connectPromise: Promise<void> | null = null;
	private connectStartedAt = 0;
	private watchdog: ReturnType<typeof setTimeout> | null = null;
	private fatal = false;
	private destroyed = false;
	private destroyPromise: Promise<void> | null = null;
	private gatewayStopped = false;
	private pingAttached = false;

	private readonly seen = new RecentIds(RECENT_MESSAGE_IDS);
	private readonly guilds = new Map<string, GuildInfo>();
	/** guild ID -> the bot's own role IDs there. */
	private readonly ownRoles = new Map<string, string[]>();
	/** Channel or thread ID -> guild ID, for cached guilds. Bounded by MAX_CACHED_CHANNELS. */
	private readonly channelGuild = new Map<string, string>();
	/** Thread ID -> parent channel ID. Kept for archived threads too (a parent never changes); bounded. */
	private readonly threadParents = new Map<string, string>();
	/** Channel ID -> channel type, so REST messages (no channel_type) can still tell DMs apart. */
	private readonly channelTypes = new Map<string, number>();
	private readonly dmChannels = new Map<string, Promise<string>>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly threadLookups = new Map<string, Promise<void>>();

	constructor(opts: FluxerClientOptions) {
		const token = normalizeToken(opts.token);
		if (!token) throw new Error("the Fluxer bot token is empty");
		const api = normalizeApiUrl(opts.apiUrl);
		this.log = opts.log;
		this.clock = opts.clock ?? systemClock;
		this.ownsRest = opts.rest === undefined;
		this.rest = opts.rest ?? createRest(token, api, opts.userAgent ?? DEFAULT_USER_AGENT);
		this.fetchFn = opts.fetch ?? globalThis.fetch;
		this.presence = opts.presence ? presencePayload(opts.presence.status, opts.presence.customStatus) : null;

		const gatewayUrl = opts.gatewayUrl?.trim() ? normalizeGatewayUrl(opts.gatewayUrl) : undefined;
		const gatewayRest = {
			get: async (route: string): Promise<unknown> => {
				if (gatewayUrl && route === Routes.gatewayBot()) return { url: gatewayUrl, shards: 1 };
				try {
					return await this.rest.get(route, { signal: this.shutdown.signal });
				} catch (err) {
					// The manager retries every error not marked otherwise, sleeping up to 45 s between tries.
					if (this.destroyed || this.fatal) throw Object.assign(destroyedError(), { isRetryable: false });
					throw err;
				}
			},
		};
		this.gw = (opts.gatewayFactory ?? createGateway)({
			token,
			rest: gatewayRest,
			ignoredEvents: IGNORED_EVENTS,
			presence: this.presence,
		});
		this.gw.on("dispatch", (ev) => this.onDispatch(ev));
		this.gw.on("close", (ev) => this.onClose(ev));
		this.gw.on("error", (ev) => this.onGatewayError(ev));
		this.gw.on("debug", (detail) => this.log.debug("gateway debug", { detail: String(detail) }));
	}

	get botUser(): ChatUser | null {
		return this.user;
	}

	botRoles(guildId: string): readonly string[] {
		return this.ownRoles.get(guildId) ?? [];
	}

	/** Looks up the bot's own roles in a guild, so a mention of its role counts as a mention of the bot. */
	private async loadOwnRoles(guildId: string): Promise<void> {
		const me = this.user;
		if (!me) return;
		try {
			const member = await this.fetchMember(guildId, me.id);
			if (member) this.ownRoles.set(guildId, [...member.roles]);
		} catch (err) {
			this.log.warn("couldn't look up the bot's roles", { guild: guildId, err });
		}
	}

	get connectionState(): ConnectionState {
		return this.state;
	}

	// ------------------------------------------------------------ events

	on<E extends keyof FluxerEvents>(event: E, handler: FluxerEvents[E]): void {
		const list = this.listeners.get(event) ?? [];
		list.push(handler as Listener);
		this.listeners.set(event, list);
	}

	/** Calls every listener; a throwing or rejecting listener is logged and never reaches the gateway. */
	private emit<E extends keyof FluxerEvents>(event: E, ...args: Parameters<FluxerEvents[E]>): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) {
			try {
				const result: unknown = (listener as (...a: Parameters<FluxerEvents[E]>) => unknown)(...args);
				if (isThenable(result)) result.then(undefined, (err: unknown) => this.listenerFailed(event, err));
			} catch (err) {
				this.listenerFailed(event, err);
			}
		}
	}

	private listenerFailed(event: string, err: unknown): void {
		this.log.error("Fluxer event listener failed", { event, err: err instanceof Error ? err : String(err) });
	}

	private setState(state: ConnectionState): void {
		if (state === this.state) return;
		this.state = state;
		this.emit("connection", state);
	}

	// ------------------------------------------------------------ lifecycle

	connect(): Promise<void> {
		if (this.destroyed) return Promise.reject(destroyedError());
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = new Promise<void>((resolve, reject) => {
			this.pending = { resolve, reject };
		});
		// The caller awaits it; this only keeps a rejection nobody waits for from becoming "unhandled".
		this.connectPromise.catch(() => {});
		this.connectStartedAt = this.clock.now();
		this.setState("connecting");
		this.armWatchdog();
		void this.start();
		return this.connectPromise;
	}

	private async start(): Promise<void> {
		try {
			await this.checkToken();
		} catch (err) {
			this.fail(describe(err), err);
			return;
		}
		if (this.destroyed || this.fatal) return;
		try {
			await this.gw.connect();
		} catch (err) {
			this.fail(`could not connect to the Fluxer gateway: ${describe(err)}`, err);
			return;
		}
		this.attachPing();
	}

	/**
	 * GET /gateway/bot answers 200 even for a revoked token, so check the token here first. Only a 401 is
	 * fatal: an outage or a network blip says nothing about the token, and the gateway (with the READY
	 * watchdog) copes with those.
	 */
	private async checkToken(): Promise<void> {
		let raw: unknown;
		try {
			raw = await this.rest.get(Routes.applicationsMe(), { signal: this.shutdown.signal });
		} catch (err) {
			const e = toRequestError("token check", err);
			if (e.status === 401) {
				throw new FluxerRequestError(
					"Fluxer rejected the bot token (401 on GET /applications/@me); check FLUXER_BOT_TOKEN",
					401,
					e.code,
				);
			}
			if (!this.destroyed) this.log.warn("couldn't check the bot token; connecting anyway", { err: e });
			return;
		}
		const app = ApplicationSchema.safeParse(raw);
		if (!app.success) {
			this.log.warn("unexpected GET /applications/@me response", { issues: issuesOf(app.error) });
			return;
		}
		if (app.data.bot_public === true) {
			this.log.warn(
				"the bot is public: anyone can add it to a community. Turn off Public Bot in the application settings.",
			);
		}
		this.log.info("Fluxer application", { appId: app.data.id, ownerId: app.data.owner?.id ?? null });
	}

	private attachPing(): void {
		if (this.pingAttached || this.destroyed || this.fatal) return;
		const shard = this.gw.getShard(0);
		if (!shard) {
			this.log.warn("gateway shard 0 not found; heartbeat events are off");
			return;
		}
		this.pingAttached = true;
		// The same shard object survives reconnects, so one listener is enough.
		shard.on("ping", () => {
			if (this.state === "connected" && !this.destroyed) this.emit("heartbeat");
		});
	}

	/** Starts the READY deadline unless one is already running (repeated closes don't extend it). */
	private armWatchdog(): void {
		if (this.watchdog || this.fatal || this.destroyed) return;
		this.watchdog = setTimeout(() => {
			this.watchdog = null;
			this.fail(`no READY from the Fluxer gateway within ${READY_TIMEOUT_MS / 1000} s`);
		}, READY_TIMEOUT_MS);
	}

	private clearWatchdog(): void {
		if (this.watchdog) clearTimeout(this.watchdog);
		this.watchdog = null;
	}

	/**
	 * Unrecoverable: stop the gateway (no new messages, no heartbeats while the app drains and exits),
	 * emit 'fatal' once and reject a pending connect(). REST keeps working for replies in flight.
	 */
	private fail(reason: string, cause?: unknown): void {
		if (this.fatal || this.destroyed) return;
		this.fatal = true;
		this.clearWatchdog();
		this.stopGateway();
		this.setState("disconnected");
		this.log.error("Fluxer connection failed for good", { reason });
		const pending = this.pending;
		this.pending = null;
		pending?.reject(cause instanceof Error ? cause : new Error(reason));
		this.emit("fatal", reason);
	}

	private stopGateway(): void {
		if (this.gatewayStopped) return;
		this.gatewayStopped = true;
		try {
			this.gw.destroy();
		} catch (err) {
			this.log.warn("gateway destroy failed", { err: toRequestError("gateway destroy", err) });
		}
	}

	destroy(): Promise<void> {
		this.destroyPromise ??= this.teardown();
		return this.destroyPromise;
	}

	private async teardown(): Promise<void> {
		this.destroyed = true;
		this.clearWatchdog();
		this.shutdown.abort();
		const pending = this.pending;
		this.pending = null;
		pending?.reject(destroyedError());
		this.stopGateway();
		this.setState("disconnected");
		if (this.ownsRest) {
			try {
				await closeSharedFetch();
			} catch (err) {
				this.log.warn("closing the HTTP agent failed", { err: toRequestError("close", err) });
			}
		}
	}

	async setPresence(status: PresenceStatus, customStatus: string | null): Promise<void> {
		this.presence = presencePayload(status, customStatus);
		if (this.state === "connected") this.sendPresence();
		else this.presencePending = true;
	}

	/** Opcode 3. Never before READY/RESUMED: any command before READY closes the socket with 4003. */
	private sendPresence(): void {
		if (!this.presence || this.state !== "connected" || this.destroyed) return;
		this.presencePending = false;
		try {
			this.gw.send(0, { op: GatewayOpcodes.PresenceUpdate, d: this.presence });
		} catch (err) {
			this.log.warn("sending presence failed", { err: toRequestError("presence", err) });
		}
	}

	// ------------------------------------------------------------ gateway events

	private onClose(ev: unknown): void {
		if (this.destroyed || this.fatal) return;
		const code = isRecord(ev) && typeof ev.code === "number" ? ev.code : 1006;
		this.log.info("Fluxer gateway closed", { code });
		this.setState("disconnected");
		if (code === GatewayCloseCodes.AuthenticationFailed) {
			this.fail("Fluxer rejected the bot token (gateway close 4004)");
			return;
		}
		if (!shouldReconnectOnClose(code)) {
			this.fail(`the Fluxer gateway closed with code ${code}, which is not retried`);
			return;
		}
		this.armWatchdog();
	}

	private onGatewayError(ev: unknown): void {
		if (this.destroyed) return;
		const error = isRecord(ev) && "error" in ev ? ev.error : ev;
		if (error instanceof SyntaxError) {
			// JSON.parse quotes the start of the frame, which can be message text: details at debug only.
			this.log.warn("Fluxer gateway sent a frame that isn't valid JSON");
			this.log.debug("gateway frame parse error", { detail: error.message });
			return;
		}
		this.log.warn("Fluxer gateway error", { err: error instanceof Error ? error : String(error) });
	}

	private onDispatch(ev: unknown): void {
		if (this.destroyed || this.fatal) return;
		const parsed = DispatchSchema.safeParse(ev);
		if (!parsed.success) {
			this.log.debug("ignoring malformed gateway dispatch", { issues: issuesOf(parsed.error) });
			return;
		}
		const { t, d } = parsed.data.payload;
		try {
			this.route(t, d);
		} catch (err) {
			this.log.error("gateway event handler failed", { event: t, err: err instanceof Error ? err : String(err) });
		}
	}

	private route(t: string, d: unknown): void {
		switch (t) {
			case "READY":
				this.onReady(d);
				break;
			case "RESUMED":
				this.onResumed();
				break;
			case "GUILD_CREATE":
				this.onGuildCreate(d);
				break;
			case "GUILD_UPDATE":
				this.onGuildUpdate(d);
				break;
			case "GUILD_DELETE":
				this.onGuildDelete(d);
				break;
			case "CHANNEL_CREATE":
			case "CHANNEL_UPDATE":
			case "THREAD_CREATE":
			case "THREAD_UPDATE":
				this.onChannelUpsert(t, d);
				break;
			case "CHANNEL_UPDATE_BULK":
			case "THREAD_LIST_SYNC":
				this.onChannelList(t, d);
				break;
			case "CHANNEL_DELETE":
			case "THREAD_DELETE":
				this.onChannelDelete(t, d);
				break;
			case "MESSAGE_CREATE":
				void this.onMessageCreate(d);
				break;
			case "GUILD_MEMBER_UPDATE":
				this.onMemberUpdate(d);
				break;
			case "GUILD_MEMBER_REMOVE":
				this.onMemberRemove(d);
				break;
			default:
				break;
		}
	}

	private malformed(event: string, error: z.ZodError): void {
		this.log.debug("ignoring malformed gateway event", { event, issues: issuesOf(error) });
	}

	private onReady(d: unknown): void {
		const r = ReadySchema.safeParse(d);
		if (!r.success) {
			// Not counted as READY: the watchdog restarts the process if no usable one follows.
			this.log.warn("READY without a usable user object", { issues: issuesOf(r.error) });
			return;
		}
		this.user = toUser(r.data.user);
		const guildIds = r.data.guilds.map((g) => g.id);
		this.clearWatchdog();
		this.setState("connected");
		this.sendPresence();
		const pending = this.pending;
		this.pending = null;
		this.log.info("Fluxer gateway ready", {
			botId: this.user.id,
			guilds: guildIds.length,
			...(pending ? { ms: this.clock.now() - this.connectStartedAt } : {}),
		});
		// A new session lists every guild (as stubs); forget those the bot was removed from while away.
		if (isRecord(d) && Array.isArray(d.guilds)) {
			const listed = new Set(guildIds);
			for (const id of [...this.guilds.keys()]) {
				if (listed.has(id)) continue;
				this.dropGuild(id);
				this.log.info("guild removed while disconnected", { guild: id });
				this.emit("guildDelete", id);
			}
		}
		this.emit("ready", { user: { ...this.user }, guildIds });
		pending?.resolve();
	}

	private onResumed(): void {
		// Only a session that had a READY can resume; anything else is a confused payload.
		if (!this.user) {
			this.log.warn("RESUMED before any READY; ignored");
			return;
		}
		this.clearWatchdog();
		this.setState("connected");
		if (this.presencePending) this.sendPresence();
		this.log.info("Fluxer gateway resumed");
	}

	private onGuildCreate(d: unknown): void {
		const r = GuildCreateSchema.safeParse(d);
		if (!r.success) {
			this.malformed("GUILD_CREATE", r.error);
			return;
		}
		const g = r.data;
		if (g.unavailable === true) {
			this.log.debug("GUILD_CREATE for an unavailable guild", { guild: g.id });
			return;
		}
		// Replaces the channel list; thread parents are kept (see threadParents).
		const guild: GuildInfo = { id: g.id, name: g.properties?.name ?? g.name ?? "", channels: new Map() };
		this.guilds.set(g.id, guild);
		for (const ch of [...g.channels, ...g.threads]) this.rememberChannel(ch, g.id);
		this.log.info("guild available", { guild: g.id, channels: guild.channels.size });
		this.emit("guildCreate", copyGuild(guild));
		void this.loadOwnRoles(g.id);
	}

	private onGuildUpdate(d: unknown): void {
		const r = GuildUpdateSchema.safeParse(d);
		if (!r.success) {
			this.malformed("GUILD_UPDATE", r.error);
			return;
		}
		const id = r.data.guild_id ?? r.data.id;
		const guild = id ? this.guilds.get(id) : undefined;
		if (guild) guild.name = r.data.name;
	}

	private onGuildDelete(d: unknown): void {
		const r = GuildDeleteSchema.safeParse(d);
		if (!r.success) {
			this.malformed("GUILD_DELETE", r.error);
			return;
		}
		const { id, unavailable } = r.data;
		if (unavailable === true) {
			// An outage, not a removal: keep everything until GUILD_CREATE comes back.
			this.log.info("guild unavailable", { guild: id });
			return;
		}
		this.dropGuild(id);
		this.log.info("guild removed", { guild: id });
		this.emit("guildDelete", id);
	}

	/** Forgets a guild and what is cached about its channels and threads. */
	private dropGuild(id: string): void {
		this.guilds.delete(id);
		this.ownRoles.delete(id);
		for (const [channelId, guildId] of this.channelGuild) {
			if (guildId !== id) continue;
			this.channelGuild.delete(channelId);
			this.threadParents.delete(channelId);
			this.channelTypes.delete(channelId);
		}
	}

	private onChannelUpsert(t: string, d: unknown): void {
		const r = ChannelSchema.safeParse(d);
		if (!r.success) {
			this.malformed(t, r.error);
			return;
		}
		this.rememberChannel(r.data);
		if (t === "CHANNEL_CREATE" && r.data.type === CHANNEL_TYPE_GROUP_DM) {
			this.emit("groupDmCreate", { channelId: r.data.id, name: r.data.name ?? null });
		}
	}

	private onChannelList(t: string, d: unknown): void {
		const r = ChannelListSchema.safeParse(d);
		if (!r.success) {
			this.malformed(t, r.error);
			return;
		}
		for (const ch of [...r.data.channels, ...r.data.threads]) this.rememberChannel(ch, r.data.guild_id);
	}

	private onChannelDelete(t: string, d: unknown): void {
		const r = ChannelDeleteSchema.safeParse(d);
		if (!r.success) {
			this.malformed(t, r.error);
			return;
		}
		this.forgetChannel(r.data.id);
	}

	private rememberChannel(ch: Channel, fallbackGuildId?: string): void {
		setBounded(this.channelTypes, ch.id, ch.type, MAX_CHANNEL_TYPES);
		const guildId = ch.guild_id ?? fallbackGuildId;
		const guild = guildId ? this.guilds.get(guildId) : undefined;
		if (!guild) return;
		setBounded(this.channelGuild, ch.id, guild.id, MAX_CACHED_CHANNELS);
		if (ch.name) guild.channels.set(ch.id, ch.name);
		// For other channels parent_id is the category, which isn't a "parent channel".
		if (THREAD_CHANNEL_TYPES.has(ch.type) && ch.parent_id) {
			setBounded(this.threadParents, ch.id, ch.parent_id, MAX_CACHED_CHANNELS);
		}
	}

	/** Fluxer sends no THREAD_DELETE for the threads of a deleted channel, so drop those too. */
	private forgetChannel(id: string): void {
		const guildId = this.channelGuild.get(id);
		if (guildId) this.guilds.get(guildId)?.channels.delete(id);
		this.channelGuild.delete(id);
		this.threadParents.delete(id);
		this.channelTypes.delete(id);
		for (const [thread, parent] of this.threadParents) {
			if (parent === id) this.forgetChannel(thread);
		}
	}

	private async onMessageCreate(d: unknown): Promise<void> {
		try {
			const parsed = parseMessage(d, {}, false);
			if (!parsed.ok) {
				this.log.debug("ignoring malformed MESSAGE_CREATE", { issues: parsed.issues });
				return;
			}
			const { msg, channelType } = parsed;
			if (!this.seen.add(msg.id)) {
				this.log.debug("duplicate MESSAGE_CREATE ignored", { message: msg.id });
				return;
			}
			if (channelType !== null) setBounded(this.channelTypes, msg.channelId, channelType, MAX_CHANNEL_TYPES);
			const knownGuild = msg.guildId !== null && this.guilds.has(msg.guildId);
			if (msg.guildId && knownGuild) setBounded(this.channelGuild, msg.channelId, msg.guildId, MAX_CACHED_CHANNELS);
			// A thread we haven't seen (archived before we connected, or evicted): find its parent before
			// anyone checks a channel allowlist against it. Only for cached guilds, which can keep the answer.
			const isThread = channelType !== null && THREAD_CHANNEL_TYPES.has(channelType);
			if (msg.guildId && knownGuild && isThread && !this.threadParents.has(msg.channelId)) {
				await this.lookupThread(msg.channelId, msg.guildId);
			}
			if (this.destroyed || this.fatal) return;
			this.emit("messageCreate", msg);
		} catch (err) {
			this.log.error("MESSAGE_CREATE handling failed", { err: err instanceof Error ? err : String(err) });
		}
	}

	private lookupThread(threadId: string, guildId: string): Promise<void> {
		const running = this.threadLookups.get(threadId);
		if (running) return running;
		const run = this.fetchThread(threadId, guildId).finally(() => this.threadLookups.delete(threadId));
		this.threadLookups.set(threadId, run);
		return run;
	}

	/** Never rejects: on failure the parent stays unknown and allowlisted-channel checks fail closed. */
	private async fetchThread(threadId: string, guildId: string): Promise<void> {
		try {
			const raw = await this.rest.get(Routes.channel(threadId), { signal: this.shutdown.signal });
			const r = ChannelSchema.safeParse(raw);
			if (r.success) this.rememberChannel(r.data, guildId);
			else this.log.warn("unexpected channel payload for a thread", { channel: threadId, issues: issuesOf(r.error) });
		} catch (err) {
			if (this.destroyed) return;
			this.log.warn("thread lookup failed", { channel: threadId, err: toRequestError("thread lookup", err) });
		}
	}

	private onMemberUpdate(d: unknown): void {
		const r = MemberUpdateSchema.safeParse(d);
		if (!r.success) {
			this.malformed("GUILD_MEMBER_UPDATE", r.error);
			return;
		}
		const m = r.data;
		if (m.user.id === this.user?.id) this.ownRoles.set(m.guild_id, [...m.roles]);
		this.emit("memberUpdate", { guildId: m.guild_id, userId: m.user.id, roles: [...m.roles], nick: m.nick ?? null });
	}

	private onMemberRemove(d: unknown): void {
		const r = MemberRemoveSchema.safeParse(d);
		if (!r.success) {
			this.malformed("GUILD_MEMBER_REMOVE", r.error);
			return;
		}
		this.emit("memberRemove", { guildId: r.data.guild_id, userId: r.data.user.id });
	}

	// ------------------------------------------------------------ caches

	guild(guildId: string): GuildInfo | undefined {
		const guild = this.guilds.get(guildId);
		return guild ? copyGuild(guild) : undefined;
	}

	channelName(channelId: string): string | undefined {
		const guildId = this.channelGuild.get(channelId);
		return guildId ? this.guilds.get(guildId)?.channels.get(channelId) : undefined;
	}

	parentChannel(channelId: string): string | undefined {
		return this.threadParents.get(channelId);
	}

	// ------------------------------------------------------------ REST

	/** Runs tasks for one key one after another, so a burst of sends/edits doesn't hit a bucket at once. */
	private serial<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(key) ?? Promise.resolve();
		const run = previous.then(task);
		const tail = run.then(
			() => {},
			() => {},
		);
		this.queues.set(key, tail);
		void tail.then(() => {
			if (this.queues.get(key) === tail) this.queues.delete(key);
		});
		return run;
	}

	/** Maps a failed call; after destroy() every failure (mostly our own abort) reads as "destroyed". */
	private requestError(op: string, err: unknown): FluxerRequestError {
		return this.destroyed ? destroyedError() : toRequestError(op, err);
	}

	/**
	 * A mutation. A 429 is waited out and retried (up to 3 times, each wait at most 60 s). With
	 * `retryFailures` (sends only: the nonce makes a repeat harmless), a 5xx, a timeout or a network error
	 * is retried too, up to 2 times. Everything else becomes a FluxerRequestError.
	 */
	private async mutate<T>(op: string, call: () => Promise<T>, retryFailures = false): Promise<T> {
		let limited = 0;
		let failed = 0;
		for (;;) {
			if (this.destroyed) throw destroyedError();
			try {
				return await call();
			} catch (err) {
				const error = this.requestError(op, err);
				if (this.destroyed) throw error;
				const limitMs = rateLimitWaitMs(err);
				let waitMs: number | null = null;
				if (limitMs !== null) {
					limited++;
					if (limited <= MAX_RATE_LIMIT_RETRIES && limitMs <= MAX_RATE_LIMIT_WAIT_MS) waitMs = limitMs;
				} else if (retryFailures && isTransient(err)) {
					failed++;
					if (failed <= MAX_FAILURE_RETRIES) waitMs = FAILURE_RETRY_MS * failed;
				}
				if (waitMs === null) throw error;
				const msg = limitMs !== null ? "Fluxer rate limit; retrying" : "Fluxer request failed; retrying";
				this.log.warn(msg, { op, waitMs, err: error });
				await this.sleep(waitMs);
			}
		}
	}

	private sleep(ms: number): Promise<void> {
		const signal = this.shutdown.signal;
		return new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(destroyedError());
				return;
			}
			const onAbort = (): void => {
				clearTimeout(timer);
				reject(destroyedError());
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	async sendMessage(channelId: string, opts: SendOptions): Promise<{ id: string }> {
		assertId(channelId, "channel");
		if (opts.replyTo !== undefined) assertId(opts.replyTo, "message");
		return this.serial(channelId, async () => {
			const body = this.createBody(channelId, opts, true);
			try {
				return await this.postMessage(channelId, body);
			} catch (err) {
				if (!body.message_reference || !isUnknownMessage(err)) throw err;
				// The trigger was deleted while we worked: post the answer without the reply link.
				this.log.info("reply target is gone; posting without a reference", { channel: channelId });
				return await this.postMessage(channelId, this.createBody(channelId, opts, false));
			}
		});
	}

	private createBody(channelId: string, opts: SendOptions, withReference: boolean): CreateMessageBody {
		const body: CreateMessageBody = {
			content: opts.content,
			nonce: newNonce(),
			allowed_mentions: allowedMentions(opts.pingReplied),
		};
		if (withReference && opts.replyTo) {
			const guildId = this.channelGuild.get(channelId);
			body.message_reference = {
				message_id: opts.replyTo,
				channel_id: channelId,
				...(guildId ? { guild_id: guildId } : {}),
			};
		}
		if (opts.suppressEmbeds) body.flags = FLAG_SUPPRESS_EMBEDS;
		return body;
	}

	private async postMessage(channelId: string, body: CreateMessageBody): Promise<{ id: string }> {
		// Every retry reuses this body and its nonce, so Fluxer returns the stored message instead of a duplicate.
		const raw = await this.mutate(
			"sendMessage",
			() => this.rest.post(Routes.channelMessages(channelId), { body, signal: this.shutdown.signal }),
			true,
		);
		const r = MessageIdSchema.safeParse(raw);
		if (!r.success) throw new FluxerRequestError("sendMessage: the response has no message ID", null, null);
		return { id: r.data.id };
	}

	async editMessage(channelId: string, messageId: string, opts: EditOptions): Promise<void> {
		assertId(channelId, "channel");
		assertId(messageId, "message");
		const body: EditMessageBody = { content: opts.content, allowed_mentions: allowedMentions(opts.pingReplied) };
		if (opts.suppressEmbeds) body.flags = FLAG_SUPPRESS_EMBEDS;
		await this.serial(channelId, () =>
			this.mutate("editMessage", () =>
				this.rest.patch(Routes.channelMessage(channelId, messageId), { body, signal: this.shutdown.signal }),
			),
		);
	}

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		assertId(channelId, "channel");
		assertId(messageId, "message");
		await this.mutate("deleteMessage", () =>
			this.rest.delete(Routes.channelMessage(channelId, messageId), { signal: this.shutdown.signal }),
		);
	}

	async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
		assertId(channelId, "channel");
		assertId(messageId, "message");
		if (!emoji) throw new FluxerRequestError("addReaction: empty emoji", null, null);
		// Routes.channelMessageReactionMe percent-encodes the emoji.
		await this.mutate("addReaction", () =>
			this.rest.put(Routes.channelMessageReactionMe(channelId, messageId, emoji), { signal: this.shutdown.signal }),
		);
	}

	/** Not retried on 429: a late typing indicator is worthless. */
	async triggerTyping(channelId: string): Promise<void> {
		assertId(channelId, "channel");
		try {
			await this.rest.post(Routes.channelTyping(channelId), { signal: this.shutdown.signal });
		} catch (err) {
			throw this.requestError("triggerTyping", err);
		}
	}

	async fetchMessage(channelId: string, messageId: string): Promise<ChatMessage | null> {
		assertId(channelId, "channel");
		assertId(messageId, "message");
		let raw: unknown;
		try {
			raw = await this.rest.get(Routes.channelMessage(channelId, messageId), { signal: this.shutdown.signal });
		} catch (err) {
			const e = this.requestError("fetchMessage", err);
			if (e.status === 404 || e.status === 403) return null;
			throw e;
		}
		// REST messages have no channel_type, guild_id or member: fill in what we know about the channel.
		const type = this.channelTypes.get(channelId);
		const isDm = type === CHANNEL_TYPE_DM;
		const isGroupDm = type === CHANNEL_TYPE_GROUP_DM;
		const guildId = isDm || isGroupDm ? null : (this.channelGuild.get(channelId) ?? null);
		const parsed = parseMessage(raw, { isDm, isGroupDm, guildId }, false);
		if (!parsed.ok) {
			this.log.warn("unreadable message from Fluxer", {
				channel: channelId,
				message: messageId,
				issues: parsed.issues,
			});
			return null;
		}
		return parsed.msg;
	}

	async fetchMember(guildId: string, userId: string): Promise<MemberInfo | null> {
		assertId(guildId, "guild");
		assertId(userId, "user");
		let raw: unknown;
		try {
			raw = await this.rest.get(Routes.guildMember(guildId, userId), { signal: this.shutdown.signal });
		} catch (err) {
			const e = this.requestError("fetchMember", err);
			if (e.status === 404) return null;
			throw e;
		}
		const r = MemberSchema.safeParse(raw);
		if (!r.success) throw new FluxerRequestError("fetchMember: unexpected response", null, null);
		return { roles: [...r.data.roles], nick: r.data.nick ?? null };
	}

	async leaveGuild(guildId: string): Promise<void> {
		assertId(guildId, "guild");
		await this.mutate("leaveGuild", () =>
			this.rest.delete(Routes.leaveGuild(guildId), { signal: this.shutdown.signal }),
		);
	}

	async leaveGroupDm(channelId: string): Promise<void> {
		assertId(channelId, "channel");
		await this.mutate("leaveGroupDm", () =>
			this.rest.delete(Routes.channel(channelId), { signal: this.shutdown.signal }),
		);
	}

	openDm(userId: string): Promise<string> {
		try {
			assertId(userId, "user");
		} catch (err) {
			return Promise.reject(err);
		}
		const cached = this.dmChannels.get(userId);
		if (cached) return cached;
		const opening = this.createDm(userId);
		setBounded(this.dmChannels, userId, opening, MAX_DM_CHANNELS);
		// A failure isn't cached, so the next call tries again.
		opening.catch(() => {
			if (this.dmChannels.get(userId) === opening) this.dmChannels.delete(userId);
		});
		return opening;
	}

	private async createDm(userId: string): Promise<string> {
		const raw = await this.mutate("openDm", () =>
			this.rest.post(Routes.userMeChannels(), { body: { recipient_id: userId }, signal: this.shutdown.signal }),
		);
		const r = ChannelSchema.safeParse(raw);
		if (!r.success) throw new FluxerRequestError("openDm: the response has no channel", null, null);
		setBounded(this.channelTypes, r.data.id, r.data.type, MAX_CHANNEL_TYPES);
		return r.data.id;
	}

	/** Plain fetch without the bot token (attachments live on the media host). */
	async download(url: string, maxBytes: number): Promise<{ data: Buffer; contentType: string | null }> {
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			throw new FluxerRequestError("download: invalid URL", null, "INVALID_URL");
		}
		if (target.protocol !== "https:" && target.protocol !== "http:") {
			throw new FluxerRequestError("download: only http(s) URLs are allowed", null, "INVALID_URL");
		}
		if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError("download: maxBytes must be >= 0");

		const signal = AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), this.shutdown.signal]);
		let res: Response;
		try {
			res = await this.fetchFn(target, { signal, redirect: "follow" });
		} catch (err) {
			throw this.requestError("download", err);
		}
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			throw new FluxerRequestError(`download failed: HTTP ${res.status}`, res.status, null);
		}
		const declared = res.headers.get("content-length");
		if (declared !== null && Number(declared) > maxBytes) {
			await res.body?.cancel().catch(() => {});
			throw tooLarge(maxBytes);
		}
		const data = await readLimited(res.body, maxBytes);
		return { data, contentType: mediaType(res.headers.get("content-type")) };
	}
}

function tooLarge(maxBytes: number): FluxerRequestError {
	return new FluxerRequestError(`download: file is larger than ${maxBytes} bytes`, null, "TOO_LARGE");
}

/** Reads a body, giving up as soon as it passes `maxBytes` (Content-Length can be absent or wrong). */
async function readLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
	if (!body) return Buffer.alloc(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw tooLarge(maxBytes);
			}
			chunks.push(value);
		}
	} catch (err) {
		throw toRequestError("download", err);
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
}

function copyGuild(guild: GuildInfo): GuildInfo {
	return { id: guild.id, name: guild.name, channels: new Map(guild.channels) };
}
