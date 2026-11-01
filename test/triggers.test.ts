// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { detectTrigger, mentionsUser, parseCommand, stripBotMentions } from "../src/triggers.js";
import type { ChatMessage, ChatUser } from "../src/types.js";

const BOT = "100";
const user = (id: string, bot = false): ChatUser => ({ id, username: `u${id}`, globalName: null, bot });

function msg(o: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: "1",
		channelId: "c",
		guildId: "g",
		isDm: false,
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
