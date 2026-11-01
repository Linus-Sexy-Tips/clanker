// SPDX-License-Identifier: AGPL-3.0-or-later
// Who may use the bot, and where. Unapproved users are ignored silently by the caller.

import type { Config } from "./config.js";
import type { AccessOverride } from "./store.js";
import type { ChatMessage, Clock, Logger, MemberInfo } from "./types.js";

export type Place = { kind: "guild"; guildId: string } | { kind: "dm" } | { kind: "group" };

export interface AccessResult {
	allowed: boolean;
	reason: "owner" | "user" | "role" | "blocked" | "revoked" | "none";
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
	/** Grants and revokes made with owner commands; they apply on top of the config. */
	overrides?: OverrideStore;
}

export interface OverrideStore {
	accessOverrides(): AccessOverride[];
	setAccessOverride(kind: "user" | "role", id: string, state: "grant" | "revoke"): void;
}

export type OverrideKind = "user" | "role";
type State = "grant" | "revoke";

export interface AccessListing {
	/** Allowed users: from the config, or granted with a command. */
	users: Array<{ id: string; source: "config" | "granted" }>;
	/** Users denied with `revoke user`, even if a role would allow them. */
	revokedUsers: string[];
	/** Allowed roles: per community from the config, or granted (any listed community). */
	roles: Array<{ id: string; guildId: string | null; source: "config" | "granted" }>;
	/** Roles removed with `revoke role`. */
	revokedRoles: string[];
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
	private readonly userOverrides = new Map<string, State>();
	private readonly roleOverrides = new Map<string, State>();

	constructor(private readonly opts: AccessOptions) {
		this.ttlMs = opts.ttlMs ?? 300_000;
		for (const o of opts.overrides?.accessOverrides() ?? []) {
			(o.kind === "user" ? this.userOverrides : this.roleOverrides).set(o.id, o.state);
		}
	}

	/** Allows a user or role (owner command). Saved, so it survives restarts. */
	grant(kind: OverrideKind, id: string): void {
		this.override(kind, id, "grant");
	}

	/** Denies a user (even with an allowed role), or removes a role's access (owner command). */
	revoke(kind: OverrideKind, id: string): void {
		this.override(kind, id, "revoke");
	}

	private override(kind: OverrideKind, id: string, state: State): void {
		this.opts.overrides?.setAccessOverride(kind, id, state);
		(kind === "user" ? this.userOverrides : this.roleOverrides).set(id, state);
	}

	/** Who has access, combining the config with grants and revokes. */
	listing(): AccessListing {
		const { config } = this.opts;
		const users: AccessListing["users"] = [];
		for (const id of config.access.users)
			if (this.userOverrides.get(id) !== "revoke") users.push({ id, source: "config" });
		for (const [id, state] of this.userOverrides) {
			if (state === "grant" && !config.access.users.includes(id)) users.push({ id, source: "granted" });
		}
		const roles: AccessListing["roles"] = [];
		for (const [guildId, guild] of Object.entries(config.guilds)) {
			for (const id of guild.roles)
				if (this.roleOverrides.get(id) !== "revoke") roles.push({ id, guildId, source: "config" });
		}
		for (const [id, state] of this.roleOverrides) {
			if (state === "grant" && !roles.some((r) => r.id === id)) roles.push({ id, guildId: null, source: "granted" });
		}
		const revoked = (m: Map<string, State>) => [...m].filter(([, s]) => s === "revoke").map(([id]) => id);
		return { users, revokedUsers: revoked(this.userOverrides), roles, revokedRoles: revoked(this.roleOverrides) };
	}

	/** Whether a role allows access in a community: listed there or granted, and not revoked. */
	private roleAllows(guildRoles: readonly string[], role: string): boolean {
		const state = this.roleOverrides.get(role);
		if (state === "revoke") return false;
		return state === "grant" || guildRoles.includes(role);
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
			roleAllowed = guild ? roles.some((r) => this.roleAllows(guild.roles, r)) : false;
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
				if (memberRoles.some((r) => this.roleAllows(guild.roles, r))) roleAllowed = true;
			}
			roles = [...all];
		}

		if (this.isOwner(userId)) return { allowed: true, reason: "owner", roles };
		const override = this.userOverrides.get(userId);
		if (override === "revoke") return { allowed: false, reason: "revoked", roles };
		if (override === "grant" || config.access.users.includes(userId)) return { allowed: true, reason: "user", roles };
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
