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
	const EVERYONE = `[guilds."300"]\nroles = ["300"]\n[guilds."301"]\nroles = []`;

	it("lets every member in when the community ID is listed as a role", async () => {
		const { access } = setup(EVERYONE, { "300:31": { roles: [], nick: null } });
		const msg = (guildId: string) => chatMessage({ author: chatUser("30"), guildId, memberRoles: [] });
		expect(await access.check(msg("300"))).toMatchObject({ allowed: true, reason: "role" });
		expect(await access.check(msg("301"))).toMatchObject({ allowed: false, reason: "none" });
		// In DMs, members of that community; others aren't.
		const dm = (id: string) => chatMessage({ author: chatUser(id), guildId: null, isDm: true, memberRoles: null });
		expect(await access.check(dm("31"))).toMatchObject({ allowed: true, reason: "role" });
		expect(await access.check(dm("32"))).toMatchObject({ allowed: false });
	});

	it("can be granted and revoked as a role", async () => {
		const { access } = setup(`[guilds."301"]\nroles = []`);
		const msg = chatMessage({ author: chatUser("30"), guildId: "301", memberRoles: [] });
		expect(await access.check(msg)).toMatchObject({ allowed: false });
		access.grant("role", "301");
		expect(await access.check(msg)).toMatchObject({ allowed: true, reason: "role" });
		access.revoke("role", "301");
		expect(await access.check(msg)).toMatchObject({ allowed: false });
	});
});

describe("check in DMs", () => {
	const dm = (id: string) => chatMessage({ author: chatUser(id), guildId: null, isDm: true, memberRoles: null });

	it("looks up roles in every allowed guild and caches them", async () => {
		const { access, fetchMember, clock } = setup(CONFIG, {
			"301:20": { roles: ["701", "799"], nick: null },
			"300:20": { roles: ["123"], nick: null },
		});
		expect(await access.check(dm("20"))).toEqual({ allowed: true, reason: "role", roles: ["123", "701", "799"] });
		expect(fetchMember).toHaveBeenCalledTimes(2);
		await access.check(dm("20"));
		expect(fetchMember).toHaveBeenCalledTimes(2);
		clock.advance(300_001);
		await access.check(dm("20"));
		expect(fetchMember).toHaveBeenCalledTimes(4);
	});

	it("denies users without roles, and member events update the cache at once", async () => {
		const { access, fetchMember } = setup(CONFIG, { "300:21": { roles: ["700"], nick: null } });
		expect(await access.check(dm("21"))).toMatchObject({ allowed: true });
		access.onMemberUpdate("300", "21", []);
		expect(await access.check(dm("21"))).toMatchObject({ allowed: false, reason: "none" });
		access.onMemberUpdate("300", "21", ["700"]);
		expect(await access.check(dm("21"))).toMatchObject({ allowed: true });
		access.onMemberRemove("300", "21");
		expect(await access.check(dm("21"))).toMatchObject({ allowed: false });
		expect(fetchMember).toHaveBeenCalledTimes(2); // only the first check fetched
	});

	it("doesn't cache members from events unless they wrote to the bot, and sweeps expired entries", async () => {
		const { access, fetchMember, clock } = setup(CONFIG, { "300:23": { roles: ["700"], nick: "Nick" } });
		access.onMemberUpdate("300", "23", ["700"]);
		access.onMemberRemove("301", "23");
		expect(access.cacheSize).toBe(0);
		expect(await access.check(dm("23"))).toMatchObject({ allowed: true, reason: "role" });
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
		expect(await access.check(dm("22"))).toMatchObject({ allowed: false });
		await access.check(dm("22"));
		// Guild 300 failed and is fetched again; guild 301's "not a member" answer was cached.
		expect(fetchMember).toHaveBeenCalledTimes(3);
	});

	it("allows listed users and the owner in DMs", async () => {
		const { access } = setup();
		expect(await access.check(dm("10"))).toMatchObject({ allowed: true, reason: "user" });
		expect(await access.check(dm("1"))).toMatchObject({ allowed: true, reason: "owner" });
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
		});
	});

	it("never locks out the owner", async () => {
		const { make } = withStore();
		const access = make();
		access.revoke("user", "1");
		expect(await access.check(inGuild("1", []))).toMatchObject({ allowed: true, reason: "owner" });
	});
});
