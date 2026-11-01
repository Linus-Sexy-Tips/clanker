// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Guards } from "../src/guards.js";

function clock(start = 0) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("Guards", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("enforces the per-user cooldown", () => {
		const c = clock();
		const g = new Guards({ cooldownMs: 5000, maxConcurrent: 2, maxQueue: 2, clock: c });
		expect(g.checkCooldown("a")).toBe(true);
		expect(g.checkCooldown("a")).toBe(false);
		expect(g.checkCooldown("b")).toBe(true);
		c.advance(4999);
		expect(g.checkCooldown("a")).toBe(false);
		c.advance(1);
		expect(g.checkCooldown("a")).toBe(true);
	});

	it("zero cooldown always allows", () => {
		const g = new Guards({ cooldownMs: 0, maxConcurrent: 1, maxQueue: 0, clock: clock() });
		expect(g.checkCooldown("a")).toBe(true);
		expect(g.checkCooldown("a")).toBe(true);
	});

	it("rate-limits slow reactions and busy notices", () => {
		const c = clock();
		const g = new Guards({ cooldownMs: 0, maxConcurrent: 1, maxQueue: 0, clock: c });
		expect(g.slowReactionDue("a")).toBe(true);
		expect(g.slowReactionDue("a")).toBe(false);
		expect(g.busyNoticeDue("ch")).toBe(true);
		expect(g.busyNoticeDue("ch")).toBe(false);
		c.advance(60_000);
		expect(g.slowReactionDue("a")).toBe(true);
		expect(g.busyNoticeDue("ch")).toBe(true);
	});

	it("allows one request in flight per user", async () => {
		const g = new Guards({ cooldownMs: 0, maxConcurrent: 4, maxQueue: 4, clock: clock() });
		const a = await g.enter("a");
		expect(a.ok).toBe(true);
		expect(g.inFlight("a")).toBe(true);
		expect(await g.enter("a")).toEqual({ ok: false, reason: "busy_user" });
		if (a.ok) a.release();
		expect(g.inFlight("a")).toBe(false);
		expect((await g.enter("a")).ok).toBe(true);
	});

	it("queues FIFO, hands slots over, rejects when the queue is full", async () => {
		const g = new Guards({ cooldownMs: 0, maxConcurrent: 1, maxQueue: 1, clock: clock() });
		const a = await g.enter("a");
		const bP = g.enter("b");
		expect(g.queued).toBe(1);
		expect(await g.enter("c")).toEqual({ ok: false, reason: "queue_full" });
		expect(await g.enter("b")).toEqual({ ok: false, reason: "busy_user" });
		if (a.ok) a.release();
		const b = await bP;
		expect(b.ok).toBe(true);
		expect(g.active).toBe(1);
		expect(g.queued).toBe(0);
		if (b.ok) {
			b.release();
			b.release(); // idempotent
		}
		expect(g.active).toBe(0);
	});

	it("times out queued requests", async () => {
		const g = new Guards({ cooldownMs: 0, maxConcurrent: 1, maxQueue: 1, clock: clock(), queueTimeoutMs: 1000 });
		const a = await g.enter("a");
		const bP = g.enter("b");
		vi.advanceTimersByTime(1000);
		expect(await bP).toEqual({ ok: false, reason: "timeout" });
		expect(g.inFlight("b")).toBe(false);
		expect(g.queued).toBe(0);
		if (a.ok) a.release();
		expect(g.active).toBe(0);
	});
});
