// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_PRICES, parseConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { costOf, estimateCall, Spend } from "../src/spend.js";
import { Store } from "../src/store.js";
import type { Usage } from "../src/types.js";

const env = { FLUXER_BOT_TOKEN: "1.x", ANTHROPIC_API_KEY: "k" };
const haiku = DEFAULT_PRICES["claude-haiku-5-5"]!;

function usage(o: Partial<Usage> = {}): Usage {
	return {
		input_tokens: 0,
		output_tokens: 0,
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

function setup(extra = "", start = Date.parse("2026-11-01T12:00:00Z")) {
	let now = start;
	const clock = { now: () => now };
	const { config, prices } = parseConfig(`owner_id = "1"\n${extra}`, env);
	const store = Store.memory();
	const spend = new Spend({ config, prices, store, clock, log: createLogger({ level: "error", write: () => {} }) });
	return { spend, store, config, advance: (ms: number) => (now += ms), setNow: (t: number) => (now = t) };
}

describe("costOf", () => {
	it("prices every part of usage", () => {
		const u = usage({
			input_tokens: 1000,
			output_tokens: 2000,
			cache_creation_input_tokens: 3000,
			cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
			cache_read_input_tokens: 50_000,
			server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
		});
		// 1000*0.1 + 1000*0.125 + 2000*0.2 + 50000*0.01 + 2000*0.5 + 2*10000 micros
		expect(costOf(u, haiku)).toBe(100 + 125 + 400 + 500 + 1000 + 20_000);
	});

	it("switches the whole call to the long-context tier above the threshold (cached tokens count)", () => {
		const below = usage({ input_tokens: 10_000, cache_read_input_tokens: 90_000, output_tokens: 1000 });
		const above = usage({ input_tokens: 10_001, cache_read_input_tokens: 90_000, output_tokens: 1000 });
		expect(costOf(below, haiku)).toBe(1000 + 900 + 500);
		expect(costOf(above, haiku)).toBe(Math.ceil(10_001 * 0.5 + 90_000 * 0.05 + 1000 * 2.5));
	});

	it("charges cache writes without a breakdown at the 1-hour rate", () => {
		const u = usage({ cache_creation_input_tokens: 1000, cache_creation: null });
		expect(costOf(u, haiku)).toBe(200);
	});
});

describe("estimateCall", () => {
	it("is about ten cents with the defaults on Haiku 5.5", () => {
		const { config } = setup();
		// 100k * 0.1 * 7 + 8000 * 0.5 + 3 * 10000
		expect(estimateCall(config, haiku)).toBe(70_000 + 4_000 + 30_000);
	});
	it("drops disabled tools", () => {
		const { config } = setup("[tools.web_search]\nenabled = false\n[tools.web_fetch]\nenabled = false");
		expect(estimateCall(config, haiku)).toBe(10_000 + 4_000);
	});
});

describe("Spend", () => {
	it("applies the highest matching override", () => {
		const { spend } = setup(
			'[[limits.overrides]]\nrole = "7"\nuser_daily_usd = 10\n[[limits.overrides]]\nuser = "2"\nuser_daily_usd = 2\n[[limits.overrides]]\nuser = "3"\nuser_daily_usd = 20',
		);
		expect(spend.userCap("u1", [])).toBe(5_000_000);
		expect(spend.userCap("u1", ["7"])).toBe(10_000_000);
		expect(spend.userCap("2", [])).toBe(5_000_000); // lower override doesn't reduce the default
		expect(spend.userCap("3", ["7"])).toBe(20_000_000);
	});

	it("reserves against the daily cap, counting open reservations, and releases", () => {
		const { spend } = setup("[limits]\nuser_daily_usd = 0.25");
		const a = spend.reserve("u1", []);
		const b = spend.reserve("u1", []);
		expect(a.ok && b.ok).toBe(true);
		const c = spend.reserve("u1", []);
		expect(c).toMatchObject({ ok: false, limit: "daily", cap: 250_000, resetAt: Date.parse("2026-11-02T00:00:00Z") });
		expect(spend.reserve("u2", []).ok).toBe(true); // other users unaffected
		if (a.ok) {
			a.reservation.release();
			a.reservation.release(); // idempotent
		}
		expect(spend.reserve("u1", []).ok).toBe(true);
	});

	it("counts recorded spend and blocks at the monthly cap first", () => {
		const { spend } = setup("[limits]\nmonthly_usd = 1.00");
		spend.record("u1", "g", "claude-haiku-5-5", usage({ output_tokens: 1_850_000 })); // $0.925
		expect(spend.usage("u1")).toEqual({ today: 925_000, month: 925_000 });
		const r = spend.reserve("u2", []);
		expect(r).toMatchObject({
			ok: false,
			limit: "monthly",
			cap: 1_000_000,
			resetAt: Date.parse("2026-12-01T00:00:00Z"),
		});
	});

	it("raises the 80% and 100% monthly alerts once each", () => {
		const { spend } = setup("[limits]\nmonthly_usd = 1.00");
		expect(spend.record("u1", null, "m", usage({ output_tokens: 1_000_000 })).alerts).toEqual([]); // $0.50
		expect(spend.record("u1", null, "m", usage({ output_tokens: 700_000 })).alerts).toEqual([80]); // $0.85
		expect(spend.record("u1", null, "m", usage({ output_tokens: 100_000 })).alerts).toEqual([]); // $0.90
		expect(spend.record("u1", null, "m", usage({ output_tokens: 300_000 })).alerts).toEqual([100]); // $1.05
		expect(spend.record("u1", null, "m", usage({ output_tokens: 1 })).alerts).toEqual([]);
	});

	it("uses the configured timezone for periods", () => {
		// 2026-11-01 05:00Z is still 2026-10-31 in Los Angeles
		const { spend } = setup('timezone = "America/Los_Angeles"', Date.parse("2026-11-01T05:00:00Z"));
		const p = spend.periods();
		expect(p.day).toBe("2026-10-31");
		expect(p.month).toBe("2026-10");
		expect(p.dayResetAt).toBe(Date.parse("2026-11-01T07:00:00Z"));
		expect(p.monthResetAt).toBe(Date.parse("2026-11-01T07:00:00Z"));
	});

	it("sends each limit notice once per user per period", () => {
		const { spend, advance } = setup();
		expect(spend.noticeDue("daily", "u1")).toBe(true);
		expect(spend.noticeDue("daily", "u1")).toBe(false);
		expect(spend.noticeDue("daily", "u2")).toBe(true);
		expect(spend.noticeDue("monthly", "u1")).toBe(true);
		advance(24 * 3_600_000);
		expect(spend.noticeDue("daily", "u1")).toBe(true);
		expect(spend.noticeDue("monthly", "u1")).toBe(false);
	});

	it("writes the notice texts from the design", () => {
		const { spend } = setup("", Date.parse("2026-11-01T20:48:00Z"));
		expect(spend.limitNotice("daily", 5_000_000, Date.parse("2026-11-02T00:00:00Z"), "<@5>")).toBe(
			"<@5>, you've reached your daily limit of US$5.00. It resets at midnight UTC (in 3 h 12 min).",
		);
		expect(spend.limitNotice("daily", 5_000_000, Date.parse("2026-11-02T00:00:00Z"), "")).toMatch(/^You've reached/);
		expect(spend.limitNotice("monthly", 100_000_000, Date.parse("2026-12-01T00:00:00Z"), "<@5>")).toBe(
			"I've reached my monthly spend limit of US$100.00. It resets on 2026-12-01.",
		);
	});
});
