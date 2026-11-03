// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
	type BuildResult,
	buildChain,
	type ChainDeps,
	type ChainLimits,
	contextLine,
	displayName,
	EARLIER_MESSAGES_UNAVAILABLE,
	estimateTokens,
	formatSize,
	IMAGE_TOKENS,
	imageByteLimit,
	imageTokens,
	MAX_IMAGE_BYTES,
	THREAD_ANSWER_UNAVAILABLE,
} from "../src/chain.js";
import { createLogger } from "../src/log.js";
import { NoticeIds, ReplayCache, type ReplayEntry } from "../src/replay.js";
import {
	type ChatAttachment,
	type ChatMessage,
	type FluxerApi,
	FluxerRequestError,
	type GuildInfo,
	type MessageParam,
} from "../src/types.js";
import { chatMessage, chatUser, testClock } from "./helpers.js";

// ---------------------------------------------------------------- fixtures

const BOT = "42";
const FP = "fingerprint-1";
const TZ = "America/Los_Angeles";
/** Sunday 2026-11-01 04:00 PST in Los Angeles (DST ended at 09:00 UTC that day; Vancouver stays on PDT per tzdata 2026e). */
const T0 = Date.parse("2026-11-01T12:00:00Z");
const CTX = '[Context: community "Rust Fans", channel #general, Sunday, 2026-11-01]';

const alice = chatUser("7", { globalName: "Alice" });
const bob = chatUser("8", { username: "bob" });
const botUser = chatUser(BOT, { username: "clanker", bot: true });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
const GIF = Buffer.from("GIF89a-gif-bytes");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

/** ISO timestamp `minute` minutes after T0. */
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
/** Label of a message posted at T0 + minute (minute < 60). */
const label = (name: string, minute: number) => `[${name} · 2026-11-01 04:${String(minute).padStart(2, "0")} PST]`;
const text = (t: string) => ({ type: "text" as const, text: t });

/** A user message at T0 + id minutes (by Alice unless overridden). */
function user(id: string, content: string, o: Partial<ChatMessage> = {}): ChatMessage {
	return chatMessage({ id, author: alice, content, timestamp: at(Number(id)), ...o });
}

function bot(id: string, content: string, o: Partial<ChatMessage> = {}): ChatMessage {
	return chatMessage({ id, author: botUser, content, timestamp: at(Number(id)), ...o });
}

/** `m` replying to `parent`, which has to be fetched. */
function replyTo(parent: ChatMessage, m: ChatMessage): ChatMessage {
	return { ...m, reference: { messageId: parent.id, channelId: parent.channelId, guildId: parent.guildId } };
}

/** `m` replying to `parent`, with the parent included in the payload. */
function replyWith(parent: ChatMessage, m: ChatMessage): ChatMessage {
	return { ...replyTo(parent, m), referenced: parent };
}

function attachment(id: string, o: Partial<ChatAttachment> = {}): ChatAttachment {
	return {
		id,
		filename: `${id}.png`,
		url: `https://media.example/attachments/${id}.png?ex=1&is=2&hm=3`,
		contentType: "image/png",
		size: 1024,
		width: 1000,
		height: 1000,
		...o,
	};
}

type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

function imageBlock(data: Buffer, mediaType: ImageType = "image/png") {
	return {
		type: "image" as const,
		source: { type: "base64" as const, media_type: mediaType, data: data.toString("base64") },
	};
}

class FakeFluxer
	implements Pick<FluxerApi, "fetchMessage" | "firstMessages" | "threadOwner" | "download" | "guild" | "channelName">
{
	readonly stored = new Map<string, ChatMessage>();
	readonly files = new Map<string, Buffer>();
	readonly fetchCalls: Array<{ channelId: string; messageId: string }> = [];
	readonly downloadCalls: Array<{ url: string; maxBytes: number }> = [];
	readonly guilds = new Map<string, GuildInfo>([
		["300", { id: "300", name: "Rust Fans", channels: new Map([["500", "general"]]) }],
	]);
	readonly channels = new Map([
		["500", "general"],
		["600", "random"],
	]);
	fetchError: Error | null = null;
	/** Thrown by every download when set. */
	downloadError: unknown = null;
	active = 0;
	maxActive = 0;

	store(...messages: ChatMessage[]): this {
		for (const m of messages) this.stored.set(m.id, m);
		return this;
	}

	file(a: ChatAttachment, data: Buffer): this {
		this.files.set(a.url, data);
		return this;
	}

	get fetchedIds(): string[] {
		return this.fetchCalls.map((c) => c.messageId);
	}

	async fetchMessage(channelId: string, messageId: string): Promise<ChatMessage | null> {
		this.fetchCalls.push({ channelId, messageId });
		if (this.fetchError) throw this.fetchError;
		return this.stored.get(messageId) ?? null;
	}

	/** Thread ID -> its messages, oldest first. */
	readonly threads = new Map<string, ChatMessage[]>();
	threadError: Error | null = null;

	/** Thread ID -> who started it. */
	readonly owners = new Map<string, string>();

	threadOwner(threadId: string): string | undefined {
		return this.owners.get(threadId);
	}

	async firstMessages(channelId: string, limit: number): Promise<ChatMessage[]> {
		if (this.threadError) throw this.threadError;
		return (this.threads.get(channelId) ?? []).slice(0, limit);
	}

	async download(url: string, maxBytes: number): Promise<{ data: Buffer; contentType: string | null }> {
		this.downloadCalls.push({ url, maxBytes });
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			await new Promise((resolve) => setImmediate(resolve)); // let other downloads start
			if (this.downloadError !== null) throw this.downloadError;
			const data = this.files.get(url);
			if (!data) throw new FluxerRequestError(`GET ${url} failed`, 404, null);
			return { data, contentType: "application/octet-stream" };
		} finally {
			this.active--;
		}
	}

	guild(guildId: string): GuildInfo | undefined {
		return this.guilds.get(guildId);
	}

	channelName(channelId: string): string | undefined {
		return this.channels.get(channelId);
	}
}

function setup(limits: Partial<ChainLimits> = {}) {
	const fluxer = new FakeFluxer();
	const replay = new ReplayCache({ ttlMs: 300_000, maxBytes: 10_000_000, clock: testClock() });
	const notices = new NoticeIds();
	const lines: string[] = [];
	const log = createLogger({ level: "info", write: (line) => lines.push(line) });
	const deps: ChainDeps = { fluxer, botId: BOT, replay, notices, fingerprint: FP, timezone: TZ, log };
	const lim: ChainLimits = { maxMessages: 50, maxChainTokens: 50_000, maxImages: 4, ...limits };
	const build = (trigger: ChatMessage, opts?: { forceRebuild?: boolean }) => buildChain(trigger, deps, lim, opts);
	const logs = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
	return { fluxer, replay, notices, deps, limits: lim, build, lines, logs };
}

function expectOk(r: BuildResult): Extract<BuildResult, { ok: true }> {
	if (!r.ok) throw new Error(`expected a chain, got too_long (${r.count} messages, ${r.tokens} tokens)`);
	return r;
}

/** Sum of the text estimates of every text block (for chains without images). */
function textTokens(messages: MessageParam[]): number {
	let sum = 0;
	for (const m of messages) {
		if (typeof m.content === "string") continue;
		for (const b of m.content) if (b.type === "text") sum += estimateTokens(b.text);
	}
	return sum;
}

// ---------------------------------------------------------------- estimates and helpers

describe("estimates", () => {
	it("counts two UTF-8 bytes per token, rounding up", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abc")).toBe(2);
		expect(estimateTokens("abcd")).toBe(2);
		expect(estimateTokens("é")).toBe(1); // 2 bytes
		expect(estimateTokens("日本")).toBe(3); // 6 bytes
		expect(estimateTokens("😀")).toBe(2); // 4 bytes
	});

	it("counts 28 px patches after downscaling, capped at the per-image maximum", () => {
		expect(IMAGE_TOKENS).toBe(4800);
		expect(imageTokens(28, 28)).toBe(1);
		expect(imageTokens(29, 28)).toBe(2);
		expect(imageTokens(1000, 1000)).toBe(1296);
		expect(imageTokens(4000, 1000)).toBe(92 * 23); // scaled to 2576 × 644
		expect(imageTokens(1000, 4000)).toBe(23 * 92);
		expect(imageTokens(3000, 3000)).toBe(4784); // 92 × 92 = 8464 before the token cap
		expect(imageTokens(2576, 1800)).toBe(4784);
	});

	it("matches the high-resolution examples in Anthropic's vision docs", () => {
		// build-with-claude/vision, "Resolution and token cost" (high-resolution tier column).
		expect(imageTokens(200, 200)).toBe(64);
		expect(imageTokens(1092, 1092)).toBe(1521);
		expect(imageTokens(1920, 1080)).toBe(2691);
		expect(imageTokens(2000, 1500)).toBe(3888);
		expect(imageTokens(3840, 2160)).toBe(4784); // downsized to 2576 × 1449
	});

	it("never budgets less than the API's exact resize rule", () => {
		// The reference implementation from build-with-claude/vision-coordinates (2,576 px, 4,784 tokens).
		const tokens = (w: number, h: number) => Math.ceil(w / 28) * Math.ceil(h / 28);
		const fits = (w: number, h: number) =>
			Math.ceil(w / 28) * 28 <= 2576 && Math.ceil(h / 28) * 28 <= 2576 && tokens(w, h) <= 4784;
		const roundEven = (v: number) => {
			const f = Math.floor(v);
			return v - f !== 0.5 ? Math.round(v) : f % 2 === 0 ? f : f + 1;
		};
		const resized = (w: number, h: number): [number, number] => {
			if (fits(w, h)) return [w, h];
			if (h > w) {
				const [rh, rw] = resized(h, w);
				return [rw, rh];
			}
			let lo = 1;
			let hi = w;
			while (lo + 1 < hi) {
				const mid = Math.floor((lo + hi) / 2);
				if (fits(mid, Math.max(roundEven((mid * h) / w), 1))) lo = mid;
				else hi = mid;
			}
			return [lo, Math.max(roundEven((lo * h) / w), 1)];
		};
		for (const [w, h] of [
			[1, 1],
			[1075, 1520],
			[1920, 1080],
			[2577, 1],
			[3000, 3000],
			[4032, 3024],
			[8000, 100],
			[100, 8000],
			[2600, 2600],
			[5000, 2813],
		] as const) {
			const exact = tokens(...resized(w, h));
			expect(exact).toBeLessThanOrEqual(4784);
			expect(imageTokens(w, h)).toBeGreaterThanOrEqual(exact);
			expect(imageTokens(w, h) - exact).toBeLessThan(200);
		}
	});

	it("keeps every request's images inside the API's size limits", () => {
		expect(imageByteLimit(0)).toBe(MAX_IMAGE_BYTES);
		expect(imageByteLimit(4)).toBe(MAX_IMAGE_BYTES);
		expect(imageByteLimit(12)).toBe(MAX_IMAGE_BYTES);
		expect(imageByteLimit(20)).toBe(Math.floor((64 * 1024 * 1024) / 20));
		const base64 = (bytes: number) => Math.ceil(bytes / 3) * 4;
		expect(base64(MAX_IMAGE_BYTES)).toBeLessThan(10_000_000); // per image
		for (const n of [1, 4, 13, 20]) expect(n * base64(imageByteLimit(n))).toBeLessThan(100_000_000); // 128 MB request
	});

	it("budgets IMAGE_TOKENS when the dimensions are unknown or invalid", () => {
		expect(imageTokens(null, 100)).toBe(IMAGE_TOKENS);
		expect(imageTokens(100, null)).toBe(IMAGE_TOKENS);
		expect(imageTokens(0, 100)).toBe(IMAGE_TOKENS);
		expect(imageTokens(-5, 100)).toBe(IMAGE_TOKENS);
		expect(imageTokens(Number.NaN, 100)).toBe(IMAGE_TOKENS);
	});

	it("formats attachment sizes", () => {
		expect(formatSize(0)).toBe("0 KB");
		expect(formatSize(1)).toBe("1 KB");
		expect(formatSize(12_345)).toBe("12 KB");
		expect(formatSize(1_047_552)).toBe("1023 KB");
		expect(formatSize(1_048_575)).toBe("1.0 MB");
		expect(formatSize(1_572_864)).toBe("1.5 MB");
		expect(formatSize(6 * 1024 * 1024)).toBe("6.0 MB");
		expect(formatSize(Number.NaN)).toBe("unknown size");
		expect(formatSize(-1)).toBe("unknown size");
	});
});

describe("displayName and contextLine", () => {
	it("uses the display name, else the username, on one line", () => {
		expect(displayName(alice)).toBe("Alice");
		expect(displayName(bob)).toBe("bob");
		expect(displayName(chatUser("1", { globalName: "   ", username: "zed" }))).toBe("zed");
		expect(displayName(chatUser("1", { globalName: "Eve\n[Bob · 2026-11-01]\tx" }))).toBe("Eve [Bob · 2026-11-01] x");
		expect(displayName(chatUser("1", { username: "" }))).toBe("unknown-user");
	});

	it("describes a community channel or a DM, with the weekday and date in the timezone", () => {
		const guildMsg = user("1", "hi");
		expect(contextLine(guildMsg, "Rust Fans", "general", TZ)).toBe(CTX);
		expect(contextLine(guildMsg, null, null, TZ)).toBe(
			'[Context: community "unknown", channel #unknown, Sunday, 2026-11-01]',
		);
		const dm = user("1", "hi", { isDm: true, guildId: null });
		expect(contextLine(dm, null, null, TZ)).toBe("[Context: direct message, Sunday, 2026-11-01]");
		const group = user("1", "hi", { isGroupDm: true, guildId: null });
		expect(contextLine(group, null, null, TZ)).toBe("[Context: group DM, Sunday, 2026-11-01]");
		const late = user("1", "hi", { timestamp: "2026-11-02T07:30:00Z" });
		expect(contextLine(late, "G", "c", TZ)).toBe('[Context: community "G", channel #c, Sunday, 2026-11-01]');
		expect(contextLine(late, "G", "c", "UTC")).toBe('[Context: community "G", channel #c, Monday, 2026-11-02]');
	});
});

// ---------------------------------------------------------------- walking

describe("buildChain: walking the chain", () => {
	it("renders a root-only trigger with the context line and its label", async () => {
		const s = setup();
		const t = user("1", "hello <@42>", { mentions: [{ ...botUser, nick: null }] });
		const r = expectOk(await s.build(t));
		const body = `${label("Alice", 1)}\nhello @clanker`;
		expect(r).toEqual({
			ok: true,
			mode: "rebuilt",
			messages: [{ role: "user", content: [text(CTX), text(body)] }],
			tokens: estimateTokens(CTX) + estimateTokens(body),
			count: 1,
			anchorId: null,
		});
		expect(s.fluxer.fetchCalls).toEqual([]);
	});

	it("uses parents from the payload, fetches the rest, and renders oldest first", async () => {
		const s = setup();
		const a = user("1", "What is Rust?");
		const b = replyTo(a, bot("2", "A language."));
		const c = replyTo(b, user("3", "Is it fast?", { author: bob }));
		const t = replyWith(c, user("4", "And safe?"));
		s.fluxer.store(a, b, c);
		const r = expectOk(await s.build(t));
		expect(r.messages).toEqual([
			{ role: "user", content: [text(`${label("Alice", 1)}\nWhat is Rust?`)] },
			{ role: "assistant", content: [text("A language.")] },
			{
				role: "user",
				content: [text(CTX), text(`${label("bob", 3)}\nIs it fast?`), text(`${label("Alice", 4)}\nAnd safe?`)],
			},
		]);
		expect(r.count).toBe(4);
		expect(r.tokens).toBe(textTokens(r.messages));
		expect(s.fluxer.fetchCalls).toEqual([
			{ channelId: "500", messageId: "2" },
			{ channelId: "500", messageId: "1" },
		]);
	});

	it("doesn't fetch a parent that a fetched message already includes", async () => {
		const s = setup();
		const a = user("1", "root");
		const b = replyWith(a, bot("2", "answer"));
		const t = replyTo(b, user("3", "next"));
		s.fluxer.store(b);
		expectOk(await s.build(t));
		expect(s.fluxer.fetchedIds).toEqual(["2"]);
	});

	it("doesn't follow a reference into another channel", async () => {
		const s = setup();
		const elsewhere = user("1", "private stuff", { channelId: "501", guildId: "301" });
		s.fluxer.store(elsewhere);
		const fetched = expectOk(await s.build(replyTo(elsewhere, user("2", "here"))));
		const included = expectOk(await s.build(replyWith(elsewhere, user("3", "here"))));
		for (const r of [fetched, included]) {
			expect(r.count).toBe(1);
			expect(JSON.stringify(r.messages)).not.toContain("private stuff");
		}
		expect(s.fluxer.fetchCalls).toEqual([]);
		expect(s.logs()).toContainEqual(expect.objectContaining({ level: "warn", messageId: "2" }));
		expect(s.logs()).toContainEqual(expect.objectContaining({ level: "warn", messageId: "3" }));
	});

	it("stops at a deleted parent", async () => {
		const s = setup();
		const t = { ...replyTo(user("1", "gone"), user("2", "reply")), referenced: null };
		const r = expectOk(await s.build(t));
		expect(r.count).toBe(1);
		expect(s.fluxer.fetchCalls).toEqual([]);
	});

	it("stops where a parent can't be fetched", async () => {
		const s = setup();
		const c = replyTo(user("1", "missing"), user("2", "middle"));
		const t = replyWith(c, user("3", "trigger"));
		const r = expectOk(await s.build(t));
		expect(s.fluxer.fetchedIds).toEqual(["1"]);
		expect(r.messages).toEqual([
			{
				role: "user",
				content: [text(CTX), text(`${label("Alice", 2)}\nmiddle`), text(`${label("Alice", 3)}\ntrigger`)],
			},
		]);
	});

	it("skips notices but keeps walking past them", async () => {
		const s = setup();
		const a = user("1", "question");
		const n = replyTo(a, bot("2", "I'm busy right now."));
		const t = replyWith(n, user("3", "try again"));
		s.fluxer.store(a, n);
		s.notices.add(n.id);
		const r = expectOk(await s.build(t));
		expect(r.messages).toEqual([
			{
				role: "user",
				content: [text(CTX), text(`${label("Alice", 1)}\nquestion`), text(`${label("Alice", 3)}\ntry again`)],
			},
		]);
		expect(r.count).toBe(2);
		expect(s.fluxer.fetchedIds).toEqual(["1"]);
	});

	it("merges a reply split over several bot messages into one assistant turn", async () => {
		const s = setup();
		const a = user("1", "long question");
		const p1 = replyTo(a, bot("2", "part one"));
		const p2 = replyTo(p1, bot("3", "part two"));
		const t = replyTo(p2, user("4", "thanks"));
		s.fluxer.store(a, p1, p2);
		const r = expectOk(await s.build(t));
		expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(r.messages[1]).toEqual({ role: "assistant", content: [text("part one\npart two")] });
		expect(r.count).toBe(4);
	});

	it("starts with a fixed user turn when the chain starts with the bot", async () => {
		const s = setup();
		const b = bot("1", "   ");
		const t = replyWith(b, user("2", "what?"));
		const r = expectOk(await s.build(t));
		expect(r.messages).toEqual([
			{ role: "user", content: [text(EARLIER_MESSAGES_UNAVAILABLE)] },
			{ role: "assistant", content: [text("(no text)")] },
			{ role: "user", content: [text(CTX), text(`${label("Alice", 2)}\nwhat?`)] },
		]);
		expect(EARLIER_MESSAGES_UNAVAILABLE).toBe("[Earlier messages aren't available.]");
		expect(r.tokens).toBe(textTokens(r.messages));
		expect(r.count).toBe(2);
	});

	it("always renders the trigger as a user turn", async () => {
		const s = setup();
		const r = expectOk(await s.build(bot("1", "odd")));
		expect(r.messages).toEqual([{ role: "user", content: [text(CTX), text(`${label("clanker", 1)}\nodd`)] }]);
	});

	it("stops at a reply cycle and logs it", async () => {
		const s = setup();
		const x = user("1", "x", { reference: { messageId: "2", channelId: "500", guildId: "300" } });
		const y = user("2", "y", { reference: { messageId: "1", channelId: "500", guildId: "300" } });
		const t = replyTo(x, user("3", "t"));
		s.fluxer.store(x, y);
		const r = expectOk(await s.build(t));
		expect(r.count).toBe(3);
		expect(s.fluxer.fetchedIds).toEqual(["1", "2"]);
		expect(s.logs()).toContainEqual(expect.objectContaining({ level: "warn", messageId: "1" }));
	});

	it("passes Fluxer errors to the caller", async () => {
		const s = setup();
		s.fluxer.fetchError = new FluxerRequestError("boom", 500, null);
		await expect(s.build(replyTo(user("1", "a"), user("2", "b")))).rejects.toThrow("boom");
	});
});

describe("buildChain: answers in threads", () => {
	const POINTER = "-# 🧵 The full answer is in the thread.";

	it("reads the answer a pointer stands for from its thread", async () => {
		const s = setup();
		const q = user("1", "Explain Rust");
		const pointer = replyTo(q, bot("2", POINTER));
		const inThread = { channelId: "2", guildId: "300" };
		s.fluxer.store(q, pointer);
		s.fluxer.threads.set("2", [
			bot("3", "Part one.", inThread),
			bot("4", "Part two.", inThread),
			user("5", "thanks", inThread),
			bot("6", "You're welcome.", inThread),
		]);
		s.notices.add("4");
		const t = replyTo(pointer, user("7", "So is it fast?"));
		const r = expectOk(await s.build(t));
		expect(r.messages).toEqual([
			{ role: "user", content: [text(`${label("Alice", 1)}\nExplain Rust`)] },
			{ role: "assistant", content: [text("Part one.")] },
			{ role: "user", content: [text(CTX), text(`${label("Alice", 7)}\nSo is it fast?`)] },
		]);
		expect(r.count).toBe(3);
		expect(r.tokens).toBe(textTokens(r.messages));
	});

	it("reads the answer from the thread the bot started on the question", async () => {
		const s = setup();
		const q = user("1", "Explain Rust");
		const inThread = { channelId: "1", guildId: "300" };
		s.fluxer.store(q);
		s.fluxer.owners.set("1", BOT);
		s.fluxer.threads.set("1", [bot("2", "The answer.", inThread), user("3", "thanks", inThread)]);
		const r = expectOk(await s.build(replyTo(q, user("4", "And safe?", { author: bob }))));
		expect(r.messages).toEqual([
			{ role: "user", content: [text(`${label("Alice", 1)}\nExplain Rust`)] },
			{ role: "assistant", content: [text("The answer.")] },
			{ role: "user", content: [text(CTX), text(`${label("bob", 4)}\nAnd safe?`)] },
		]);
		// From inside that thread, the answer is already in the chain.
		const answer = bot("2", "The answer.", inThread);
		const t = user("5", "more", inThread);
		const parents = new Map<string, ChatMessage | null>([
			[t.id, answer],
			[answer.id, q],
		]);
		const inside = expectOk(await buildChain(t, s.deps, s.limits, { parents }));
		expect(inside.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
		// Someone else's thread on a message isn't read.
		s.fluxer.owners.set("1", "999");
		const other = expectOk(await s.build(replyTo(q, user("6", "hm"))));
		expect(other.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
	});

	it("says so when the thread can't be read", async () => {
		const s = setup();
		const pointer = bot("2", POINTER);
		s.fluxer.store(pointer);
		s.fluxer.threadError = new FluxerRequestError("gone", 404, null);
		const r = expectOk(await s.build(replyTo(pointer, user("3", "more?"))));
		expect(r.messages[1]).toEqual({ role: "assistant", content: [text(THREAD_ANSWER_UNAVAILABLE)] });

		s.fluxer.threadError = new FluxerRequestError("boom", 500, null);
		await expect(s.build(replyTo(pointer, user("4", "more?")))).rejects.toThrow("boom");
	});

	it("leaves the pointer out when the chain comes from inside its thread", async () => {
		const s = setup();
		const q = user("1", "Explain Rust");
		const pointer = replyTo(q, bot("2", POINTER));
		const inThread = { channelId: "2", guildId: "300" };
		const answer = bot("3", "The answer.", inThread);
		const t = user("4", "And safe?", inThread);
		s.fluxer.store(q);
		const parents = new Map<string, ChatMessage | null>([
			[t.id, answer],
			[answer.id, pointer],
		]);
		const r = expectOk(await buildChain(t, s.deps, s.limits, { parents }));
		expect(r.messages[1]).toEqual({ role: "assistant", content: [text("The answer.")] });
		expect(JSON.stringify(r.messages)).not.toContain("full answer is in the thread");
	});
});

// ---------------------------------------------------------------- rendering

describe("buildChain: rendering messages", () => {
	it("labels with display names, never nicknames, and resolves mentions", async () => {
		const s = setup();
		const t = user("1", "<@7> hi <@!8>, ask <@&9> in <#600> or <#601>; <@99>", {
			author: chatUser("5", { username: "carol" }),
			memberNick: "Caz",
			mentions: [
				{ ...alice, nick: "Ally" },
				{ ...bob, nick: null },
			],
		});
		const r = expectOk(await s.build(t));
		expect(r.messages[0]?.content).toEqual([
			text(CTX),
			text(`${label("carol", 1)}\n@Alice hi @bob, ask @role in #random or #channel; @unknown-user`),
		]);
	});

	it("doesn't resolve markup inside resolved names", async () => {
		const s = setup();
		const sneaky = chatUser("9", { globalName: "<@&1> <#600>" });
		const t = user("1", "<@9>", { mentions: [{ ...sneaky, nick: null }] });
		const r = expectOk(await s.build(t));
		expect(r.messages[0]?.content).toEqual([text(CTX), text(`${label("Alice", 1)}\n@<@&1> <#600>`)]);
	});

	it("writes the context line for DMs and unknown places", async () => {
		const s = setup();
		const dm = user("1", "hi", { isDm: true, guildId: null, channelId: "900" });
		expect(expectOk(await s.build(dm)).messages[0]?.content).toEqual([
			text("[Context: direct message, Sunday, 2026-11-01]"),
			text(`${label("Alice", 1)}\nhi`),
		]);
		const lost = user("2", "hi", { guildId: "999", channelId: "777" });
		expect(expectOk(await s.build(lost)).messages[0]?.content).toEqual([
			text('[Context: community "unknown", channel #unknown, Sunday, 2026-11-01]'),
			text(`${label("Alice", 2)}\nhi`),
		]);
	});

	it("takes the date and time from the trigger, in the configured timezone", async () => {
		const s = setup();
		const t = user("1", "late", { timestamp: "2026-11-02T07:30:00.000Z" });
		expect(expectOk(await s.build(t)).messages[0]?.content).toEqual([
			text(CTX),
			text("[Alice · 2026-11-01 23:30 PST]\nlate"),
		]);
		const utc = await buildChain(t, { ...s.deps, timezone: "UTC" }, s.limits);
		expect(expectOk(utc).messages[0]?.content).toEqual([
			text('[Context: community "Rust Fans", channel #general, Monday, 2026-11-02]'),
			text("[Alice · 2026-11-02 07:30 UTC]\nlate"),
		]);
	});

	it("writes (no text) for an empty message without attachments", async () => {
		const s = setup();
		const r = expectOk(await s.build(user("1", " \n ")));
		expect(r.messages[0]?.content).toEqual([text(CTX), text(`${label("Alice", 1)}\n(no text)`)]);
	});

	it("lists attachments that aren't sent as images", async () => {
		const s = setup();
		const t = user("1", "", {
			attachments: [
				attachment("f1", { filename: "notes.pdf", contentType: "application/pdf", size: 12_345 }),
				attachment("f2", { filename: "blob", contentType: null, size: 3 * 1024 * 1024 }),
			],
		});
		const r = expectOk(await s.build(t));
		expect(r.messages[0]?.content).toEqual([
			text(CTX),
			text(
				`${label("Alice", 1)}\n[attachment: notes.pdf (application/pdf, 12 KB)]\n[attachment: blob (unknown type, 3.0 MB)]`,
			),
		]);
		expect(s.fluxer.downloadCalls).toEqual([]);
	});
});

// ---------------------------------------------------------------- images

describe("buildChain: images", () => {
	it("sends the newest images up to the limit, right after their message", async () => {
		const s = setup({ maxImages: 2 });
		const a1 = attachment("a1");
		const t1 = attachment("t1", { width: 28, height: 28 });
		const t2 = attachment("t2", { filename: "t2.jpg", contentType: "image/jpeg", width: null, height: null });
		const a = user("1", "old picture", { attachments: [a1] });
		const b = replyTo(a, bot("2", "nice"));
		const t = replyTo(b, user("3", "new pictures", { attachments: [t1, t2] }));
		s.fluxer.store(a, b).file(a1, PNG).file(t1, PNG).file(t2, JPEG);
		const r = expectOk(await s.build(t));
		const aText = `${label("Alice", 1)}\nold picture\n[attachment: a1.png (image/png, 1 KB)]`;
		const tText = `${label("Alice", 3)}\nnew pictures`;
		expect(r.messages).toEqual([
			{ role: "user", content: [text(aText)] },
			{ role: "assistant", content: [text("nice")] },
			{ role: "user", content: [text(CTX), text(tText), imageBlock(PNG), imageBlock(JPEG, "image/jpeg")] },
		]);
		expect(r.tokens).toBe(textTokens(r.messages) + 1 + IMAGE_TOKENS);
		expect(s.fluxer.downloadCalls.map((c) => c.url)).toEqual([t1.url, t2.url]);
		expect(s.fluxer.downloadCalls.every((c) => c.maxBytes === MAX_IMAGE_BYTES)).toBe(true);

		const more = setup({ maxImages: 3 });
		more.fluxer.store(a, b).file(a1, PNG).file(t1, PNG).file(t2, JPEG);
		const r3 = expectOk(await more.build(t));
		expect(r3.messages[0]).toEqual({
			role: "user",
			content: [text(`${label("Alice", 1)}\nold picture`), imageBlock(PNG)],
		});
	});

	it("labels an image-only message without (no text)", async () => {
		const s = setup();
		const i1 = attachment("i1");
		s.fluxer.file(i1, PNG);
		const r = expectOk(await s.build(user("1", "", { attachments: [i1] })));
		expect(r.messages[0]?.content).toEqual([text(CTX), text(label("Alice", 1)), imageBlock(PNG)]);
	});

	it("takes the media type from the bytes, not the declared type", async () => {
		const s = setup();
		const lies = attachment("x1"); // declared image/png
		const gif = attachment("x2", { contentType: "image/gif" });
		const webp = attachment("x3", { contentType: "IMAGE/WEBP; q=1" });
		s.fluxer.file(lies, JPEG).file(gif, GIF).file(webp, WEBP);
		const r = expectOk(await s.build(user("1", "pics", { attachments: [lies, gif, webp] })));
		expect(r.messages[0]?.content).toEqual([
			text(CTX),
			text(`${label("Alice", 1)}\npics`),
			imageBlock(JPEG, "image/jpeg"),
			imageBlock(GIF, "image/gif"),
			imageBlock(WEBP, "image/webp"),
		]);
	});

	it("lists images that are too large, too big in pixels, unsupported, or over the limit", async () => {
		const s = setup({ maxImages: 1 });
		const big = attachment("b1", { size: 6 * 1024 * 1024 });
		const wide = attachment("b2", { width: 9000 });
		const bmp = attachment("b3", { filename: "b3.bmp", contentType: "image/bmp" });
		const svg = attachment("b4", { filename: "b4.svg", contentType: "image/svg+xml" });
		const ok1 = attachment("b5");
		const ok2 = attachment("b6");
		s.fluxer.file(ok1, PNG).file(ok2, PNG);
		const t = user("1", "", { attachments: [big, wide, bmp, svg, ok1, ok2] });
		const r = expectOk(await s.build(t));
		expect(r.messages[0]?.content).toEqual([
			text(CTX),
			text(
				[
					label("Alice", 1),
					"[attachment: b1.png (image/png, 6.0 MB)]",
					"[attachment: b2.png (image/png, 1 KB)]",
					"[attachment: b3.bmp (image/bmp, 1 KB)]",
					"[attachment: b4.svg (image/svg+xml, 1 KB)]",
					"[attachment: b6.png (image/png, 1 KB)]",
				].join("\n"),
			),
			imageBlock(PNG),
		]);
		expect(s.fluxer.downloadCalls.map((c) => c.url)).toEqual([ok1.url]);
	});

	it("sends no images when max_images is 0", async () => {
		const s = setup({ maxImages: 0 });
		const i1 = attachment("i1");
		const r = expectOk(await s.build(user("1", "", { attachments: [i1] })));
		expect(r.messages[0]?.content).toEqual([
			text(CTX),
			text(`${label("Alice", 1)}\n[attachment: i1.png (image/png, 1 KB)]`),
		]);
		expect(s.fluxer.downloadCalls).toEqual([]);
	});

	it("lists images that couldn't be loaded and logs no URLs or text", async () => {
		const s = setup();
		const gone = attachment("g1", { filename: "cat.png" });
		const junk = attachment("g2", { filename: "dog.png" });
		s.fluxer.file(junk, Buffer.from("<html>not an image</html>"));
		const r = expectOk(await s.build(user("1", "secret words", { attachments: [gone, junk] })));
		const body = [
			label("Alice", 1),
			"secret words",
			"[attachment: cat.png (image/png, 1 KB) (couldn't load)]",
			"[attachment: dog.png (image/png, 1 KB) (couldn't load)]",
		].join("\n");
		expect(r.messages[0]?.content).toEqual([text(CTX), text(body)]);
		expect(r.tokens).toBe(estimateTokens(CTX) + estimateTokens(body));
		expect(s.logs()).toContainEqual(
			expect.objectContaining({
				level: "warn",
				messageId: "1",
				attachmentId: "g1",
				error: "FluxerRequestError",
				status: 404,
			}),
		);
		expect(s.logs()).toContainEqual(expect.objectContaining({ level: "warn", attachmentId: "g2" }));
		const all = s.lines.join("\n");
		expect(all).not.toContain("media.example");
		expect(all).not.toContain("secret words");
	});

	it("lowers the per-image size limit when max_images is high", async () => {
		const s = setup({ maxImages: 20 });
		const limit = 3_355_443; // 64 MiB / 20
		const big = attachment("b1", { size: 4 * 1024 * 1024 }); // fine with fewer images
		const ok = attachment("b2", { size: limit });
		s.fluxer.file(big, PNG).file(ok, PNG);
		const r = expectOk(await s.build(user("1", "", { attachments: [big, ok] })));
		expect(r.messages[0]?.content).toEqual([
			text(CTX),
			text(`${label("Alice", 1)}\n[attachment: b1.png (image/png, 4.0 MB)]`),
			imageBlock(PNG),
		]);
		expect(s.fluxer.downloadCalls).toEqual([{ url: ok.url, maxBytes: limit }]);
	});

	it("rejects a download larger than the limit even if the size field was wrong", async () => {
		const s = setup();
		const liar = attachment("l1", { size: 10 });
		s.fluxer.file(liar, Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
		const r = expectOk(await s.build(user("1", "", { attachments: [liar] })));
		expect(r.messages[0]?.content).toEqual([
			text(CTX),
			text(`${label("Alice", 1)}\n[attachment: l1.png (image/png, 1 KB) (couldn't load)]`),
		]);
		expect(s.logs()).toContainEqual(
			expect.objectContaining({ level: "warn", attachmentId: "l1", bytes: MAX_IMAGE_BYTES + PNG.length }),
		);
	});

	it("lists expired attachments without downloading them", async () => {
		const s = setup();
		const expired = attachment("x1", { url: "" });
		const r = expectOk(await s.build(user("1", "old", { attachments: [expired] })));
		expect(r.messages[0]?.content).toEqual([
			text(CTX),
			text(`${label("Alice", 1)}\nold\n[attachment: x1.png (image/png, 1 KB)]`),
		]);
		expect(s.fluxer.downloadCalls).toEqual([]);
	});

	it("logs only the kind of an unexpected download error", async () => {
		for (const [thrown, kind] of [
			[new TypeError("fetch failed for https://media.example/attachments/u1.png"), "TypeError"],
			["https://media.example/attachments/u1.png", "string"],
		] as const) {
			const s = setup();
			s.fluxer.downloadError = thrown;
			const r = expectOk(await s.build(user("1", "", { attachments: [attachment("u1")] })));
			expect(r.messages[0]?.content).toEqual([
				text(CTX),
				text(`${label("Alice", 1)}\n[attachment: u1.png (image/png, 1 KB) (couldn't load)]`),
			]);
			expect(s.logs()).toContainEqual(expect.objectContaining({ level: "warn", attachmentId: "u1", error: kind }));
			expect(s.lines.join("\n")).not.toContain("media.example");
		}
	});

	it("downloads at most three images at a time, keeping attachment order", async () => {
		const s = setup({ maxImages: 6 });
		const files = ["p1", "p2", "p3", "p4", "p5", "p6"].map((id) => attachment(id));
		for (const f of files) s.fluxer.file(f, Buffer.concat([PNG, Buffer.from(f.id)]));
		const r = expectOk(await s.build(user("1", "lots", { attachments: files })));
		expect(s.fluxer.maxActive).toBe(3);
		expect(r.messages[0]?.content.slice(2)).toEqual(
			files.map((f) => imageBlock(Buffer.concat([PNG, Buffer.from(f.id)]))),
		);
	});

	it("counts image tokens toward the budget without downloading", async () => {
		const s = setup({ maxChainTokens: 4000 });
		const i1 = attachment("i1", { width: null, height: null });
		const r = await s.build(user("1", "look", { attachments: [i1] }));
		expect(r.ok).toBe(false);
		expect(r.tokens).toBeGreaterThan(IMAGE_TOKENS);
		expect(s.fluxer.downloadCalls).toEqual([]);
	});
});

// ---------------------------------------------------------------- replay

function replayFixture(limits: Partial<ChainLimits> = {}, fingerprint = FP) {
	const s = setup(limits);
	const a = user("1", "What is Rust?");
	const b = replyTo(a, bot("2", "A language."));
	const t = replyWith(b, user("3", "Is it fast?"));
	s.fluxer.store(a, b);
	const entry: ReplayEntry = {
		fingerprint,
		messages: [{ role: "user", content: [text("[Context: earlier]"), text(`${label("Alice", 1)}\nWhat is Rust?`)] }],
		assistant: [
			[
				{ type: "thinking", thinking: "", signature: "sig-1" },
				{ type: "text", text: "A lang", citations: null },
			],
			[{ type: "text", text: "uage.", citations: null }],
		],
		tokens: 1234,
	};
	s.replay.set([b.id], entry);
	return { ...s, a, b, t, entry };
}

describe("buildChain: exact replay", () => {
	it("sends the stored request and answer exactly, then one new user turn", async () => {
		const f = replayFixture();
		const before = structuredClone(f.entry);
		const r = expectOk(await f.build(f.t));
		const newText = `${label("Alice", 3)}\nIs it fast?`;
		expect(r.messages).toEqual([
			{
				role: "user",
				content: [
					text("[Context: earlier]"),
					{ type: "text", text: `${label("Alice", 1)}\nWhat is Rust?`, cache_control: { type: "ephemeral" } },
				],
			},
			{ role: "assistant", content: f.entry.assistant[0] },
			{ role: "assistant", content: f.entry.assistant[1] },
			{ role: "user", content: [text(CTX), text(newText)] },
		]);
		expect(r.mode).toBe("replay");
		expect(r.anchorId).toBe("2");
		expect(r.count).toBe(1);
		expect(r.tokens).toBe(1234 + estimateTokens(CTX) + estimateTokens(newText));
		// The walk stops at the anchor: the root is never fetched.
		expect(f.fluxer.fetchCalls).toEqual([]);
		// The marker went on a copy; replayed answer pieces are the stored objects.
		expect(f.entry).toEqual(before);
		expect(JSON.stringify(f.entry)).not.toContain("cache_control");
		expect(r.messages[1]?.content).toBe(f.entry.assistant[0]);
		expect(r.messages[0]?.content).not.toBe(f.entry.messages[0]?.content);
	});

	it("moves cache markers left in the stored messages to the last user turn", async () => {
		const f = replayFixture();
		const marked = { type: "text" as const, text: "old", cache_control: { type: "ephemeral" as const } };
		f.entry.messages = [
			{ role: "user", content: [marked] },
			{ role: "assistant", content: [text("earlier answer")] },
			{ role: "user", content: [text("question"), { ...marked, text: "q2" }] },
		];
		const r = expectOk(await f.build(f.t));
		expect(r.messages.slice(0, 3)).toEqual([
			{ role: "user", content: [text("old")] },
			{ role: "assistant", content: [text("earlier answer")] },
			{ role: "user", content: [text("question"), { type: "text", text: "q2", cache_control: { type: "ephemeral" } }] },
		]);
		expect(JSON.stringify(r.messages).match(/cache_control/g)).toHaveLength(1);
		expect(marked.cache_control).toEqual({ type: "ephemeral" }); // stored block untouched
		expect(r.messages[1]).toBe(f.entry.messages[1]); // unchanged messages are shared
	});

	it("puts every message after the anchor into the new turn, skipping notices", async () => {
		const f = replayFixture();
		const x = replyTo(f.b, user("4", "me too", { author: bob }));
		const n = replyTo(x, bot("5", "You're sending messages too quickly."));
		const t = replyTo(n, user("6", "sorry"));
		f.fluxer.store(x, n);
		f.notices.add(n.id);
		const r = expectOk(await f.build(t));
		expect(r.mode).toBe("replay");
		expect(r.count).toBe(2);
		expect(r.messages.at(-1)).toEqual({
			role: "user",
			content: [text(CTX), text(`${label("bob", 4)}\nme too`), text(`${label("Alice", 6)}\nsorry`)],
		});
		expect(f.fluxer.fetchedIds).toEqual(["5", "4", "2"]);
	});

	it("only downloads images of the new turn", async () => {
		const f = replayFixture();
		const old = attachment("o1");
		const fresh = attachment("n1");
		f.fluxer.store({ ...f.a, attachments: [old] });
		f.fluxer.file(old, PNG).file(fresh, JPEG);
		const t = { ...f.t, attachments: [fresh] };
		const r = expectOk(await f.build(t));
		expect(r.mode).toBe("replay");
		expect(f.fluxer.downloadCalls.map((c) => c.url)).toEqual([fresh.url]);
		expect(r.messages.at(-1)?.content).toEqual([
			text(CTX),
			text(`${label("Alice", 3)}\nIs it fast?`),
			imageBlock(JPEG, "image/jpeg"),
		]);
		expect(r.tokens).toBe(1234 + estimateTokens(CTX) + estimateTokens(`${label("Alice", 3)}\nIs it fast?`) + 1296);
	});

	it("rebuilds from text when the replay would be over budget", async () => {
		const f = replayFixture({ maxChainTokens: 1250 });
		const r = expectOk(await f.build(f.t));
		expect(r.mode).toBe("rebuilt");
		expect(r.anchorId).toBeNull();
		expect(r.messages).toEqual([
			{ role: "user", content: [text(`${label("Alice", 1)}\nWhat is Rust?`)] },
			{ role: "assistant", content: [text("A language.")] },
			{ role: "user", content: [text(CTX), text(`${label("Alice", 3)}\nIs it fast?`)] },
		]);
		expect(r.count).toBe(3);
		expect(f.fluxer.fetchedIds).toEqual(["1"]);
		expect(f.logs()).toContainEqual(
			expect.objectContaining({ level: "info", anchorId: "2", tokens: expect.any(Number), maxChainTokens: 1250 }),
		);
	});

	it("rebuilds when failed images push the replay over budget, without downloading twice", async () => {
		const f = replayFixture();
		const tiny = attachment("t1", { width: 28, height: 28 }); // 1 token as an image, ~30 as a "couldn't load" line
		const t = { ...f.t, attachments: [tiny] };
		const walkEstimate = estimateTokens(CTX) + estimateTokens(`${label("Alice", 3)}\nIs it fast?`) + 1;
		f.entry.tokens = f.limits.maxChainTokens - walkEstimate; // fits exactly until the download fails
		const r = expectOk(await f.build(t));
		expect(r.mode).toBe("rebuilt");
		expect(f.fluxer.downloadCalls).toHaveLength(1);
		expect(r.messages.at(-1)?.content).toEqual([
			text(CTX),
			text(`${label("Alice", 3)}\nIs it fast?\n[attachment: t1.png (image/png, 1 KB) (couldn't load)]`),
		]);
	});

	it("is too long when both the replay and the rebuilt chain are over budget", async () => {
		const f = replayFixture({ maxChainTokens: 40 });
		const r = await f.build(f.t);
		expect(r).toEqual({ ok: false, reason: "too_long", tokens: expect.any(Number), count: expect.any(Number) });
		expect(r.tokens).toBeGreaterThan(40);
	});

	it("ignores replay entries with forceRebuild", async () => {
		const f = replayFixture();
		const r = expectOk(await f.build(f.t, { forceRebuild: true }));
		expect(r.mode).toBe("rebuilt");
		expect(r.anchorId).toBeNull();
		expect(r.messages[1]).toEqual({ role: "assistant", content: [text("A language.")] });
	});

	it("rebuilds when the entry was made with another config", async () => {
		const f = replayFixture({}, "other-fingerprint");
		const r = expectOk(await f.build(f.t));
		expect(r.mode).toBe("rebuilt");
		expect(r.count).toBe(3);
	});

	it("only lets the answer nearest the trigger anchor a replay", async () => {
		const f = replayFixture();
		const c = replyTo(f.b, user("4", "more"));
		const b2 = replyTo(c, bot("5", "second answer"));
		const t = replyTo(b2, user("6", "and?"));
		f.fluxer.store(c, b2);
		const r = expectOk(await f.build(t));
		expect(r.mode).toBe("rebuilt");
		expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
	});

	it("replays when the replayed and new images fit max_images together", async () => {
		const f = replayFixture({ maxImages: 2 });
		f.entry.messages = [{ role: "user", content: [text("q"), imageBlock(PNG)] }];
		const fresh = attachment("n1");
		f.fluxer.file(fresh, JPEG);
		const r = expectOk(await f.build({ ...f.t, attachments: [fresh] }));
		expect(r.mode).toBe("replay");
		expect(r.messages[0]).toEqual({
			role: "user",
			content: [text("q"), { ...imageBlock(PNG), cache_control: { type: "ephemeral" } }],
		});
		expect(JSON.stringify(f.entry)).not.toContain("cache_control");
	});

	it("rebuilds, keeping the newest images, when replayed and new images are over max_images", async () => {
		const f = replayFixture({ maxImages: 2 });
		f.entry.messages = [{ role: "user", content: [text("q"), imageBlock(PNG)] }];
		const old = attachment("o1");
		const n1 = attachment("n1");
		const n2 = attachment("n2");
		const b = replyTo(f.a, bot("2", "A language."));
		f.fluxer
			.store({ ...f.a, attachments: [old] }, b)
			.file(old, PNG)
			.file(n1, JPEG)
			.file(n2, GIF);
		const t = { ...replyTo(b, user("3", "Is it fast?")), attachments: [n1, n2] };
		const r = expectOk(await f.build(t));
		expect(r.mode).toBe("rebuilt");
		expect(r.messages).toEqual([
			{ role: "user", content: [text(`${label("Alice", 1)}\nWhat is Rust?\n[attachment: o1.png (image/png, 1 KB)]`)] },
			{ role: "assistant", content: [text("A language.")] },
			{
				role: "user",
				content: [
					text(CTX),
					text(`${label("Alice", 3)}\nIs it fast?`),
					imageBlock(JPEG, "image/jpeg"),
					imageBlock(GIF, "image/gif"),
				],
			},
		]);
		// Each message and image is fetched once, though the chain was walked twice.
		expect(f.fluxer.fetchedIds).toEqual(["2", "1"]);
		expect(f.fluxer.downloadCalls.map((c) => c.url)).toEqual([n1.url, n2.url]);
		expect(f.logs()).toContainEqual(expect.objectContaining({ level: "info", anchorId: "2", images: 3, maxImages: 2 }));
	});

	it("replays stored string content and image blocks with the marker on a copy", async () => {
		const f = replayFixture();
		const image = imageBlock(PNG);
		f.entry.messages = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: [text("second"), image] },
		];
		const r = expectOk(await f.build(f.t));
		expect(r.messages.slice(0, 3)).toEqual([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: [text("second"), { ...image, cache_control: { type: "ephemeral" } }] },
		]);
		expect(image).not.toHaveProperty("cache_control");

		f.entry.messages = [{ role: "user", content: "only" }];
		const r2 = expectOk(await f.build(f.t));
		expect(r2.messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: "only", cache_control: { type: "ephemeral" } }],
		});
		expect(f.entry.messages[0]).toEqual({ role: "user", content: "only" });
	});

	it("is too long when the messages after the anchor alone are over max_messages", async () => {
		const f = replayFixture({ maxMessages: 1 });
		const x = replyTo(f.b, user("4", "one"));
		const t = replyTo(x, user("5", "two"));
		f.fluxer.store(x);
		const r = await f.build(t);
		expect(r).toEqual({ ok: false, reason: "too_long", tokens: expect.any(Number), count: 2 });
		expect(f.fluxer.fetchedIds).toEqual(["4"]);
	});

	it("counts the replayed messages toward max_messages, and rebuilds when the total is over", async () => {
		const ok = replayFixture({ maxMessages: 3 });
		ok.replay.set([ok.b.id], { ...ok.entry, count: 2 });
		const fits = expectOk(await ok.build(ok.t));
		expect(fits).toMatchObject({ mode: "replay", count: 3 });

		const over = replayFixture({ maxMessages: 3 });
		over.replay.set([over.b.id], { ...over.entry, count: 3 });
		// The rebuilt chain (a, b, t) fits, so the request is rebuilt rather than refused.
		const rebuilt = expectOk(await over.build(over.t));
		expect(rebuilt).toMatchObject({ mode: "rebuilt", count: 3 });
	});
});

// ---------------------------------------------------------------- limits

/** m1 ← m2 ← ... ← mN, every parent fetched. Returns the trigger (mN). */
function line(s: ReturnType<typeof setup>, n: number, content = (i: number) => `message ${i}`): ChatMessage {
	let prev: ChatMessage | null = null;
	for (let i = 1; i <= n; i++) {
		const m: ChatMessage = user(String(i), content(i));
		prev = prev ? replyTo(prev, m) : m;
		s.fluxer.store(prev);
	}
	return prev as ChatMessage;
}

describe("buildChain: limits", () => {
	it("is too long by message count, and stops walking there", async () => {
		const s = setup({ maxMessages: 3 });
		const r = await s.build(line(s, 10));
		expect(r).toEqual({ ok: false, reason: "too_long", tokens: expect.any(Number), count: 4 });
		expect(s.fluxer.fetchedIds).toEqual(["9", "8", "7"]);
	});

	it("allows a chain of exactly max_messages", async () => {
		const s = setup({ maxMessages: 3 });
		const r = expectOk(await s.build(line(s, 3)));
		expect(r.count).toBe(3);
	});

	it("is too long by tokens, and stops walking there", async () => {
		const s = setup({ maxChainTokens: 1200 });
		const r = await s.build(line(s, 10, () => "x".repeat(1000)));
		expect(r.ok).toBe(false);
		expect(r.count).toBe(3);
		expect(r.tokens).toBeGreaterThan(1200);
		expect(s.fluxer.fetchedIds).toEqual(["9", "8"]);
	});

	it("allows a chain of exactly max_chain_tokens", async () => {
		const body = `${label("Alice", 1)}\nhello`;
		const exact = estimateTokens(CTX) + estimateTokens(body);
		expect(expectOk(await setup({ maxChainTokens: exact }).build(user("1", "hello"))).tokens).toBe(exact);
		const over = await setup({ maxChainTokens: exact - 1 }).build(user("1", "hello"));
		expect(over).toEqual({ ok: false, reason: "too_long", tokens: exact, count: 1 });
	});

	it("counts the fixed first turn against the budget", async () => {
		const b = bot("1", "x");
		const t = replyWith(b, user("2", "what?"));
		const walked = estimateTokens(CTX) + estimateTokens(`${label("Alice", 2)}\nwhat?`) + estimateTokens("x");
		const r = await setup({ maxChainTokens: walked }).build(t);
		expect(r).toEqual({
			ok: false,
			reason: "too_long",
			tokens: walked + estimateTokens(EARLIER_MESSAGES_UNAVAILABLE),
			count: 2,
		});
	});

	it("doesn't count notices toward the message limit", async () => {
		const s = setup({ maxMessages: 2 });
		const a = user("1", "question");
		const n1 = replyTo(a, bot("2", "busy"));
		const n2 = replyTo(n1, bot("3", "still busy"));
		const t = replyTo(n2, user("4", "now?"));
		s.fluxer.store(a, n1, n2);
		s.notices.add(n1.id);
		s.notices.add(n2.id);
		expect(expectOk(await s.build(t)).count).toBe(2);
	});
});

// ---------------------------------------------------------------- logging

describe("buildChain: logging", () => {
	it("logs IDs and counts but no names, text or URLs above debug", async () => {
		const f = replayFixture({ maxChainTokens: 1250 }); // replay over budget → rebuilt
		const gone = attachment("g1", { filename: "holiday.png", width: 28, height: 28 });
		const forwarded = user("9", "from elsewhere", { channelId: "777" });
		f.fluxer.store({ ...f.a, reference: { messageId: "9", channelId: "777", guildId: null } }, forwarded);
		const r = expectOk(await f.build({ ...f.t, attachments: [gone] }));
		expect(r.mode).toBe("rebuilt");
		expect(f.logs().map((l) => l.level)).toEqual(["info", "warn", "warn"]);
		const all = f.lines.join("\n");
		for (const secret of ["Alice", "Rust", "fast", "language", "holiday", "media.example", "elsewhere"]) {
			expect(all).not.toContain(secret);
		}
	});
});

// ---------------------------------------------------------------- determinism

describe("buildChain: determinism", () => {
	function scenario() {
		const s = setup();
		const i1 = attachment("i1");
		const a = user("1", "hi <@8> in <#600>", { mentions: [{ ...bob, nick: "B" }], attachments: [i1] });
		const b = replyTo(a, bot("2", "hello"));
		const c = replyTo(b, user("3", "", { attachments: [attachment("f1", { contentType: "text/plain" })] }));
		const t = replyTo(c, user("4", "and <@&5>?"));
		s.fluxer.store(a, b, c).file(i1, PNG);
		return { s, t };
	}

	it("renders byte-identical JSON on every build", async () => {
		const one = scenario();
		const two = scenario();
		const first = JSON.stringify(await one.s.build(one.t));
		expect(JSON.stringify(await one.s.build(one.t))).toBe(first);
		expect(JSON.stringify(await two.s.build(two.t))).toBe(first);
	});

	it("renders byte-identical JSON in replay mode", async () => {
		const f = replayFixture();
		const first = JSON.stringify(await f.build(f.t));
		expect(JSON.stringify(await f.build(f.t))).toBe(first);
		expect(JSON.parse(first).mode).toBe("replay");
	});
});
