// SPDX-License-Identifier: AGPL-3.0-or-later
// Money helpers. Internally all amounts are integer micro-dollars (Micros).
// Handy fact: a price in USD per million tokens is the same number in micro-dollars per token.

import type { Micros } from "./types.js";

export const MICROS_PER_USD = 1_000_000;

/** Converts dollars to micro-dollars, rounding to the nearest micro-dollar. */
export function usd(dollars: number): Micros {
	return Math.round(dollars * MICROS_PER_USD);
}

/** Cost of `tokens` at `usdPerMTok` dollars per million tokens, in (fractional) micro-dollars. */
export function tokenCost(tokens: number, usdPerMTok: number): number {
	return tokens * usdPerMTok;
}

/**
 * Formats micro-dollars for people: "US$5.00", "US$0.12", and for small non-zero
 * amounts below one cent up to three significant decimals, e.g. "US$0.004".
 */
export function formatUsd(amount: Micros): string {
	const sign = amount < 0 ? "-" : "";
	const abs = Math.abs(amount);
	if (abs === 0) return "US$0.00";
	if (abs < 10_000) {
		// Below one cent: show up to 3 decimals, at least one significant digit.
		const dollars = abs / MICROS_PER_USD;
		const text = dollars < 0.001 ? "0.001" : dollars.toFixed(3);
		return `${sign}${dollars < 0.001 ? "<" : ""}US$${text}`;
	}
	return `${sign}US$${(abs / MICROS_PER_USD).toFixed(2)}`;
}
