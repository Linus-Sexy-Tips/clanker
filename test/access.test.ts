// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { Access } from "../src/access.js";
import { Store } from "../src/store.js";
import type { MemberInfo } from "../src/types.js";
import { chatMessage, chatUser, loadTestConfig, quietLog, testClock } from "./helpers.js";

const CONFIG = `
[access]
users = ["10"]
blocked_users = ["66"]
[guilds."300"]
roles = ["700"]
[guilds."301"]
roles = ["701"]
channels = ["600"]
[[limits.overrides]]
role = "799"
user_daily_usd = 9
`;

function setup(extra = CONFIG, members: Record<string, MemberInfo | null> = {}) {
	const { config } = loadTestConfig(extra);
	const clock = testClock();
	const fetchMember = vi.fn(async (g: string, u: string) => members[`${g}:${u}`] ?? null);
	const access = new Access({
		config,
		fetchMember,
		parentChannel: (c) => (c === "650" ? "600" : undefined),
		clock,
		log: quietLog,
	});
	return { access, fetchMember, clock };
}

describe("place", () => {
	it("serves listed guilds, restricted channels and their threads, and DMs", () => {
		const { access } = setup();
		expect(access.place(chatMessage({ guildId: "300", channelId: "1" }))).toEqual({ kind: "guild", guildId: "300" });
		expect(access.place(chatMessage({ guildId: "999" }))).toBeNull();
		expect(access.place(chatMessage({ guildId: "301", channelId: "600" }))).toEqual({ kind: "guild", guildId: "301" });
		expect(access.place(chatMessage({ guildId: "301", channelId: "650" }))).toEqual({ kind: "guild", guildId: "301" });
		expect(access.place(chatMessage({ guildId: "301", channelId: "601" }))).toBeNull();
		expect(access.place(chatMessage({ guildId: null, isDm: true }))).toEqual({ kind: "dm" });
		expect(access.place(chatMessage({ guildId: null, isDm: false, isGroupDm: true }))).toEqual({ kind: "group" });
		expect(access.place(chatMessage({ guildId: null, isDm: false }))).toBeNull(); // neither guild nor DM
	});
	it("refuses group DMs when they're off", () => {
		const { access } = setup(`${CONFIG}\n[dms]\ngroups = false`);
		expect(access.place(chatMessage({ guildId: null, isGroupDm: true }))).toBeNull();
	});
	it("refuses DMs when they're off", () => {
		const { access } = setup(`${CONFIG}\n[dms]\nenabled = false`);
		expect(access.place(chatMessage({ guildId: null, isDm: true }))).toBeNull();
	});
});

describe("check in guilds", () => {
	it("allows by user ID, role or owner, and blocks blocked users", async () => {
		const { access, fetchMember } = setup();
		const in300 = (id: string, roles: string[]) => chatMessage({ author: chatUser(id), memberRoles: roles });
		expect(await access.check(in300("10", []))).toMatchObject({ allowed: true, reason: "user" });
		expect(await access.check(in300("11", ["700", "799"]))).toEqual({
			allowed: true,
			reason: "role",
			roles: ["700", "799"],
		});
		expect(await access.check(in300("12", ["701"]))).toMatchObject({ allowed: false, reason: "none" }); // other guild's role
		expect(await access.check(in300("1", []))).toMatchObject({ allowed: true, reason: "owner" });
		expect(await access.check(in300("66", ["700"]))).toMatchObject({ allowed: false, reason: "blocked" });
		expect(fetchMember).not.toHaveBeenCalled();
	});
});

describe("everyone in a community", () => {
	const EVERYONE = `[guilds."300"]\neveryone = true\n[guilds."301"]\nroles = []`;

	it("lets every member in with everyone = true", async () => {
		const { access } = setup(EVERYONE, { "300:31": { roles: [], nick: null } });
		const msg = (guildId: string) => chatMessage({ author: chatUser("30"), guildId, memberRoles: [] });
		expect(await access.check(msg("300"))).toMatchObject({ allowed: true, reason: "role" });
		expect(await access.check(msg("301"))).toMatchObject({ allowed: false, reason: "none" });
		// Not in DMs: those need a user grant.
		const dm = chatMessage({ author: chatUser("31"), guildId: null, isDm: true, memberRoles: null });
		expect(await access.check(dm)).toMatchObject({ allowed: false });
	});

	it("also counts the community ID listed as a role", async () => {
		const { access } = setup(`[guilds."300"]\nroles = ["300"]`);
		const msg = chatMessage({ author: chatUser("30"), guildId: "300", memberRoles: [] });
		expect(await access.check(msg)).toMatchObject({ allowed: true, reason: "role" });
		expect(access.listing()).toMatchObject({ roles: [], communities: [{ id: "300", source: "config" }] });
	});

	it("can be granted and revoked, and lists communities apart from roles", async () => {
		const { access } = setup(`${EVERYONE}\n[guilds."302"]\nroles = ["702"]`);
		const msg = chatMessage({ author: chatUser("30"), guildId: "301", memberRoles: [] });
		expect(await access.check(msg)).toMatchObject({ allowed: false });
		access.grant("community", "301");
		expect(await access.check(msg)).toMatchObject({ allowed: true, reason: "role" });
		access.revoke("community", "300");
		expect(await access.check(chatMessage({ author: chatUser("30"), guildId: "300", memberRoles: [] }))).toMatchObject({
			allowed: false,
		});
		expect(access.listing()).toMatchObject({
			roles: [{ id: "702", guildId: "302", source: "config" }],
			communities: [{ id: "301", source: "granted" }],
			revokedRoles: [],
			revokedCommunities: ["300"],
		});
		access.revoke("community", "301");
		expect(await access.check(msg)).toMatchObject({ allowed: false });
	});
});

describe("check in DMs", () => {
	const dm = (id: string) => chatMessage({ author: chatUser(id), guildId: null, isDm: true, memberRoles: null });
	const group = (id: string) =>
		chatMessage({ author: chatUser(id), guildId: null, isGroupDm: true, channelId: "800", memberRoles: null });

	it("allows only the owner and users allowed by ID; roles don't count", async () => {
		const { access, fetchMember } = setup(CONFIG, { "300:20": { roles: ["700"], nick: null } });
		expect(await access.check(dm("10"))).toMatchObject({ allowed: true, reason: "user" });
		expect(await access.check(dm("1"))).toMatchObject({ allowed: true, reason: "owner" });
		expect(await access.check(dm("20"))).toEqual({ allowed: false, reason: "none", roles: [] });
		expect(await access.check(group("20"))).toMatchObject({ allowed: false, reason: "none" });
		expect(await access.check(group("10"))).toMatchObject({ allowed: true, reason: "user" });
		expect(await access.check(dm("66"))).toMatchObject({ allowed: false, reason: "blocked" });
		// Nobody is looked up for a refusal.
		expect(fetchMember.mock.calls.every(([, u]) => u !== "20")).toBe(true);
	});

	it("allows granted users and refuses revoked ones", async () => {
		const { access } = setup();
		access.grant("user", "30");
		expect(await access.check(dm("30"))).toMatchObject({ allowed: true, reason: "user" });
		access.revoke("user", "10");
		expect(await access.check(dm("10"))).toMatchObject({ allowed: false, reason: "revoked" });
	});

	it("looks up the roles of allowed users in every listed community for their caps, and caches them", async () => {
		const { access, fetchMember, clock } = setup(CONFIG, {
			"301:10": { roles: ["701", "799"], nick: null },
			"300:10": { roles: ["123"], nick: null },
		});
		expect(await access.check(dm("10"))).toEqual({ allowed: true, reason: "user", roles: ["123", "701", "799"] });
		expect(fetchMember).toHaveBeenCalledTimes(2);
		await access.check(dm("10"));
		expect(fetchMember).toHaveBeenCalledTimes(2);
		clock.advance(300_001);
		await access.check(dm("10"));
		expect(fetchMember).toHaveBeenCalledTimes(4);
	});

	it("member events update the cache at once", async () => {
		const { access, fetchMember } = setup(CONFIG, { "300:10": { roles: ["799"], nick: null } });
		expect((await access.check(dm("10"))).roles).toEqual(["799"]);
		access.onMemberUpdate("300", "10", []);
		expect((await access.check(dm("10"))).roles).toEqual([]);
		access.onMemberUpdate("300", "10", ["799"]);
		access.onMemberRemove("301", "10");
		expect((await access.check(dm("10"))).roles).toEqual(["799"]);
		expect(fetchMember).toHaveBeenCalledTimes(2); // only the first check fetched
	});

	it("doesn't cache members from events unless they wrote to the bot, and sweeps expired entries", async () => {
		const { access, fetchMember, clock } = setup(CONFIG, { "300:10": { roles: ["700"], nick: "Nick" } });
		access.onMemberUpdate("300", "10", ["700"]);
		access.onMemberRemove("301", "10");
		expect(access.cacheSize).toBe(0);
		expect(await access.check(dm("10"))).toMatchObject({ allowed: true, roles: ["700"] });
		expect(fetchMember).toHaveBeenCalledTimes(2); // nothing was cached from the events
		expect(access.cacheSize).toBe(2);
		clock.advance(299_000);
		access.sweep();
		expect(access.cacheSize).toBe(2);
		clock.advance(1_001);
		access.sweep();
		expect(access.cacheSize).toBe(0);
	});

	it("does not cache failed lookups", async () => {
		const { access, fetchMember } = setup();
		fetchMember.mockRejectedValueOnce(new Error("network"));
		expect(await access.check(dm("10"))).toMatchObject({ allowed: true, roles: [] });
		await access.check(dm("10"));
		// Guild 300 failed and is fetched again; guild 301's "not a member" answer was cached.
		expect(fetchMember).toHaveBeenCalledTimes(3);
	});
});

describe("grants and revokes", () => {
	function withStore() {
		const { config } = loadTestConfig(CONFIG);
		const store = Store.memory();
		const make = () =>
			new Access({ config, fetchMember: async () => null, clock: testClock(), log: quietLog, overrides: store });
		return { store, make };
	}
	const inGuild = (id: string, roles: string[]) => chatMessage({ author: chatUser(id), memberRoles: roles });

	it("grants and revokes users, overriding the config and roles, and saves them", async () => {
		const { make } = withStore();
		const access = make();
		expect(await access.check(inGuild("30", []))).toMatchObject({ allowed: false });
		access.grant("user", "30");
		expect(await access.check(inGuild("30", []))).toMatchObject({ allowed: true, reason: "user" });
		access.revoke("user", "10"); // listed in the config
		expect(await access.check(inGuild("10", []))).toMatchObject({ allowed: false, reason: "revoked" });
		access.revoke("user", "31");
		expect(await access.check(inGuild("31", ["700"]))).toMatchObject({ allowed: false, reason: "revoked" });
		// A new instance (a restart) loads the saved state.
		const again = make();
		expect(await again.check(inGuild("30", []))).toMatchObject({ allowed: true });
		expect(await again.check(inGuild("10", []))).toMatchObject({ allowed: false });
	});

	it("grants roles in any listed community and revokes configured ones", async () => {
		const { make } = withStore();
		const access = make();
		access.grant("role", "777");
		expect(await access.check(inGuild("40", ["777"]))).toMatchObject({ allowed: true, reason: "role" });
		access.revoke("role", "700");
		expect(await access.check(inGuild("41", ["700"]))).toMatchObject({ allowed: false });
		expect(access.listing()).toEqual({
			users: [{ id: "10", source: "config" }],
			revokedUsers: [],
			roles: [
				{ id: "701", guildId: "301", source: "config" },
				{ id: "777", guildId: null, source: "granted" },
			],
			revokedRoles: ["700"],
			communities: [],
			revokedCommunities: [],
		});
	});

	it("never locks out the owner", async () => {
		const { make } = withStore();
		const access = make();
		access.revoke("user", "1");
		expect(await access.check(inGuild("1", []))).toMatchObject({ allowed: true, reason: "owner" });
	});
});

describe("pro tier", () => {
	const PRO = `${CONFIG}\n[pro]\nenabled = true\nusers = ["10"]\nroles = ["777"]\n[limits]\nmonthly_usd = 150`;

	function withStore(extra = PRO) {
		const { config } = loadTestConfig(extra);
		const store = Store.memory();
		const make = () =>
			new Access({ config, fetchMember: async () => null, clock: testClock(), log: quietLog, overrides: store });
		return { access: make(), make, store };
	}

	it("puts listed users and members with a listed role on the pro tier", () => {
		const { access } = withStore();
		expect(access.isPro("10", [])).toBe(true);
		expect(access.isPro("20", ["700", "777"])).toBe(true);
		expect(access.isPro("20", ["700"])).toBe(false);
	});

	it("is never on while [pro] is off", () => {
		const { access } = withStore(`${CONFIG}\n[pro]\nusers = ["10"]`);
		expect(access.isPro("10", [])).toBe(false);
	});

	it("adds and removes by command, on top of the config, and keeps it across restarts", () => {
		const { access, make } = withStore();
		access.setPro("user", "30", "add");
		access.setPro("user", "10", "remove");
		access.setPro("role", "777", "remove");
		access.setPro("role", "778", "add");
		const again = make();
		expect(again.isPro("30", [])).toBe(true);
		expect(again.isPro("10", [])).toBe(false);
		expect(again.isPro("20", ["777"])).toBe(false);
		expect(again.isPro("20", ["778"])).toBe(true);
		// Removed by ID wins over a pro role.
		again.setPro("user", "21", "remove");
		expect(again.isPro("21", ["778"])).toBe(false);
		expect(again.proListing()).toEqual({
			users: [{ id: "30", source: "added" }],
			roles: [{ id: "778", source: "added" }],
			removedUsers: ["10"],
			removedRoles: ["777"],
		});
	});
});
