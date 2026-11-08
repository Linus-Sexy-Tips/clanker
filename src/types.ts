// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared types and interfaces. Modules depend on these, not on each other's internals.

import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------- basics

/** Milliseconds since the Unix epoch. */
export interface Clock {
	now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Integer micro-dollars (1 USD = 1_000_000). */
export type Micros = number;

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
	debug(msg: string, fields?: LogFields): void;
	info(msg: string, fields?: LogFields): void;
	warn(msg: string, fields?: LogFields): void;
	error(msg: string, fields?: LogFields): void;
	child(fields: LogFields): Logger;
	readonly level: LogLevel;
}

// ---------------------------------------------------------------- Fluxer side

export interface ChatUser {
	id: string;
	username: string;
	/** Display name set by the user, if any. */
	globalName: string | null;
	bot: boolean;
}

export interface ChatAttachment {
	id: string;
	filename: string;
	url: string;
	contentType: string | null;
	/** Bytes. */
	size: number;
	width: number | null;
	height: number | null;
}

export interface MessageRef {
	messageId: string;
	channelId: string;
	guildId: string | null;
}

/** A Fluxer message, normalized from the gateway or REST payload. */
export interface ChatMessage {
	id: string;
	channelId: string;
	/** null for DMs. */
	guildId: string | null;
	/** True when the channel is a 1:1 DM (false for guild channels and group DMs). */
	isDm: boolean;
	/** True when the channel is a group DM. */
	isGroupDm: boolean;
	/** True when the channel is a thread (its ID is the thread's; the parent comes from FluxerApi.parentChannel). */
	isThread: boolean;
	author: ChatUser;
	/** Author's nickname in the guild, when known (gateway events only; not used for labels). */
	memberNick: string | null;
	/** Author's role IDs in the guild; null when not provided (DMs, or REST payloads without member). */
	memberRoles: string[] | null;
	webhookId: string | null;
	/** Fluxer message type number (0 = default, see fluxer.ts for the reply type). */
	type: number;
	/** True for ordinary user messages (default or reply type); false for system messages. */
	isUserMessage: boolean;
	content: string;
	/** ISO 8601 timestamp of creation. */
	timestamp: string;
	editedTimestamp: string | null;
	/**
	 * Users mentioned in the content, embeds or forwarded messages (payload `mentions` merged with
	 * `users`). Used to show names only; it never triggers the bot.
	 */
	mentions: Array<ChatUser & { nick: string | null }>;
	mentionRoleIds: string[];
	mentionEveryone: boolean;
	reference: MessageRef | null;
	/**
	 * The message this one replies to, as included in the payload (one hop).
	 * undefined = not included in the payload; null = included but deleted/unavailable.
	 */
	referenced: ChatMessage | null | undefined;
	attachments: ChatAttachment[];
}

export interface GuildInfo {
	id: string;
	name: string;
	/** channel ID -> channel name */
	channels: Map<string, string>;
}

export interface MemberInfo {
	roles: string[];
	nick: string | null;
}

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface SendOptions {
	content: string;
	/** Reply to this message (same channel). */
	replyTo?: string;
	/** Ping the author of the replied-to message. Default false. No other mentions are ever allowed. */
	pingReplied?: boolean;
	/** Suppress link previews, if Fluxer supports it. */
	suppressEmbeds?: boolean;
}

export interface EditOptions {
	content: string;
	/** Must match what the message was created with (edits re-parse mentions). Default false. */
	pingReplied?: boolean;
	suppressEmbeds?: boolean;
}

export interface FluxerEvents {
	ready: (info: { user: ChatUser; guildIds: string[] }) => void;
	guildCreate: (guild: GuildInfo) => void;
	guildDelete: (guildId: string) => void;
	messageCreate: (msg: ChatMessage) => void;
	memberUpdate: (ev: { guildId: string; userId: string; roles: string[]; nick: string | null }) => void;
	memberRemove: (ev: { guildId: string; userId: string }) => void;
	connection: (state: ConnectionState) => void;
	/** The bot was added to a group DM. */
	groupDmCreate: (ev: { channelId: string; name: string | null }) => void;
	/** The gateway acknowledged a heartbeat while the session is live (about every 41 s). */
	heartbeat: () => void;
	/** Unrecoverable: bad token (close 4004), or no READY for too long. The process should exit and restart. */
	fatal: (reason: string) => void;
}

/** Everything Clanker needs from Fluxer. Implemented by fluxer.ts; faked in tests. */
export interface FluxerApi {
	/** The bot's own user (available after ready). */
	readonly botUser: ChatUser | null;
	readonly connectionState: ConnectionState;

	sendMessage(channelId: string, opts: SendOptions): Promise<{ id: string }>;
	editMessage(channelId: string, messageId: string, opts: EditOptions): Promise<void>;
	deleteMessage(channelId: string, messageId: string): Promise<void>;
	/** Unicode emoji, e.g. "⏳". */
	addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
	triggerTyping(channelId: string): Promise<void>;
	/** null when the message doesn't exist or can't be read. */
	fetchMessage(channelId: string, messageId: string): Promise<ChatMessage | null>;
	/** null when the user isn't a member of the guild. */
	fetchMember(guildId: string, userId: string): Promise<MemberInfo | null>;
	leaveGuild(guildId: string): Promise<void>;
	/** Leaves a group DM. */
	leaveGroupDm(channelId: string): Promise<void>;
	/** Starts a public thread from a message and returns the thread's channel ID (which equals the message ID). */
	createThread(channelId: string, messageId: string, name: string): Promise<string>;
	/** The newest `limit` (1-100) messages of a channel, oldest first. */
	recentMessages(channelId: string, limit: number): Promise<ChatMessage[]>;
	/** The first `limit` messages of a channel, oldest first. */
	firstMessages(channelId: string, limit: number): Promise<ChatMessage[]>;
	/** Opens (or reuses) a DM channel with the user and returns its channel ID. */
	openDm(userId: string): Promise<string>;
	/** Downloads an attachment. Rejects when larger than maxBytes. */
	download(url: string, maxBytes: number): Promise<{ data: Buffer; contentType: string | null }>;

	guild(guildId: string): GuildInfo | undefined;
	channelName(channelId: string): string | undefined;
	/** For a thread, its parent channel ID; otherwise undefined. */
	parentChannel(channelId: string): string | undefined;
	/** For a known thread, the user who started it; otherwise undefined. */
	threadOwner(threadId: string): string | undefined;
	/** The bot's own roles in a guild (e.g. the role Fluxer creates on install); mentioning one addresses the bot. */
	botRoles(guildId: string): readonly string[];
}

/** A failed Fluxer REST call. `code` is Fluxer's string error code, e.g. "UNKNOWN_MESSAGE", "CONTENT_BLOCKED". */
export class FluxerRequestError extends Error {
	override name = "FluxerRequestError";
	constructor(
		message: string,
		readonly status: number | null,
		readonly code: string | null,
	) {
		super(message);
	}
}

export interface FluxerClient extends FluxerApi {
	on<E extends keyof FluxerEvents>(event: E, handler: FluxerEvents[E]): void;
	connect(): Promise<void>;
	setPresence(status: "online" | "idle" | "dnd" | "invisible", customStatus: string | null): Promise<void>;
	destroy(): Promise<void>;
}

// ---------------------------------------------------------------- Claude side

export type MessageParam = Anthropic.Messages.MessageParam;
export type ContentBlock = Anthropic.Messages.ContentBlock;
export type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
export type ApiMessage = Anthropic.Messages.Message;
export type Usage = Anthropic.Messages.Usage;
export type StreamEvent = Anthropic.Messages.RawMessageStreamEvent;
export type MessageCreateParams = Anthropic.Messages.MessageCreateParamsStreaming;

/** A running stream: events as they arrive, then the final message. */
export interface ClaudeStream extends AsyncIterable<StreamEvent> {
	finalMessage(): Promise<ApiMessage>;
	abort(): void;
}

/** Thin seam over the SDK so tests can fake the API. */
export interface ClaudeTransport {
	stream(params: MessageCreateParams): ClaudeStream;
}

export type ToolStatus = { tool: "web_search"; query: string } | { tool: "web_fetch"; url: string };

export interface TurnProgress {
	/** Visible answer text so far (all text blocks concatenated, no citations rendered). */
	onText(text: string): void;
	/** A server tool started (with its input once known), or null when it finished. */
	onToolStatus(status: ToolStatus | null): void;
}

export type TurnStop =
	| "end_turn"
	| "max_tokens"
	| "refusal"
	/** pause_turn continued 3 times and paused again. */
	| "pause_limit"
	/** Any other stop (stop_sequence, model_context_window_exceeded, a tool call that couldn't be continued). */
	| "unexpected";

export interface CallRecord {
	usage: Usage;
	model: string;
}

export interface TurnResult {
	stop: TurnStop;
	/** All assistant content blocks, concatenated across continuations, exactly as returned. */
	content: ContentBlock[];
	/** The same content split per API call (one entry per pause_turn continuation), for exact replay. */
	pieces: ContentBlock[][];
	/** Refusal category from stop_details, if any. */
	refusalCategory: string | null;
	/** Usage of the last API call (for replay sizing). */
	lastUsage: Usage | null;
	/**
	 * False when the turn had a message of its own between pieces (a stray tool call answered with
	 * an error), so it can't be replayed as consecutive assistant messages. Absent means true.
	 */
	replayable?: boolean;
}

// ---------------------------------------------------------------- spend

export type LimitKind = "daily" | "monthly";

export type LimitCheck = { ok: true } | { ok: false; limit: LimitKind; cap: Micros; resetAt: number };

export interface UsageRow {
	ts: number;
	userId: string;
	/** null for DMs. */
	guildId: string | null;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheWrite5mTokens: number;
	cacheWrite1hTokens: number;
	cacheReadTokens: number;
	webSearches: number;
	webFetches: number;
	cost: Micros;
	/** Period keys in the configured timezone. */
	day: string; // YYYY-MM-DD
	month: string; // YYYY-MM
}
