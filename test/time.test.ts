// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
	dayKey,
	formatDuration,
	formatLabelTime,
	isValidTimeZone,
	monthKey,
	nextDayStart,
	nextMonthStart,
	weekday,
} from "../src/time.js";

const iso = (s: string) => Date.parse(s);

describe("period keys", () => {
	it("uses the configured zone", () => {
		const t = iso("2026-11-01T05:30:00Z"); // 2026-10-31 22:30 in Vancouver
		expect(dayKey(t, "UTC")).toBe("2026-11-01");
		expect(dayKey(t, "America/Vancouver")).toBe("2026-10-31");
		expect(monthKey(t, "America/Vancouver")).toBe("2026-10");
		expect(monthKey(t, "UTC")).toBe("2026-11");
	});
});

describe("next period start", () => {
	it("UTC midnight", () => {
		expect(nextDayStart(iso("2026-11-01T14:05:00Z"), "UTC")).toBe(iso("2026-11-02T00:00:00Z"));
		expect(nextMonthStart(iso("2026-11-15T14:05:00Z"), "UTC")).toBe(iso("2026-12-01T00:00:00Z"));
		expect(nextMonthStart(iso("2026-12-31T23:59:00Z"), "UTC")).toBe(iso("2027-01-01T00:00:00Z"));
	});
	it("across a DST change (Los Angeles falls back on 2026-11-01)", () => {
		// 2026-11-01 00:30 PDT = 07:30Z; next midnight is 2026-11-02 00:00 PST = 08:00Z
		// (Not Vancouver: tzdata 2026e keeps British Columbia on UTC-7 all year.)
		expect(nextDayStart(iso("2026-11-01T07:30:00Z"), "America/Los_Angeles")).toBe(iso("2026-11-02T08:00:00Z"));
		// spring forward 2027-03-14 (Los Angeles): midnight 2027-03-15 is PDT = 07:00Z
		expect(nextDayStart(iso("2027-03-14T12:00:00Z"), "America/Los_Angeles")).toBe(iso("2027-03-15T07:00:00Z"));
	});
	it("handles a zone whose midnight is skipped by DST", () => {
		// America/Santiago springs forward at 24:00 -> 01:00 (first Sunday of September 2026 is 2026-09-06)
		const start = nextDayStart(iso("2026-09-05T15:00:00Z"), "America/Santiago");
		expect(dayKey(start, "America/Santiago")).toBe("2026-09-06");
		expect(dayKey(start - 60_000, "America/Santiago")).toBe("2026-09-05");
	});
	it("next month in a zone behind UTC", () => {
		expect(nextMonthStart(iso("2026-11-15T12:00:00Z"), "America/Los_Angeles")).toBe(iso("2026-12-01T08:00:00Z"));
	});
});

describe("formatting", () => {
	it("labels", () => {
		expect(formatLabelTime(iso("2026-11-01T22:05:00Z"), "America/Los_Angeles")).toBe("2026-11-01 14:05 PST");
		expect(formatLabelTime(iso("2026-11-01T22:05:00Z"), "UTC")).toBe("2026-11-01 22:05 UTC");
		expect(weekday(iso("2026-11-01T22:05:00Z"), "UTC")).toBe("Sunday");
	});
	it("durations", () => {
		expect(formatDuration(0)).toBe("less than 1 min");
		expect(formatDuration(45 * 60_000)).toBe("45 min");
		expect(formatDuration((3 * 60 + 12) * 60_000 + 5_000)).toBe("3 h 12 min");
		expect(formatDuration(2 * 3_600_000)).toBe("2 h");
		expect(formatDuration((2 * 24 + 4) * 3_600_000)).toBe("2 d 4 h");
	});
	it("validates zones", () => {
		expect(isValidTimeZone("America/Vancouver")).toBe(true);
		expect(isValidTimeZone("Mars/Base")).toBe(false);
	});
});
