// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { NoticeIds, ReplayCache, type ReplayEntry } from "../src/replay.js";

function clock() {
	let t = 0;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

const entry = (fp = "fp", text = "hi"): ReplayEntry => ({
	fingerprint: fp,
	messages: [{ role: "user", content: [{ type: "text", text }] }],
	assistant: [{ type: "text", text: "hello", citations: null }],
	tokens: 10,
});

describe("ReplayCache", () => {
	it("maps every part ID to the entry and checks the fingerprint", () => {
		const c = clock();
		const r = new ReplayCache({ ttlMs: 300_000, maxBytes: 1_000_000, clock: c });
		const e = entry();
		r.set(["m1", "m2"], e);
		expect(r.get("m1", "fp")).toBe(e);
		expect(r.get("m2", "fp")).toBe(e);
		expect(r.get("m2", "other")).toBeUndefined();
		expect(r.get("m3", "fp")).toBeUndefined();
		expect(r.size).toBe(1);
	});

	it("expires entries after the TTL since last use, and use refreshes it", () => {
		const c = clock();
		const r = new ReplayCache({ ttlMs: 1000, maxBytes: 1_000_000, clock: c });
		r.set(["m1"], entry());
		c.advance(900);
		expect(r.get("m1", "fp")).toBeDefined();
		c.advance(900);
		expect(r.get("m1", "fp")).toBeDefined();
		c.advance(1001);
		expect(r.get("m1", "fp")).toBeUndefined();
		expect(r.size).toBe(0);
		expect(r.bytes).toBe(0);
	});

	it("evicts least recently used entries over the byte or count cap", () => {
		const c = clock();
		const one = JSON.stringify(entry().messages).length + JSON.stringify(entry().assistant).length;
		const r = new ReplayCache({ ttlMs: 10_000, maxBytes: one * 2, clock: c });
		r.set(["a"], entry());
		r.set(["b"], entry());
		expect(r.get("a", "fp")).toBeDefined(); // a is now most recent
		r.set(["c"], entry());
		expect(r.get("b", "fp")).toBeUndefined();
		expect(r.get("a", "fp")).toBeDefined();
		expect(r.get("c", "fp")).toBeDefined();
		const small = new ReplayCache({ ttlMs: 10_000, maxBytes: 1e9, clock: c, maxEntries: 1 });
		small.set(["a"], entry());
		small.set(["b"], entry());
		expect(small.size).toBe(1);
		expect(small.get("a", "fp")).toBeUndefined();
	});

	it("is disabled with a zero TTL", () => {
		const r = new ReplayCache({ ttlMs: 0, maxBytes: 1e9, clock: clock() });
		r.set(["a"], entry());
		expect(r.size).toBe(0);
	});

	it("replaces an entry when an ID is reused", () => {
		const r = new ReplayCache({ ttlMs: 10_000, maxBytes: 1e9, clock: clock() });
		r.set(["a", "b"], entry("fp", "one"));
		const e2 = entry("fp", "two");
		r.set(["b"], e2);
		expect(r.get("b", "fp")).toBe(e2);
		expect(r.get("a", "fp")).toBeUndefined();
		expect(r.size).toBe(1);
	});
});

describe("NoticeIds", () => {
	it("is bounded", () => {
		const n = new NoticeIds(2);
		n.add("1");
		n.add("2");
		n.add("3");
		expect(n.has("1")).toBe(false);
		expect(n.has("2")).toBe(true);
		expect(n.has("3")).toBe(true);
	});
});
