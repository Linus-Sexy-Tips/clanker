// SPDX-License-Identifier: AGPL-3.0-or-later
// The message flow: every check in plain code first, then (and only then) a Claude call.

import type { Access, AccessResult, Place } from "./access.js";
import { type BuildResult, buildChain, type ChainDeps, type ChainLimits, estimateTokens } from "./chain.js";
import { ClaudeError, type ClaudeRunner } from "./claude.js";
import {
	accessText,
	helpText,
	notices,
	OPERATOR_ONLY,
	personalityText,
	statusText,
	usageAllText,
	usageText,
} from "./commands.js";
import { applyPersonality, type LoadedConfig } from "./config.js";
import type { Guards } from "./guards.js";
import { formatUsd } from "./money.js";
import { MAX_PERSONALITY_CHARS } from "./prompt.js";
import { composeReply, formatAnswer, ReplyStreamer, ThreadedReply, untrustedInline } from "./render.js";
import type { NoticeIds, ReplayCache } from "./replay.js";
import type { Spend } from "./spend.js";
import type { Store } from "./store.js";
import {
	type Command,
	detectTrigger,
	mentionsUser,
	type OwnerCommand,
	parseCommand,
	parseOwnerCommand,
	stripBotMentions,
} from "./triggers.js";
import {
	type ChatMessage,
	type Clock,
	type ContentBlock,
	type FluxerClient,
	FluxerRequestError,
	type Logger,
	type MessageParam,
	type Reservation,
	type ReserveResult,
	type ToolStatus,
	type TurnResult,
	type Usage,
} from "./types.js";

export interface AppDeps {
	loaded: LoadedConfig;
	fluxer: FluxerClient;
	runner: ClaudeRunner;
	store: Store;
	spend: Spend;
	replay: ReplayCache;
	notices: NoticeIds;
	access: Access;
	guards: Guards;
	log: Logger;
	clock: Clock;
	version: string;
	startedAt: number;
	/** Quiet time in a Clanker thread before it answers; each new message restarts it (default 3,000 ms). */
	threadDebounceMs?: number;
}

/** What the bot knows about a thread: the message it started from (or its first message), and whose it is. */
interface ThreadInfo {
	starter: ChatMessage | null;
	/** Started by Clanker or on one of its messages: every message from an allowed user there is addressed to the bot. */
	botThread: boolean;
}

/** A Clanker thread's pending answer: messages are batched until the thread is quiet. */
interface ThreadBatch {
	timer: ReturnType<typeof setTimeout> | null;
	running: boolean;
	pending: boolean;
	/** The latest message from an allowed user: they pay, and get any limit notice. */
	payer: ChatMessage;
	who: AccessResult;
	place: Place;
}

interface AnswerOptions {
	/** Who pays and gets limit notices, if not the trigger's author (thread batches). */
	payer?: ChatMessage;
	/** Parents for the chain (thread conversations, which have no replies). */
	parents?: ReadonlyMap<string, ChatMessage | null>;
	/** Answer in the trigger's thread, without replies. */
	inThread?: boolean;
}

type Streamer = ReplyStreamer | ThreadedReply;

const MAX_THREAD_INFO = 1000;

/** Settings key of the personality set with the `personality set` command. */
export const PERSONALITY_KEY = "personality";

/** Settings key of the custom status set with `presence set` ("" = none). */
export const PRESENCE_KEY = "presence";

/** The custom status in use: one set with `presence`, or the config's. Null = none. */
export function customStatus(stored: string | null, configured: string): string | null {
	if (stored !== null) return stored || null;
	return configured || null;
}

const MAX_PRESENCE_CHARS = 128;

const FAILURE_ALERT_AFTER = 3;
/** Owner alerts about leaving unlisted communities, per hour. Anyone can add a public bot. */
const LEAVE_ALERTS_PER_HOUR = 3;
/** Longest community name quoted in an owner alert. */
const GUILD_NAME_MAX = 60;

export class App {
	private readonly inflight = new Set<Promise<void>>();
	/** Communities being left, with the name for the owner alert once known. */
	private readonly leaving = new Map<string, string | null>();
	private leaveAlerts = { windowStart: 0, count: 0 };
	private consecutiveFailures = 0;
	/** Owner alerts sent for failures that last until the owner acts ("auth:<day>"); cleared on success. */
	private readonly alerted = new Set<string>();
	/** The owner has been told the ledger can't be written; cleared once a write works again. */
	private ledgerAlerted = false;
	private closed = false;
	private readonly threadInfos = new Map<string, ThreadInfo>();
	private readonly threadBatches = new Map<string, ThreadBatch>();

	constructor(private readonly d: AppDeps) {}

	private get config() {
		return this.d.loaded.config;
	}

	/** Subscribes to Fluxer events. */
	attach(): void {
		const { fluxer, access, log } = this.d;
		fluxer.on("ready", ({ guildIds }) => {
			for (const id of guildIds) this.track(this.enforceGuild(id, null));
		});
		fluxer.on("guildCreate", (g) => this.track(this.enforceGuild(g.id, g.name)));
		fluxer.on("groupDmCreate", (g) => this.track(this.enforceGroupDm(g.channelId)));
		fluxer.on("memberUpdate", (e) => access.onMemberUpdate(e.guildId, e.userId, e.roles));
		fluxer.on("memberRemove", (e) => access.onMemberRemove(e.guildId, e.userId));
		fluxer.on("messageCreate", (msg) => this.track(this.handleMessage(msg)));
		log.debug("app attached");
	}

	/** Waits for running work to finish, up to timeoutMs. New messages are ignored from now on. */
	async drain(timeoutMs: number): Promise<void> {
		this.closed = true;
		for (const batch of this.threadBatches.values()) if (batch.timer) clearTimeout(batch.timer);
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.allSettled([...this.inflight]),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
		clearTimeout(timer);
	}

	private track(p: Promise<void>): void {
		this.inflight.add(p);
		void p.finally(() => this.inflight.delete(p));
	}

	// ------------------------------------------------------------ guilds

	/** Leaves communities that aren't in the config (if configured to), and tells the owner. */
	private async enforceGuild(guildId: string, name: string | null): Promise<void> {
		const { access, fluxer, log } = this.d;
		if (access.guildAllowed(guildId)) return;
		if (this.leaving.has(guildId)) {
			// READY lists only IDs; the GUILD_CREATE that follows brings the name for the alert.
			if (name) this.leaving.set(guildId, name);
			return;
		}
		if (!this.config.access.guilds_leave_unlisted) {
			log.warn("in a community that isn't listed; staying (guilds_leave_unlisted = false)", { guild: guildId });
			return;
		}
		this.leaving.set(guildId, name);
		try {
			await fluxer.leaveGuild(guildId);
			log.warn("left a community that isn't listed", { guild: guildId });
			if (!this.leaveAlertDue()) {
				log.warn("owner alert about leaving a community suppressed (rate limit)", { guild: guildId });
				return;
			}
			// The name is chosen by whoever added the bot: quote it as plain text, never as Markdown or a link.
			const known = this.leaving.get(guildId);
			const shown = known ? untrustedInline(known, GUILD_NAME_MAX) : "";
			await this.alertOwner(
				`I left a community that isn't in my config: ${shown ? `"${shown}" ` : ""}(${guildId}). Add it under [guilds] if you want me there, or if you didn't add me, turn off Public bot in the application settings.`,
			);
		} catch (err) {
			log.error("couldn't leave an unlisted community", { guild: guildId, err });
		} finally {
			this.leaving.delete(guildId);
		}
	}

	/** With group DMs turned off (dms.groups = false), leaves any group DM the bot is added to, and tells the owner. */
	private async enforceGroupDm(channelId: string): Promise<void> {
		const { fluxer, log } = this.d;
		if (this.config.dms.groups || this.leaving.has(channelId)) return;
		this.leaving.set(channelId, null);
		try {
			await fluxer.leaveGroupDm(channelId);
			log.warn("left a group DM (dms.groups = false)", { channel: channelId });
			if (this.leaveAlertDue()) {
				await this.alertOwner(
					`I left a group DM (${channelId}) because group DMs are turned off. Set dms.groups = true if you want me there.`,
				);
			}
		} catch (err) {
			log.error("couldn't leave a group DM", { channel: channelId, err });
		} finally {
			this.leaving.delete(channelId);
		}
	}

	/** At most LEAVE_ALERTS_PER_HOUR alerts an hour, so adding the bot over and over can't flood the owner. */
	private leaveAlertDue(): boolean {
		const now = this.d.clock.now();
		if (now - this.leaveAlerts.windowStart >= 3_600_000) this.leaveAlerts = { windowStart: now, count: 0 };
		if (this.leaveAlerts.count >= LEAVE_ALERTS_PER_HOUR) return false;
		this.leaveAlerts.count++;
		return true;
	}

	// ------------------------------------------------------------ messages

	async handleMessage(msg: ChatMessage): Promise<void> {
		if (this.closed) return;
		const { fluxer, access, guards } = this.d;
		try {
			const bot = fluxer.botUser;
			if (!bot) return;
			// 1. Ignore bots, webhooks, ourselves and system messages.
			if (msg.author.bot || msg.webhookId || msg.author.id === bot.id || !msg.isUserMessage) return;
			// 2. Where.
			const place = access.place(msg);
			if (!place) {
				if (msg.isGroupDm) await this.enforceGroupDm(msg.channelId);
				return;
			}
			// 3. Trigger.
			// The bot's own roles (like the one Fluxer creates on install) count as mentions of the bot.
			const botRoles = msg.guildId ? fluxer.botRoles(msg.guildId) : [];
			const thread = msg.isThread ? await this.threadInfo(msg.channelId) : null;
			if (thread?.botThread) {
				await this.onBotThreadMessage(msg, place, botRoles);
				return;
			}
			const trigger = detectTrigger(msg, bot.id, botRoles);
			if (!trigger) return;
			// A reply to a command reply or notice is talk between people, unless it mentions the bot.
			if (
				trigger === "reply" &&
				msg.referenced &&
				this.d.notices.has(msg.referenced.id) &&
				!mentionsUser(msg, bot.id, botRoles)
			)
				return;
			// 4. Who. Unapproved users are ignored silently.
			const who = await access.check(msg);
			if (!who.allowed) return;

			const log = this.d.log.child({
				message: msg.id,
				user: msg.author.id,
				guild: msg.guildId,
				channel: msg.channelId,
			});
			log.info("triggered", { reason: who.reason });

			// 6a. Cooldown (applies to commands too).
			if (!guards.checkCooldown(msg.author.id)) {
				if (guards.slowReactionDue(msg.author.id)) await this.react(msg, "🐢", log);
				return;
			}

			// 5. Commands are answered from code. The owner's commands first.
			if (access.isOwner(msg.author.id)) {
				const owner = parseOwnerCommand(msg, bot.id, botRoles);
				if (owner) {
					this.d.notices.add(msg.id);
					await this.ownerCommand(owner, msg, log);
					return;
				}
			}
			const cmd = parseCommand(msg, bot.id, botRoles);
			if (cmd) {
				this.d.notices.add(msg.id);
				await this.command(cmd, msg, who, log);
				return;
			}

			// 6b. One request per user, and the global concurrency limit.
			const slot = await guards.enter(msg.author.id);
			if (!slot.ok) {
				if (slot.reason === "busy_user") {
					if (guards.slowReactionDue(msg.author.id)) await this.react(msg, "🐢", log);
				} else if (guards.busyNoticeDue(msg.channelId)) {
					await this.notice(msg, notices.busy(), log);
				}
				return;
			}
			try {
				// Shutting down while this waited in the queue: don't start a paid call that would be cut off.
				if (this.closed) return;
				// In another thread there are no replies: the context is the message and the thread's first one.
				const parents = new Map<string, ChatMessage | null>();
				if (thread) {
					const starter = thread.starter && thread.starter.id !== msg.id ? thread.starter : null;
					parents.set(msg.id, starter);
					if (starter) parents.set(starter.id, null);
				}
				await this.answer(msg, who, place, log, thread ? { parents, inThread: true } : {});
			} finally {
				slot.release();
			}
		} catch (err) {
			this.d.log.error("message handling failed", { message: msg.id, err });
		}
	}

	private async answer(
		msg: ChatMessage,
		who: AccessResult,
		place: Place,
		log: Logger,
		opts: AnswerOptions = {},
	): Promise<void> {
		const { spend, runner, replay } = this.d;
		const payer = opts.payer ?? msg;
		const userId = payer.author.id;

		// 8. Spend: the worst case of one call must fit both caps. Checked before any API call.
		const first = spend.reserve(userId, who.roles);
		if (!first.ok) {
			await this.limitNotice(payer, first, place, log);
			return;
		}
		let reservation: Reservation | null = first.reservation;
		let outputTokens = 0;
		/** Calls the API accepted (it sent usage), so their request prefix was valid. */
		let accepted = 0;

		const streamer = this.streamerFor(msg, place, log, opts);
		streamer.start();

		const hooks = {
			progress: {
				onText: (text: string) => streamer.update(text),
				onToolStatus: (status: ToolStatus | null) => streamer.status(status),
			},
			onCallEnd: (usage: Usage | null, model: string) => {
				// Never throws into the runner: the answer is already paid for and should still be posted.
				try {
					if (usage) {
						accepted++;
						outputTokens += usage.output_tokens;
						const rec = spend.record(userId, msg.guildId, model, usage);
						log.info("call cost", { cost: rec.cost, month: rec.month });
						this.ledgerHealth(rec.recorded);
						for (const pct of rec.alerts) void this.monthlyAlert(pct, rec.month);
					}
				} catch (err) {
					log.error("couldn't record a call's cost", { err });
				} finally {
					reservation?.release();
					reservation = null;
				}
			},
			beforeContinuation: () => {
				const next = spend.reserve(userId, who.roles);
				if (!next.ok) return false;
				reservation = next.reservation;
				return true;
			},
		};

		try {
			// 7. The reply chain.
			let built = await buildChain(msg, this.chainDeps(), this.chainLimits(), { parents: opts.parents });
			if (!built.ok) {
				await this.finishNotice(
					streamer,
					notices.tooLong(this.config.context.max_messages, this.config.context.max_chain_tokens),
				);
				log.info("chain too long", { messages: built.count, tokens: built.tokens });
				return;
			}
			log.info("chain built", { mode: built.mode, messages: built.count, tokens: built.tokens });

			// 9. Claude.
			let result: TurnResult;
			try {
				result = await runner.run(built.messages, hooks);
			} catch (err) {
				// Only a rejection of the first call can be about the replayed prefix: once a call was
				// accepted, the same prefix was fine.
				const prefixRejected =
					err instanceof ClaudeError &&
					built.mode === "replay" &&
					accepted === 0 &&
					(err.kind === "thinking_mismatch" || (err.kind === "invalid_request" && err.status === 400));
				if (!prefixRejected) throw err;
				// Replay is append-only by design, so this is a bug; recover by rebuilding from Fluxer text,
				// and drop the stored turn so later replies don't send it again.
				log.warn("replayed chain rejected; rebuilding the chain from text", { err, kind: err.kind });
				if (built.anchorId) replay.delete(built.anchorId);
				const again = spend.reserve(userId, who.roles);
				if (!again.ok) {
					await this.finishNotice(streamer, notices.budgetStop());
					return;
				}
				reservation = again.reservation;
				built = await buildChain(msg, this.chainDeps(), this.chainLimits(), {
					forceRebuild: true,
					parents: opts.parents,
				});
				if (!built.ok) {
					reservation.release();
					await this.finishNotice(
						streamer,
						notices.tooLong(this.config.context.max_messages, this.config.context.max_chain_tokens),
					);
					return;
				}
				result = await runner.run(built.messages, hooks);
			}

			// 10. Post the reply.
			const answer = this.finalText(result, built.messages);
			const ids = await streamer.finish(answer.text);

			// Keep the exact turn for follow-ups (only complete answers).
			if (result.stop === "end_turn" && answer.hasText) {
				replay.set(ids, {
					fingerprint: this.d.loaded.fingerprint,
					messages: withoutCacheMarkers(built.messages),
					assistant: result.pieces,
					tokens: built.tokens + replayedTurnTokens(result.pieces, outputTokens),
					count: built.count + ids.length,
				});
			}
			this.consecutiveFailures = 0;
			this.alerted.clear();
			log.info("answered", { stop: result.stop, parts: ids.length });
		} catch (err) {
			log.error("answer failed", { err });
			// Only blame Claude when the call to Claude failed (not, say, fetching the chain from Fluxer).
			await this.finishNotice(streamer, err instanceof ClaudeError ? notices.unavailable() : notices.failed());
			await this.recordFailure(err);
		} finally {
			// 11. Never leave a reservation behind.
			(reservation as Reservation | null)?.release();
			streamer.stop();
		}
	}

	/** The text to post for a finished turn. */
	private finalText(result: TurnResult, history: MessageParam[]): { text: string; hasText: boolean } {
		if (result.stop === "refusal") return { text: notices.refusal(), hasText: false };
		const { text, sources } = formatAnswer(result.content as ContentBlock[], history);
		const notes: string[] = [];
		if (result.stop === "max_tokens") notes.push(notices.cutOff());
		if (result.stop === "pause_limit") notes.push(notices.pauseLimit());
		if (result.stop === "budget") notes.push(notices.budgetStop());
		const hasText = text.trim().length > 0;
		if (!hasText) return { text: notes.length > 0 ? notes.join("\n\n") : notices.empty(), hasText };
		return { text: composeReply(text, sources, notes), hasText };
	}

	/**
	 * Where the answer goes: into the thread without replies; in a community channel through
	 * ThreadedReply, which moves long answers to a thread; otherwise a reply to the trigger.
	 */
	private streamerFor(msg: ChatMessage, place: Place, log: Logger, opts: AnswerOptions): Streamer {
		const base = { fluxer: this.d.fluxer, channelId: msg.channelId, log, clock: this.d.clock };
		if (opts.inThread || msg.isThread) return new ReplyStreamer({ ...base, replyTo: null, pingReplied: false });
		const limit = this.config.replies.thread_after_chars;
		if (place.kind === "guild" && limit > 0) {
			return new ThreadedReply({
				...base,
				replyTo: msg.id,
				pingReplied: true,
				threadAfterChars: limit,
				threadName: threadName(msg, this.d.fluxer.botUser?.id ?? ""),
			});
		}
		return new ReplyStreamer({ ...base, replyTo: msg.id, pingReplied: place.kind !== "dm" });
	}

	// ------------------------------------------------------------ threads

	/** The thread's starting message and whether it's a Clanker thread; cached (neither changes). */
	private async threadInfo(threadId: string): Promise<ThreadInfo> {
		const known = this.threadInfos.get(threadId);
		if (known) return known;
		const { fluxer } = this.d;
		const parent = fluxer.parentChannel(threadId);
		// A thread started from a message has that message's ID; otherwise use its first message.
		let starter = parent ? await fluxer.fetchMessage(parent, threadId) : null;
		if (!starter) starter = (await fluxer.firstMessages(threadId, 1)).find((m) => m.isUserMessage) ?? null;
		const botId = fluxer.botUser?.id;
		const botThread = fluxer.threadOwner(threadId) === botId || (starter !== null && starter.author.id === botId);
		const info: ThreadInfo = { starter, botThread };
		if (this.threadInfos.size >= MAX_THREAD_INFO) {
			const oldest = this.threadInfos.keys().next().value;
			if (oldest !== undefined) this.threadInfos.delete(oldest);
		}
		this.threadInfos.set(threadId, info);
		return info;
	}

	/**
	 * A message in a Clanker thread. Commands are answered at once. Otherwise every message from an
	 * allowed user is addressed to the bot: it waits until the thread is quiet, then answers all of
	 * them in one turn. Messages from others are only context.
	 */
	private async onBotThreadMessage(msg: ChatMessage, place: Place, botRoles: readonly string[]): Promise<void> {
		const { access, fluxer } = this.d;
		const bot = fluxer.botUser;
		if (!bot) return;
		const who = await access.check(msg);
		if (!who.allowed) return;
		const log = this.d.log.child({ message: msg.id, user: msg.author.id, guild: msg.guildId, channel: msg.channelId });
		if (access.isOwner(msg.author.id)) {
			const owner = parseOwnerCommand(msg, bot.id, botRoles);
			if (owner) {
				this.d.notices.add(msg.id);
				await this.ownerCommand(owner, msg, log);
				return;
			}
		}
		const cmd = parseCommand(msg, bot.id, botRoles);
		if (cmd) {
			this.d.notices.add(msg.id);
			await this.command(cmd, msg, who, log);
			return;
		}
		const threadId = msg.channelId;
		let batch = this.threadBatches.get(threadId);
		if (!batch) {
			batch = { timer: null, running: false, pending: false, payer: msg, who, place };
			this.threadBatches.set(threadId, batch);
		}
		batch.payer = msg;
		batch.who = who;
		batch.pending = true;
		log.info("thread message queued", { reason: who.reason });
		this.restartThreadTimer(threadId, batch);
	}

	private restartThreadTimer(threadId: string, batch: ThreadBatch): void {
		if (batch.timer) clearTimeout(batch.timer);
		batch.timer = setTimeout(() => {
			batch.timer = null;
			this.fireThread(threadId, batch);
		}, this.d.threadDebounceMs ?? 3000);
	}

	private fireThread(threadId: string, batch: ThreadBatch): void {
		if (this.closed || batch.running || !batch.pending) return;
		batch.running = true;
		batch.pending = false;
		this.track(
			this.threadTurn(threadId, batch).finally(() => {
				batch.running = false;
				// Messages that came in while it answered get their own turn once the thread is quiet again.
				if (batch.pending) {
					if (!batch.timer) this.restartThreadTimer(threadId, batch);
				} else if (!batch.timer) {
					this.threadBatches.delete(threadId);
				}
			}),
		);
	}

	/** Answers everything said in a Clanker thread since the bot's last answer. */
	private async threadTurn(threadId: string, batch: ThreadBatch): Promise<void> {
		const { fluxer, guards } = this.d;
		const payer = batch.payer;
		const log = this.d.log.child({ user: payer.author.id, guild: payer.guildId, channel: threadId });
		try {
			const info = await this.threadInfo(threadId);
			const max = this.config.context.max_messages;
			const fetched = (await fluxer.recentMessages(threadId, Math.min(100, max + 1))).filter((m) => m.isUserMessage);
			const trigger = fetched.at(-1);
			// The bot already answered the latest message.
			if (!trigger || trigger.author.id === fluxer.botUser?.id) return;
			if (fetched.length > max) {
				await this.notice(payer, notices.tooLong(max, this.config.context.max_chain_tokens), log);
				return;
			}
			// No replies in threads: each message follows the one before, the first follows the starter.
			const parents = new Map<string, ChatMessage | null>();
			fetched.forEach((m, i) => {
				parents.set(m.id, i === 0 ? (info.starter?.id === m.id ? null : info.starter) : (fetched[i - 1] ?? null));
			});
			const slot = await guards.enter(payer.author.id);
			if (!slot.ok) {
				if (guards.slowReactionDue(payer.author.id)) await this.react(payer, "🐢", log);
				return;
			}
			try {
				if (this.closed) return;
				log.info("thread turn", { messages: fetched.length });
				await this.answer(trigger, batch.who, batch.place, log, { payer, parents, inThread: true });
			} finally {
				slot.release();
			}
		} catch (err) {
			log.error("thread turn failed", { err });
		}
	}

	private async finishNotice(streamer: Streamer, text: string): Promise<void> {
		try {
			const ids = await streamer.finish(text);
			for (const id of ids) this.d.notices.add(id);
		} catch (err) {
			this.d.log.warn("couldn't post a notice", { err });
		}
	}

	private chainDeps(): ChainDeps {
		const { fluxer, replay, notices: noticeIds, loaded, log } = this.d;
		const botId = fluxer.botUser?.id ?? "";
		return {
			fluxer,
			botId,
			replay,
			notices: noticeIds,
			fingerprint: loaded.fingerprint,
			timezone: loaded.config.timezone,
			log,
		};
	}

	private chainLimits(): ChainLimits {
		const c = this.config.context;
		return { maxMessages: c.max_messages, maxChainTokens: c.max_chain_tokens, maxImages: c.max_images };
	}

	// ------------------------------------------------------------ notices and commands

	/** Limit reached: the full notice once per period, then only a ⏳ reaction. */
	private async limitNotice(
		msg: ChatMessage,
		res: Extract<ReserveResult, { ok: false }>,
		place: Place,
		log: Logger,
	): Promise<void> {
		const { spend, fluxer } = this.d;
		log.info("limit reached", { limit: res.limit });
		if (!spend.noticeDue(res.limit, msg.author.id)) {
			await this.react(msg, "⏳", log);
			return;
		}
		const viaDm = this.config.limits.notice === "dm" && place.kind !== "dm";
		if (viaDm) {
			await this.react(msg, "⏳", log);
			try {
				const channel = await fluxer.openDm(msg.author.id);
				const sent = await fluxer.sendMessage(channel, {
					content: spend.limitNotice(res.limit, res.cap, res.resetAt, ""),
				});
				this.d.notices.add(sent.id);
				return;
			} catch (err) {
				// The user may block DMs from bots; the notice goes out once per period either way.
				log.warn("couldn't DM a limit notice; replying in the channel", { err });
			}
		}
		const mention = place.kind !== "dm" ? `<@${msg.author.id}>` : "";
		await this.notice(msg, spend.limitNotice(res.limit, res.cap, res.resetAt, mention), log);
	}

	private async command(cmd: Command, msg: ChatMessage, who: AccessResult, log: Logger): Promise<void> {
		const { spend, store, fluxer, guards, replay, access, clock } = this.d;
		const config = this.config;
		log.info("command", { command: cmd });
		let text: string;
		switch (cmd) {
			case "help":
				text = helpText({
					botName: fluxer.botUser?.globalName ?? fluxer.botUser?.username ?? "Clanker",
					model: config.model.name,
					effort: config.model.effort,
					dailyCap: spend.userCap(msg.author.id, who.roles),
					monthlyCap: spend.monthlyCap,
					sourceUrl: config.source_url,
					webSearch: config.tools.web_search.enabled,
					webFetch: config.tools.web_fetch.enabled,
					// DMs are for the owner and users allowed by ID, not for roles.
					dms: config.dms.enabled && (who.reason === "owner" || who.reason === "user"),
					owner: access.isOwner(msg.author.id),
				});
				break;
			case "usage": {
				const u = spend.usage(msg.author.id);
				const p = spend.periods();
				text = usageText({
					today: u.today,
					dailyCap: spend.userCap(msg.author.id, who.roles),
					month: spend.monthTotal(),
					monthlyCap: spend.monthlyCap,
					now: clock.now(),
					dayResetAt: p.dayResetAt,
					monthResetAt: p.monthResetAt,
					timezone: config.timezone,
				});
				break;
			}
			case "usage all":
			case "status": {
				if (!access.isOwner(msg.author.id)) {
					text = OPERATOR_ONLY;
					break;
				}
				const p = spend.periods();
				if (cmd === "usage all") {
					text = usageAllText({
						rows: store.perUser(p.day, p.month),
						month: spend.monthTotal(),
						monthlyCap: spend.monthlyCap,
					});
				} else {
					text = statusText({
						version: this.d.version,
						uptimeMs: clock.now() - this.d.startedAt,
						connection: fluxer.connectionState,
						model: config.model.name,
						effort: config.model.effort,
						guilds: Object.keys(config.guilds).map((id) => ({ id, name: fluxer.guild(id)?.name ?? null })),
						today: store.dayStats(p.day),
						month: spend.monthTotal(),
						monthlyCap: spend.monthlyCap,
						replayEntries: replay.size,
						active: guards.active,
						queued: guards.queued,
					});
				}
				break;
			}
		}
		await this.notice(msg, text, log);
	}

	/** Owner commands: personality, access grants and revokes, daily usage resets. */
	private async ownerCommand(cmd: OwnerCommand, msg: ChatMessage, log: Logger): Promise<void> {
		const { loaded, store, access, spend } = this.d;
		log.info("owner command", { command: cmd.kind });
		let text: string;
		try {
			switch (cmd.kind) {
				case "personality-show":
					text = personalityText(loaded.personality, store.getSetting(PERSONALITY_KEY) === null);
					break;
				case "personality-set":
					if (cmd.text.length > MAX_PERSONALITY_CHARS) {
						text = `That's ${cmd.text.length} characters; the limit is ${MAX_PERSONALITY_CHARS}.`;
						break;
					}
					store.setSetting(PERSONALITY_KEY, cmd.text, this.d.clock.now());
					applyPersonality(loaded, cmd.text);
					text = `Personality updated. It applies from the next answer.\n\n${personalityText(loaded.personality, false)}`;
					break;
				case "personality-reset":
					store.setSetting(PERSONALITY_KEY, null);
					applyPersonality(loaded, null);
					text = `Personality reset to the default.\n\n${personalityText(loaded.personality, true)}`;
					break;
				case "presence-show": {
					const current = customStatus(store.getSetting(PRESENCE_KEY), this.config.presence.custom_status);
					const source = store.getSetting(PRESENCE_KEY) === null ? "from the config" : "set with `presence set`";
					text = current ? `Status message (${source}): ${current}` : `No status message (${source}).`;
					break;
				}
				case "presence-set":
				case "presence-clear":
				case "presence-reset": {
					if (cmd.kind === "presence-set" && cmd.text.length > MAX_PRESENCE_CHARS) {
						text = `That's ${cmd.text.length} characters; the limit is ${MAX_PRESENCE_CHARS}.`;
						break;
					}
					const stored = cmd.kind === "presence-set" ? cmd.text : cmd.kind === "presence-clear" ? "" : null;
					store.setSetting(PRESENCE_KEY, stored, this.d.clock.now());
					const shown = customStatus(stored, this.config.presence.custom_status);
					await this.d.fluxer.setPresence(this.config.presence.status, shown);
					text =
						cmd.kind === "presence-reset"
							? `Status message reset to the config's: ${shown ?? "none"}.`
							: shown
								? `Status message set: ${shown}`
								: "Status message removed.";
					break;
				}
				case "reset": {
					const before = spend.resetDaily(cmd.userId);
					text = `Reset <@${cmd.userId}>'s usage for today (was ${formatUsd(before)}). The monthly total still counts it.`;
					break;
				}
				case "grant":
				case "revoke": {
					if (cmd.target === "user" && access.isOwner(cmd.id)) {
						text = "The owner always has access.";
						break;
					}
					// A community's @everyone role has the community's ID.
					const target = cmd.target === "role" && access.guildAllowed(cmd.id) ? "community" : cmd.target;
					if (target === "community") {
						if (!access.guildAllowed(cmd.id)) {
							text = "I don't serve that community. List it under `[guilds]` in the config first.";
							break;
						}
						access[cmd.kind]("community", cmd.id);
						const name = this.communityName(cmd.id);
						text =
							cmd.kind === "grant"
								? `Everyone in ${name} can use me now there. DMs still need \`grant user\`.`
								: `${name} no longer gives access to all its members. Members may still have access through a role or as a listed user.`;
						break;
					}
					const who = target === "user" ? `<@${cmd.id}>` : `<@&${cmd.id}>`;
					access[cmd.kind](target, cmd.id);
					text =
						cmd.kind === "grant"
							? target === "user"
								? `${who} can use me now.`
								: `Members with ${who} can use me now, in the communities I serve.`
							: target === "user"
								? `${who} can no longer use me, whatever their roles.`
								: `${who} no longer gives access. Members may still have access through another role or as a listed user.`;
					break;
				}
				case "access":
					text = accessText(access.listing(), (id) => this.communityName(id));
					break;
				case "usage-error":
					text = `Usage: ${cmd.usage}`;
					break;
			}
		} catch (err) {
			log.error("owner command failed", { command: cmd.kind, err });
			text = "That didn't work: I couldn't save the change. Check the logs.";
		}
		await this.notice(msg, text, log);
	}

	/** "Privacy Guides (1559249183368544256)", or just the ID while the community isn't loaded. */
	private communityName(guildId: string): string {
		const name = this.d.fluxer.guild(guildId)?.name;
		return name ? `${name} (${guildId})` : guildId;
	}

	/** Replies with a code-written message and remembers it as a notice (not chain context). */
	private async notice(msg: ChatMessage, content: string, log: Logger): Promise<void> {
		try {
			const sent = await this.d.fluxer.sendMessage(msg.channelId, {
				content,
				// Fluxer shows no replies in threads.
				replyTo: msg.isThread ? undefined : msg.id,
				pingReplied: false,
				suppressEmbeds: true,
			});
			this.d.notices.add(sent.id);
		} catch (err) {
			log.warn("couldn't send a notice", { err });
		}
	}

	private async react(msg: ChatMessage, emoji: string, log: Logger): Promise<void> {
		try {
			await this.d.fluxer.addReaction(msg.channelId, msg.id, emoji);
		} catch (err) {
			log.warn("couldn't add a reaction", { emoji, err });
		}
	}

	// ------------------------------------------------------------ owner alerts

	private async monthlyAlert(pct: 80 | 100, month: number): Promise<void> {
		const { spend } = this.d;
		const cap = spend.monthlyCap;
		await this.alertOwner(
			pct >= 100
				? `Monthly spend limit reached: ${formatUsd(month)} of ${formatUsd(cap)}, and one more request could cost up to ${formatUsd(spend.callEstimate)}. I won't answer anyone until next month.`
				: `Monthly spend is at ${Math.floor((month / cap) * 100)}%: ${formatUsd(month)} of ${formatUsd(cap)}.`,
		);
	}

	private async recordFailure(err: unknown): Promise<void> {
		this.consecutiveFailures++;
		const kind = err instanceof ClaudeError ? err.kind : null;
		if (kind === "auth" || kind === "spend_limit") {
			// These fail until the owner acts: one DM per incident (and day), not one per request.
			const key = `${kind}:${this.d.spend.periods().day}`;
			if (this.alerted.has(key)) return;
			this.alerted.add(key); // before the await, so concurrent failures can't both alert
			await this.alertOwner(
				kind === "auth"
					? "The Anthropic API rejected my API key. Check ANTHROPIC_API_KEY."
					: "The Anthropic API refused a request because of a spend limit or billing problem (workspace limit, usage tier cap, or no credit left). Check the Console.",
			);
			return;
		}
		if (this.consecutiveFailures === FAILURE_ALERT_AFTER) {
			await this.alertOwner(
				`My last ${FAILURE_ALERT_AFTER} answers failed (latest: ${failureLabel(err)}). I'll keep trying; check the logs.`,
			);
		}
	}

	/** Tells the owner once when the spending ledger can't be written, and again only after it recovered. */
	private ledgerHealth(recorded: boolean): void {
		if (recorded) {
			this.ledgerAlerted = false;
			return;
		}
		if (this.ledgerAlerted) return;
		this.ledgerAlerted = true;
		void this.alertOwner(
			"I couldn't write to the spending ledger (disk full?). I'm counting spend in memory until it works again, but that is lost if I restart. Check the logs.",
		);
	}

	/** DMs the owner. Failures are logged, never thrown (the owner may block bot DMs). */
	async alertOwner(text: string): Promise<void> {
		const { fluxer, log } = this.d;
		try {
			const channel = await fluxer.openDm(this.config.owner_id);
			const sent = await fluxer.sendMessage(channel, { content: text });
			this.d.notices.add(sent.id);
			log.info("owner alerted");
		} catch (err) {
			log.warn("couldn't DM the owner", { err });
		}
	}
}

/** Where a failed answer went wrong, for the owner alert. */
function failureLabel(err: unknown): string {
	if (err instanceof ClaudeError) return `Claude ${err.kind}`;
	if (err instanceof FluxerRequestError) return `Fluxer ${err.status ?? err.code ?? "network error"}`;
	return err instanceof Error ? err.name : "unknown error";
}

/**
 * Estimated size of a stored answer when it is replayed: its output tokens (text and hidden
 * thinking) plus the tool calls and results it carries, which come back as input next time.
 */
export function replayedTurnTokens(pieces: ContentBlock[][], outputTokens: number): number {
	const carried = pieces
		.flat()
		.filter((b) => b.type !== "text" && b.type !== "thinking" && b.type !== "redacted_thinking");
	return outputTokens + (carried.length > 0 ? estimateTokens(JSON.stringify(carried)) : 0);
}

/**
 * Copies messages without cache_control markers on content blocks. Stored turns must not
 * keep the per-request breakpoint, or markers would pile up past the limit of four.
 */
export function withoutCacheMarkers(messages: MessageParam[]): MessageParam[] {
	return messages.map((m) => {
		if (typeof m.content === "string") return m;
		if (!m.content.some((b) => "cache_control" in b && b.cache_control)) return m;
		return {
			...m,
			content: m.content.map((b) => {
				if (!("cache_control" in b) || !b.cache_control) return b;
				const { cache_control: _drop, ...rest } = b;
				return rest;
			}),
		} as MessageParam;
	});
}

export type { BuildResult };

/** A thread name from the question: its first line without bot mentions, at most 80 characters. */
export function threadName(msg: ChatMessage, botId: string): string {
	const line = stripBotMentions(msg.content, botId)
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l !== "");
	if (!line) return "Clanker";
	return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}
