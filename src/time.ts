// SPDX-License-Identifier: AGPL-3.0-or-later
// Time-zone helpers built on Intl. Cap periods and chain labels use the configured zone.

export interface ZonedParts {
	year: number;
	month: number; // 1-12
	day: number;
	hour: number;
	minute: number;
	second: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
	let f = partFormatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		partFormatters.set(tz, f);
	}
	return f;
}

export function isValidTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

export function zonedParts(ts: number, tz: string): ZonedParts {
	const out: Record<string, number> = {};
	for (const p of partsFormatter(tz).formatToParts(new Date(ts))) {
		if (p.type !== "literal") out[p.type] = Number(p.value);
	}
	return {
		year: out.year ?? 0,
		month: out.month ?? 0,
		day: out.day ?? 0,
		hour: (out.hour ?? 0) % 24,
		minute: out.minute ?? 0,
		second: out.second ?? 0,
	};
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "YYYY-MM-DD" of the day containing ts, in tz. */
export function dayKey(ts: number, tz: string): string {
	const p = zonedParts(ts, tz);
	return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** "YYYY-MM" of the month containing ts, in tz. */
export function monthKey(ts: number, tz: string): string {
	const p = zonedParts(ts, tz);
	return `${pad(p.year, 4)}-${pad(p.month)}`;
}

/** Offset of tz from UTC at instant ts, in ms (local = utc + offset). */
function offsetAt(ts: number, tz: string): number {
	const p = zonedParts(ts, tz);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	return asUtc - Math.floor(ts / 1000) * 1000;
}

/** First instant at or after local midnight of the given local date (handles DST gaps). */
function localMidnight(year: number, month: number, day: number, tz: string): number {
	const wall = Date.UTC(year, month - 1, day, 0, 0, 0);
	let t = wall - offsetAt(wall, tz);
	for (let i = 0; i < 3; i++) {
		const next = wall - offsetAt(t, tz);
		if (next === t) break;
		t = next;
	}
	// If midnight falls in a DST gap, t may land before the new day; step forward to the first instant of it.
	const target = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
	if (dayKey(t, tz) < target) {
		let lo = t;
		let hi = t + 3 * 3_600_000;
		while (hi - lo > 60_000) {
			const mid = Math.floor((lo + hi) / 2);
			if (dayKey(mid, tz) < target) lo = mid;
			else hi = mid;
		}
		t = hi - (hi % 60_000);
		while (dayKey(t, tz) < target) t += 60_000;
	}
	return t;
}

/** Start of the next local day after ts. */
export function nextDayStart(ts: number, tz: string): number {
	const p = zonedParts(ts, tz);
	const d = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
	return localMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), tz);
}

/** Start of the next local month after ts. */
export function nextMonthStart(ts: number, tz: string): number {
	const p = zonedParts(ts, tz);
	const d = new Date(Date.UTC(p.year, p.month, 1));
	return localMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, tz);
}

const zoneNameFormatters = new Map<string, Intl.DateTimeFormat>();

/** Short zone name at ts, e.g. "PST", "UTC", "GMT+2". */
export function zoneName(ts: number, tz: string): string {
	let f = zoneNameFormatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" });
		zoneNameFormatters.set(tz, f);
	}
	return f.formatToParts(new Date(ts)).find((p) => p.type === "timeZoneName")?.value ?? tz;
}

/** "2026-11-01 14:05 PST" */
export function formatLabelTime(ts: number, tz: string): string {
	const p = zonedParts(ts, tz);
	return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${zoneName(ts, tz)}`;
}

/** "2026-11-01" in tz. */
export function formatDate(ts: number, tz: string): string {
	return dayKey(ts, tz);
}

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

/** "Sunday" in tz. */
export function weekday(ts: number, tz: string): string {
	let f = weekdayFormatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" });
		weekdayFormatters.set(tz, f);
	}
	return f.format(new Date(ts));
}

/** Human duration: "3 h 12 min", "45 min", "less than 1 min", "2 d 4 h". */
export function formatDuration(ms: number): string {
	const totalMin = Math.floor(Math.max(0, ms) / 60_000);
	if (totalMin < 1) return "less than 1 min";
	const d = Math.floor(totalMin / 1440);
	const h = Math.floor((totalMin % 1440) / 60);
	const m = totalMin % 60;
	if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
	if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
	return `${m} min`;
}
