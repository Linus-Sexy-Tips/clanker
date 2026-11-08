// SPDX-License-Identifier: AGPL-3.0-or-later
// Replies that come from code, never from Claude: commands and notices.

import { formatUsd } from "./money.js";
import { formatDate, formatDuration } from "./time.js";
import type { ConnectionState, Micros } from "./types.js";

export interface HelpInfo {
	botName: string;
	model: string;
	effort: string;
	dailyCap: Micros;
	monthlyCap: Micros;
	sourceUrl: string;
	webSearch: boolean;
	webFetch: boolean;
	dms: boolean;
	/** The asker is on the pro tier (model and dailyCap are already the pro ones). */
	pro?: boolean;
	/** Adds the owner's commands. */
	owner?: boolean;
	/** Adds the admin commands. */
	admin?: boolean;
}

export function helpText(i: HelpInfo): string {
	const web =
		i.webSearch && i.webFetch
			? "I can search the web and read links."
			: i.webSearch
				? "I can search the web."
				: i.webFetch
					? "I can read links."
					: "I can't use the web.";
	return [
		`**${i.botName}** is an AI assistant: a bot, not a person. It answers ${i.pro ? "you (pro) " : ""}with Claude (\`${i.model}\`, effort ${i.effort}) from Anthropic.`,
		"",
		`- Mention me with a question, or reply to one of my messages to continue.${i.dms ? " You can also DM me." : ""}`,
		"- I only see the reply chain you're in, not the rest of the channel. That chain is sent to Anthropic to write the answer.",
		`- ${web}`,
		"- Commands: mention me with just `help` or `usage`.",
		"",
		`Limits: ${formatUsd(i.dailyCap)} ${i.pro ? "for you" : "per person"} per day, ${formatUsd(i.monthlyCap)} per month for everyone.`,
		`Source code (AGPL-3.0): <${i.sourceUrl}>`,
		...(i.owner ? ["", OWNER_HELP] : i.admin ? ["", ADMIN_HELP] : []),
	].join("\n");
}

const MANAGE_HELP = [
	"- `access`: who may use the bot, and who gets the pro tier",
	"- `grant user @user`, `grant role @role`, `revoke user @user`, `revoke role @role` (IDs work too)",
	"- `grant community <ID>`, `revoke community <ID>`: every member of a listed community (not in DMs)",
	"- `block user @user`, `unblock user @user`: a blocked user can't use the bot, whatever their grants and roles",
	"- `pro`: who gets the pro tier; `pro add user @user`, `pro add role @role`, `pro remove user @user`, `pro remove role @role` (IDs work too)",
	"- `status`, `usage all`",
];

const OWNER_HELP = [
	"Owner commands:",
	"- `personality`: show the personality and response style; `personality set <text>` replaces it, `personality reset` restores the default",
	"- `presence`: show the bot's status message; `presence set <text>` changes it, `presence clear` removes it, `presence reset` restores the config's",
	...MANAGE_HELP,
	"- `admin add user @user`, `admin remove user @user`: admins can use the commands above except personality, presence and reset, and can't change your or other admins' access",
	"- `reset @user`: clear the user's usage for today (the monthly total keeps counting it)",
].join("\n");

const ADMIN_HELP = ["Admin commands (you can't change the owner's or other admins' access):", ...MANAGE_HELP].join(
	"\n",
);

/** The personality in use, quoted so its Markdown shows as written. */
export function personalityText(personality: string, isDefault: boolean): string {
	const quoted = personality
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	return `**Personality and style** (${isDefault ? "default" : "custom"}):\n${quoted}`;
}

/** "Users: <@1>, <@2>", or "Users: none". */
function listLine(label: string, items: string[]): string {
	return `${label}: ${items.length > 0 ? items.join(", ") : "none"}`;
}

const user = (id: string) => `<@${id}>`;
const role = (id: string) => `<@&${id}>`;

export function accessText(
	l: {
		users: string[];
		revokedUsers: string[];
		blockedUsers: string[];
		admins: string[];
		roles: string[];
		revokedRoles: string[];
		communities: string[];
		revokedCommunities: string[];
	},
	communityName: (id: string) => string,
	/** Who gets the pro tier, or null when it's off. */
	pro: { users: string[]; roles: string[] } | null = null,
): string {
	const lines = ["**Access** (the owner and admins always have it)", listLine("Admins", l.admins.map(user))];
	if (l.communities.length > 0) lines.push(`Everyone in: ${l.communities.map(communityName).join(", ")} (not in DMs)`);
	lines.push(listLine("Users", l.users.map(user)), listLine("Roles", l.roles.map(role)));
	if (pro) {
		lines.push(listLine("Pro users", pro.users.map(user)));
		if (pro.roles.length > 0) lines.push(listLine("Pro roles", pro.roles.map(role)));
	} else lines.push("Pro tier: off");
	lines.push(listLine("Blocked users", l.blockedUsers.map(user)));
	if (l.revokedUsers.length > 0) lines.push(listLine("Revoked users", l.revokedUsers.map(user)));
	if (l.revokedRoles.length > 0) lines.push(listLine("Revoked roles", l.revokedRoles.map(role)));
	if (l.revokedCommunities.length > 0)
		lines.push(listLine("Revoked communities", l.revokedCommunities.map(communityName)));
	return lines.join("\n");
}

export function proText(
	l: { users: string[]; roles: string[]; removedUsers: string[]; removedRoles: string[] },
	tier: { model: string; effort: string; dailyCap: Micros } | null,
): string {
	if (!tier) return "The pro tier is off. Turn it on with `enabled = true` under `[pro]` in the config.";
	const lines = [
		`**Pro tier**: \`${tier.model}\`, effort ${tier.effort}, ${formatUsd(tier.dailyCap)} per person per day`,
		listLine("Users", l.users.map(user)),
		listLine("Roles", l.roles.map(role)),
	];
	if (l.removedUsers.length > 0) lines.push(listLine("Removed users", l.removedUsers.map(user)));
	if (l.removedRoles.length > 0) lines.push(listLine("Removed roles", l.removedRoles.map(role)));
	return lines.join("\n");
}

export function usageText(i: {
	today: Micros;
	dailyCap: Micros;
	month: Micros;
	monthlyCap: Micros;
	now: number;
	dayResetAt: number;
	monthResetAt: number;
	timezone: string;
}): string {
	return [
		`Your usage today: ${formatUsd(i.today)} of ${formatUsd(i.dailyCap)} (resets in ${formatDuration(i.dayResetAt - i.now)}).`,
		`Everyone this month: ${formatUsd(i.month)} of ${formatUsd(i.monthlyCap)} (resets on ${formatDate(i.monthResetAt, i.timezone)}).`,
	].join("\n");
}

const MAX_ROWS = 50;

export function usageAllText(i: {
	rows: Array<{ userId: string; today: Micros; month: Micros }>;
	month: Micros;
	monthlyCap: Micros;
}): string {
	const lines = [`**Usage this month:** ${formatUsd(i.month)} of ${formatUsd(i.monthlyCap)}`];
	if (i.rows.length === 0) lines.push("No requests yet this month.");
	for (const r of i.rows.slice(0, MAX_ROWS)) {
		lines.push(`- <@${r.userId}>: ${formatUsd(r.month)} this month, ${formatUsd(r.today)} today`);
	}
	if (i.rows.length > MAX_ROWS) lines.push(`…and ${i.rows.length - MAX_ROWS} more.`);
	return lines.join("\n");
}

export function statusText(i: {
	version: string;
	uptimeMs: number;
	connection: ConnectionState;
	model: string;
	effort: string;
	/** The pro tier's model, or null when it's off. */
	pro?: { model: string; effort: string } | null;
	guilds: Array<{ id: string; name: string | null }>;
	today: {
		requests: number;
		cost: Micros;
		inputTokens: number;
		cacheWriteTokens: number;
		cacheReadTokens: number;
		webSearches: number;
		webFetches: number;
	};
	month: Micros;
	monthlyCap: Micros;
	replayEntries: number;
	active: number;
	queued: number;
}): string {
	const t = i.today;
	const prompt = t.inputTokens + t.cacheWriteTokens + t.cacheReadTokens;
	const hit = prompt > 0 ? `${Math.round((t.cacheReadTokens / prompt) * 100)}%` : "n/a";
	const guilds = i.guilds.length > 0 ? i.guilds.map((g) => (g.name ? `${g.name} (${g.id})` : g.id)).join(", ") : "none";
	return [
		`**Clanker ${i.version}**: up ${formatDuration(i.uptimeMs)}, gateway ${i.connection}`,
		`Model: \`${i.model}\`, effort ${i.effort}${i.pro ? `; pro: \`${i.pro.model}\`, effort ${i.pro.effort}` : ""}`,
		`Communities: ${guilds}`,
		`Today: ${plural(t.requests, "API call")}, ${formatUsd(t.cost)}, ${plural(t.webSearches, "search", "searches")}, ${plural(t.webFetches, "fetch", "fetches")}`,
		`Cache today: ${hit} of prompt tokens read from cache (${t.cacheReadTokens} read, ${t.cacheWriteTokens} written, ${t.inputTokens} uncached)`,
		`This month: ${formatUsd(i.month)} of ${formatUsd(i.monthlyCap)}`,
		`Requests: ${i.active} running, ${i.queued} waiting. Replay cache: ${i.replayEntries} turns.`,
	].join("\n");
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

export const OPERATOR_ONLY = "That command is only for the bot's operator.";

export const notices = {
	tooLong: (maxMessages: number, maxTokens: number) =>
		`This reply chain is too long for me (my limit is ${maxMessages} messages or about ${maxTokens.toLocaleString("en-US")} tokens). Please start a new one by mentioning me in a fresh message.`,
	busy: () => "I'm busy with other requests right now. Please try again in a minute.",
	unavailable: () => "Sorry, I can't reach Claude right now. Please try again in a few minutes.",
	failed: () => "Sorry, something went wrong while I was answering. Please try again in a few minutes.",
	refusal: () => "Sorry, I can't help with that request.",
	cutOff: () => "_(Answer cut off: it reached the length limit.)_",
	pauseLimit: () => "_(I stopped here: this needed more web lookups than I can do in one answer.)_",
	unfinished: () => "_(Answer stopped early for an unexpected reason. Ask again to get the rest.)_",
	empty: () => "Sorry, I couldn't come up with an answer. Please try rephrasing.",
	blocked: () => "_(Part of this reply was blocked by the server's content filter.)_",
};
