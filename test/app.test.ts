// SPDX-License-Identifier: AGPL-3.0-or-later
// End-to-end tests of the message flow with fake Fluxer and a scripted Claude runner.

import { describe, expect, it, vi } from "vitest";
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
	const spend = new Spend({ config, prices: loaded.prices, pro: loaded.pro, store, clock, log: quietLog });
	const replay = new ReplayCache({ ttlMs: 300_000, maxBytes: 64 * 1024 * 1024, clock });
	const notices = new NoticeIds();
	const access = new Access({
		config,
		fetchMember: (g, u) => fluxer.fetchMember(g, u),
		clock,
		log: quietLog,
		overrides: store,
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
		threadDebounceMs: 20,
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

	it("offers DMs only to users allowed by ID, and ignores role members' DMs", async () => {
		const t = setup();
		t.fluxer.members.set("300:20", { roles: ["700"], nick: null });
		await t.say({ author: allowed, content: `${t.mention} help`, mentions: t.botMentions });
		await t.say({ author: roleUser, memberRoles: ["700"], content: `${t.mention} help`, mentions: t.botMentions });
		expect(t.fluxer.sent[0]?.content).toContain("You can also DM me.");
		expect(t.fluxer.sent[1]?.content).not.toContain("DM me");
		await t.say({ author: roleUser, guildId: null, isDm: true, channelId: "dm-20", memberRoles: null, content: "hi" });
		expect(t.runner.calls).toHaveLength(0);
		expect(t.fluxer.sent).toHaveLength(2);
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

	it("records each call of a pause_turn continuation", async () => {
		const t = setup();
		t.runner.next(async (_m, hooks) => {
			hooks.onCallEnd(
				usage({ server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 } }),
				"claude-haiku-5-5",
			);
			hooks.progress.onText("Found it.");
			hooks.onCallEnd(usage(), "claude-haiku-5-5");
			const pieces = [[textBlock("Searching. ")], [textBlock("Found it.")]];
			return { stop: "end_turn", content: pieces.flat(), pieces, refusalCategory: null, lastUsage: usage() };
		});
		await t.say({ author: allowed, content: `${t.mention} look it up`, mentions: t.botMentions });
		const stats = t.store.dayStats("2026-11-01");
		expect(stats.requests).toBe(2);
		expect(stats.webSearches).toBe(3);
	});
});

describe("spending caps", () => {
	/** US$0.50 of spend for user 10 today: the whole US$0.50 cap. */
	const spendSome = (t: ReturnType<typeof setup>) =>
		t.spend.record("10", "300", "claude-haiku-5-5", usage({ input_tokens: 0, output_tokens: 1_000_000 }));

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
		// Haiku output at US$0.50 per million: $0.85, then $1.05.
		t.runner.answer("pricey", { output_tokens: 1_700_000 }).answer("over", { output_tokens: 400_000 });
		await t.say({ author: allowed, content: `${t.mention} hi`, mentions: t.botMentions });
		await t.say({ author: roleUser, memberRoles: ["700"], content: `${t.mention} hi`, mentions: t.botMentions });
		const toOwner = t.fluxer.sent.filter((s) => s.channelId === "dm-1");
		expect(toOwner.map((s) => s.content)).toEqual([
			expect.stringMatching(/Monthly spend is at 85%/),
			"Monthly spend limit reached: US$1.05 of US$1.00. I won't answer anyone until next month.",
		]);
		await t.say({ author: allowed, content: `${t.mention} again`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/monthly spend limit of US\$1\.00/);
		expect(t.runner.calls).toHaveLength(2);
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
		const t = setup("", "user_daily_usd = 0.30");
		t.store.insertUsage = () => {
			throw new Error("database or disk is full");
		};
		// $0.15 of output each: the second call reaches the $0.30 cap.
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

describe("owner commands", () => {
	const owner = chatUser("1", { globalName: "Owner" });

	it("shows, sets and resets the personality, which changes the system prompt", async () => {
		const t = setup();
		const loaded = (t.app as unknown as { d: { loaded: { systemPrompt: string; personality: string } } }).d.loaded;
		await t.say({ author: owner, content: `${t.mention} personality`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/\(default\)/);
		await t.say({
			author: owner,
			content: `${t.mention} personality set Talk like a pirate.`,
			mentions: t.botMentions,
		});
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/Personality updated/);
		expect(loaded.systemPrompt.endsWith("Talk like a pirate.")).toBe(true);
		expect(t.store.getSetting("personality")).toBe("Talk like a pirate.");
		await t.say({ author: owner, content: `${t.mention} personality reset`, mentions: t.botMentions });
		expect(t.store.getSetting("personality")).toBeNull();
		expect(loaded.systemPrompt.endsWith("Talk like a pirate.")).toBe(false);
		expect(t.runner.calls).toHaveLength(0);
	});

	it("sets, clears and resets the status message, saving it", async () => {
		const t = setup();
		await t.say({ author: owner, content: `${t.mention} presence set Ask me anything`, mentions: t.botMentions });
		expect(t.fluxer.presences.at(-1)).toEqual({ status: "online", customStatus: "Ask me anything" });
		expect(t.store.getSetting("presence")).toBe("Ask me anything");
		await t.say({ author: owner, content: `${t.mention} presence`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toBe("Status message (set with `presence set`): Ask me anything");
		await t.say({ author: owner, content: `${t.mention} presence clear`, mentions: t.botMentions });
		expect(t.fluxer.presences.at(-1)?.customStatus).toBeNull();
		await t.say({ author: owner, content: `${t.mention} presence reset`, mentions: t.botMentions });
		expect(t.fluxer.presences.at(-1)?.customStatus).toBe("@mention me to ask");
		expect(t.store.getSetting("presence")).toBeNull();
		await t.say({ author: owner, content: `${t.mention} presence set ${"x".repeat(129)}`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/limit is 128/);
	});

	it("grants and revokes access", async () => {
		const t = setup();
		t.runner.answer("hi");
		await t.say({ author: stranger, content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(0);
		await t.say({ author: owner, content: `${t.mention} grant user <@30>`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toBe("<@30> can use me now.");
		await t.say({ author: stranger, content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(1);
		await t.say({ author: owner, content: `${t.mention} revoke user <@30>`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/^<@30> no longer has access by ID/);
		await t.say({ author: stranger, content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(1);
		await t.say({ author: owner, content: `${t.mention} revoke user <@10>`, mentions: t.botMentions });
		await t.say({ author: owner, content: `${t.mention} access`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/Revoked users: <@10>/);
		await t.say({ author: owner, content: `${t.mention} revoke user <@1>`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toBe("The owner always has access.");
	});

	it("blocks users whatever their roles, and unblocks them", async () => {
		const t = setup();
		const say = (content: string) =>
			t.say({ author: owner, content: `${t.mention} ${content}`, mentions: t.botMentions });
		t.runner.answer("hi");
		await say("block user <@20>");
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/^<@20> is blocked/);
		await t.say({ author: roleUser, memberRoles: ["700"], content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(0);
		await say("grant user <@20>");
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/^<@20> is blocked. Unblock them first/);
		await say("access");
		expect(t.fluxer.sent.at(-1)?.content).toContain("Blocked users: <@20>");
		await say("block user <@1>");
		expect(t.fluxer.sent.at(-1)?.content).toBe("The owner can't be blocked.");
		await say("unblock user <@20>");
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/^<@20> is unblocked/);
		await t.say({ author: roleUser, memberRoles: ["700"], content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(1);
		await say("unblock user <@20>");
		expect(t.fluxer.sent.at(-1)?.content).toBe("<@20> isn't blocked.");
	});

	it("lets admins manage access but not the owner's or admins', and DMs the owner about each change", async () => {
		const t = setup("[pro]\nenabled = true", "monthly_usd = 150");
		const admin = chatUser("40", { globalName: "Admin" });
		const as = (author: typeof owner, content: string) =>
			t.say({ author, content: `${t.mention} ${content}`, mentions: t.botMentions });
		const last = () => t.fluxer.sent.filter((m) => m.channelId !== "dm-1").at(-1)?.content;
		const toOwner = () => t.fluxer.sent.filter((m) => m.channelId === "dm-1").map((m) => m.content);

		await as(admin, "grant user <@30>");
		expect(t.fluxer.sent).toHaveLength(0); // not an admin yet, and no access: ignored
		await as(owner, "admin add user <@40>");
		expect(last()).toMatch(/^<@40> is an admin now/);
		await as(owner, "block user <@40>");
		expect(last()).toMatch(/^<@40> is an admin. Remove them first/);

		await as(admin, "grant user <@30>");
		expect(last()).toBe("<@30> can use me now.");
		expect(toOwner()).toEqual(["Admin <@40> made a change: <@30> can use me now."]);
		await as(admin, "pro add user <@30>");
		await as(admin, "block user <@31>");
		expect(toOwner()).toHaveLength(3);

		await as(admin, "block user <@1>");
		expect(last()).toBe("Only the owner can change the owner's or an admin's access.");
		await as(admin, "pro remove user <@40>");
		expect(last()).toBe("Only the owner can change the owner's or an admin's access.");
		for (const cmd of ["personality", "presence clear", "reset <@30>", "admin add user <@30>"]) {
			await as(admin, cmd);
			expect(last()).toBe("Only the owner can do that.");
		}
		await as(admin, "access");
		expect(last()).toContain("Admins: <@40>");
		await as(admin, "status");
		expect(last()).toMatch(/^\*\*Clanker /);
		await as(admin, "help");
		expect(last()).toContain("Admin commands");
		expect(toOwner()).toHaveLength(3); // refusals and listings don't DM the owner

		await as(owner, "admin remove user <@40>");
		expect(last()).toBe("<@40> is no longer an admin.");
		const sent = t.fluxer.sent.length;
		await as(admin, "status");
		expect(t.fluxer.sent).toHaveLength(sent); // no access any more: ignored
	});

	it("grants whole communities by name, also when given as a role, but not in DMs", async () => {
		const t = setup();
		const say = (content: string) =>
			t.say({ author: owner, content: `${t.mention} ${content}`, mentions: t.botMentions });
		await say("grant community 999");
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/I don't serve that community/);
		await say("grant role 300");
		expect(t.fluxer.sent.at(-1)?.content).toBe(
			"Everyone in Home (300) can use me now there. DMs still need `grant user`.",
		);
		await say("access");
		const listing = t.fluxer.sent.at(-1)?.content ?? "";
		expect(listing).toContain("Everyone in: Home (300) (granted) (not in DMs)");
		expect(listing).toContain("Roles: <@&700>");
		expect(listing).toContain("Blocked users: none");
		expect(listing).not.toContain("<@&300>");
		t.runner.answer("hi");
		await t.say({ author: stranger, memberRoles: [], content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(1);
		await t.say({ author: stranger, guildId: null, isDm: true, channelId: "dm-30", memberRoles: null, content: "hi" });
		expect(t.runner.calls).toHaveLength(1);
		await say("revoke community 300");
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/^Home \(300\) no longer gives access to all its members/);
		await say("access");
		expect(t.fluxer.sent.at(-1)?.content).toContain("Revoked communities: Home (300)");
	});

	it("resets a user's daily usage", async () => {
		const t = setup("", "user_daily_usd = 0.50");
		t.runner.answer("pricey", { output_tokens: 1_200_000 }); // $0.60
		await t.say({ author: allowed, content: `${t.mention} one`, mentions: t.botMentions });
		await t.say({ author: allowed, content: `${t.mention} two`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/daily limit/);
		await t.say({ author: owner, content: `${t.mention} reset <@10>`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/Reset <@10>'s usage for today \(was US\$0\.60\)/);
		t.runner.answer("again");
		await t.say({ author: allowed, content: `${t.mention} three`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(2);
	});

	it("doesn't treat other users' messages as owner commands", async () => {
		const t = setup();
		t.runner.answer("I can't do that.");
		await t.say({ author: allowed, content: `${t.mention} grant user <@30>`, mentions: t.botMentions });
		expect(t.runner.calls).toHaveLength(1);
	});
});

describe("role mentions", () => {
	it("answers a mention of the bot's own role", async () => {
		const t = setup();
		t.fluxer.ownRoles.set("300", ["900"]);
		t.runner.answer("Hi.");
		await t.say({ author: allowed, content: "<@&900> hi" });
		expect(t.runner.calls).toHaveLength(1);
		await t.say({ author: allowed, content: "<@&901> hi" });
		expect(t.runner.calls).toHaveLength(1);
	});
});

describe("commands in conversations", () => {
	const owner = chatUser("1", { globalName: "Owner" });

	it("ignores replies to command replies unless they mention the bot, and keeps commands out of context", async () => {
		const t = setup();
		const cmd = await t.say({ author: owner, content: `${t.mention} grant user <@20>`, mentions: t.botMentions });
		const reply = t.fluxer.messages.get(t.fluxer.sent.at(-1)?.id as string) as ChatMessage;
		const ref = { reference: { messageId: reply.id, channelId: "500", guildId: "300" }, referenced: reply };
		await t.say({ author: roleUser, memberRoles: [], content: "that sounds fun", ...ref });
		expect(t.runner.calls).toHaveLength(0);

		t.runner.answer("Hi Bob.");
		await t.say({ author: roleUser, memberRoles: [], content: `${t.mention} hi`, mentions: t.botMentions, ...ref });
		expect(t.runner.calls).toHaveLength(1);
		const sent = JSON.stringify(t.runner.calls[0]);
		expect(sent).not.toContain("grant user");
		expect(sent).not.toContain("can use me now");
		expect(cmd.id).toBeDefined();
	});

	it("lets the owner use status and usage all in a channel", async () => {
		const t = setup();
		await t.say({ author: owner, content: `${t.mention} status`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/gateway connected/);
		await t.say({ author: owner, content: `${t.mention} usage all`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/Usage this month/);
	});
});

describe("threads", () => {
	const long = "A long answer. ".repeat(50);

	async function longAnswer(t: ReturnType<typeof setup>) {
		t.runner.answer(long);
		const q = await t.say({ author: allowed, content: `${t.mention} explain rust`, mentions: t.botMentions });
		return { q, threadId: q.id };
	}

	it("moves a long answer into a thread on the question, posting nothing in the channel", async () => {
		const t = setup();
		const { q, threadId } = await longAnswer(t);
		expect(t.fluxer.createdThreads).toEqual([{ channelId: "500", messageId: q.id, name: "explain rust" }]);
		expect(t.fluxer.sent.filter((m) => m.channelId === "500" && t.fluxer.messages.has(m.id))).toHaveLength(0);
		const inThread = t.fluxer.sent.filter((m) => m.channelId === threadId);
		expect(inThread.map((m) => t.fluxer.shown(m.id)).join("")).toContain("A long answer.");
		expect(inThread.every((m) => m.replyTo === undefined)).toBe(true);
	});

	it("answers every message in its own thread, batching a burst into one turn", async () => {
		const t = setup();
		const { threadId } = await longAnswer(t);
		const inThread = { channelId: threadId, isThread: true, memberRoles: [] };
		t.runner.answer("Short follow-up answer.");
		await t.say({ ...inThread, author: allowed, content: "is it fast" });
		await t.say({ ...inThread, author: stranger, content: "who's asking" });
		await t.say({ ...inThread, author: allowed, content: "and safe?" });
		await vi.waitFor(() => expect(t.runner.calls).toHaveLength(2), { timeout: 1000 });
		const sent = JSON.stringify(t.runner.calls[1]);
		expect(sent).toContain("is it fast");
		expect(sent).toContain("who's asking");
		expect(sent).toContain("and safe?");
		expect(sent).toContain("explain rust");
		await vi.waitFor(() => expect(t.fluxer.sent.at(-1)?.channelId).toBe(threadId));

		// Someone who isn't allowed doesn't start a turn.
		await t.say({ ...inThread, author: stranger, content: "hello?" });
		await new Promise((r) => setTimeout(r, 80));
		expect(t.runner.calls).toHaveLength(2);
	});

	it("reads the thread when someone replies to the question in the channel later", async () => {
		const t = setup();
		const { q } = await longAnswer(t);
		t.clock.advance(10 * 60_000);
		t.runner.answer("Yes.");
		await t.say({
			author: roleUser,
			memberRoles: ["700"],
			content: `${t.mention} is it fast?`,
			mentions: t.botMentions,
			reference: { messageId: q.id, channelId: "500", guildId: "300" },
			referenced: q,
		});
		expect(t.runner.calls).toHaveLength(2);
		const sent = JSON.stringify(t.runner.calls[1]);
		expect(sent).toContain("explain rust");
		expect(sent).toContain("A long answer.");
	});

	it("in other threads answers mentions with the thread's first message as context", async () => {
		const t = setup();
		const starter = await t.say({ author: roleUser, memberRoles: [], content: "Look at this cool crate" });
		t.fluxer.threads.set(starter.id, "500");
		t.runner.answer("Nice.");
		await t.say({
			channelId: starter.id,
			isThread: true,
			author: allowed,
			content: `${t.mention} what do you think?`,
			mentions: t.botMentions,
		});
		const sent = JSON.stringify(t.runner.calls[0]);
		expect(sent).toContain("Look at this cool crate");
		expect(sent).toContain("what do you think?");
		expect(t.fluxer.sent.at(-1)).toMatchObject({ channelId: starter.id, replyTo: undefined });
		// Without a mention, nothing happens there.
		await t.say({ channelId: starter.id, isThread: true, author: allowed, content: "cool" });
		expect(t.runner.calls).toHaveLength(1);
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

describe("pro tier", () => {
	const owner = chatUser("1", { globalName: "Owner" });
	const PRO = '[pro]\nenabled = true\nroles = ["777"]';
	const MONTHLY = "monthly_usd = 150\n";

	it("answers pro users with the pro tier and everyone else with the standard one", async () => {
		const t = setup(PRO, MONTHLY);
		t.runner.answer("standard").answer("pro");
		await t.say({ author: allowed, content: `${t.mention} hi`, mentions: t.botMentions });
		await t.say({ author: roleUser, memberRoles: ["700", "777"], content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.runner.tiers.map((x) => x?.name)).toEqual(["standard", "pro"]);
		expect(t.runner.tiers[1]?.config.model.name).toBe("claude-sonnet-5-5");
	});

	it("adds and removes pro users with owner commands, and keeps them in the ledger", async () => {
		const t = setup(PRO, MONTHLY);
		t.runner.answer("a").answer("b").answer("c");
		await t.say({ author: owner, content: `${t.mention} pro add user <@10>`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toBe(
			"<@10> gets the pro tier now (`claude-sonnet-5-5`). They still need access to use me.",
		);
		expect(t.store.proOverrides()).toEqual([{ kind: "user", id: "10", state: "add" }]);
		await t.say({ author: allowed, content: `${t.mention} hi`, mentions: t.botMentions });
		await t.say({ author: owner, content: `${t.mention} pro`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/Users: <@10> \(added\)\nRoles: <@&777>/);
		await t.say({ author: owner, content: `${t.mention} pro remove user 10`, mentions: t.botMentions });
		await t.say({ author: allowed, content: `${t.mention} hi`, mentions: t.botMentions });
		// Taken off by ID: the pro role doesn't bring it back.
		await t.say({ author: owner, content: `${t.mention} pro remove role <@&777>`, mentions: t.botMentions });
		await t.say({ author: roleUser, memberRoles: ["700", "777"], content: `${t.mention} hi`, mentions: t.botMentions });
		expect(t.runner.tiers.map((x) => x?.name)).toEqual(["pro", "standard", "standard"]);
	});

	it("shows pro users their model and cap in help", async () => {
		const t = setup(PRO, MONTHLY);
		await t.say({
			author: roleUser,
			memberRoles: ["700", "777"],
			content: `${t.mention} help`,
			mentions: t.botMentions,
		});
		const text = t.fluxer.sent.at(-1)?.content ?? "";
		expect(text).toContain("It answers you (pro) with Claude (`claude-sonnet-5-5`, effort high)");
		expect(text).toContain("US$10.00 for you per day");
	});

	it("says the pro tier is off when [pro] isn't enabled", async () => {
		const t = setup();
		await t.say({ author: owner, content: `${t.mention} pro add user <@10>`, mentions: t.botMentions });
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/^The pro tier is off/);
		expect(t.store.proOverrides()).toEqual([]);
	});

	it("blocks a pro user for the day at the pro cap", async () => {
		const t = setup(PRO, MONTHLY);
		t.runner.answer("expensive", { output_tokens: 1_100_000 }); // US$11 at Sonnet output prices
		await t.say({ author: roleUser, memberRoles: ["700", "777"], content: `${t.mention} hi`, mentions: t.botMentions });
		await t.say({
			author: roleUser,
			memberRoles: ["700", "777"],
			content: `${t.mention} again`,
			mentions: t.botMentions,
		});
		expect(t.runner.calls).toHaveLength(1);
		expect(t.fluxer.sent.at(-1)?.content).toMatch(/<@20>, you've reached your daily limit of US\$10\.00/);
	});
});
