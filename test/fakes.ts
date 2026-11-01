// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory fakes of Fluxer and the Claude runner for end-to-end tests of the message flow.

import type { RunHooks } from "../src/claude.js";
import {
	type ChatMessage,
	type ChatUser,
	type ConnectionState,
	type ContentBlock,
	type EditOptions,
	type FluxerClient,
	type FluxerEvents,
	FluxerRequestError,
	type GuildInfo,
	type MemberInfo,
	type MessageParam,
	type SendOptions,
	type TurnResult,
	type Usage,
} from "../src/types.js";
import { chatUser } from "./helpers.js";

export interface SentMessage {
	id: string;
	channelId: string;
	content: string;
	replyTo?: string;
	pingReplied?: boolean;
	suppressEmbeds?: boolean;
}

type Handlers = { [E in keyof FluxerEvents]: Array<FluxerEvents[E]> };

let seq = 9_000_000;

export class FakeFluxer implements FluxerClient {
	botUser: ChatUser | null = chatUser("100", { username: "clanker", globalName: "Clanker", bot: true });
	connectionState: ConnectionState = "connected";
	readonly sent: SentMessage[] = [];
	readonly edits: Array<{ channelId: string; messageId: string; opts: EditOptions }> = [];
	readonly deleted: string[] = [];
	readonly reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
	readonly typing: string[] = [];
	readonly left: string[] = [];
	readonly dms = new Map<string, string>();
	/** Messages the bot can fetch (the "server"), by ID. */
	readonly messages = new Map<string, ChatMessage>();
	readonly members = new Map<string, MemberInfo>();
	readonly guilds = new Map<string, GuildInfo>();
	fetchCalls = 0;
	/** Users whose DMs from the bot fail (they block DMs from bots). */
	readonly dmBlocked = new Set<string>();
	/** When set, fetchMessage fails with this error. */
	fetchError: Error | null = null;
	private readonly handlers: Handlers = {
		ready: [],
		guildCreate: [],
		groupDmCreate: [],
		guildDelete: [],
		messageCreate: [],
		memberUpdate: [],
		memberRemove: [],
		connection: [],
		heartbeat: [],
		fatal: [],
	};

	on<E extends keyof FluxerEvents>(event: E, handler: FluxerEvents[E]): void {
		(this.handlers[event] as Array<FluxerEvents[E]>).push(handler);
	}

	emit<E extends keyof FluxerEvents>(event: E, ...args: Parameters<FluxerEvents[E]>): void {
		for (const h of this.handlers[event]) (h as (...a: Parameters<FluxerEvents[E]>) => void)(...args);
	}

	async connect(): Promise<void> {}
	readonly presences: Array<{ status: string; customStatus: string | null }> = [];

	async setPresence(status: string, customStatus: string | null): Promise<void> {
		this.presences.push({ status, customStatus });
	}
	async destroy(): Promise<void> {}

	async sendMessage(channelId: string, opts: SendOptions): Promise<{ id: string }> {
		for (const user of this.dmBlocked) {
			if (channelId === `dm-${user}`) {
				throw new FluxerRequestError(
					"sendMessage: 400 CANNOT_SEND_MESSAGES_TO_USER",
					400,
					"CANNOT_SEND_MESSAGES_TO_USER",
				);
			}
		}
		const id = String(seq++);
		this.sent.push({ id, channelId, ...opts });
		// The bot's own messages become fetchable, like on the real server.
		const bot = this.botUser as ChatUser;
		const reply = opts.replyTo ? this.messages.get(opts.replyTo) : undefined;
		this.messages.set(id, {
			id,
			channelId,
			guildId: reply?.guildId ?? null,
			isDm: reply?.isDm ?? false,
			isGroupDm: reply?.isGroupDm ?? false,
			isThread: this.threads.has(channelId),
			author: bot,
			memberNick: null,
			memberRoles: null,
			webhookId: null,
			type: opts.replyTo ? 19 : 0,
			isUserMessage: true,
			content: opts.content,
			timestamp: "2026-11-01T12:00:01.000Z",
			editedTimestamp: null,
			mentions: [],
			mentionRoleIds: [],
			mentionEveryone: false,
			reference: opts.replyTo ? { messageId: opts.replyTo, channelId, guildId: reply?.guildId ?? null } : null,
			referenced: undefined,
			attachments: [],
		});
		return { id };
	}

	async editMessage(channelId: string, messageId: string, opts: EditOptions): Promise<void> {
		this.edits.push({ channelId, messageId, opts });
		const m = this.messages.get(messageId);
		if (m) this.messages.set(messageId, { ...m, content: opts.content });
	}

	async deleteMessage(_channelId: string, messageId: string): Promise<void> {
		this.deleted.push(messageId);
		this.messages.delete(messageId);
	}

	async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
		this.reactions.push({ channelId, messageId, emoji });
	}

	async triggerTyping(channelId: string): Promise<void> {
		this.typing.push(channelId);
	}

	async fetchMessage(_channelId: string, messageId: string): Promise<ChatMessage | null> {
		this.fetchCalls++;
		if (this.fetchError) throw this.fetchError;
		return this.messages.get(messageId) ?? null;
	}

	async fetchMember(guildId: string, userId: string): Promise<MemberInfo | null> {
		return this.members.get(`${guildId}:${userId}`) ?? null;
	}

	readonly leftGroups: string[] = [];
	/** Thread ID -> parent channel ID. */
	readonly threads = new Map<string, string>();
	readonly createdThreads: Array<{ channelId: string; messageId: string; name: string }> = [];
	/** Set to make createThread fail. */
	threadError: Error | null = null;

	async createThread(channelId: string, messageId: string, name: string): Promise<string> {
		if (this.threadError) throw this.threadError;
		this.createdThreads.push({ channelId, messageId, name });
		this.threads.set(messageId, channelId);
		return messageId;
	}

	private channelMessages(channelId: string): ChatMessage[] {
		// Insertion order is time order here (test IDs don't grow with time like snowflakes do).
		return [...this.messages.values()].filter((m) => m.channelId === channelId);
	}

	async recentMessages(channelId: string, limit: number): Promise<ChatMessage[]> {
		return this.channelMessages(channelId).slice(-limit);
	}

	async firstMessages(channelId: string, limit: number): Promise<ChatMessage[]> {
		return this.channelMessages(channelId).slice(0, limit);
	}

	async leaveGroupDm(channelId: string): Promise<void> {
		this.leftGroups.push(channelId);
	}

	async leaveGuild(guildId: string): Promise<void> {
		this.left.push(guildId);
	}

	async openDm(userId: string): Promise<string> {
		let ch = this.dms.get(userId);
		if (!ch) {
			ch = `dm-${userId}`;
			this.dms.set(userId, ch);
		}
		return ch;
	}

	async download(): Promise<{ data: Buffer; contentType: string | null }> {
		return { data: Buffer.from("fake-image"), contentType: "image/png" };
	}

	guild(guildId: string): GuildInfo | undefined {
		return this.guilds.get(guildId);
	}

	channelName(channelId: string): string | undefined {
		for (const g of this.guilds.values()) {
			const n = g.channels.get(channelId);
			if (n) return n;
		}
		return undefined;
	}

	readonly ownRoles = new Map<string, string[]>();

	botRoles(guildId: string): readonly string[] {
		return this.ownRoles.get(guildId) ?? [];
	}

	parentChannel(channelId: string): string | undefined {
		return this.threads.get(channelId);
	}

	/** The last message content shown for a sent message ID (after edits). */
	shown(id: string): string | undefined {
		return this.messages.get(id)?.content;
	}
}

export function usage(o: Partial<Usage> = {}): Usage {
	return {
		input_tokens: 1000,
		output_tokens: 200,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
		server_tool_use: null,
		inference_geo: null,
		output_tokens_details: null,
		service_tier: "standard",
		speed: null,
		...o,
	} as Usage;
}

export function textBlock(text: string): ContentBlock {
	return { type: "text", text, citations: null } as ContentBlock;
}

export type Script = (messages: MessageParam[], hooks: RunHooks) => Promise<TurnResult>;

/** A stand-in for ClaudeRunner that runs scripted turns and records the messages it got. */
export class FakeRunner {
	readonly calls: MessageParam[][] = [];
	private readonly scripts: Script[] = [];

	/** Queues a turn. Without a script, run() answers "ok". */
	next(script: Script): this {
		this.scripts.push(script);
		return this;
	}

	/** Queues a plain answer. */
	answer(text: string, u: Partial<Usage> = {}): this {
		return this.next(async (_m, hooks) => {
			hooks.progress.onText(text);
			hooks.onCallEnd(usage(u), "claude-haiku-5-5");
			const content = [textBlock(text)];
			return { stop: "end_turn", content, pieces: [content], refusalCategory: null, lastUsage: usage(u) };
		});
	}

	async run(messages: MessageParam[], hooks: RunHooks): Promise<TurnResult> {
		this.calls.push(messages);
		const script = this.scripts.shift();
		if (!script) throw new Error("FakeRunner: no scripted turn left");
		return script(messages, hooks);
	}
}
