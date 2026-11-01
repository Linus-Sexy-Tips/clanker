// SPDX-License-Identifier: AGPL-3.0-or-later
// End-to-end tests of the message flow with fake Fluxer and a scripted Claude runner.

import { describe, expect, it } from "vitest";
import { Access } from "../src/access.js";
import { App } from "../src/app.js";
import { ClaudeError, type ClaudeRunner } from "../src/claude.js";
import { Guards } from "../src/guards.js";
import { NoticeIds, ReplayCache } from "../src/replay.js";
import { Spend } from "../src/spend.js";
import { Store } from "../src/store.js";
import { type ChatMessage, type ChatUser, FluxerRequestError, type MessageParam } from "../src/types.js";
import { FakeFluxer, FakeRunner, textBlock, usage } from "./fakes.js";
import { chatMessage, chatUser, loadTestConfig, quietLog, testClock } from "./helpers.js";

const BASE = `
[access]
users = ["10"]
[guilds."300"]
roles = ["700"]
`;

/** `limits` goes inside the [limits] table (cooldown off unless set); `extra` is any other TOML. */
function setup(extra = "", limits = "") {
	const cooldown = /cooldown_seconds/.test(limits) ? "" : "cooldown_seconds = 0\n";
	const loaded = loadTestConfig(`${BASE}\n${extra}\n[limits]\n${cooldown}${limits}`);
	const { config } = loaded;
	const clock = testClock();
	const fluxer = new FakeFluxer();
	fluxer.guilds.set("300", { id: "300", name: "Home", channels: new Map([["500", "general"]]) });
	const runner = new FakeRunner();
	const store = Store.memory();
	const spend = new Spend({ config, prices: loaded.prices, store, clock, log: quietLog });
	const replay = new ReplayCache({ ttlMs: 300_000, maxBytes: 64 * 1024 * 1024, clock });
	const notices = new NoticeIds();
	const access = new Access({
		config,
		fetchMember: (g, u) => fluxer.fetchMember(g, u),
		clock,
		log: quietLog,
	});
	const guards = new Guards({
		cooldownMs: config.limits.cooldown_seconds * 1000,
		maxConcurrent: config.limits.max_concurrent,
		maxQueue: config.limits.max_queue,
		clock,
	});
	const app = new App({
		loaded,
		fluxer,
		runner: runner as unknown as ClaudeRunner,
		store,
		spend,
		replay,
		notices,
		access,
		guards,
		log: quietLog,
		clock,
		version: "0.0.0-test",
		startedAt: clock.now(),
	});
	app.attach();

	/** Sends a user message through the flow and makes it fetchable. */
	const say = async (o: Partial<ChatMessage>) => {
		const msg = chatMessage(o);
		fluxer.messages.set(msg.id, msg);
		await app.handleMessage(msg);
		return msg;
	};
	const mention = "<@100>";
	const botMentions = [{ ...chatUser("100", { bot: true, globalName: "Clanker" }), nick: null }];
	return { app, fluxer, runner, store, spend, replay, notices, clock, say, mention, botMentions, config };
}

const allowed = chatUser("10", { globalName: "Alice" });
const roleUser = chatUser("20", { globalName: "Bob" });
const stranger = chatUser("30", { globalName: "Mallory" });

describe("who and where", () => {
	it("ignores unapproved users completely", async () => {
		const t = setup();
		await t.say({ author: stranger, content: `${t.mention} hi`, mentions: t.botMentions, memberRoles: [] });
		expect(t.fluxer.sent).toHaveLength(0);
		expect(t.fluxer.reactions).toHaveLength(0);
		expect(t.fluxer.typing).toHaveLength(0);
		expect(t.runner.calls).toHaveLength(0);
	});

	it("ignores messages that don't address the bot, bots and webhooks", async () => {
		const t = setup();
		await t.say({ author: allowed, content: "just chatting" });
		await t.say({ author: chatUser("11", { bot: true }), content: `${t.mention} hi`, mentions: t.botMentions });
		await t.say({ author: allowed, webhookId: "9", content: `${t.mention} hi`, mentions: t.botMentions });
		await t.say({ author: allowed, guildId: "999", content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.fluxer.sent).toHaveLength(0);
		expect(t.runner.calls).toHaveLength(0);
	});

	it("answers users with an allowed role", async () => {
		const t = setup();
		t.runner.answer("Hello Bob");
		await t.say({ author: roleUser, memberRoles: ["700"], content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(1);
		expect(t.fluxer.sent.at(0)?.content).toContain("Hello Bob");
	});
});

describe("commands", () => {
	it("answers help and usage without calling Claude", async () => {
		const t = setup();
		await t.say({ author: allowed, content: `${t.mention} help`, mentions: t.botMentions });
		await t.say({ author: allowed, content: `${t.mention} usage`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(0);
		expect(t.fluxer.sent[0]?.content).toMatch(/AI assistant/);
		expect(t.fluxer.sent[1]?.content).toMatch(/Your usage today: US\$0\.00 of US\$5\.00/);
		// Command replies are notices, not chain context.
		expect(t.notices.has(t.fluxer.sent[0]?.id as string)).toBe(true);
	});

	it("keeps status and usage all for the owner in DMs", async () => {
		const t = setup();
		await t.say({ author: allowed, content: `${t.mention} status`, mentions: t.botMentions });
		expect(t.fluxer.sent[0]?.content).toMatch(/only for the bot's operator/);
		const owner = chatUser("1", { globalName: "Owner" });
		await t.say({ author: owner, guildId: null, isDm: true, channelId: "dm-1", memberRoles: null, content: "status" });
		expect(t.fluxer.sent[1]?.content).toMatch(/gateway connected/);
		await t.say({
			author: owner,
			guildId: null,
			isDm: true,
			channelId: "dm-1",
			memberRoles: null,
			content: "usage all",
		});
		expect(t.fluxer.sent[2]?.content).toMatch(/Usage this month/);
		expect(t.runner.calls).toHaveLength(0);
	});

	it("still serves the owner's DMs when DMs are off", async () => {
		const t = setup("[dms]\nenabled = false");
		const owner = chatUser("1", { globalName: "Owner" });
		await t.say({ author: owner, guildId: null, isDm: true, channelId: "dm-1", memberRoles: null, content: "status" });
		expect(t.fluxer.sent[0]?.content).toMatch(/gateway connected/);
		await t.say({ author: allowed, guildId: null, isDm: true, channelId: "dm-10", memberRoles: null, content: "hi" });
		expect(t.fluxer.sent).toHaveLength(1);
		expect(t.runner.calls).toHaveLength(0);
	});
});

describe("answers and context", () => {
	it("streams an answer as a reply that pings only the author", async () => {
		const t = setup();
		t.runner.answer("The answer is 42.");
		const q = await t.say({ author: allowed, content: `${t.mention} what is the answer?`, mentions: t.botMentions });
		expect(t.fluxer.sent).toHaveLength(1);
		expect(t.fluxer.sent[0]).toMatchObject({ replyTo: q.id, pingReplied: true });
		expect(t.fluxer.shown(t.fluxer.sent[0]?.id as string)).toBe("The answer is 42.");
		const req = t.runner.calls[0] as MessageParam[];
		expect(req).toHaveLength(1);
		expect(JSON.stringify(req[0])).toContain("[Alice · 2026-11-01 12:00 UTC]");
		expect(JSON.stringify(req[0])).toContain('community \\"Home\\", channel #general');
	});

	it("replays the exact earlier turn for a follow-up (append-only)", async () => {
		const t = setup();
		t.runner.answer("First answer.");
		await t.say({ author: allowed, content: `${t.mention} first question`, mentions: t.botMentions });
		const firstRequest = t.runner.calls[0] as MessageParam[];
		const botReply = t.fluxer.messages.get(t.fluxer.sent[0]?.id as string) as ChatMessage;

		t.runner.answer("Second answer.");
		await t.say({
			author: allowed,
			content: "and a follow-up",
			reference: { messageId: botReply.id, channelId: "500", guildId: "300" },
			referenced: botReply,
		});
		const second = t.runner.calls[1] as MessageParam[];
		expect(second).toHaveLength(firstRequest.length + 2);
		// Same prefix (ignoring cache markers), then the exact assistant turn, then the new user turn.
		const strip = (v: unknown) => JSON.parse(JSON.stringify(v).replace(/,"cache_control":\{"type":"ephemeral"\}/g, ""));
		expect(strip(second.slice(0, firstRequest.length))).toEqual(strip(firstRequest));
		expect(second[firstRequest.length]).toEqual({ role: "assistant", content: [textBlock("First answer.")] });
		expect(second.at(-1)?.role).toBe("user");
		expect(JSON.stringify(second.at(-1))).toContain("and a follow-up");
	});

	it("refuses chains that are too long, without calling Claude", async () => {
		const t = setup("[context]\nmax_messages = 2");
		const a = await t.say({ author: allowed, content: "one" });
		const b = await t.say({
			author: allowed,
			content: "two",
			reference: { messageId: a.id, channelId: "500", guildId: "300" },
			referenced: a,
		});
		await t.say({
			author: allowed,
			content: `${t.mention} three`,
			mentions: t.botMentions,
			reference: { messageId: b.id, channelId: "500", guildId: "300" },
			referenced: b,
		});
		expect(t.runner.calls).toHaveLength(0);
		expect(t.fluxer.shown(t.fluxer.sent[0]?.id as string)).toMatch(/too long/);
		expect(t.store.dayStats("2026-11-01").requests).toBe(0);
	});

	it("posts a refusal note and doesn't keep the turn", async () => {
		const t = setup();
		t.runner.next(async (_m, hooks) => {
			hooks.progress.onText("partial text that must disappear");
			hooks.onCallEnd(usage(), "claude-haiku-5-5");
			return { stop: "refusal", content: [], pieces: [[]], refusalCategory: "cyber", lastUsage: usage() };
		});
		await t.say({ author: allowed, content: `${t.mention} do something bad`, mentions: t.botMentions });
		expect(t.fluxer.shown(t.fluxer.sent[0]?.id as string)).toMatch(/can't help with that/);
		expect(t.replay.size).toBe(0);
	});

	it("continues after pause_turn with a fresh reservation per call, and records each call", async () => {
		const t = setup();
		t.runner.next(async (_m, hooks) => {
			hooks.onCallEnd(
				usage({ server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 } }),
				"claude-haiku-5-5",
			);
			expect(hooks.beforeContinuation()).toBe(true);
			hooks.progress.onText("Found it.");
			hooks.onCallEnd(usage(), "claude-haiku-5-5");
			const pieces = [[textBlock("Searching. ")], [textBlock("Found it.")]];
			return { stop: "end_turn", content: pieces.flat(), pieces, refusalCategory: null, lastUsage: usage() };
		});
		await t.say({ author: allowed, content: `${t.mention} look it up`, mentions: t.botMentions });
		const stats = t.store.dayStats("2026-11-01");
		expect(stats.requests).toBe(2);
		expect(stats.webSearches).toBe(3);
		// Every reservation was released: the full cap minus actual spend is available again.
		expect(t.spend.reserve("10", []).ok).toBe(true);
	});
});

describe("spending caps", () => {
	/** Spend of about US$0.15 for user 10 today: with a US$0.50 cap, the next US$0.40 reservation doesn't fit. */
	const spendSome = (t: ReturnType<typeof setup>) =>
		t.spend.record("10", "300", "claude-haiku-5-5", usage({ input_tokens: 0, output_tokens: 300_000 }));

	it("sends the daily limit notice once, then only reacts", async () => {
		const t = setup("", "user_daily_usd = 0.50");
		spendSome(t);
		const a = await t.say({ author: allowed, content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(0);
		expect(t.fluxer.sent[0]).toMatchObject({ replyTo: a.id });
		expect(t.fluxer.sent[0]?.content).toMatch(/<@10>, you've reached your daily limit of US\$0\.50/);
		const b = await t.say({ author: allowed, content: `${t.mention} again`, mentions: t.botMentions });
		expect(t.fluxer.sent).toHaveLength(1);
		expect(t.fluxer.reactions).toEqual([{ channelId: "500", messageId: b.id, emoji: "⏳" }]);
	});

	it("can send the notice by DM instead", async () => {
		const t = setup("", 'user_daily_usd = 0.50\nnotice = "dm"');
		spendSome(t);
		const a = await t.say({ author: allowed, content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.fluxer.reactions).toEqual([{ channelId: "500", messageId: a.id, emoji: "⏳" }]);
		expect(t.fluxer.sent[0]).toMatchObject({ channelId: "dm-10" });
		expect(t.fluxer.sent[0]?.content).toMatch(/^You've reached your daily limit/);
	});

	it("replies in the channel when the notice can't be DMed, still only once", async () => {
		const t = setup("", 'user_daily_usd = 0.50\nnotice = "dm"');
		spendSome(t);
		t.fluxer.dmBlocked.add("10");
		const a = await t.say({ author: allowed, content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.fluxer.reactions).toEqual([{ channelId: "500", messageId: a.id, emoji: "⏳" }]);
		expect(t.fluxer.sent).toHaveLength(1);
		expect(t.fluxer.sent[0]).toMatchObject({ channelId: "500", replyTo: a.id });
		expect(t.fluxer.sent[0]?.content).toMatch(/^<@10>, you've reached your daily limit/);
		const b = await t.say({ author: allowed, content: `${t.mention} again`, mentions: t.botMentions });
		expect(t.fluxer.sent).toHaveLength(1);
		expect(t.fluxer.reactions.at(-1)).toEqual({ channelId: "500", messageId: b.id, emoji: "⏳" });
		expect(t.runner.calls).toHaveLength(0);
	});

	it("blocks everyone at the monthly cap and alerts the owner at 80% and 100%", async () => {
		const t = setup("", "monthly_usd = 1.00");
		// $0.85 of output on Haiku's base rates: past 80%, and the next $0.40 reservation can't fit.
		t.runner.answer("pricey", { output_tokens: 1_700_000 });
		await t.say({ author: allowed, content: `${t.mention} hi`, mentions: t.botMentions });
		const toOwner = t.fluxer.sent.filter((s) => s.channelId === "dm-1");
		expect(toOwner.map((s) => s.content)).toEqual([
			expect.stringMatching(/Monthly spend is at 85%/),
			expect.stringMatching(/Monthly spend limit reached: US\$0\.85 of US\$1\.00, .*up to US\$0\.40/),
		]);
		await t.say({ author: roleUser, memberRoles: ["700"], content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/monthly spend limit of US\$1\.00/);
		expect(t.runner.calls).toHaveLength(1);
	});
});

describe("guards and failures", () => {
	it("reacts with a turtle while on cooldown", async () => {
		const t = setup("", "cooldown_seconds = 30");
		t.runner.answer("ok");
		await t.say({ author: allowed, content: `${t.mention} one`, mentions: t.botMentions });
		const b = await t.say({ author: allowed, content: `${t.mention} two`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(1);
		expect(t.fluxer.reactions).toEqual([{ channelId: "500", messageId: b.id, emoji: "🐢" }]);
	});

	it("posts a notice on API errors and alerts the owner after three in a row", async () => {
		const t = setup();
		for (let i = 0; i < 3; i++) {
			t.runner.next(async (_m, hooks) => {
				hooks.onCallEnd(null, "claude-haiku-5-5");
				throw new ClaudeError("overloaded", "overloaded", 529);
			});
			await t.say({ author: allowed, content: `${t.mention} q${i}`, mentions: t.botMentions });
		}
		const answers = t.fluxer.sent.filter((s) => s.channelId === "500");
		expect(answers).toHaveLength(3);
		for (const a of answers) expect(t.fluxer.shown(a.id)).toMatch(/can't reach Claude/);
		const toOwner = t.fluxer.sent.filter((s) => s.channelId === "dm-1");
		expect(toOwner).toHaveLength(1);
		expect(toOwner[0]?.content).toMatch(/last 3 answers failed \(latest: Claude overloaded\)/);
		expect(t.spend.reserve("10", []).ok).toBe(true);
	});

	const failWith = (t: ReturnType<typeof setup>, err: ClaudeError) =>
		t.runner.next(async (_m, hooks) => {
			hooks.onCallEnd(null, "claude-haiku-5-5");
			throw err;
		});

	for (const [kind, status, text] of [
		["spend_limit", 400, /Check the Console/],
		["auth", 401, /rejected my API key/],
	] as const) {
		it(`alerts the owner once per incident when requests fail with ${kind}`, async () => {
			const t = setup();
			const users = [allowed, roleUser, allowed];
			for (const [i, author] of users.entries()) {
				failWith(t, new ClaudeError("no", kind, status));
				await t.say({ author, memberRoles: ["700"], content: `${t.mention} q${i}`, mentions: t.botMentions });
			}
			const toOwner = () => t.fluxer.sent.filter((s) => s.channelId === "dm-1");
			expect(toOwner()).toHaveLength(1);
			expect(toOwner()[0]?.content).toMatch(text);
			// A success ends the incident; the next failure is a new one.
			t.runner.answer("fine");
			await t.say({ author: allowed, content: `${t.mention} ok?`, mentions: t.botMentions });
			failWith(t, new ClaudeError("no", kind, status));
			await t.say({ author: allowed, content: `${t.mention} again`, mentions: t.botMentions });
			expect(toOwner()).toHaveLength(2);
			// A long incident gets one reminder a day.
			t.clock.advance(24 * 3_600_000);
			failWith(t, new ClaudeError("no", kind, status));
			await t.say({ author: allowed, content: `${t.mention} next day`, mentions: t.botMentions });
			expect(toOwner()).toHaveLength(3);
		});
	}

	it("doesn't blame Claude when fetching the chain from Fluxer fails", async () => {
		const t = setup();
		for (let i = 0; i < 3; i++) {
			const a = chatMessage({ author: allowed, content: `first ${i}` });
			const b = chatMessage({
				author: roleUser,
				content: "second",
				reference: { messageId: a.id, channelId: "500", guildId: "300" },
			});
			t.fluxer.fetchError = new FluxerRequestError("fetchMessage: 503", 503, null);
			await t.say({
				author: allowed,
				content: `${t.mention} third`,
				mentions: t.botMentions,
				reference: { messageId: b.id, channelId: "500", guildId: "300" },
				referenced: b,
			});
		}
		expect(t.runner.calls).toHaveLength(0);
		const answers = t.fluxer.sent.filter((s) => s.channelId === "500");
		expect(answers).toHaveLength(3);
		for (const a of answers) {
			expect(t.fluxer.shown(a.id)).toMatch(/something went wrong/);
			expect(t.fluxer.shown(a.id)).not.toMatch(/Claude/);
		}
		const toOwner = t.fluxer.sent.filter((s) => s.channelId === "dm-1");
		expect(toOwner.map((s) => s.content)).toEqual([expect.stringMatching(/latest: Fluxer 503/)]);
	});

	it("keeps posting answers and counting spend in memory when the ledger can't be written", async () => {
		const t = setup("", "user_daily_usd = 0.60");
		t.store.insertUsage = () => {
			throw new Error("database or disk is full");
		};
		// $0.15 of output each: the second call leaves $0.30 spent, so a third $0.40 reservation won't fit.
		t.runner.answer("one", { input_tokens: 0, output_tokens: 300_000 });
		t.runner.answer("two", { input_tokens: 0, output_tokens: 300_000 });
		await t.say({ author: allowed, content: `${t.mention} one`, mentions: t.botMentions });
		const first = t.fluxer.sent.find((s) => s.channelId === "500");
		expect(t.fluxer.shown(first?.id as string)).toBe("one");
		await t.say({ author: allowed, content: `${t.mention} two`, mentions: t.botMentions });
		expect(t.spend.usage("10").today).toBe(300_000);
		await t.say({ author: allowed, content: `${t.mention} three`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(2);
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/<@10>, you've reached your daily limit/);
		const toOwner = t.fluxer.sent.filter((s) => s.channelId === "dm-1");
		expect(toOwner.map((s) => s.content)).toEqual([expect.stringMatching(/couldn't write to the spending ledger/)]);
	});

	it("rebuilds the chain from text once if replayed thinking is rejected", async () => {
		const t = setup();
		t.runner.answer("First.");
		await t.say({ author: allowed, content: `${t.mention} one`, mentions: t.botMentions });
		const botReply = t.fluxer.messages.get(t.fluxer.sent[0]?.id as string) as ChatMessage;
		t.runner.next(async (_m, hooks) => {
			hooks.onCallEnd(null, "claude-haiku-5-5");
			throw new ClaudeError("bound to a different conversation", "thinking_mismatch", 400);
		});
		t.runner.answer("Second.");
		await t.say({
			author: allowed,
			content: "two",
			reference: { messageId: botReply.id, channelId: "500", guildId: "300" },
			referenced: botReply,
		});
		expect(t.runner.calls).toHaveLength(3);
		const rebuilt = t.runner.calls[2] as MessageParam[];
		// Rebuilt from Fluxer text: the assistant turn is plain text, not the stored blocks.
		expect(JSON.stringify(rebuilt[1])).toContain("First.");
		expect(t.fluxer.shown(t.fluxer.sent.at(-1)?.id as string)).toBe("Second.");
	});

	it("rebuilds once on another 400 for a replayed chain, and drops the stored turn", async () => {
		const t = setup();
		t.runner.answer("First.");
		await t.say({ author: allowed, content: `${t.mention} one`, mentions: t.botMentions });
		const botReply = t.fluxer.messages.get(t.fluxer.sent[0]?.id as string) as ChatMessage;
		failWith(t, new ClaudeError("bad block", "invalid_request", 400));
		t.runner.answer("Second.");
		const follow = { reference: { messageId: botReply.id, channelId: "500", guildId: "300" }, referenced: botReply };
		await t.say({ author: allowed, content: "two", ...follow });
		expect(t.runner.calls).toHaveLength(3);
		const plain = { role: "assistant", content: [{ type: "text", text: "First." }] };
		// Replayed: the stored blocks; rebuilt: plain text from Fluxer.
		expect((t.runner.calls[1] as MessageParam[])[1]).toEqual({ role: "assistant", content: [textBlock("First.")] });
		expect((t.runner.calls[2] as MessageParam[])[1]).toEqual(plain);
		expect(t.fluxer.shown(t.fluxer.sent.at(-1)?.id as string)).toBe("Second.");
		// The rejected turn isn't replayed again.
		t.runner.answer("Third.");
		await t.say({ author: allowed, content: "three", ...follow });
		expect((t.runner.calls[3] as MessageParam[])[1]).toEqual(plain);
	});

	it("doesn't rebuild on a 400 after a call was accepted", async () => {
		const t = setup();
		t.runner.answer("First.");
		await t.say({ author: allowed, content: `${t.mention} one`, mentions: t.botMentions });
		const botReply = t.fluxer.messages.get(t.fluxer.sent[0]?.id as string) as ChatMessage;
		t.runner.next(async (_m, hooks) => {
			hooks.onCallEnd(usage(), "claude-haiku-5-5");
			expect(hooks.beforeContinuation()).toBe(true);
			hooks.onCallEnd(null, "claude-haiku-5-5");
			throw new ClaudeError("bad continuation", "invalid_request", 400);
		});
		await t.say({
			author: allowed,
			content: "two",
			reference: { messageId: botReply.id, channelId: "500", guildId: "300" },
			referenced: botReply,
		});
		expect(t.runner.calls).toHaveLength(2);
		expect(t.fluxer.shown(t.fluxer.sent.at(-1)?.id as string)).toMatch(/can't reach Claude/);
	});

	it("doesn't start queued requests once shutdown began", async () => {
		const t = setup("", "max_concurrent = 1");
		let open = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		t.runner.next(async (_m, hooks) => {
			await gate;
			hooks.progress.onText("done");
			hooks.onCallEnd(usage(), "claude-haiku-5-5");
			const content = [textBlock("done")];
			return { stop: "end_turn", content, pieces: [content], refusalCategory: null, lastUsage: usage() };
		});
		t.runner.answer("never");
		const first = chatMessage({ author: allowed, content: `${t.mention} one`, mentions: t.botMentions });
		const second = chatMessage({
			author: roleUser,
			memberRoles: ["700"],
			content: `${t.mention} two`,
			mentions: t.botMentions,
		});
		t.fluxer.emit("messageCreate", first);
		t.fluxer.emit("messageCreate", second);
		await new Promise((resolve) => setImmediate(resolve));
		const drained = t.app.drain(1000);
		open();
		await drained;
		expect(t.runner.calls).toHaveLength(1);
		expect(t.fluxer.sent.filter((s) => s.replyTo === second.id)).toHaveLength(0);
	});
});

describe("group DMs", () => {
	const group = { guildId: null, isGroupDm: true, channelId: "800", memberRoles: null };

	it("answers allowed users who mention the bot, pinging them, and ignores everything else", async () => {
		const t = setup();
		t.runner.answer("Hi all.");
		await t.say({ ...group, author: allowed, content: "just chatting" });
		await t.say({ ...group, author: stranger, content: `${t.mention} hi`, mentions: t.botMentions });
		const q = await t.say({ ...group, author: allowed, content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(1);
		expect(JSON.stringify(t.runner.calls[0])).toContain("[Context: group DM,");
		expect(t.fluxer.sent).toEqual([expect.objectContaining({ channelId: "800", replyTo: q.id, pingReplied: true })]);
	});

	it("leaves group DMs when they're turned off, and tells the owner", async () => {
		const t = setup("[dms]\ngroups = false");
		t.fluxer.emit("groupDmCreate", { channelId: "801", name: "friends" });
		await t.say({ ...group, author: allowed, content: `${t.mention} hi`, mentions: t.botMentions });
		await t.app.drain(1000);
		expect(t.runner.calls).toHaveLength(0);
		expect(t.fluxer.leftGroups).toEqual(["801", "800"]);
		expect(t.fluxer.sent.filter((s) => s.channelId === "dm-1")).toHaveLength(2);
	});

	it("stays in group DMs by default", async () => {
		const t = setup();
		t.fluxer.emit("groupDmCreate", { channelId: "801", name: "friends" });
		await t.app.drain(1000);
		expect(t.fluxer.leftGroups).toEqual([]);
	});
});

describe("guild allowlist", () => {
	it("leaves unlisted communities and tells the owner", async () => {
		const t = setup();
		t.fluxer.emit("guildCreate", { id: "999", name: "Elsewhere", channels: new Map() });
		t.fluxer.emit("guildCreate", { id: "300", name: "Home", channels: new Map() });
		await t.app.drain(1000);
		expect(t.fluxer.left).toEqual(["999"]);
		expect(t.fluxer.sent.find((s) => s.channelId === "dm-1")?.content).toMatch(/"Elsewhere" \(999\)/);
	});

	it("names a community found at startup once its GUILD_CREATE arrives", async () => {
		const t = setup();
		t.fluxer.emit("ready", { user: t.fluxer.botUser as ChatUser, guildIds: ["999", "300"] });
		t.fluxer.emit("guildCreate", { id: "999", name: "Elsewhere", channels: new Map() });
		t.fluxer.emit("guildCreate", { id: "300", name: "Home", channels: new Map() });
		await t.app.drain(1000);
		expect(t.fluxer.left).toEqual(["999"]);
		const alerts = t.fluxer.sent.filter((s) => s.channelId === "dm-1");
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.content).toMatch(/"Elsewhere" \(999\)/);
	});

	it("quotes the community name as plain text, never as a link", async () => {
		const t = setup();
		t.fluxer.emit("guildCreate", {
			id: "999",
			name: "Fluxer Safety:\n# suspended, [appeal](https://evil.example) <@1>",
			channels: new Map(),
		});
		await t.app.drain(1000);
		const alert = t.fluxer.sent.find((s) => s.channelId === "dm-1")?.content ?? "";
		expect(alert).toContain("\\[appeal\\](https\\://evil.example)");
		expect(alert).not.toMatch(/[^\\]\]\(/); // no unescaped "](" that would start a link
		expect(alert).not.toContain("\n");
		expect(alert).not.toContain("<@1>");
		expect(alert).toContain("(999)");
	});

	it("leaves every unlisted community but sends at most 3 alerts an hour", async () => {
		const t = setup();
		for (let i = 0; i < 5; i++) t.fluxer.emit("guildCreate", { id: `90${i}`, name: `Spam ${i}`, channels: new Map() });
		await t.app.drain(1000);
		expect(t.fluxer.left).toHaveLength(5);
		expect(t.fluxer.sent.filter((s) => s.channelId === "dm-1")).toHaveLength(3);
		t.clock.advance(3_600_000);
		t.fluxer.emit("guildCreate", { id: "906", name: "Later", channels: new Map() });
		await t.app.drain(1000);
		expect(t.fluxer.sent.filter((s) => s.channelId === "dm-1")).toHaveLength(4);
	});
});
