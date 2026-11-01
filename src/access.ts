// SPDX-License-Identifier: AGPL-3.0-or-later
// Who may use the bot, and where. Unapproved users are ignored silently by the caller.

import type { Config } from "./config.js";
import type { ChatMessage, Clock, Logger, MemberInfo } from "./types.js";

export type Place = { kind: "guild"; guildId: string } | { kind: "dm" } | { kind: "group" };

export interface AccessResult {
	allowed: boolean;
	reason: "owner" | "user" | "role" | "blocked" | "none";
	/** Role IDs that count for cap overrides: the member's roles, or in DMs the union across allowed guilds. */
	roles: string[];
}

export interface AccessOptions {
	config: Config;
	fetchMember: (guildId: string, userId: string) => Promise<MemberInfo | null>;
	/** Parent channel of a thread, so channel allowlists cover threads. */
	parentChannel?: (channelId: string) => string | undefined;
	clock: Clock;
	log: Logger;
	ttlMs?: number;
}

/** Only role IDs are kept, and only for people who wrote to the bot: null = not a member. */
interface CachedMember {
	roles: string[] | null;
	at: number;
}

const MAX_CACHE = 10_000;

export class Access {
	private readonly members = new Map<string, CachedMember>();
	private readonly ttlMs: number;

	constructor(private readonly opts: AccessOptions) {
		this.ttlMs = opts.ttlMs ?? 300_000;
	}

	guildAllowed(guildId: string): boolean {
		return Object.hasOwn(this.opts.config.guilds, guildId);
	}

	isOwner(userId: string): boolean {
		return userId === this.opts.config.owner_id;
	}

	/**
	 * Where the message is, if the bot serves that place at all. With DMs off, the owner's 1:1 DMs are
	 * still served (owner commands, and replies to alerts).
	 */
	place(msg: ChatMessage): Place | null {
		if (msg.isDm) return this.opts.config.dms.enabled || this.isOwner(msg.author.id) ? { kind: "dm" } : null;
		if (msg.isGroupDm) return this.opts.config.dms.groups ? { kind: "group" } : null;
		if (!msg.guildId) return null; // group DMs and anything else without a guild
		const guild = this.opts.config.guilds[msg.guildId];
		if (!guild) return null;
		if (guild.channels.length > 0) {
			const parent = this.opts.parentChannel?.(msg.channelId);
			const ok = guild.channels.includes(msg.channelId) || (parent !== undefined && guild.channels.includes(parent));
			if (!ok) return null;
		}
		return { kind: "guild", guildId: msg.guildId };
	}

	/** Whether the author may trigger the bot, and the roles that count for their caps. */
	async check(msg: ChatMessage): Promise<AccessResult> {
		const { config } = this.opts;
		const userId = msg.author.id;
		if (config.access.blocked_users.includes(userId)) return { allowed: false, reason: "blocked", roles: [] };

		let roles: string[];
		let roleAllowed = false;
		if (msg.guildId && !msg.isDm) {
			const guild = config.guilds[msg.guildId];
			if (msg.memberRoles) {
				roles = msg.memberRoles;
				this.remember(msg.guildId, userId, msg.memberRoles);
			} else {
				roles = (await this.member(msg.guildId, userId)) ?? [];
			}
			roleAllowed = guild?.roles.some((r) => roles.includes(r)) ?? false;
		} else {
			const lookups = await Promise.all(
				Object.entries(config.guilds).map(async ([guildId, guild]) => ({
					guild,
					memberRoles: await this.member(guildId, userId),
				})),
			);
			const all = new Set<string>();
			for (const { guild, memberRoles } of lookups) {
				if (!memberRoles) continue;
				for (const r of memberRoles) all.add(r);
				if (guild.roles.some((r) => memberRoles.includes(r))) roleAllowed = true;
			}
			roles = [...all];
		}

		if (this.isOwner(userId)) return { allowed: true, reason: "owner", roles };
		if (config.access.users.includes(userId)) return { allowed: true, reason: "user", roles };
		if (roleAllowed) return { allowed: true, reason: "role", roles };
		return { allowed: false, reason: "none", roles };
	}

	/** Refreshes a cached member's roles. Members who never wrote to the bot aren't added. */
	onMemberUpdate(guildId: string, userId: string, roles: string[]): void {
		if (this.members.has(`${guildId}:${userId}`)) this.remember(guildId, userId, roles);
	}

	onMemberRemove(guildId: string, userId: string): void {
		if (this.members.has(`${guildId}:${userId}`)) this.remember(guildId, userId, null);
	}

	/** Drops expired entries. The map is in last-written order, so the oldest come first. */
	sweep(): void {
		const now = this.opts.clock.now();
		for (const [k, v] of this.members) {
			if (now - v.at < this.ttlMs) break;
			this.members.delete(k);
		}
	}

	/** Number of cached members. */
	get cacheSize(): number {
		return this.members.size;
	}

	private remember(guildId: string, userId: string, roles: string[] | null): void {
		const now = this.opts.clock.now();
		if (this.members.size >= MAX_CACHE) {
			for (const [k, v] of this.members) if (now - v.at > this.ttlMs) this.members.delete(k);
			// Still full: drop the oldest entries (Map keeps insertion order).
			for (const k of this.members.keys()) {
				if (this.members.size < MAX_CACHE) break;
				this.members.delete(k);
			}
		}
		const key = `${guildId}:${userId}`;
		this.members.delete(key);
		this.members.set(key, { roles, at: now });
	}

	/** A member's roles in a guild, from the cache or the API. null = not a member (or lookup failed). */
	private async member(guildId: string, userId: string): Promise<string[] | null> {
		const key = `${guildId}:${userId}`;
		const hit = this.members.get(key);
		if (hit && this.opts.clock.now() - hit.at < this.ttlMs) return hit.roles;
		try {
			const roles = (await this.opts.fetchMember(guildId, userId))?.roles ?? null;
			this.remember(guildId, userId, roles);
			return roles;
		} catch (err) {
			// Not cached, so the next message tries again.
			this.opts.log.warn("member lookup failed", { guild: guildId, user: userId, err });
			return null;
		}
	}
}
