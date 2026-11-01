// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { formatUsd, tokenCost, usd } from "../src/money.js";

describe("money", () => {
	it("converts and formats", () => {
		expect(usd(5)).toBe(5_000_000);
		expect(usd(0.1)).toBe(100_000);
		expect(formatUsd(usd(5))).toBe("US$5.00");
		expect(formatUsd(usd(100))).toBe("US$100.00");
		expect(formatUsd(usd(0.123))).toBe("US$0.12");
		expect(formatUsd(usd(0.004))).toBe("US$0.004");
		expect(formatUsd(0)).toBe("US$0.00");
		expect(formatUsd(500)).toBe("<US$0.001");
	});
	it("prices per million tokens are micro-dollars per token", () => {
		// 100,000 tokens at $0.10 / MTok = $0.01 = 10,000 micros
		expect(tokenCost(100_000, 0.1)).toBeCloseTo(10_000);
	});
});
