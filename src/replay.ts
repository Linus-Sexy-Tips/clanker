// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory exact-turn cache. For each answered request it keeps the exact messages that
// were sent and the exact assistant content that came back, so a follow-up can send the
// same prefix byte for byte (prompt-cache hits, valid thinking blocks). Never written to disk.

import type { Clock, ContentBlock, MessageParam } from "./types.js";

export interface ReplayEntry {
	/** Config fingerprint (model, effort, system prompt, tools...) the entry was made with. */
	fingerprint: string;
	/** Exactly what was sent, ending with the user turn that was answered. */
	messages: MessageParam[];
	/** Exactly what came back (all blocks, across pause_turn continuations). */
	assistant: ContentBlock[];
	/** Size of messages + assistant in tokens (from usage), excluding system and tools. */
	tokens: number;
}

interface Slot {
	entry: ReplayEntry;
	ids: string[];
	bytes: number;
	lastUsed: number;
}

export interface ReplayOptions {
	ttlMs: number;
	maxBytes: number;
	clock: Clock;
	maxEntries?: number;
}

export class ReplayCache {
	private readonly byId = new Map<string, Slot>();
	/** Slots in least-recently-used order (Map keeps insertion order; we re-insert on use). */
	private readonly lru = new Map<Slot, true>();
	private totalBytes = 0;
	private readonly maxEntries: number;

	constructor(private readonly opts: ReplayOptions) {
		this.maxEntries = opts.maxEntries ?? 2000;
	}

	get size(): number {
		return this.lru.size;
	}

	get bytes(): number {
		return this.totalBytes;
	}

	get enabled(): boolean {
		return this.opts.ttlMs > 0 && this.opts.maxBytes > 0;
	}

	set(botMessageIds: string[], entry: ReplayEntry): void {
		if (!this.enabled || botMessageIds.length === 0) return;
		this.sweep();
		// Counts the whole entry, even when its prefix shares objects with an older entry.
		// That overestimates memory, which is the safe direction for a cap.
		const bytes = approxBytes(entry.messages) + approxBytes(entry.assistant);
		if (bytes > this.opts.maxBytes) return;
		for (const id of botMessageIds) {
			const old = this.byId.get(id);
			if (old) this.drop(old);
		}
		const slot: Slot = { entry, ids: [...botMessageIds], bytes, lastUsed: this.opts.clock.now() };
		for (const id of slot.ids) this.byId.set(id, slot);
		this.lru.set(slot, true);
		this.totalBytes += bytes;
		while (this.totalBytes > this.opts.maxBytes || this.lru.size > this.maxEntries) {
			const oldest = this.lru.keys().next().value;
			if (!oldest) break;
			this.drop(oldest);
		}
	}

	/** The live entry for a bot message, if it was made with the same config. */
	get(botMessageId: string, fingerprint: string): ReplayEntry | undefined {
		const slot = this.byId.get(botMessageId);
		if (!slot) return undefined;
		const now = this.opts.clock.now();
		if (now - slot.lastUsed > this.opts.ttlMs) {
			this.drop(slot);
			return undefined;
		}
		if (slot.entry.fingerprint !== fingerprint) return undefined;
		slot.lastUsed = now;
		this.lru.delete(slot);
		this.lru.set(slot, true);
		return slot.entry;
	}

	/** Drops expired entries. */
	sweep(): void {
		const now = this.opts.clock.now();
		for (const slot of this.lru.keys()) {
			if (now - slot.lastUsed <= this.opts.ttlMs) break; // LRU order: the rest are newer
			this.drop(slot);
		}
	}

	private drop(slot: Slot): void {
		if (!this.lru.delete(slot)) return;
		for (const id of slot.ids) if (this.byId.get(id) === slot) this.byId.delete(id);
		this.totalBytes -= slot.bytes;
	}
}

function approxBytes(value: unknown): number {
	if (value === undefined) return 0;
	try {
		return JSON.stringify(value).length;
	} catch {
		return 0;
	}
}

/** Bounded set of bot message IDs that are notices or command replies, not Claude answers. */
export class NoticeIds {
	private readonly ids = new Set<string>();

	constructor(private readonly max = 10_000) {}

	add(id: string): void {
		this.ids.delete(id);
		this.ids.add(id);
		while (this.ids.size > this.max) {
			const oldest = this.ids.values().next().value;
			if (oldest === undefined) break;
			this.ids.delete(oldest);
		}
	}

	has(id: string): boolean {
		return this.ids.has(id);
	}
}
