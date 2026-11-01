// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { helpText, notices, statusText, usageAllText, usageText } from "../src/commands.js";

describe("command texts", () => {
	it("help mentions the AI, the caps, the data flow and the source", () => {
		const t = helpText({
			botName: "Clanker",
			model: "claude-haiku-5-5",
			effort: "medium",
			dailyCap: 5_000_000,
			monthlyCap: 100_000_000,
			sourceUrl: "https://github.com/Linus-Sexy-Tips/clanker",
			webSearch: true,
			webFetch: true,
			dms: true,
		});
		expect(t).toMatch(/AI assistant/);
		expect(t).toMatch(/US\$5\.00 per person per day/);
		expect(t).toMatch(/US\$100\.00 per month/);
		expect(t).toMatch(/sent to Anthropic/);
		expect(t).toMatch(/AGPL-3\.0\): <https:\/\/github\.com\/Linus-Sexy-Tips\/clanker>/);
		expect(t).toMatch(/DM me/);
		expect(t.length).toBeLessThan(4000);
	});

	it("usage", () => {
		const now = Date.parse("2026-11-01T20:48:00Z");
		const t = usageText({
			today: 120_000,
			dailyCap: 5_000_000,
			month: 12_340_000,
			monthlyCap: 100_000_000,
			now,
			dayResetAt: Date.parse("2026-11-02T00:00:00Z"),
			monthResetAt: Date.parse("2026-12-01T00:00:00Z"),
			timezone: "UTC",
		});
		expect(t).toBe(
			"Your usage today: US$0.12 of US$5.00 (resets in 3 h 12 min).\nEveryone this month: US$12.34 of US$100.00 (resets on 2026-12-01).",
		);
	});

	it("usage all caps the rows", () => {
		const rows = Array.from({ length: 60 }, (_, i) => ({ userId: String(i + 1), today: 0, month: 1000 }));
		const t = usageAllText({ rows, month: 60_000, monthlyCap: 100_000_000 });
		expect(t).toMatch(/<@1>: US\$0\.001 this month/);
		expect(t).toMatch(/and 10 more/);
		expect(t.length).toBeLessThan(4000);
		expect(usageAllText({ rows: [], month: 0, monthlyCap: 1 })).toMatch(/No requests/);
	});

	it("status shows the cache hit rate", () => {
		const t = statusText({
			version: "0.1.0",
			uptimeMs: 3_600_000,
			connection: "connected",
			model: "claude-haiku-5-5",
			effort: "medium",
			guilds: [{ id: "300", name: "Home" }],
			today: {
				requests: 4,
				cost: 50_000,
				inputTokens: 100,
				cacheWriteTokens: 100,
				cacheReadTokens: 800,
				webSearches: 1,
				webFetches: 0,
			},
			month: 1_000_000,
			monthlyCap: 100_000_000,
			replayEntries: 3,
			active: 1,
			queued: 0,
		});
		expect(t).toMatch(/80% of prompt tokens/);
		expect(t).toMatch(/Home \(300\)/);
	});

	it("too-long notice", () => {
		expect(notices.tooLong(51, 52_000, 50_000)).toMatch(/51 messages, about 52,000 tokens; my limit is 50,000/);
	});
});
