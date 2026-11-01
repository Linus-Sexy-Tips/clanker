// SPDX-License-Identifier: AGPL-3.0-or-later
// Spending: prices, cost of a call, the worst-case estimate, caps, reservations and limit notices.
// Everything here is plain arithmetic over the local ledger; it never calls Claude.

import { type Config, type ModelPrices, WEB_SEARCH_USD_PER_REQUEST } from "./config.js";
import { formatUsd, tokenCost, usd } from "./money.js";
import type { Store } from "./store.js";
import { dayKey, formatDuration, monthKey, nextDayStart, nextMonthStart, zoneName } from "./time.js";
import type { Clock, LimitKind, Logger, Micros, Reservation, ReserveResult, Usage } from "./types.js";

type Rates = Omit<ModelPrices, "long_context">;

/** Total prompt tokens of a call: uncached input plus cache writes and reads. */
export function promptTokens(usage: Usage): number {
	return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

function ratesFor(prices: ModelPrices, prompt: number): Rates {
	const long = prices.long_context;
	return long && prompt > long.threshold ? long : prices;
}

/** Cost of one API call from its usage, rounded up to a whole micro-dollar. */
export function costOf(usage: Usage, prices: ModelPrices): Micros {
	const rates = ratesFor(prices, promptTokens(usage));
	const written = usage.cache_creation_input_tokens ?? 0;
	// Without a TTL breakdown, charge every write at the dearer 1-hour rate.
	const w5m = usage.cache_creation ? usage.cache_creation.ephemeral_5m_input_tokens : 0;
	const w1h = usage.cache_creation ? usage.cache_creation.ephemeral_1h_input_tokens : written;
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

/**
 * Worst-case cost of one API call, from the context budget:
 * every server tool iteration re-reads a full-size prompt at the uncached rate,
 * the output is max_tokens, and every allowed search happens.
 */
export function estimateCall(config: Config, prices: ModelPrices): Micros {
	const { web_search: search, web_fetch: fetch } = config.tools;
	const searches = search.enabled ? search.max_uses : 0;
	const fetches = fetch.enabled ? fetch.max_uses : 0;
	const prompt = config.context.max_request_tokens;
	const rates = ratesFor(prices, prompt);
	const total =
		tokenCost(prompt, rates.input) * (1 + searches + fetches) +
		tokenCost(config.model.max_tokens, rates.output) +
		searches * usd(WEB_SEARCH_USD_PER_REQUEST);
	return Math.ceil(total);
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
		const month = this.opts.store.sumMonth(p.month) + this.reservedTotal;
		if (month + amount > monthCap) {
			return { ok: false, limit: "monthly", cap: monthCap, resetAt: p.monthResetAt };
		}
		const dayCap = this.userCap(userId, roles);
		const today = this.opts.store.sumUserDay(userId, p.day) + (this.reservedByUser.get(userId) ?? 0);
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
	 * Records the actual cost of one call. Returns the monthly alert thresholds crossed
	 * for the first time this month (80 and/or 100 percent).
	 */
	record(
		userId: string,
		guildId: string | null,
		model: string,
		usage: Usage,
	): { cost: Micros; month: Micros; alerts: Array<80 | 100> } {
		const now = this.opts.clock.now();
		const cost = costOf(usage, this.opts.prices);
		const day = dayKey(now, this.tz);
		const monthK = monthKey(now, this.tz);
		const cacheCreation = usage.cache_creation;
		this.opts.store.insertUsage({
			ts: now,
			userId,
			guildId,
			model,
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheWrite5mTokens: cacheCreation ? cacheCreation.ephemeral_5m_input_tokens : 0,
			cacheWrite1hTokens: cacheCreation
				? cacheCreation.ephemeral_1h_input_tokens
				: (usage.cache_creation_input_tokens ?? 0),
			cacheReadTokens: usage.cache_read_input_tokens ?? 0,
			webSearches: usage.server_tool_use?.web_search_requests ?? 0,
			webFetches: usage.server_tool_use?.web_fetch_requests ?? 0,
			cost,
			day,
			month: monthK,
		});
		const month = this.opts.store.sumMonth(monthK);
		const alerts: Array<80 | 100> = [];
		const cap = this.monthlyCap;
		if (cap > 0) {
			if (month >= cap * 0.8 && this.opts.store.markOnce("alert", "monthly-80", monthK, now)) alerts.push(80);
			if (month >= cap && this.opts.store.markOnce("alert", "monthly-100", monthK, now)) alerts.push(100);
		}
		return { cost, month, alerts };
	}

	usage(userId: string): { today: Micros; month: Micros } {
		const p = this.periods();
		return {
			today: this.opts.store.sumUserDay(userId, p.day),
			month: this.opts.store.sumUserMonth(userId, p.month),
		};
	}

	monthTotal(): Micros {
		return this.opts.store.sumMonth(this.periods().month);
	}

	/** True the first time in the period that this user should get the full limit notice. */
	noticeDue(kind: LimitKind, userId: string): boolean {
		const p = this.periods();
		return this.opts.store.markOnce(
			`notice:${kind}`,
			userId,
			kind === "daily" ? p.day : p.month,
			this.opts.clock.now(),
		);
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
