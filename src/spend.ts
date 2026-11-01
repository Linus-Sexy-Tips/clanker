// SPDX-License-Identifier: AGPL-3.0-or-later
// Spending: prices, cost of a call, the worst-case estimate, caps, reservations and limit notices.
// Everything here is plain arithmetic over the local ledger; it never calls Claude.

import { type Config, estimateCall, type ModelPrices, ratesFor, WEB_SEARCH_USD_PER_REQUEST } from "./config.js";
import { formatUsd, tokenCost, usd } from "./money.js";
import type { Store } from "./store.js";
import { dayKey, formatDuration, monthKey, nextDayStart, nextMonthStart, zoneName } from "./time.js";
import type { Clock, LimitKind, Logger, Micros, Reservation, ReserveResult, Usage, UsageRow } from "./types.js";

/** Total prompt tokens of a call: uncached input plus cache writes and reads. */
export function promptTokens(usage: Usage): number {
	return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

export { estimateCall };

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
	store: Store;
	clock: Clock;
	log: Logger;
}

export class Spend {
	private readonly reservedByUser = new Map<string, Micros>();
	private reservedTotal: Micros = 0;
	private readonly estimate: Micros;
	private readonly tz: string;
	/**
	 * Calls whose ledger row couldn't be written (disk full, I/O error). They still count against
	 * the caps, and are written with the next row that can be. Lost on restart.
	 */
	private readonly unrecorded: UsageRow[] = [];

	constructor(private readonly opts: SpendOptions) {
		this.estimate = estimateCall(opts.config, opts.prices);
		this.tz = opts.config.timezone;
	}

	/** Worst-case cost of one call with the current config. */
	get callEstimate(): Micros {
		return this.estimate;
	}

	get monthlyCap(): Micros {
		return usd(this.opts.config.limits.monthly_usd);
	}

	/** The user's daily cap: the default, or the highest matching override. */
	userCap(userId: string, roles: string[]): Micros {
		let cap = this.opts.config.limits.user_daily_usd;
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

	/** Reserves the worst-case cost of one call against both caps, or says which cap is in the way. */
	reserve(userId: string, roles: string[]): ReserveResult {
		const p = this.periods();
		const amount = this.estimate;

		const monthCap = this.monthlyCap;
		const month = this.monthSpend(p.month) + this.reservedTotal;
		if (month + amount > monthCap) {
			return { ok: false, limit: "monthly", cap: monthCap, resetAt: p.monthResetAt };
		}
		const dayCap = this.userCap(userId, roles);
		const today = this.userDaySpend(userId, p.day) + (this.reservedByUser.get(userId) ?? 0);
		if (today + amount > dayCap) {
			return { ok: false, limit: "daily", cap: dayCap, resetAt: p.dayResetAt };
		}

		this.reservedTotal += amount;
		this.reservedByUser.set(userId, (this.reservedByUser.get(userId) ?? 0) + amount);
		let released = false;
		const reservation: Reservation = {
			amount,
			release: () => {
				if (released) return;
				released = true;
				this.reservedTotal -= amount;
				const left = (this.reservedByUser.get(userId) ?? 0) - amount;
				if (left > 0) this.reservedByUser.set(userId, left);
				else this.reservedByUser.delete(userId);
			},
		};
		return { ok: true, reservation };
	}

	/**
	 * Records the actual cost of one call. Returns the monthly alerts due for the first time this
	 * month: 80 at 80% of the cap, 100 once what's left can't cover one more call's worst case
	 * (reserve() refuses every call from then on, so spend itself rarely reaches the cap).
	 */
	record(
		userId: string,
		guildId: string | null,
		model: string,
		usage: Usage,
	): { cost: Micros; month: Micros; alerts: Array<80 | 100>; recorded: boolean } {
		const now = this.opts.clock.now();
		const cost = costOf(usage, this.opts.prices);
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
				const at80 = month >= cap * 0.8;
				// Open reservations are left out, so a short burst of concurrent calls can't set this off.
				const full = month + this.estimate > cap;
				// Once the limit is reached, a later 80% alert would only confuse: it is marked as sent too.
				if ((at80 || full) && this.opts.store.markOnce("alert", "monthly-80", monthK, now) && at80) alerts.push(80);
				if (full && this.opts.store.markOnce("alert", "monthly-100", monthK, now)) alerts.push(100);
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

	private userDaySpend(userId: string, day: string): Micros {
		return this.opts.store.sumUserDay(userId, day) + this.pendingCost((r) => r.userId === userId && r.day === day);
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
