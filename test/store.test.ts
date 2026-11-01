// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import type { UsageRow } from "../src/types.js";

const row = (o: Partial<UsageRow>): UsageRow => ({
	ts: 1,
	userId: "u1",
	guildId: "g1",
	model: "claude-haiku-5-5",
	inputTokens: 10,
	outputTokens: 5,
	cacheWrite5mTokens: 100,
	cacheWrite1hTokens: 50,
	cacheReadTokens: 1000,
	webSearches: 1,
	webFetches: 2,
	cost: 1000,
	day: "2026-11-01",
	month: "2026-11",
	...o,
});

describe("Store", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("sums per user, day and month", () => {
		const s = Store.memory();
		s.insertUsage(row({}));
		s.insertUsage(row({ cost: 2500 }));
		s.insertUsage(row({ userId: "u2", cost: 7000 }));
		s.insertUsage(row({ day: "2026-11-02", cost: 400 }));
		s.insertUsage(row({ day: "2026-10-31", month: "2026-10", cost: 99_999 }));
		expect(s.sumUserDay("u1", "2026-11-01")).toBe(3500);
		expect(s.sumUserDay("nobody", "2026-11-01")).toBe(0);
		expect(s.sumUserMonth("u1", "2026-11")).toBe(3900);
		expect(s.sumMonth("2026-11")).toBe(10_900);
		expect(s.perUser("2026-11-02", "2026-11")).toEqual([
			{ userId: "u2", today: 0, month: 7000 },
			{ userId: "u1", today: 400, month: 3900 },
		]);
		const st = s.dayStats("2026-11-01");
		expect(st).toEqual({
			requests: 3,
			cost: 10_500,
			inputTokens: 30,
			cacheWriteTokens: 450,
			cacheReadTokens: 3000,
			webSearches: 3,
			webFetches: 6,
		});
		expect(s.dayStats("2030-01-01").requests).toBe(0);
		s.close();
	});

	it("markOnce is true only the first time", () => {
		const s = Store.memory();
		expect(s.markOnce("notice:daily", "u1", "2026-11-01")).toBe(true);
		expect(s.markOnce("notice:daily", "u1", "2026-11-01")).toBe(false);
		expect(s.markOnce("notice:daily", "u1", "2026-11-02")).toBe(true);
		expect(s.markOnce("notice:daily", "u2", "2026-11-01")).toBe(true);
	});

	it("persists across reopen and keeps its schema version", () => {
		const dir = mkdtempSync(join(tmpdir(), "clanker-store-"));
		dirs.push(dir);
		const path = join(dir, "ledger.db");
		const a = Store.open(path);
		a.insertUsage(row({ cost: 123 }));
		a.markOnce("alert", "monthly-80", "2026-11");
		a.close();
		const b = Store.open(path);
		expect(b.sumMonth("2026-11")).toBe(123);
		expect(b.markOnce("alert", "monthly-80", "2026-11")).toBe(false);
		b.close();
	});
});
