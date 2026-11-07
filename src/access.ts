// SPDX-License-Identifier: AGPL-3.0-or-later
// Who may use the bot, and where. Unapproved users are ignored silently by the caller.

import type { Config } from "./config.js";
import type { AccessOverride, ProOverride } from "./store.js";
import type { ChatMessage, Clock, Logger, MemberInfo } from "./types.js";

export type Place = { kind: "guild"; guildId: string } | { kind: "dm" } | { kind: "group" };

export interface AccessResult {
	allowed: boolean;
	reason: "owner" | "admin" | "user" | "role" | "blocked" | "none";
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
	/** Grants, revokes, blocks, pro and admins set with commands; they apply on top of the config. */
	overrides?: OverrideStore;
}

export interface OverrideStore {
	accessOverrides(): AccessOverride[];
	setAccessOverride(kind: "user" | "role", id: string, state: "grant" | "revoke"): void;
	proOverrides?(): ProOverride[];
	setProOverride?(kind: "user" | "role", id: string, state: "add" | "remove"): void;
	blockedUsers?(): string[];
	setBlocked?(userId: string, blocked: boolean): void;
	admins?(): string[];
	setAdmin?(userId: string, admin: boolean): void;
}

export interface ProListing {
	users: Array<{ id: string; source: "config" | "added" }>;
	roles: Array<{ id: string; source: "config" | "added" }>;
	/** Listed in the config but taken off with `pro remove`. */
	removedUsers: string[];
	removedRoles: string[];
}

/**
 * Communities are stored as role overrides of the community's @everyone role, which has the
 * community's ID.
 */
export type OverrideKind = "user" | "role" | "community";
type State = "grant" | "revoke";

export interface AccessListing {
	/** Allowed users: from the config, or granted with a command. */
	users: Array<{ id: string; source: "config" | "granted" }>;
	/** Users in the config's `access.users` taken off with `revoke user` (roles may still allow them). */
	revokedUsers: string[];
	/** Never allowed, whatever their grants and roles: from the config, or blocked with a command. */
	blockedUsers: Array<{ id: string; source: "config" | "blocked" }>;
	/** Added with `admin add user`. */
	admins: string[];
	/** Allowed roles: per community from the config, or granted (any listed community). */
	roles: Array<{ id: string; guildId: string | null; source: "config" | "granted" }>;
	/** Roles removed with `revoke role`. */
	revokedRoles: string[];
	/** Listed communities whose every member is allowed: `everyone` in the config, or granted. */
	communities: Array<{ id: string; source: "config" | "granted" }>;
	/** Communities removed with `revoke community`. */
	revokedCommunities: string[];
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
	private readonly proUsers = new Map<string, "add" | "remove">();
	private readonly proRoles = new Map<string, "add" | "remove">();
	private readonly blocked: Set<string>;
	private readonly adminIds: Set<string>;

	constructor(private readonly opts: AccessOptions) {
		this.ttlMs = opts.ttlMs ?? 300_000;
		for (const o of opts.overrides?.accessOverrides() ?? []) {
			(o.kind === "user" ? this.userOverrides : this.roleOverrides).set(o.id, o.state);
		}
		for (const o of opts.overrides?.proOverrides?.() ?? []) {
			(o.kind === "user" ? this.proUsers : this.proRoles).set(o.id, o.state);
		}
		this.blocked = new Set(opts.overrides?.blockedUsers?.() ?? []);
		this.adminIds = new Set(opts.overrides?.admins?.() ?? []);
	}

	/** Blocked in the config or with `block user`. The owner can't be blocked. */
	isBlocked(userId: string): boolean {
		return this.opts.config.access.blocked_users.includes(userId) || this.blocked.has(userId);
	}

	/** Blocked in the config, which `unblock user` can't change. */
	blockedInConfig(userId: string): boolean {
		return this.opts.config.access.blocked_users.includes(userId);
	}

	/** Blocks or unblocks a user (command). Saved, so it survives restarts. */
	setBlocked(userId: string, blocked: boolean): void {
		this.opts.overrides?.setBlocked?.(userId, blocked);
		if (blocked) this.blocked.add(userId);
		else this.blocked.delete(userId);
	}

	/** Admins manage access and the pro tier, but not the owner's or other admins'. */
	isAdmin(userId: string): boolean {
		return this.adminIds.has(userId);
	}

	/** Adds or removes an admin (owner command). Saved, so it survives restarts. */
	setAdmin(userId: string, admin: boolean): void {
		this.opts.overrides?.setAdmin?.(userId, admin);
		if (admin) this.adminIds.add(userId);
		else this.adminIds.delete(userId);
	}

	/**
	 * Whether the user gets the pro tier: listed in [pro] or added with `pro add`, by ID or by one of
	 * the roles that count for their caps. A user taken off by ID stays off whatever their roles.
	 * Always false while [pro] is off.
	 */
	isPro(userId: string, roles: readonly string[]): boolean {
		const pro = this.opts.config.pro;
		if (!pro.enabled) return false;
		const byUser = this.proUsers.get(userId);
		if (byUser) return byUser === "add";
		if (pro.users.includes(userId)) return true;
		return roles.some((r) => {
			const state = this.proRoles.get(r);
			return state ? state === "add" : pro.roles.includes(r);
		});
	}

	/** Adds a user or role to the pro tier, or takes one off (owner command). Saved, so it survives restarts. */
	setPro(kind: "user" | "role", id: string, state: "add" | "remove"): void {
		this.opts.overrides?.setProOverride?.(kind, id, state);
		(kind === "user" ? this.proUsers : this.proRoles).set(id, state);
	}

	/** Who gets the pro tier, combining the config with `pro add` and `pro remove`. */
	proListing(): ProListing {
		const pro = this.opts.config.pro;
		const list = (configured: string[], overrides: Map<string, "add" | "remove">) => {
			const on: Array<{ id: string; source: "config" | "added" }> = [];
			for (const id of configured) if (overrides.get(id) !== "remove") on.push({ id, source: "config" });
			for (const [id, state] of overrides) {
				if (state === "add" && !configured.includes(id)) on.push({ id, source: "added" });
			}
			const removed = configured.filter((id) => overrides.get(id) === "remove");
			return { on, removed };
		};
		const users = list(pro.users, this.proUsers);
		const roles = list(pro.roles, this.proRoles);
		return { users: users.on, roles: roles.on, removedUsers: users.removed, removedRoles: roles.removed };
	}

	/** Allows a user or role (command). Saved, so it survives restarts. */
	grant(kind: OverrideKind, id: string): void {
		this.override(kind, id, "grant");
	}

	/** Removes a user's access by ID (roles may still allow them), or a role's access (command). */
	revoke(kind: OverrideKind, id: string): void {
		this.override(kind, id, "revoke");
	}

	private override(kind: OverrideKind, id: string, state: State): void {
		const stored = kind === "community" ? "role" : kind;
		this.opts.overrides?.setAccessOverride(stored, id, state);
		(stored === "user" ? this.userOverrides : this.roleOverrides).set(id, state);
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
		const isCommunity = (id: string) => this.guildAllowed(id);
		const communities: AccessListing["communities"] = [];
		const roles: AccessListing["roles"] = [];
		for (const [guildId, guild] of Object.entries(config.guilds)) {
			const configured = guild.everyone || guild.roles.includes(guildId);
			if (configured && this.roleOverrides.get(guildId) !== "revoke")
				communities.push({ id: guildId, source: "config" });
			for (const id of guild.roles)
				if (id !== guildId && this.roleOverrides.get(id) !== "revoke") roles.push({ id, guildId, source: "config" });
		}
		for (const [id, state] of this.roleOverrides) {
			if (state !== "grant") continue;
			if (isCommunity(id)) {
				if (!communities.some((c) => c.id === id)) communities.push({ id, source: "granted" });
			} else if (!roles.some((r) => r.id === id)) roles.push({ id, guildId: null, source: "granted" });
		}
		const revoked = (m: Map<string, State>) => [...m].filter(([, s]) => s === "revoke").map(([id]) => id);
		const revokedRoles = revoked(this.roleOverrides);
		const blockedUsers: AccessListing["blockedUsers"] = config.access.blocked_users.map((id) => ({
			id,
			source: "config",
		}));
		for (const id of this.blocked) if (!this.blockedInConfig(id)) blockedUsers.push({ id, source: "blocked" });
		return {
			users,
			revokedUsers: revoked(this.userOverrides).filter((id) => config.access.users.includes(id)),
			blockedUsers,
			admins: [...this.adminIds],
			roles,
			revokedRoles: revokedRoles.filter((id) => !isCommunity(id)),
			communities,
			revokedCommunities: revokedRoles.filter(isCommunity),
		};
	}

	/** Whether a role allows access in a community: listed there or granted, and not revoked. */
	private roleAllows(guildRoles: readonly string[], role: string): boolean {
		const state = this.roleOverrides.get(role);
		if (state === "revoke") return false;
		return state === "grant" || guildRoles.includes(role);
	}

	/**
	 * Whether a member's roles allow access in a community. Members also have the @everyone role,
	 * which has the community's ID and is never in their role list: `everyone` in the config, or
	 * granting the community, lets every member in.
	 */
	private anyRoleAllows(guild: Config["guilds"][string], guildId: string, memberRoles: readonly string[]): boolean {
		const allowed = guild.everyone ? [...guild.roles, guildId] : guild.roles;
		return this.roleAllows(allowed, guildId) || memberRoles.some((r) => this.roleAllows(allowed, r));
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

	/**
	 * Whether the author may trigger the bot, and the roles that count for their caps. A block beats
	 * every grant, role and community; the owner and admins are always allowed.
	 */
	async check(msg: ChatMessage): Promise<AccessResult> {
		const { config } = this.opts;
		const userId = msg.author.id;
		const owner = this.isOwner(userId);
		if (!owner && this.isBlocked(userId)) return { allowed: false, reason: "blocked", roles: [] };
		const override = this.userOverrides.get(userId);
		const byUser = owner ? "owner" : this.isAdmin(userId) ? "admin" : null;
		const listed = override ? override === "grant" : config.access.users.includes(userId);

		if (!msg.guildId || msg.isDm) {
			// DMs and group DMs: only the owner, admins and users allowed by ID. Roles only set their caps.
			if (byUser === null && !listed) return { allowed: false, reason: "none", roles: [] };
			return { allowed: true, reason: byUser ?? "user", roles: await this.rolesEverywhere(userId) };
		}

		let roles: string[];
		if (msg.memberRoles) {
			roles = msg.memberRoles;
			this.remember(msg.guildId, userId, msg.memberRoles);
		} else {
			roles = (await this.member(msg.guildId, userId)) ?? [];
		}
		if (byUser) return { allowed: true, reason: byUser, roles };
		if (listed) return { allowed: true, reason: "user", roles };
		const guild = config.guilds[msg.guildId];
		if (guild && this.anyRoleAllows(guild, msg.guildId, roles)) return { allowed: true, reason: "role", roles };
		return { allowed: false, reason: "none", roles };
	}

	/** A user's roles across the listed communities (for caps in DMs). */
	private async rolesEverywhere(userId: string): Promise<string[]> {
		const lookups = await Promise.all(Object.keys(this.opts.config.guilds).map((g) => this.member(g, userId)));
		const all = new Set<string>();
		for (const memberRoles of lookups) for (const r of memberRoles ?? []) all.add(r);
		return [...all];
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
