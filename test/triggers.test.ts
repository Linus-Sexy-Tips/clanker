// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { detectTrigger, mentionsUser, parseCommand, parseOwnerCommand, stripBotMentions } from "../src/triggers.js";
import type { ChatMessage, ChatUser } from "../src/types.js";

const BOT = "100";
const user = (id: string, bot = false): ChatUser => ({ id, username: `u${id}`, globalName: null, bot });

function msg(o: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: "1",
		channelId: "c",
		guildId: "g",
		isDm: false,
		isGroupDm: false,
		isThread: false,
		author: user("5"),
		memberNick: null,
		memberRoles: [],
		webhookId: null,
		type: 0,
		isUserMessage: true,
		content: "",
		timestamp: "2026-11-01T00:00:00.000Z",
		editedTimestamp: null,
		mentions: [],
		mentionRoleIds: [],
		mentionEveryone: false,
		reference: null,
		referenced: undefined,
		attachments: [],
		...o,
	};
}

describe("detectTrigger", () => {
	it("group DMs trigger only on a mention or a reply", () => {
		const group = { isGroupDm: true, guildId: null };
		expect(detectTrigger(msg({ ...group, content: "hi" }), BOT)).toBeNull();
		expect(detectTrigger(msg({ ...group, content: "<@100> hi" }), BOT)).toBe("mention");
		expect(detectTrigger(msg({ ...group, referenced: msg({ id: "9", author: user(BOT, true) }) }), BOT)).toBe("reply");
	});
	it("DMs always trigger", () => {
		expect(detectTrigger(msg({ isDm: true, guildId: null, content: "hi" }), BOT)).toBe("dm");
	});
	it("mentions written in the content", () => {
		expect(detectTrigger(msg({ content: "<@100> hi", mentions: [{ ...user(BOT, true), nick: null }] }), BOT)).toBe(
			"mention",
		);
		expect(detectTrigger(msg({ content: "hey <@!100>" }), BOT)).toBe("mention");
		expect(mentionsUser(msg({ content: "<@1000>" }), BOT)).toBe(false);
	});
	it("doesn't trigger on the mention list alone (forwards and embeds put users there)", () => {
		expect(detectTrigger(msg({ content: "", mentions: [{ ...user(BOT, true), nick: null }] }), BOT)).toBeNull();
		expect(detectTrigger(msg({ content: "see this", mentions: [{ ...user(BOT, true), nick: null }] }), BOT)).toBeNull();
	});
	it("ignores @everyone and role mentions", () => {
		expect(detectTrigger(msg({ content: "@everyone", mentionEveryone: true }), BOT)).toBeNull();
		expect(detectTrigger(msg({ content: "<@&100>", mentionRoleIds: ["100"] }), BOT)).toBeNull();
	});
	it("replies to the bot trigger; replies to others don't", () => {
		const botMsg = msg({ id: "9", author: user(BOT, true) });
		expect(detectTrigger(msg({ referenced: botMsg }), BOT)).toBe("reply");
		expect(detectTrigger(msg({ referenced: msg({ author: user("7") }) }), BOT)).toBeNull();
		expect(detectTrigger(msg({ referenced: null }), BOT)).toBeNull();
	});
});

describe("commands", () => {
	it("whole-message keywords only", () => {
		expect(parseCommand(msg({ content: "<@100> help" }), BOT)).toBe("help");
		expect(parseCommand(msg({ content: "<@100>   Usage   ALL " }), BOT)).toBe("usage all");
		expect(parseCommand(msg({ content: "status <@100>" }), BOT)).toBe("status");
		expect(parseCommand(msg({ content: "<@100> help me write a poem" }), BOT)).toBeNull();
		expect(parseCommand(msg({ content: "<@100>" }), BOT)).toBeNull();
		expect(
			parseCommand(
				msg({
					content: "<@100> help",
					attachments: [
						{ id: "a", filename: "x.png", url: "u", contentType: "image/png", size: 1, width: 1, height: 1 },
					],
				}),
				BOT,
			),
		).toBeNull();
	});
	it("strips bot mentions", () => {
		expect(stripBotMentions("<@100> what is <@!100>  up?\n <@100> ok", BOT)).toBe("what is up?\nok");
		expect(stripBotMentions("<@200> hi", BOT)).toBe("<@200> hi");
	});
});

describe("role mentions", () => {
	it("counts a mention of one of the bot's own roles as a mention of the bot", () => {
		expect(detectTrigger(msg({ content: "<@&77> hello" }), BOT, ["77"])).toBe("mention");
		expect(detectTrigger(msg({ content: "<@&78> hello" }), BOT, ["77"])).toBeNull();
		expect(detectTrigger(msg({ content: "<@&77> hello" }), BOT)).toBeNull();
		expect(parseCommand(msg({ content: "<@&77> help" }), BOT, ["77"])).toBe("help");
		expect(parseOwnerCommand(msg({ content: "<@&77> personality set Be terse." }), BOT, ["77"])).toEqual({
			kind: "personality-set",
			text: "Be terse.",
		});
		expect(stripBotMentions("<@&77> <@100> hi", BOT, ["77"])).toBe("hi");
	});
});

describe("owner commands", () => {
	const p = (content: string) => parseOwnerCommand(msg({ content }), BOT);
	it("parses personality, access, reset, grant and revoke", () => {
		expect(p("<@100> personality")).toEqual({ kind: "personality-show" });
		expect(p("<@100> Personality RESET")).toEqual({ kind: "personality-reset" });
		expect(p("<@100> personality set Be terse.\n  - No emoji.")).toEqual({
			kind: "personality-set",
			text: "Be terse.\n  - No emoji.",
		});
		expect(p("<@100> access")).toEqual({ kind: "access" });
		expect(p("<@100> reset <@!42>")).toEqual({ kind: "reset", userId: "42" });
		expect(p("<@100> reset 42")).toEqual({ kind: "reset", userId: "42" });
		expect(p("<@100> grant user <@42>")).toEqual({ kind: "grant", target: "user", id: "42" });
		expect(p("<@100> revoke role <@&7>")).toEqual({ kind: "revoke", target: "role", id: "7" });
		expect(p("<@100> Grant Role 7")).toEqual({ kind: "grant", target: "role", id: "7" });
		expect(p("<@100> grant community 300")).toEqual({ kind: "grant", target: "community", id: "300" });
		expect(p("<@100> revoke Community 300")).toEqual({ kind: "revoke", target: "community", id: "300" });
	});
	it("parses presence commands", () => {
		expect(p("<@100> presence")).toEqual({ kind: "presence-show" });
		expect(p("<@100> presence set  Ask me   anything ")).toEqual({ kind: "presence-set", text: "Ask me anything" });
		expect(p("<@100> presence clear")).toEqual({ kind: "presence-clear" });
		expect(p("<@100> Presence Reset")).toEqual({ kind: "presence-reset" });
		expect(p("<@100> presence set")).toMatchObject({ kind: "usage-error" });
		expect(p("<@100> presence of mind")).toBeNull();
	});
	it("explains malformed grants, revokes and empty personalities", () => {
		expect(p("<@100> grant user bob")).toMatchObject({ kind: "usage-error" });
		expect(p("<@100> revoke role <@42>")).toMatchObject({ kind: "usage-error" });
		expect(p("<@100> grant community <@&300>")).toMatchObject({ kind: "usage-error" });
		expect(p("<@100> personality set   ")).toMatchObject({ kind: "usage-error" });
	});
	it("leaves ordinary questions alone", () => {
		expect(p("<@100> reset my router?")).toBeNull();
		expect(p("<@100> access to what?")).toBeNull();
		expect(p("<@100> personality types explained")).toBeNull();
		expect(p("<@100> grant me a wish")).toBeNull();
	});
});
