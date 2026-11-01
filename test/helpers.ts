// SPDX-License-Identifier: AGPL-3.0-or-later
// Small builders shared by tests.

import { parseConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import type { ChatMessage, ChatUser, Logger } from "../src/types.js";

export const TEST_ENV = { FLUXER_BOT_TOKEN: "100.secret", ANTHROPIC_API_KEY: "sk-ant-test" };

export function loadTestConfig(extra = "", owner = "1") {
	return parseConfig(`owner_id = "${owner}"\n${extra}`, TEST_ENV);
}

export const quietLog: Logger = createLogger({ level: "error", write: () => {} });

export function testClock(start = Date.parse("2026-11-01T12:00:00Z")) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
			return t;
		},
		set: (ms: number) => {
			t = ms;
		},
	};
}

export function chatUser(id: string, o: Partial<ChatUser> = {}): ChatUser {
	return { id, username: `user${id}`, globalName: null, bot: false, ...o };
}

let nextId = 1000;

export function chatMessage(o: Partial<ChatMessage> = {}): ChatMessage {
	const id = o.id ?? String(nextId++);
	return {
		id,
		channelId: "500",
		guildId: "300",
		isDm: false,
		author: chatUser("5"),
		memberNick: null,
		memberRoles: [],
		webhookId: null,
		type: 0,
		isUserMessage: true,
		content: "",
		timestamp: "2026-11-01T12:00:00.000Z",
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
