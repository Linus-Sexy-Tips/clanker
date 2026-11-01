// SPDX-License-Identifier: AGPL-3.0-or-later
// The message flow: every check in plain code first, then (and only then) a Claude call.

import type { Access, AccessResult, Place } from "./access.js";
import { type BuildResult, buildChain, type ChainDeps, type ChainLimits, estimateTokens } from "./chain.js";
import { ClaudeError, type ClaudeRunner } from "./claude.js";
import { helpText, notices, OPERATOR_ONLY, statusText, usageAllText, usageText } from "./commands.js";
import type { LoadedConfig } from "./config.js";
import type { Guards } from "./guards.js";
import { formatUsd } from "./money.js";
import { composeReply, formatAnswer, ReplyStreamer } from "./render.js";
import type { NoticeIds, ReplayCache } from "./replay.js";
import type { Spend } from "./spend.js";
import type { Store } from "./store.js";
import { type Command, detectTrigger, parseCommand } from "./triggers.js";
import type {
	ChatMessage,
	Clock,
	ContentBlock,
	FluxerClient,
	Logger,
	MessageParam,
	Reservation,
	ReserveResult,
	TurnResult,
	Usage,
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
}

const FAILURE_ALERT_AFTER = 3;

export class App {
	private readonly inflight = new Set<Promise<void>>();
	private readonly leaving = new Set<string>();
	private consecutiveFailures = 0;
	private closed = false;

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
		fluxer.on("memberUpdate", (e) => access.onMemberUpdate(e.guildId, e.userId, e.roles, e.nick));
		fluxer.on("memberRemove", (e) => access.onMemberRemove(e.guildId, e.userId));
		fluxer.on("messageCreate", (msg) => this.track(this.handleMessage(msg)));
		log.debug("app attached");
	}

	/** Waits for running work to finish, up to timeoutMs. New messages are ignored from now on. */
	async drain(timeoutMs: number): Promise<void> {
		this.closed = true;
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
		if (access.guildAllowed(guildId) || this.leaving.has(guildId)) return;
		if (!this.config.access.guilds_leave_unlisted) {
			log.warn("in a community that isn't listed; staying (guilds_leave_unlisted = false)", { guild: guildId });
			return;
		}
		this.leaving.add(guildId);
		try {
			await fluxer.leaveGuild(guildId);
			log.warn("left a community that isn't listed", { guild: guildId });
			await this.alertOwner(
				`I left a community that isn't in my config: ${name ? `"${name}" ` : ""}(${guildId}). Add it under [guilds] if you want me there.`,
			);
		} catch (err) {
			log.error("couldn't leave an unlisted community", { guild: guildId, err });
		} finally {
			this.leaving.delete(guildId);
		}
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
			if (!place) return;
			// 3. Trigger.
			if (!detectTrigger(msg, bot.id)) return;
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

			// 5. Commands are answered from code.
			const cmd = parseCommand(msg, bot.id);
			if (cmd) {
				await this.command(cmd, msg, who, place, log);
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
				await this.answer(msg, who, place, log);
			} finally {
				slot.release();
			}
		} catch (err) {
			this.d.log.error("message handling failed", { message: msg.id, err });
		}
	}

	private async answer(msg: ChatMessage, who: AccessResult, place: Place, log: Logger): Promise<void> {
		const { spend, runner, replay, fluxer } = this.d;
		const userId = msg.author.id;

		// 8. Spend: the worst case of one call must fit both caps. Checked before any API call.
		const first = spend.reserve(userId, who.roles);
		if (!first.ok) {
			await this.limitNotice(msg, first, place, log);
			return;
		}
		let reservation: Reservation | null = first.reservation;
		let outputTokens = 0;

		const streamer = new ReplyStreamer({
			fluxer,
			channelId: msg.channelId,
			replyTo: msg.id,
			pingReplied: place.kind === "guild",
			log,
			clock: this.d.clock,
		});
		streamer.start();

		const hooks = {
			progress: {
				onText: (text: string) => streamer.update(text),
				onToolStatus: (status: Parameters<ReplyStreamer["status"]>[0]) => streamer.status(status),
			},
			onCallEnd: (usage: Usage | null, model: string) => {
				if (usage) {
					outputTokens += usage.output_tokens;
					const rec = spend.record(userId, msg.guildId, model, usage);
					log.info("call cost", { cost: rec.cost, month: rec.month });
					for (const pct of rec.alerts) void this.monthlyAlert(pct, rec.month);
				}
				reservation?.release();
				reservation = null;
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
			let built = await buildChain(msg, this.chainDeps(), this.chainLimits());
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
				if (!(err instanceof ClaudeError && err.kind === "thinking_mismatch" && built.mode === "replay")) throw err;
				// Replay is append-only by design, so this is a bug; recover by rebuilding from Fluxer text.
				log.warn("thinking blocks rejected; rebuilding the chain from text", { err });
				if (built.anchorId) replay.delete(built.anchorId);
				const again = spend.reserve(userId, who.roles);
				if (!again.ok) {
					await this.finishNotice(streamer, notices.budgetStop());
					return;
				}
				reservation = again.reservation;
				built = await buildChain(msg, this.chainDeps(), this.chainLimits(), { forceRebuild: true });
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
			log.info("answered", { stop: result.stop, parts: ids.length });
		} catch (err) {
			log.error("answer failed", { err });
			await this.finishNotice(streamer, notices.unavailable());
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

	private async finishNotice(streamer: ReplyStreamer, text: string): Promise<void> {
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
		const viaDm = this.config.limits.notice === "dm" && place.kind === "guild";
		if (viaDm) {
			await this.react(msg, "⏳", log);
			try {
				const channel = await fluxer.openDm(msg.author.id);
				const sent = await fluxer.sendMessage(channel, {
					content: spend.limitNotice(res.limit, res.cap, res.resetAt, ""),
				});
				this.d.notices.add(sent.id);
			} catch (err) {
				log.warn("couldn't DM a limit notice", { err });
			}
			return;
		}
		const mention = place.kind === "guild" ? `<@${msg.author.id}>` : "";
		await this.notice(msg, spend.limitNotice(res.limit, res.cap, res.resetAt, mention), log);
	}

	private async command(cmd: Command, msg: ChatMessage, who: AccessResult, place: Place, log: Logger): Promise<void> {
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
					dms: config.dms.enabled,
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
				if (!(access.isOwner(msg.author.id) && place.kind === "dm")) {
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

	/** Replies with a code-written message and remembers it as a notice (not chain context). */
	private async notice(msg: ChatMessage, content: string, log: Logger): Promise<void> {
		try {
			const sent = await this.d.fluxer.sendMessage(msg.channelId, {
				content,
				replyTo: msg.id,
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
		const cap = this.d.spend.monthlyCap;
		await this.alertOwner(
			pct >= 100
				? `Monthly spend limit reached: ${formatUsd(month)} of ${formatUsd(cap)}. I won't answer anyone until next month.`
				: `Monthly spend is at ${Math.floor((month / cap) * 100)}%: ${formatUsd(month)} of ${formatUsd(cap)}.`,
		);
	}

	private async recordFailure(err: unknown): Promise<void> {
		this.consecutiveFailures++;
		const kind = err instanceof ClaudeError ? err.kind : "other";
		if (kind === "auth") {
			await this.alertOwner("The Anthropic API rejected my API key. Check ANTHROPIC_API_KEY.");
			return;
		}
		if (kind === "spend_limit") {
			await this.alertOwner(
				"The Anthropic API refused a request because of a spend limit or billing problem (workspace limit, usage tier cap, or no credit left). Check the Console.",
			);
			return;
		}
		if (this.consecutiveFailures === FAILURE_ALERT_AFTER) {
			await this.alertOwner(
				`My last ${FAILURE_ALERT_AFTER} requests to Claude failed (latest: ${kind}). I'll keep trying; check the logs.`,
			);
		}
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
