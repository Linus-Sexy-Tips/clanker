// SPDX-License-Identifier: AGPL-3.0-or-later
// Abuse guards: per-user cooldown, one request in flight per user, and a global
// concurrency limit with a short FIFO queue. All of this is plain code; nothing here costs money.

import type { Clock } from "./types.js";

export type EnterResult =
	| { ok: true; release: () => void }
	| { ok: false; reason: "busy_user" | "queue_full" | "timeout" };

interface Waiter {
	grant: () => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface GuardsOptions {
	cooldownMs: number;
	maxConcurrent: number;
	maxQueue: number;
	clock: Clock;
	queueTimeoutMs?: number;
	reactionIntervalMs?: number;
}

export class Guards {
	private readonly lastAccepted = new Map<string, number>();
	private readonly lastSlowReaction = new Map<string, number>();
	private readonly lastBusyNotice = new Map<string, number>();
	private readonly users = new Set<string>();
	private readonly waiters: Waiter[] = [];
	private running = 0;
	private readonly queueTimeoutMs: number;
	private readonly reactionIntervalMs: number;

	constructor(private readonly opts: GuardsOptions) {
		this.queueTimeoutMs = opts.queueTimeoutMs ?? 60_000;
		this.reactionIntervalMs = opts.reactionIntervalMs ?? 60_000;
	}

	get active(): number {
		return this.running;
	}

	get queued(): number {
		return this.waiters.length;
	}

	/** True if the user may trigger now; starts their cooldown. */
	checkCooldown(userId: string): boolean {
		const now = this.opts.clock.now();
		const last = this.lastAccepted.get(userId);
		if (last !== undefined && now - last < this.opts.cooldownMs) return false;
		this.lastAccepted.set(userId, now);
		this.prune(this.lastAccepted, now, Math.max(this.opts.cooldownMs, 1));
		return true;
	}

	/** True at most once per interval per user (for the 🐢 reaction). */
	slowReactionDue(userId: string): boolean {
		return this.due(this.lastSlowReaction, userId);
	}

	/** True at most once per interval per channel (for the busy notice). */
	busyNoticeDue(channelId: string): boolean {
		return this.due(this.lastBusyNotice, channelId);
	}

	inFlight(userId: string): boolean {
		return this.users.has(userId);
	}

	/**
	 * Claims the user's single in-flight slot, then a global slot. Waits in a FIFO
	 * queue when all global slots are busy, up to queueTimeoutMs.
	 */
	async enter(userId: string): Promise<EnterResult> {
		if (this.users.has(userId)) return { ok: false, reason: "busy_user" };
		if (this.running < this.opts.maxConcurrent) {
			this.users.add(userId);
			this.running++;
			return { ok: true, release: this.releaser(userId) };
		}
		if (this.waiters.length >= this.opts.maxQueue) return { ok: false, reason: "queue_full" };

		// Hold the user's slot while queued so they can't queue twice.
		this.users.add(userId);
		const granted = await new Promise<boolean>((resolve) => {
			const waiter: Waiter = {
				grant: () => {
					clearTimeout(waiter.timer);
					resolve(true);
				},
				timer: setTimeout(() => {
					const i = this.waiters.indexOf(waiter);
					if (i >= 0) this.waiters.splice(i, 1);
					resolve(false);
				}, this.queueTimeoutMs),
			};
			this.waiters.push(waiter);
		});
		if (!granted) {
			this.users.delete(userId);
			return { ok: false, reason: "timeout" };
		}
		// The releasing request handed its global slot over to us (running unchanged).
		return { ok: true, release: this.releaser(userId) };
	}

	private releaser(userId: string): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.users.delete(userId);
			const next = this.waiters.shift();
			if (next) next.grant();
			else this.running--;
		};
	}

	private due(map: Map<string, number>, key: string): boolean {
		const now = this.opts.clock.now();
		const last = map.get(key);
		if (last !== undefined && now - last < this.reactionIntervalMs) return false;
		map.set(key, now);
		this.prune(map, now, this.reactionIntervalMs);
		return true;
	}

	/** Keeps the maps from growing forever: drops entries older than maxAge once they get big. */
	private prune(map: Map<string, number>, now: number, maxAge: number): void {
		if (map.size < 1000) return;
		for (const [k, t] of map) if (now - t >= maxAge) map.delete(k);
	}
}
