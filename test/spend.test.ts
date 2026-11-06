// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PRICES, parseConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { cacheWrites, costOf, Spend } from "../src/spend.js";
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
	const { config, prices, pro } = parseConfig(`owner_id = "1"\n${extra}`, env);
	const store = Store.memory();
	const spend = new Spend({
		config,
		prices,
		pro,
		store,
		clock,
		log: createLogger({ level: "error", write: () => {} }),
	});
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

	it("charges writes from later tool iterations (beyond message_start's split) at the 5-minute rate", () => {
		const u = usage({
			input_tokens: 1000,
			output_tokens: 2000,
			cache_creation_input_tokens: 85_000,
			cache_creation: { ephemeral_5m_input_tokens: 50_000, ephemeral_1h_input_tokens: 3_000 },
			cache_read_input_tokens: 400_000,
			server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 },
		});
		expect(cacheWrites(u)).toEqual({ w5m: 82_000, w1h: 3_000 });
		// Long-context card: 1000*0.5 + 82000*0.625 + 3000*1.0 + 400000*0.05 + 2000*2.5 + 3*10000
		expect(costOf(u, haiku)).toBe(500 + 51_250 + 3_000 + 20_000 + 5_000 + 30_000);
		expect(
			cacheWrites(
				usage({
					cache_creation_input_tokens: 10_000,
					cache_creation: {
						ephemeral_5m_input_tokens: 1_000,
						ephemeral_1h_input_tokens: 2_000,
					},
				}),
			),
		).toEqual({ w5m: 8_000, w1h: 2_000 });
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

	it("lets a request start while the user is under the daily cap, and stops them once they reach it", () => {
		const { spend } = setup("[limits]\nuser_daily_usd = 0.50");
		expect(spend.check("u1", []).ok).toBe(true);
		spend.record("u1", null, "m", usage({ output_tokens: 900_000 })); // $0.45: still under
		expect(spend.check("u1", []).ok).toBe(true);
		spend.record("u1", null, "m", usage({ output_tokens: 200_000 })); // $0.55: the last request went over
		expect(spend.check("u1", [])).toMatchObject({
			ok: false,
			limit: "daily",
			cap: 500_000,
			resetAt: Date.parse("2026-11-02T00:00:00Z"),
		});
		expect(spend.check("u2", []).ok).toBe(true); // other users unaffected
	});

	it("blocks everyone with a cap of 0", () => {
		const { spend } = setup("[limits]\nuser_daily_usd = 0");
		expect(spend.check("u1", [])).toMatchObject({ ok: false, limit: "daily" });
	});

	it("records every cache write, split by TTL", () => {
		const { spend, store } = setup();
		const insert = vi.spyOn(store, "insertUsage");
		spend.record(
			"u1",
			null,
			"m",
			usage({
				input_tokens: 1000,
				cache_creation_input_tokens: 85_000,
				cache_creation: { ephemeral_5m_input_tokens: 50_000, ephemeral_1h_input_tokens: 3_000 },
			}),
		);
		expect(insert.mock.calls[0]?.[0]).toMatchObject({ cacheWrite5mTokens: 82_000, cacheWrite1hTokens: 3_000 });
		expect(store.dayStats("2026-11-01")).toMatchObject({ cacheWriteTokens: 85_000 });
	});

	it("counts recorded spend and blocks at the monthly cap first", () => {
		const { spend } = setup("[limits]\nmonthly_usd = 1.00");
		spend.record("u1", "g", "claude-haiku-5-5", usage({ output_tokens: 1_850_000 })); // $0.925 (small prompt: base rates)
		expect(spend.usage("u1")).toEqual({ today: 925_000, month: 925_000 });
		expect(spend.check("u2", []).ok).toBe(true); // $0.925 < $1.00
		spend.record("u1", "g", "claude-haiku-5-5", usage({ output_tokens: 200_000 })); // $1.025
		expect(spend.check("u2", [])).toMatchObject({
			ok: false,
			limit: "monthly",
			cap: 1_000_000,
			resetAt: Date.parse("2026-12-01T00:00:00Z"),
		});
	});

	it("raises the 80% and 100% monthly alerts once each", () => {
		const { spend } = setup("[limits]\nmonthly_usd = 1.00");
		expect(spend.record("u1", null, "m", usage({ output_tokens: 1_000_000 })).alerts).toEqual([]); // $0.50
		expect(spend.record("u1", null, "m", usage({ output_tokens: 600_000 })).alerts).toEqual([80]); // $0.80
		expect(spend.record("u1", null, "m", usage({ output_tokens: 100_000 })).alerts).toEqual([]); // $0.85
		expect(spend.record("u1", null, "m", usage({ output_tokens: 300_000 })).alerts).toEqual([100]); // $1.00
		expect(spend.record("u1", null, "m", usage({ output_tokens: 100_000 })).alerts).toEqual([]); // $1.05
	});

	it("skips the 80% alert when one call takes spend past the cap", () => {
		const { spend } = setup("[limits]\nmonthly_usd = 1.00");
		expect(spend.record("u1", null, "m", usage({ output_tokens: 2_200_000 })).alerts).toEqual([100]); // $1.10
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

describe("daily reset", () => {
	it("clears today's spend and the notice flag, but not the monthly total", () => {
		const { spend, advance } = setup("[limits]\nuser_daily_usd = 0.50");
		spend.record("u1", null, "m", usage({ output_tokens: 1_200_000 })); // $0.60
		expect(spend.check("u1", []).ok).toBe(false);
		expect(spend.noticeDue("daily", "u1")).toBe(true);
		advance(1);
		expect(spend.resetDaily("u1")).toBe(600_000);
		expect(spend.usage("u1").today).toBe(0);
		expect(spend.monthTotal()).toBe(600_000);
		expect(spend.noticeDue("daily", "u1")).toBe(true);
		expect(spend.check("u1", []).ok).toBe(true);
		advance(1);
		spend.record("u1", null, "m", usage({ output_tokens: 200_000 })); // $0.10 after the reset
		expect(spend.usage("u1").today).toBe(100_000);
	});
});

describe("pro tier", () => {
	const PRO = "[pro]\nenabled = true\n[limits]\nmonthly_usd = 150";

	it("gives pro users the pro daily cap, and only them", () => {
		const { spend } = setup(PRO);
		expect(spend.userCap("9", [], true)).toBe(10_000_000);
		expect(spend.userCap("9", [], false)).toBe(5_000_000);
	});

	it("keeps a higher override for a pro user", () => {
		const { spend } = setup(`${PRO}\n[[limits.overrides]]\nuser = "9"\nuser_daily_usd = 20`);
		expect(spend.userCap("9", [], true)).toBe(20_000_000);
	});

	it("lets a pro user go until they reach the pro cap", () => {
		const { spend } = setup(PRO);
		spend.record("9", null, "claude-sonnet-5-5", usage({ output_tokens: 900_000 }), true); // $9
		expect(spend.check("9", [], true).ok).toBe(true);
		spend.record("9", null, "claude-sonnet-5-5", usage({ output_tokens: 200_000 }), true); // $11
		expect(spend.check("9", [], true)).toMatchObject({ ok: false, limit: "daily", cap: 10_000_000 });
	});

	it("records pro calls at the pro model's prices", () => {
		const { spend } = setup(PRO);
		const rec = spend.record("9", null, "claude-sonnet-5-5", usage({ input_tokens: 50_000 }), true);
		expect(rec.cost).toBe(100_000);
		const std = spend.record("8", null, "claude-haiku-5-5", usage({ input_tokens: 50_000 }));
		expect(std.cost).toBe(5_000);
	});

	it("uses the standard cap when [pro] is off", () => {
		const { spend } = setup();
		expect(spend.userCap("9", [], true)).toBe(5_000_000);
	});
});
