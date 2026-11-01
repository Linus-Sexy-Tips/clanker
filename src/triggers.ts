// SPDX-License-Identifier: AGPL-3.0-or-later
// Trigger and command detection. Pure functions over normalized messages.

import type { ChatMessage } from "./types.js";

export type Trigger = "mention" | "reply" | "dm";
export type Command = "help" | "usage" | "usage all" | "status";

const COMMANDS: ReadonlySet<string> = new Set<Command>(["help", "usage", "usage all", "status"]);

function mentionPattern(userId: string): RegExp {
	return new RegExp(`<@!?${userId}>`, "g");
}

/**
 * True when the message's own text has `<@id>` or `<@!id>` (not @everyone, @here or a role).
 * The payload's mention list isn't used: it also holds users mentioned in forwarded messages and
 * embeds. A reply's ping is covered by the "reply" trigger.
 */
export function mentionsUser(msg: ChatMessage, userId: string): boolean {
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

/** Owner-only commands. Parsed only for the owner; anyone else's message goes to Claude as usual. */
export type OwnerCommand =
	| { kind: "personality-show" }
	| { kind: "personality-set"; text: string }
	| { kind: "personality-reset" }
	| { kind: "reset"; userId: string }
	| { kind: "grant" | "revoke"; target: "user" | "role"; id: string }
	| { kind: "access" }
	| { kind: "usage-error"; usage: string };

const USER_ARG = /^(?:<@!?(\d{1,20})>|(\d{1,20}))$/;
const ROLE_ARG = /^(?:<@&(\d{1,20})>|(\d{1,20}))$/;

export const OWNER_USAGE = {
	personality: "`personality`, `personality set <text>`, or `personality reset`",
	reset: "`reset @user` (or a user ID)",
	grant: "`grant user @user`, `grant role @role` (or IDs)",
	revoke: "`revoke user @user`, `revoke role @role` (or IDs)",
};

/**
 * Parses an owner command from a triggered message. Keywords are case-insensitive; the personality
 * text keeps its own line breaks and indentation. Returns null when the message isn't one.
 */
export function parseOwnerCommand(msg: ChatMessage, botId: string): OwnerCommand | null {
	if (msg.attachments.length > 0) return null;
	const raw = msg.content.replace(mentionPattern(botId), "");
	const set = /^\s*personality\s+set(?:\s+|$)([\s\S]*)$/i.exec(raw);
	if (set) {
		const text = (set[1] ?? "").trim();
		return text ? { kind: "personality-set", text } : { kind: "usage-error", usage: OWNER_USAGE.personality };
	}
	const words = stripBotMentions(msg.content, botId).split(/\s+/).filter(Boolean);
	const [first = "", second = "", third = ""] = words.map((w, i) => (i < 2 ? w.toLowerCase() : w));
	const arg = (re: RegExp, value: string) => {
		const m = re.exec(value);
		return m ? (m[1] ?? m[2] ?? null) : null;
	};
	switch (first) {
		case "personality":
			if (words.length === 1) return { kind: "personality-show" };
			if (words.length === 2 && second === "reset") return { kind: "personality-reset" };
			return null;
		case "access":
			return words.length === 1 ? { kind: "access" } : null;
		case "reset": {
			if (words.length !== 2) return null;
			const userId = arg(USER_ARG, words[1] ?? "");
			return userId ? { kind: "reset", userId } : null;
		}
		case "grant":
		case "revoke": {
			if (second !== "user" && second !== "role") return null;
			const id = words.length === 3 ? arg(second === "user" ? USER_ARG : ROLE_ARG, third) : null;
			return id ? { kind: first, target: second, id } : { kind: "usage-error", usage: OWNER_USAGE[first] };
		}
		default:
			return null;
	}
}
