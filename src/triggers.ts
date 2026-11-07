// SPDX-License-Identifier: AGPL-3.0-or-later
// Trigger and command detection. Pure functions over normalized messages.

import type { ChatMessage } from "./types.js";

export type Trigger = "mention" | "reply" | "dm";
export type Command = "help" | "usage" | "usage all" | "status";

const COMMANDS: ReadonlySet<string> = new Set<Command>(["help", "usage", "usage all", "status"]);

/** `<@id>`, `<@!id>`, and `<@&role>` for any of the given roles. */
function mentionPattern(userId: string, roleIds: readonly string[] = []): RegExp {
	const roles = roleIds.filter((r) => /^\d+$/.test(r));
	return new RegExp(roles.length > 0 ? `<@!?${userId}>|<@&(?:${roles.join("|")})>` : `<@!?${userId}>`, "g");
}

/**
 * True when the message's own text has `<@id>` or `<@!id>` (not @everyone, @here or a role).
 * The payload's mention list isn't used: it also holds users mentioned in forwarded messages and
 * embeds. A reply's ping is covered by the "reply" trigger.
 */
export function mentionsUser(msg: ChatMessage, userId: string, roleIds: readonly string[] = []): boolean {
	return mentionPattern(userId, roleIds).test(msg.content);
}

/**
 * Why this message is addressed to the bot, or null if it isn't.
 * A reply counts only when the payload included the replied-to message and the bot wrote it.
 */
export function detectTrigger(msg: ChatMessage, botId: string, botRoleIds: readonly string[] = []): Trigger | null {
	if (msg.isDm) return "dm";
	if (msg.referenced && msg.referenced.author.id === botId) return "reply";
	if (mentionsUser(msg, botId, botRoleIds)) return "mention";
	return null;
}

/** Removes mentions of the bot and tidies the whitespace left behind. */
export function stripBotMentions(content: string, botId: string, botRoleIds: readonly string[] = []): string {
	return content
		.replace(mentionPattern(botId, botRoleIds), " ")
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.trim();
}

/** A command is a triggered message whose whole text (minus bot mentions) is a keyword. */
export function parseCommand(msg: ChatMessage, botId: string, botRoleIds: readonly string[] = []): Command | null {
	if (msg.attachments.length > 0) return null;
	const text = stripBotMentions(msg.content, botId, botRoleIds).toLowerCase().replace(/\s+/g, " ").trim();
	return COMMANDS.has(text) ? (text as Command) : null;
}

/**
 * Owner and admin commands. Parsed only for them; anyone else's message goes to Claude as usual.
 * Admins may use the kinds in ADMIN_COMMANDS.
 */
export type OwnerCommand =
	| { kind: "personality-show" }
	| { kind: "personality-set"; text: string }
	| { kind: "personality-reset" }
	| { kind: "presence-show" }
	| { kind: "presence-set"; text: string }
	| { kind: "presence-clear" }
	| { kind: "presence-reset" }
	| { kind: "reset"; userId: string }
	| { kind: "grant" | "revoke"; target: "user" | "role" | "community"; id: string }
	| { kind: "access" }
	| { kind: "pro" }
	| { kind: "pro-add" | "pro-remove"; target: "user" | "role"; id: string }
	| { kind: "block" | "unblock"; id: string }
	| { kind: "admin-add" | "admin-remove"; id: string }
	| { kind: "usage-error"; usage: string };

/** What admins may do: manage access, blocks and the pro tier, and list them. */
export const ADMIN_COMMANDS: ReadonlySet<OwnerCommand["kind"]> = new Set<OwnerCommand["kind"]>([
	"grant",
	"revoke",
	"block",
	"unblock",
	"access",
	"pro",
	"pro-add",
	"pro-remove",
	"usage-error",
]);

const USER_ARG = /^(?:<@!?(\d{1,20})>|(\d{1,20}))$/;
const ROLE_ARG = /^(?:<@&(\d{1,20})>|(\d{1,20}))$/;
const ID_ARG = /^(\d{1,20})$/;

export const OWNER_USAGE = {
	personality: "`personality`, `personality set <text>`, or `personality reset`",
	presence: "`presence`, `presence set <text>`, `presence clear`, or `presence reset`",
	reset: "`reset @user` (or a user ID)",
	grant: "`grant user @user`, `grant role @role` (or IDs), or `grant community <ID>`",
	revoke: "`revoke user @user`, `revoke role @role` (or IDs), or `revoke community <ID>`",
	block: "`block user @user` or `unblock user @user` (or a user ID)",
	admin: "`admin add user @user` or `admin remove user @user` (or a user ID)",
	pro: "`pro`, `pro add user @user`, `pro add role @role`, `pro remove user @user`, or `pro remove role @role` (or IDs)",
};

/**
 * Parses an owner command from a triggered message. Keywords are case-insensitive; the personality
 * text keeps its own line breaks and indentation. Returns null when the message isn't one.
 */
export function parseOwnerCommand(
	msg: ChatMessage,
	botId: string,
	botRoleIds: readonly string[] = [],
): OwnerCommand | null {
	if (msg.attachments.length > 0) return null;
	const raw = msg.content.replace(mentionPattern(botId, botRoleIds), "");
	const set = /^\s*personality\s+set(?:\s+|$)([\s\S]*)$/i.exec(raw);
	if (set) {
		const text = (set[1] ?? "").trim();
		return text ? { kind: "personality-set", text } : { kind: "usage-error", usage: OWNER_USAGE.personality };
	}
	const presence = /^\s*presence\s+set(?:\s+|$)([\s\S]*)$/i.exec(raw);
	if (presence) {
		const text = (presence[1] ?? "").replace(/\s+/g, " ").trim();
		return text ? { kind: "presence-set", text } : { kind: "usage-error", usage: OWNER_USAGE.presence };
	}
	const words = stripBotMentions(msg.content, botId, botRoleIds).split(/\s+/).filter(Boolean);
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
		case "presence":
			if (words.length === 1) return { kind: "presence-show" };
			if (words.length === 2 && second === "clear") return { kind: "presence-clear" };
			if (words.length === 2 && second === "reset") return { kind: "presence-reset" };
			return null;
		case "access":
			return words.length === 1 ? { kind: "access" } : null;
		case "reset": {
			if (words.length !== 2) return null;
			const userId = arg(USER_ARG, words[1] ?? "");
			return userId ? { kind: "reset", userId } : null;
		}
		case "pro": {
			if (words.length === 1) return { kind: "pro" };
			// Anything else starting with "pro" is a question for Claude.
			if (second !== "add" && second !== "remove") return null;
			const target = words[2]?.toLowerCase();
			if ((target !== "user" && target !== "role") || words.length !== 4) {
				return { kind: "usage-error", usage: OWNER_USAGE.pro };
			}
			const id = arg(target === "user" ? USER_ARG : ROLE_ARG, words[3] ?? "");
			return id
				? { kind: second === "add" ? "pro-add" : "pro-remove", target, id }
				: { kind: "usage-error", usage: OWNER_USAGE.pro };
		}
		case "block":
		case "unblock": {
			if (second !== "user") return null;
			const id = words.length === 3 ? arg(USER_ARG, third) : null;
			return id ? { kind: first, id } : { kind: "usage-error", usage: OWNER_USAGE.block };
		}
		case "admin": {
			// Anything else starting with "admin" is a question for Claude.
			if (second !== "add" && second !== "remove") return null;
			const id = words.length === 4 && words[2]?.toLowerCase() === "user" ? arg(USER_ARG, words[3] ?? "") : null;
			return id
				? { kind: second === "add" ? "admin-add" : "admin-remove", id }
				: { kind: "usage-error", usage: OWNER_USAGE.admin };
		}
		case "grant":
		case "revoke": {
			if (second !== "user" && second !== "role" && second !== "community") return null;
			const pattern = second === "user" ? USER_ARG : second === "role" ? ROLE_ARG : ID_ARG;
			const id = words.length === 3 ? arg(pattern, third) : null;
			return id ? { kind: first, target: second, id } : { kind: "usage-error", usage: OWNER_USAGE[first] };
		}
		default:
			return null;
	}
}
