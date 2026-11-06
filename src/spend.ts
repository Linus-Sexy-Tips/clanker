// SPDX-License-Identifier: AGPL-3.0-or-later
// Spending: prices, cost of a call, caps and limit notices.
// Everything here is plain arithmetic over the local ledger; it never calls Claude.

import { type Config, type ModelPrices, ratesFor, WEB_SEARCH_USD_PER_REQUEST } from "./config.js";
import { formatUsd, tokenCost, usd } from "./money.js";
import type { Store } from "./store.js";
import { dayKey, formatDuration, monthKey, nextDayStart, nextMonthStart, zoneName } from "./time.js";
import type { Clock, LimitCheck, LimitKind, Logger, Micros, Usage, UsageRow } from "./types.js";

/** Total prompt tokens of a call: uncached input plus cache writes and reads. */
export function promptTokens(usage: Usage): number {
	return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

/**
 * Cache writes by TTL. On the (non-beta) stream, `cache_creation` is message_start's split, which
 * covers only the first iteration of a server tool loop, while `cache_creation_input_tokens` is the
 * total over all iterations. 1-hour writes happen only at the system breakpoint in the first
 * iteration; the API's own breakpoints after server tool results are 5-minute, so the rest is
 * 5-minute writes. Without a split, everything is charged at the dearer 1-hour rate.
 */
export function cacheWrites(usage: Usage): { w5m: number; w1h: number } {
	const written = usage.cache_creation_input_tokens ?? 0;
	const split = usage.cache_creation;
	if (!split) return { w5m: 0, w1h: written };
	const total = Math.max(written, split.ephemeral_5m_input_tokens + split.ephemeral_1h_input_tokens);
	return { w5m: total - split.ephemeral_1h_input_tokens, w1h: split.ephemeral_1h_input_tokens };
}

/** Cost of one API call from its usage, rounded up to a whole micro-dollar. */
export function costOf(usage: Usage, prices: ModelPrices): Micros {
	const rates = ratesFor(prices, promptTokens(usage));
	const { w5m, w1h } = cacheWrites(usage);
	const searches = usage.server_tool_use?.web_search_requests ?? 0;
	const total =
		tokenCost(usage.input_tokens, rates.input) +
		tokenCost(w5m, rates.cache_write_5m) +
		tokenCost(w1h, rates.cache_write_1h) +
		tokenCost(usage.cache_read_input_tokens ?? 0, rates.cache_read) +
		tokenCost(usage.output_tokens, rates.output) +
		searches * usd(WEB_SEARCH_USD_PER_REQUEST);
	return Math.ceil(total - 1e-6);
}

export interface SpendOptions {
	config: Config;
	prices: ModelPrices;
	/** The pro tier's prices, when [pro] is on. */
	pro?: { prices: ModelPrices } | null;
	store: Store;
	clock: Clock;
	log: Logger;
}

export class Spend {
	private readonly tz: string;
	/**
	 * Calls whose ledger row couldn't be written (disk full, I/O error). They still count against
	 * the caps, and are written with the next row that can be. Lost on restart.
	 */
	private readonly unrecorded: UsageRow[] = [];

	constructor(private readonly opts: SpendOptions) {
		this.tz = opts.config.timezone;
	}

	get monthlyCap(): Micros {
		return usd(this.opts.config.limits.monthly_usd);
	}

	/** The user's daily cap: the default (pro.user_daily_usd for pro users), or the highest matching override. */
	userCap(userId: string, roles: string[], pro = false): Micros {
		let cap = this.opts.config.limits.user_daily_usd;
		if (pro && this.opts.pro) cap = Math.max(cap, this.opts.config.pro.user_daily_usd);
		for (const o of this.opts.config.limits.overrides) {
			const matches = (o.user !== undefined && o.user === userId) || (o.role !== undefined && roles.includes(o.role));
			if (matches && o.user_daily_usd > cap) cap = o.user_daily_usd;
		}
		return usd(cap);
	}

	periods(): { day: string; month: string; dayResetAt: number; monthResetAt: number } {
		const now = this.opts.clock.now();
		return {
			day: dayKey(now, this.tz),
			month: monthKey(now, this.tz),
			dayResetAt: nextDayStart(now, this.tz),
			monthResetAt: nextMonthStart(now, this.tz),
		};
	}

	/**
	 * Whether a request may start: what the user spent today and everyone spent this month, both
	 * below their caps. Costs are only known afterwards, so the last request can go over a cap.
	 * `pro`: the user is on the pro tier (its daily cap).
	 */
	check(userId: string, roles: string[], pro = false): LimitCheck {
		const p = this.periods();
		const monthCap = this.monthlyCap;
		if (this.monthSpend(p.month) >= monthCap) {
			return { ok: false, limit: "monthly", cap: monthCap, resetAt: p.monthResetAt };
		}
		const dayCap = this.userCap(userId, roles, pro);
		if (this.userDaySpend(userId, p.day) >= dayCap) {
			return { ok: false, limit: "daily", cap: dayCap, resetAt: p.dayResetAt };
		}
		return { ok: true };
	}

	/**
	 * Records the actual cost of one call, at the tier's prices. Returns the monthly alerts due for
	 * the first time this month: 80 at 80% of the cap, 100 once spend reaches it.
	 */
	record(
		userId: string,
		guildId: string | null,
		model: string,
		usage: Usage,
		pro = false,
	): { cost: Micros; month: Micros; alerts: Array<80 | 100>; recorded: boolean } {
		const now = this.opts.clock.now();
		const cost = costOf(usage, pro && this.opts.pro ? this.opts.pro.prices : this.opts.prices);
		const day = dayKey(now, this.tz);
		const monthK = monthKey(now, this.tz);
		const { w5m, w1h } = cacheWrites(usage);
		const row: UsageRow = {
			ts: now,
			userId,
			guildId,
			model,
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheWrite5mTokens: w5m,
			cacheWrite1hTokens: w1h,
			cacheReadTokens: usage.cache_read_input_tokens ?? 0,
			webSearches: usage.server_tool_use?.web_search_requests ?? 0,
			webFetches: usage.server_tool_use?.web_fetch_requests ?? 0,
			cost,
			day,
			month: monthK,
		};
		const recorded = this.write(row);
		const month = this.monthSpend(monthK);
		const alerts: Array<80 | 100> = [];
		const cap = this.monthlyCap;
		try {
			if (cap > 0) {
				if (month >= cap) {
					// Past the cap, an 80% alert would only confuse: it is marked as sent without going out.
					this.opts.store.markOnce("alert", "monthly-80", monthK, now);
					if (this.opts.store.markOnce("alert", "monthly-100", monthK, now)) alerts.push(100);
				} else if (month >= cap * 0.8 && this.opts.store.markOnce("alert", "monthly-80", monthK, now)) {
					alerts.push(80);
				}
			}
		} catch (err) {
			this.opts.log.error("couldn't record a monthly alert", { err });
			alerts.length = 0;
		}
		return { cost, month, alerts, recorded };
	}

	/** Writes the rows held back earlier, then `row`. False (and `row` held back) if the ledger can't be written. */
	private write(row: UsageRow): boolean {
		try {
			while (this.unrecorded[0]) {
				this.opts.store.insertUsage(this.unrecorded[0]);
				this.unrecorded.shift();
			}
			this.opts.store.insertUsage(row);
			return true;
		} catch (err) {
			this.unrecorded.push(row);
			this.opts.log.error("couldn't write to the ledger; counting in memory", { err, held: this.unrecorded.length });
			return false;
		}
	}

	/** Cost of the held-back rows that match. */
	private pendingCost(match: (row: UsageRow) => boolean): Micros {
		let total = 0;
		for (const row of this.unrecorded) if (match(row)) total += row.cost;
		return total;
	}

	private monthSpend(month: string): Micros {
		return this.opts.store.sumMonth(month) + this.pendingCost((r) => r.month === month);
	}

	/** The user's spend today, counting only calls after their last daily reset. */
	private userDaySpend(userId: string, day: string): Micros {
		const since = this.opts.store.dailyReset(userId);
		return (
			this.opts.store.sumUserDay(userId, day, since) +
			this.pendingCost((r) => r.userId === userId && r.day === day && r.ts > since)
		);
	}

	/**
	 * Resets the user's daily usage to zero (owner command). Earlier calls stay in the ledger and keep
	 * counting toward the shared monthly total. Returns what the user had spent today before the reset.
	 */
	resetDaily(userId: string): Micros {
		const p = this.periods();
		const before = this.userDaySpend(userId, p.day);
		this.opts.store.setDailyReset(userId, this.opts.clock.now());
		this.opts.store.unmark("notice:daily", userId, p.day);
		return before;
	}

	usage(userId: string): { today: Micros; month: Micros } {
		const p = this.periods();
		return {
			today: this.userDaySpend(userId, p.day),
			month:
				this.opts.store.sumUserMonth(userId, p.month) +
				this.pendingCost((r) => r.userId === userId && r.month === p.month),
		};
	}

	monthTotal(): Micros {
		return this.monthSpend(this.periods().month);
	}

	/**
	 * True the first time in the period that this user should get the full limit notice. If the
	 * flag can't be written, false: the user gets the ⏳ reaction rather than a notice every time.
	 */
	noticeDue(kind: LimitKind, userId: string): boolean {
		const p = this.periods();
		try {
			return this.opts.store.markOnce(
				`notice:${kind}`,
				userId,
				kind === "daily" ? p.day : p.month,
				this.opts.clock.now(),
			);
		} catch (err) {
			this.opts.log.error("couldn't record a limit notice", { err });
			return false;
		}
	}

	/** The limit notice text. `mention` is "<@id>" for a channel reply, or "" for a DM. */
	limitNotice(kind: LimitKind, cap: Micros, resetAt: number, mention: string): string {
		if (kind === "monthly") {
			return `I've reached my monthly spend limit of ${formatUsd(cap)}. It resets on ${dayKey(resetAt, this.tz)}.`;
		}
		const who = mention ? `${mention}, you've` : "You've";
		const inTime = formatDuration(resetAt - this.opts.clock.now());
		return `${who} reached your daily limit of ${formatUsd(cap)}. It resets at midnight ${zoneName(resetAt, this.tz)} (in ${inTime}).`;
	}
}
