// SPDX-License-Identifier: AGPL-3.0-or-later
// Trigger and command detection. Pure functions over normalized messages.

import type { ChatMessage } from "./types.js";

export type Trigger = "mention" | "reply" | "dm";
export type Command = "help" | "usage" | "usage all" | "status";

const COMMANDS: ReadonlySet<string> = new Set<Command>(["help", "usage", "usage all", "status"]);

function mentionPattern(userId: string): RegExp {
	return new RegExp(`<@!?${userId}>`, "g");
}

/** True when the message mentions the user directly (not via @everyone, @here or a role). */
export function mentionsUser(msg: ChatMessage, userId: string): boolean {
	if (msg.mentions.some((u) => u.id === userId)) return true;
	return mentionPattern(userId).test(msg.content);
}

/**
 * Why this message is addressed to the bot, or null if it isn't.
 * A reply counts only when the payload included the replied-to message and the bot wrote it.
 */
export function detectTrigger(msg: ChatMessage, botId: string): Trigger | null {
	if (msg.isDm) return "dm";
	if (msg.referenced && msg.referenced.author.id === botId) return "reply";
	if (mentionsUser(msg, botId)) return "mention";
	return null;
}

/** Removes mentions of the bot and tidies the whitespace left behind. */
export function stripBotMentions(content: string, botId: string): string {
	return content
		.replace(mentionPattern(botId), " ")
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.trim();
}

/** A command is a triggered message whose whole text (minus bot mentions) is a keyword. */
export function parseCommand(msg: ChatMessage, botId: string): Command | null {
	if (msg.attachments.length > 0) return null;
	const text = stripBotMentions(msg.content, botId).toLowerCase().replace(/\s+/g, " ").trim();
	return COMMANDS.has(text) ? (text as Command) : null;
}
