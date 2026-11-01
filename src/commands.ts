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
	/** Adds the owner's commands. */
	owner?: boolean;
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
		`**${i.botName}** is an AI assistant: a bot, not a person. It answers with Claude (\`${i.model}\`, effort ${i.effort}) from Anthropic.`,
		"",
		`- Mention me with a question, or reply to one of my messages to continue.${i.dms ? " You can also DM me." : ""}`,
		"- I only see the reply chain you're in, not the rest of the channel. That chain is sent to Anthropic to write the answer.",
		`- ${web}`,
		"- Commands: mention me with just `help` or `usage`.",
		"",
		`Limits: ${formatUsd(i.dailyCap)} per person per day, ${formatUsd(i.monthlyCap)} per month for everyone.`,
		`Source code (AGPL-3.0): <${i.sourceUrl}>`,
		...(i.owner ? ["", OWNER_HELP] : []),
	].join("\n");
}

const OWNER_HELP = [
	"Owner commands:",
	"- `personality`: show the personality and response style; `personality set <text>` replaces it, `personality reset` restores the default",
	"- `access`: who may use the bot",
	"- `grant user @user`, `grant role @role`, `revoke user @user`, `revoke role @role` (IDs work too)",
	"- `reset @user`: clear the user's usage for today (the monthly total keeps counting it)",
	"- `status`, `usage all`",
].join("\n");

/** The personality in use, quoted so its Markdown shows as written. */
export function personalityText(personality: string, isDefault: boolean): string {
	const quoted = personality
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	return `**Personality and style** (${isDefault ? "default" : "custom"}):\n${quoted}`;
}

export function accessText(l: {
	users: Array<{ id: string; source: "config" | "granted" }>;
	revokedUsers: string[];
	roles: Array<{ id: string; guildId: string | null; source: "config" | "granted" }>;
	revokedRoles: string[];
}): string {
	const mark = (source: "config" | "granted") => (source === "granted" ? " (granted)" : "");
	const lines = ["**Access** (the owner always has it)"];
	lines.push(
		l.users.length > 0 ? `Users: ${l.users.map((u) => `<@${u.id}>${mark(u.source)}`).join(", ")}` : "Users: none",
	);
	lines.push(
		l.roles.length > 0 ? `Roles: ${l.roles.map((r) => `<@&${r.id}>${mark(r.source)}`).join(", ")}` : "Roles: none",
	);
	if (l.revokedUsers.length > 0) lines.push(`Revoked users: ${l.revokedUsers.map((id) => `<@${id}>`).join(", ")}`);
	if (l.revokedRoles.length > 0) lines.push(`Revoked roles: ${l.revokedRoles.map((id) => `<@&${id}>`).join(", ")}`);
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
		`Model: \`${i.model}\`, effort ${i.effort}`,
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
	budgetStop: () => "_(I stopped here: continuing could go over the spending limit.)_",
	empty: () => "Sorry, I couldn't come up with an answer. Please try rephrasing.",
	blocked: () => "_(Part of this reply was blocked by the server's content filter.)_",
};
