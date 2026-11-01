// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { FluxerAPIError, HTTPError, RateLimitError } from "@fluxerjs/rest";
import type { GatewaySendPayload } from "@fluxerjs/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import {
	createFluxerClient,
	createGateway,
	type GatewayFactoryOptions,
	type GatewayLike,
	IGNORED_EVENTS,
	MAX_CACHED_CHANNELS,
	normalizeApiUrl,
	normalizeGatewayUrl,
	normalizeMessage,
	normalizeToken,
	presencePayload,
	type RestLike,
	type RestRequest,
} from "../src/fluxer.js";
import { createLogger } from "../src/log.js";
import { type ChatMessage, type ConnectionState, type FluxerClient, FluxerRequestError } from "../src/types.js";

// ---------------------------------------------------------------- fixtures and fakes

const GUILD = "1501314428688990001";
const OTHER_GUILD = "1501314428688990002";
const CHANNEL = "1501314428688998182";
const OTHER_CHANNEL = "1501314428688998183";
const CATEGORY = "1501314428688998100";
const THREAD = "1501314428688998500";
const DM_CHANNEL = "1501314428688998300";
const BOT = "1501314428688990555";
const ADA = "1501314428688990000";
const BOB = "1501314428688990777";
const MSG = "1501320000000000001";
const SENT_ID = "1501320000000009999";

const FIXTURES = new URL("./fixtures/fluxer/", import.meta.url);

function fixture(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as Record<string, unknown>;
}

type LogLine = { level: string; msg: string } & Record<string, unknown>;

function captureLog() {
	const lines: LogLine[] = [];
	const log = createLogger({ level: "debug", write: (line) => lines.push(JSON.parse(line) as LogLine) });
	const has = (level: string, text: string) => lines.some((l) => l.level === level && l.msg.includes(text));
	return { log, lines, has };
}

interface RestCall {
	method: string;
	route: string;
	body: unknown;
	signal: AbortSignal | undefined;
}
type RestHandler = (call: RestCall) => unknown;

const APP = { id: BOT, name: "Clanker", bot_public: false, owner: { id: ADA, username: "ada" } };

function defaultRest(call: RestCall): unknown {
	if (call.route === "/applications/@me") return APP;
	if (call.method === "POST" && call.route.endsWith("/messages")) return { id: SENT_ID, content: "x" };
	if (call.method === "POST" && call.route === "/users/@me/channels") return { id: DM_CHANNEL, type: 1 };
	return undefined;
}

class FakeRest implements RestLike {
	readonly calls: RestCall[] = [];
	handler: RestHandler = defaultRest;

	get(route: string, o?: { signal?: AbortSignal }): Promise<unknown> {
		return this.run("GET", route, undefined, o?.signal);
	}
	post(route: string, o?: RestRequest): Promise<unknown> {
		return this.run("POST", route, o?.body, o?.signal);
	}
	patch(route: string, o?: RestRequest): Promise<unknown> {
		return this.run("PATCH", route, o?.body, o?.signal);
	}
	put(route: string, o?: RestRequest): Promise<unknown> {
		return this.run("PUT", route, o?.body, o?.signal);
	}
	delete(route: string, o?: RestRequest): Promise<unknown> {
		return this.run("DELETE", route, o?.body, o?.signal);
	}

	/** Calls other than the token check. */
	get api(): RestCall[] {
		return this.calls.filter((c) => c.route !== "/applications/@me");
	}

	private async run(method: string, route: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
		const call = { method, route, body, signal };
		this.calls.push(call);
		return this.handler(call);
	}
}

/** A request that never answers, and rejects like @fluxerjs/rest when its signal aborts. */
function hang(call: RestCall): Promise<never> {
	return new Promise((_resolve, reject) => {
		const abort = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
		if (call.signal?.aborted) abort();
		else call.signal?.addEventListener("abort", abort);
	});
}

class FakeShard extends EventEmitter {}

class FakeGateway extends EventEmitter implements GatewayLike {
	readonly sent: GatewaySendPayload[] = [];
	readonly shard = new FakeShard();
	connectCalls = 0;
	destroyCalls = 0;
	connectError: Error | null = null;
	factoryOpts: GatewayFactoryOptions | null = null;

	async connect(): Promise<void> {
		this.connectCalls++;
		if (this.connectError) throw this.connectError;
	}
	send(_shardId: number, payload: GatewaySendPayload): void {
		this.sent.push(payload);
	}
	destroy(): void {
		this.destroyCalls++;
	}
	getShard(shardId: number): FakeShard | undefined {
		return shardId === 0 ? this.shard : undefined;
	}
	dispatch(t: string, d: unknown): void {
		this.emit("dispatch", { shardId: 0, payload: { op: 0, t, s: 1, d } });
	}
	close(code: number): void {
		this.emit("close", { shardId: 0, code });
	}
}

const clients: FluxerClient[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(clients.splice(0).map((c) => c.destroy()));
});

function setup(o: { handler?: RestHandler; fetch?: typeof fetch; presence?: boolean } = {}) {
	const rest = new FakeRest();
	if (o.handler) rest.handler = o.handler;
	const gw = new FakeGateway();
	const logs = captureLog();
	const client = createFluxerClient({
		token: `Bot ${BOT}.secret`,
		apiUrl: "https://api.fluxer.app/v1",
		log: logs.log,
		rest,
		gatewayFactory: (f) => {
			gw.factoryOpts = f;
			return gw;
		},
		...(o.presence === false ? {} : { presence: { status: "online", customStatus: "@mention me to ask" } }),
		...(o.fetch ? { fetch: o.fetch } : {}),
	});
	clients.push(client);
	const events = {
		fatal: [] as string[],
		connection: [] as ConnectionState[],
		messages: [] as ChatMessage[],
		heartbeats: 0,
	};
	client.on("fatal", (r) => events.fatal.push(r));
	client.on("connection", (s) => events.connection.push(s));
	client.on("messageCreate", (m) => events.messages.push(m));
	client.on("heartbeat", () => {
		events.heartbeats++;
	});
	return { client, rest, gw, events, ...logs };
}

type Env = ReturnType<typeof setup>;

/** Lets pending promise callbacks run (fake REST and gateway only use microtasks). */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function until(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 500; i++) {
		if (cond()) return;
		await Promise.resolve();
	}
	throw new Error("condition never became true");
}

async function connectReady(env: Env): Promise<void> {
	const connected = env.client.connect();
	await until(() => env.gw.connectCalls === 1);
	env.gw.dispatch("READY", fixture("ready"));
	await connected;
}

async function readyWithGuild(env: Env): Promise<void> {
	await connectReady(env);
	env.gw.dispatch("GUILD_CREATE", fixture("guild-create"));
}

function bodyOf(call: RestCall | undefined): Record<string, unknown> {
	return (call?.body ?? {}) as Record<string, unknown>;
}

async function rejection(p: Promise<unknown>): Promise<FluxerRequestError> {
	try {
		await p;
	} catch (err) {
		expect(err).toBeInstanceOf(FluxerRequestError);
		return err as FluxerRequestError;
	}
	throw new Error("expected a rejection");
}

const apiError = (status: number, code: string) => new FluxerAPIError({ code, message: code.toLowerCase() }, status);
const rateLimited = (seconds: number) =>
	new RateLimitError({ code: "RATE_LIMITED", message: "slow down", retry_after: seconds, global: false }, 429);

// ---------------------------------------------------------------- normalizeMessage

describe("normalizeMessage", () => {
	it("maps a guild message with member, mentions and attachments", () => {
		expect(normalizeMessage(fixture("message-guild"))).toStrictEqual({
			id: MSG,
			channelId: CHANNEL,
			guildId: GUILD,
			isDm: false,
			author: { id: ADA, username: "ada", globalName: "Ada L.", bot: false },
			memberNick: "Countess",
			memberRoles: ["1501314428688990100", "1501314428688990101"],
			webhookId: null,
			type: 0,
			isUserMessage: true,
			content: `<@${BOT}> what changed in v2? cc <@${BOB}>`,
			timestamp: "2026-11-01T14:05:00.000Z",
			editedTimestamp: null,
			mentions: [
				{ id: BOT, username: "clanker", globalName: null, bot: true, nick: null },
				{ id: BOB, username: "bob", globalName: "Bob", bot: false, nick: null },
			],
			mentionRoleIds: ["1501314428688990100"],
			mentionEveryone: false,
			reference: null,
			referenced: undefined,
			attachments: [
				{
					id: "1501320000000000900",
					filename: "chart.png",
					url: "https://fluxerusercontent.com/attachments/1501314428688998182/1501320000000000900/chart.png?ex=6725a1b0&is=67245030&hm=0b1e",
					contentType: "image/png",
					size: 48213,
					width: 800,
					height: 600,
				},
				// Expired: no URL, no content type, no dimensions.
				{
					id: "1501320000000000901",
					filename: "notes.txt",
					url: "",
					contentType: null,
					size: 120,
					width: null,
					height: null,
				},
			],
		});
	});

	it("normalizes the replied-to message one hop deep", () => {
		const msg = normalizeMessage(fixture("message-reply"));
		expect(msg?.type).toBe(19);
		expect(msg?.isUserMessage).toBe(true);
		expect(msg?.reference).toEqual({ messageId: "1501320000000000005", channelId: CHANNEL, guildId: GUILD });
		const ref = msg?.referenced;
		expect(ref).toMatchObject({
			id: "1501320000000000005",
			channelId: CHANNEL,
			guildId: GUILD, // not in the nested payload: inherited from the reply
			isDm: false,
			author: { id: BOT, bot: true },
			memberRoles: null,
			content: "v2 adds tables.",
			editedTimestamp: "2026-11-01T14:06:03.000Z",
			reference: { messageId: MSG, channelId: CHANNEL, guildId: GUILD },
		});
		// Its own referenced_message is ignored.
		expect(ref?.referenced).toBeUndefined();
	});

	it("tells a deleted reply target (null) from a non-reply (undefined)", () => {
		const deleted = fixture("message-reply");
		deleted.referenced_message = null;
		expect(normalizeMessage(deleted)?.referenced).toBeNull();

		const absent = fixture("message-reply");
		delete absent.referenced_message;
		const msg = normalizeMessage(absent);
		expect(msg?.referenced).toBeUndefined();
		expect(msg?.reference?.messageId).toBe("1501320000000000005");
	});

	it("treats a malformed referenced_message as not included", () => {
		const raw = fixture("message-reply");
		raw.referenced_message = { id: "1501320000000000005", content: "no author" };
		const msg = normalizeMessage(raw);
		expect(msg?.id).toBe("1501320000000000010");
		expect(msg?.referenced).toBeUndefined();
	});

	it("marks channel_type 1 as a DM without guild or member data", () => {
		const msg = normalizeMessage(fixture("message-dm"));
		expect(msg).toMatchObject({ isDm: true, guildId: null, memberRoles: null, memberNick: null, content: "usage" });
	});

	it("does not treat a group DM (type 3) as a DM", () => {
		const msg = normalizeMessage(fixture("message-group-dm"));
		expect(msg).toMatchObject({ isDm: false, guildId: null });
		expect(msg?.mentions.map((m) => m.id)).toEqual([BOT]);
	});

	it("uses the options for REST payloads without channel_type or guild_id", () => {
		const raw = fixture("message-dm");
		delete raw.channel_type;
		expect(normalizeMessage(raw)?.isDm).toBe(false);
		expect(normalizeMessage(raw, { isDm: true })).toMatchObject({ isDm: true, guildId: null });
		expect(normalizeMessage(raw, { isDm: true, guildId: GUILD })?.guildId).toBeNull();
		expect(normalizeMessage(raw, { guildId: GUILD })).toMatchObject({ isDm: false, guildId: GUILD });

		// channel_type in the payload wins over the option.
		const guildMsg = fixture("message-guild");
		expect(normalizeMessage(guildMsg, { isDm: true })?.isDm).toBe(false);
	});

	it("flags system messages and non-chat types as not user messages", () => {
		expect(normalizeMessage(fixture("message-system"))?.isUserMessage).toBe(false);

		const systemAuthor = fixture("message-system");
		systemAuthor.type = 0;
		expect(normalizeMessage(systemAuthor)?.isUserMessage).toBe(false);

		for (const [type, expected] of [
			[0, true],
			[19, true],
			[6, false],
			[7, false],
			[21, false],
		] as const) {
			const raw = fixture("message-guild");
			raw.type = type;
			expect(normalizeMessage(raw)?.isUserMessage, `type ${type}`).toBe(expected);
		}
	});

	it("keeps the webhook ID and the bot flag of webhook authors", () => {
		const msg = normalizeMessage(fixture("message-webhook"));
		expect(msg).toMatchObject({ webhookId: "1501314428688995000", author: { bot: true, username: "CI" } });
	});

	it("merges mentions and users, dedupes by ID and takes nicks from member", () => {
		const raw = fixture("message-guild");
		raw.mentions = [
			{ id: BOT, username: "clanker", global_name: null, bot: true, member: { nick: "Clank", roles: [] } },
		];
		raw.users = [
			{ id: BOT, username: "duplicate", global_name: null },
			{ id: BOB, username: "bob", global_name: "Bob" },
		];
		expect(normalizeMessage(raw)?.mentions).toEqual([
			{ id: BOT, username: "clanker", globalName: null, bot: true, nick: "Clank" },
			{ id: BOB, username: "bob", globalName: "Bob", bot: false, nick: null },
		]);
	});

	it("drops malformed list entries instead of the whole message", () => {
		const raw = fixture("message-guild");
		raw.mentions = [{ id: "not-an-id", username: "x" }, { username: "no id" }, raw.users];
		raw.users = "not an array";
		raw.mention_roles = ["1501314428688990100", 42, "abc"];
		raw.attachments = [{ id: "1501320000000000900" }, { id: "1501320000000000902", filename: "a.png", size: 5 }];
		raw.member = { roles: "admin" };
		const msg = normalizeMessage(raw);
		expect(msg?.mentions).toEqual([]);
		expect(msg?.mentionRoleIds).toEqual(["1501314428688990100"]);
		expect(msg?.attachments.map((a) => a.filename)).toEqual(["a.png"]);
		expect(msg?.memberRoles).toBeNull();
		expect(msg?.memberNick).toBeNull();
	});

	it("ignores forwards and references without a message ID", () => {
		const forward = fixture("message-reply");
		delete forward.referenced_message;
		forward.message_reference = { channel_id: OTHER_CHANNEL, message_id: "1501320000000000777", type: 1 };
		expect(normalizeMessage(forward)?.reference).toBeNull();

		const noId = fixture("message-reply");
		noId.message_reference = { channel_id: CHANNEL, type: 0 };
		expect(normalizeMessage(noId)?.reference).toBeNull();

		const noType = fixture("message-reply");
		noType.message_reference = { message_id: "1501320000000000005" };
		expect(normalizeMessage(noType)?.reference).toEqual({
			messageId: "1501320000000000005",
			channelId: CHANNEL,
			guildId: null,
		});
	});

	it("defaults optional scalars", () => {
		const raw = fixture("message-guild");
		raw.content = null;
		delete raw.edited_timestamp;
		delete raw.mention_everyone;
		delete raw.mention_roles;
		delete raw.attachments;
		delete raw.author;
		raw.author = { id: ADA, username: "ada" };
		const msg = normalizeMessage(raw);
		expect(msg).toMatchObject({
			content: "",
			editedTimestamp: null,
			mentionEveryone: false,
			mentionRoleIds: [],
			attachments: [],
			author: { id: ADA, username: "ada", globalName: null, bot: false },
		});
		raw.mention_everyone = true;
		expect(normalizeMessage(raw)?.mentionEveryone).toBe(true);
	});

	it.each([
		["id", (r: Record<string, unknown>) => delete r.id],
		["channel_id", (r: Record<string, unknown>) => delete r.channel_id],
		["author", (r: Record<string, unknown>) => delete r.author],
		["author.username", (r: Record<string, unknown>) => delete (r.author as Record<string, unknown>).username],
		["author.id", (r: Record<string, unknown>) => ((r.author as Record<string, unknown>).id = 5)],
		["type", (r: Record<string, unknown>) => delete r.type],
		["timestamp", (r: Record<string, unknown>) => delete r.timestamp],
		["non-numeric id", (r: Record<string, unknown>) => (r.id = "abc")],
		["guild_id of the wrong type", (r: Record<string, unknown>) => (r.guild_id = 12)],
		["webhook_id of the wrong type", (r: Record<string, unknown>) => (r.webhook_id = true)],
	])("returns null without %s", (_name, mutate) => {
		const raw = fixture("message-guild");
		mutate(raw);
		expect(normalizeMessage(raw)).toBeNull();
	});

	it.each([null, undefined, "message", 42, [], [fixture("message-guild")]])("returns null for %j", (raw) => {
		expect(normalizeMessage(raw)).toBeNull();
	});
});

// ---------------------------------------------------------------- small helpers

describe("normalizeToken / normalizeApiUrl / presencePayload", () => {
	it("strips the Bot prefix and whitespace", () => {
		expect(normalizeToken("Bot 123.abc")).toBe("123.abc");
		expect(normalizeToken("  bot   123.abc \n")).toBe("123.abc");
		expect(normalizeToken("BOT\t123.abc")).toBe("123.abc");
		expect(normalizeToken("123.abc")).toBe("123.abc");
		expect(normalizeToken("Botany.abc")).toBe("Botany.abc");
	});

	it("strips a trailing /v1 and slashes from the API URL", () => {
		expect(normalizeApiUrl("https://api.fluxer.app/v1")).toBe("https://api.fluxer.app");
		expect(normalizeApiUrl("https://api.fluxer.app/v1/")).toBe("https://api.fluxer.app");
		expect(normalizeApiUrl("https://api.fluxer.app/")).toBe("https://api.fluxer.app");
		expect(normalizeApiUrl("https://api.fluxer.app")).toBe("https://api.fluxer.app");
		expect(normalizeApiUrl(" http://fluxer.local:8080/api/V1 ")).toBe("http://fluxer.local:8080/api");
		expect(normalizeApiUrl("https://chat.example/api/v10")).toBe("https://chat.example/api/v10");
	});

	it("rejects API URLs that REST can't use", () => {
		expect(() => normalizeApiUrl("api.fluxer.app")).toThrow(/valid URL/);
		expect(() => normalizeApiUrl("ftp://api.fluxer.app")).toThrow(/http/);
		expect(() => normalizeApiUrl("https://api.fluxer.app/v1?x=1")).toThrow(/query/);
	});

	it("accepts ws(s) gateway URLs without a query", () => {
		expect(normalizeGatewayUrl("wss://gateway.fluxer.app")).toBe("wss://gateway.fluxer.app/");
		expect(normalizeGatewayUrl(" ws://127.0.0.1:8080/gw ")).toBe("ws://127.0.0.1:8080/gw");
		expect(() => normalizeGatewayUrl("https://gateway.fluxer.app")).toThrow(/ws\(s\)/);
		expect(() => normalizeGatewayUrl("gateway.fluxer.app")).toThrow(/valid URL/);
		// The library appends "?v=1&encoding=json" without checking for an existing query.
		expect(() => normalizeGatewayUrl("wss://gateway.fluxer.app/?v=1")).toThrow(/query/);
		expect(() => normalizeGatewayUrl("wss://gateway.fluxer.app/?")).toThrow(/query/);
		expect(() => normalizeGatewayUrl("wss://gateway.fluxer.app/#x")).toThrow(/query/);
	});

	it("builds opcode 3 payloads with a 1-128 char custom status", () => {
		expect(presencePayload("idle", " hi ")).toEqual({ status: "idle", afk: false, custom_status: { text: "hi" } });
		expect(presencePayload("online", "")).toEqual({ status: "online", afk: false, custom_status: null });
		expect(presencePayload("dnd", "   ")).toEqual({ status: "dnd", afk: false, custom_status: null });
		expect(presencePayload("invisible", null).custom_status).toBeNull();
		expect(presencePayload("online", "x".repeat(200)).custom_status?.text).toHaveLength(128);
		// Never cut an emoji in half.
		const text = presencePayload("online", `${"x".repeat(127)}🤖`).custom_status?.text;
		expect(text).toBe("x".repeat(127));
		expect(() => presencePayload("away" as "online", null)).toThrow(RangeError);
	});
});

// ---------------------------------------------------------------- REST

describe("sendMessage", () => {
	it("posts content, a nonce and mentions that ping nobody", async () => {
		const env = setup();
		expect(await env.client.sendMessage(CHANNEL, { content: "hello" })).toEqual({ id: SENT_ID });
		const [call] = env.rest.calls;
		expect(call?.method).toBe("POST");
		expect(call?.route).toBe(`/channels/${CHANNEL}/messages`);
		expect(call?.body).toStrictEqual({
			content: "hello",
			nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
			allowed_mentions: { parse: [], replied_user: false },
		});
		expect(JSON.stringify(bodyOf(call).allowed_mentions)).toBe('{"parse":[],"replied_user":false}');
	});

	it("adds the reply reference, the reply ping and SUPPRESS_EMBEDS when asked", async () => {
		const env = setup();
		await readyWithGuild(env);
		await env.client.sendMessage(CHANNEL, { content: "answer", replyTo: MSG, pingReplied: true, suppressEmbeds: true });
		expect(env.rest.api[0]?.body).toStrictEqual({
			content: "answer",
			nonce: expect.any(String),
			allowed_mentions: { parse: [], replied_user: true },
			message_reference: { message_id: MSG, channel_id: CHANNEL, guild_id: GUILD },
			flags: 4,
		});
	});

	it("leaves guild_id out of the reference when the channel isn't a known guild channel", async () => {
		const env = setup();
		await env.client.sendMessage(DM_CHANNEL, { content: "hi", replyTo: MSG });
		expect(bodyOf(env.rest.calls[0]).message_reference).toStrictEqual({ message_id: MSG, channel_id: DM_CHANNEL });
	});

	it("uses a new nonce for every message", async () => {
		const env = setup();
		await env.client.sendMessage(CHANNEL, { content: "a" });
		await env.client.sendMessage(CHANNEL, { content: "b" });
		const [a, b] = env.rest.calls.map((c) => bodyOf(c).nonce);
		expect(a).not.toBe(b);
	});

	it("posts again without the reference when the reply target is gone", async () => {
		const env = setup({
			handler: (call) => {
				if (bodyOf(call).message_reference) throw apiError(404, "UNKNOWN_MESSAGE");
				return { id: SENT_ID };
			},
		});
		const sent = await env.client.sendMessage(CHANNEL, {
			content: "answer",
			replyTo: MSG,
			pingReplied: true,
			suppressEmbeds: true,
		});
		expect(sent).toEqual({ id: SENT_ID });
		expect(env.rest.calls).toHaveLength(2);
		const [first, second] = env.rest.calls.map(bodyOf);
		expect(second).toStrictEqual({
			content: "answer",
			nonce: expect.any(String),
			allowed_mentions: { parse: [], replied_user: true },
			flags: 4,
		});
		expect(second?.nonce).not.toBe(first?.nonce);
		expect(env.has("info", "reply target is gone")).toBe(true);
	});

	it("does not retry other 404s or a 404 on a message that wasn't a reply", async () => {
		const unknownChannel = setup({
			handler: () => {
				throw apiError(404, "UNKNOWN_CHANNEL");
			},
		});
		const err = await rejection(unknownChannel.client.sendMessage(CHANNEL, { content: "x", replyTo: MSG }));
		expect(err).toMatchObject({ status: 404, code: "UNKNOWN_CHANNEL" });
		expect(unknownChannel.rest.calls).toHaveLength(1);

		const noReply = setup({
			handler: () => {
				throw apiError(404, "UNKNOWN_MESSAGE");
			},
		});
		await rejection(noReply.client.sendMessage(CHANNEL, { content: "x" }));
		expect(noReply.rest.calls).toHaveLength(1);
	});

	it("surfaces CONTENT_BLOCKED without retrying", async () => {
		const env = setup({
			handler: () => {
				throw apiError(403, "CONTENT_BLOCKED");
			},
		});
		const err = await rejection(env.client.sendMessage(CHANNEL, { content: "bad link" }));
		expect(err).toMatchObject({ status: 403, code: "CONTENT_BLOCKED" });
		expect(env.rest.calls).toHaveLength(1);
	});

	it("rejects a response without a message ID", async () => {
		const env = setup({ handler: () => ({ ok: true }) });
		await rejection(env.client.sendMessage(CHANNEL, { content: "x" }));
	});

	it("rejects invalid IDs without calling Fluxer", async () => {
		const env = setup();
		await rejection(env.client.sendMessage("general", { content: "x" }));
		await rejection(env.client.sendMessage(CHANNEL, { content: "x", replyTo: "../../users/@me" }));
		await rejection(env.client.fetchMessage(CHANNEL, "1/../2"));
		await rejection(env.client.openDm(""));
		expect(env.rest.calls).toHaveLength(0);
	});
});

describe("editMessage", () => {
	it("always sends allowed_mentions, and flags only when suppressing embeds", async () => {
		const env = setup();
		await env.client.editMessage(CHANNEL, MSG, { content: "v1" });
		await env.client.editMessage(CHANNEL, MSG, { content: "v2", pingReplied: true, suppressEmbeds: true });
		const [plain, full] = env.rest.calls;
		expect(plain?.method).toBe("PATCH");
		expect(plain?.route).toBe(`/channels/${CHANNEL}/messages/${MSG}`);
		expect(plain?.body).toStrictEqual({ content: "v1", allowed_mentions: { parse: [], replied_user: false } });
		expect(full?.body).toStrictEqual({ content: "v2", allowed_mentions: { parse: [], replied_user: true }, flags: 4 });
	});
});

describe("rate limits and errors", () => {
	it("waits retry_after and retries a rate-limited mutation", async () => {
		let attempts = 0;
		const env = setup({
			handler: () => {
				attempts++;
				if (attempts < 3) throw rateLimited(0.005);
				return { id: SENT_ID };
			},
		});
		const started = Date.now();
		await env.client.sendMessage(CHANNEL, { content: "x" });
		expect(attempts).toBe(3);
		expect(Date.now() - started).toBeGreaterThanOrEqual(8);
		expect(env.lines.filter((l) => l.msg.includes("rate limit"))).toHaveLength(2);
		// The same nonce on every retry, so Fluxer can dedupe.
		expect(new Set(env.rest.calls.map((c) => bodyOf(c).nonce)).size).toBe(1);
	});

	it("gives up after three retries", async () => {
		const env = setup({
			handler: () => {
				throw rateLimited(0.001);
			},
		});
		const err = await rejection(env.client.editMessage(CHANNEL, MSG, { content: "x" }));
		expect(err).toMatchObject({ status: 429, code: "RATE_LIMITED" });
		expect(env.rest.calls).toHaveLength(4);
	});

	it("doesn't wait out a very long retry_after", async () => {
		const env = setup({
			handler: () => {
				throw rateLimited(600);
			},
		});
		const err = await rejection(env.client.deleteMessage(CHANNEL, MSG));
		expect(err.status).toBe(429);
		expect(env.rest.calls).toHaveLength(1);
	});

	it.each([
		["a 5xx", () => new HTTPError(502, "<html>bad gateway</html>")],
		["a Fluxer 5xx", () => apiError(503, "SERVICE_UNAVAILABLE")],
		["a timeout", () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" })],
		["a network error", () => new Error("fetch failed")],
	])("retries a send after %s with the same nonce", async (_name, failure) => {
		vi.useFakeTimers();
		let attempts = 0;
		const env = setup({
			handler: () => {
				attempts++;
				if (attempts < 3) throw failure();
				return { id: SENT_ID };
			},
		});
		const sending = env.client.sendMessage(CHANNEL, { content: "x", replyTo: MSG });
		await until(() => attempts === 1);
		await vi.advanceTimersByTimeAsync(999);
		expect(attempts).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toBe(2);
		await vi.advanceTimersByTimeAsync(2_000); // the second wait is longer
		expect(await sending).toEqual({ id: SENT_ID });
		expect(new Set(env.rest.calls.map((c) => bodyOf(c).nonce)).size).toBe(1);
		expect(env.rest.calls.every((c) => bodyOf(c).message_reference)).toBe(true);
		expect(env.lines.filter((l) => l.msg.includes("request failed; retrying"))).toHaveLength(2);
	});

	it("gives up on a send after two failure retries", async () => {
		vi.useFakeTimers();
		const env = setup({
			handler: () => {
				throw new HTTPError(500, null);
			},
		});
		const sending = rejection(env.client.sendMessage(CHANNEL, { content: "x" }));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await sending).toMatchObject({ status: 500 });
		expect(env.rest.calls).toHaveLength(3);
	});

	it("counts rate limits and failures separately", async () => {
		vi.useFakeTimers();
		const script: Array<() => never> = [
			() => {
				throw new HTTPError(502, null);
			},
			() => {
				throw rateLimited(0.5);
			},
			() => {
				throw new HTTPError(502, null);
			},
			() => {
				throw rateLimited(0.5);
			},
		];
		const env = setup({ handler: () => (script.shift() ?? (() => ({ id: SENT_ID })))() });
		const sending = env.client.sendMessage(CHANNEL, { content: "x" });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await sending).toEqual({ id: SENT_ID });
		expect(env.rest.calls).toHaveLength(5);
	});

	it("doesn't retry 4xx sends, or edits and other mutations after a 5xx", async () => {
		const bad = setup({
			handler: () => {
				throw apiError(400, "INVALID_FORM_BODY");
			},
		});
		expect((await rejection(bad.client.sendMessage(CHANNEL, { content: "x" }))).code).toBe("INVALID_FORM_BODY");
		expect(bad.rest.calls).toHaveLength(1);

		const down = setup({
			handler: () => {
				throw new HTTPError(502, null);
			},
		});
		expect((await rejection(down.client.editMessage(CHANNEL, MSG, { content: "x" }))).status).toBe(502);
		expect((await rejection(down.client.deleteMessage(CHANNEL, MSG))).status).toBe(502);
		expect((await rejection(down.client.addReaction(CHANNEL, MSG, "⏳"))).status).toBe(502);
		expect(down.rest.calls).toHaveLength(3);
	});

	it("doesn't retry typing", async () => {
		const env = setup({
			handler: () => {
				throw rateLimited(0.001);
			},
		});
		expect((await rejection(env.client.triggerTyping(CHANNEL))).status).toBe(429);
		expect(env.rest.calls).toHaveLength(1);
	});

	it.each([
		["FluxerAPIError", apiError(403, "MISSING_PERMISSIONS"), 403, "MISSING_PERMISSIONS"],
		["HTTPError", new HTTPError(502, "<html>bad gateway</html>"), 502, null],
		["plain Error", new Error("socket hang up"), null, null],
		["AbortError", Object.assign(new Error("aborted"), { name: "AbortError" }), null, null],
		["non-Error", "weird", null, null],
		["Node error with a code", Object.assign(new Error("reset"), { code: "ECONNRESET" }), null, null],
	])("maps %s to FluxerRequestError", async (_name, thrown, status, code) => {
		const env = setup({
			handler: () => {
				throw thrown;
			},
		});
		const err = await rejection(env.client.deleteMessage(CHANNEL, MSG));
		expect(err.status).toBe(status);
		expect(err.code).toBe(code);
		expect(err.message).toContain("deleteMessage");
	});
});

describe("per-channel ordering", () => {
	it("runs sends and edits for one channel one at a time, other channels in parallel", async () => {
		const gates: Array<() => void> = [];
		const env = setup({
			handler: () => new Promise((resolve) => gates.push(() => resolve({ id: SENT_ID }))),
		});
		const contents = () => env.rest.calls.map((c) => bodyOf(c).content);
		const a = env.client.sendMessage(CHANNEL, { content: "a" });
		const b = env.client.editMessage(CHANNEL, SENT_ID, { content: "b" });
		const c = env.client.sendMessage(OTHER_CHANNEL, { content: "c" });
		await flush();
		expect(contents()).toEqual(["a", "c"]);
		gates[0]?.();
		await a;
		await flush();
		expect(contents()).toEqual(["a", "c", "b"]);
		for (const open of gates) open();
		await Promise.all([b, c]);
	});

	it("keeps going after a failed send", async () => {
		let first = true;
		const env = setup({
			handler: () => {
				if (first) {
					first = false;
					throw apiError(400, "INVALID_FORM_BODY");
				}
				return { id: SENT_ID };
			},
		});
		const failed = env.client.sendMessage(CHANNEL, { content: "a" });
		const next = env.client.sendMessage(CHANNEL, { content: "b" });
		await rejection(failed);
		expect(await next).toEqual({ id: SENT_ID });
	});
});

describe("other REST calls", () => {
	it("deletes, reacts, types and leaves on the right routes", async () => {
		const env = setup();
		await env.client.deleteMessage(CHANNEL, MSG);
		await env.client.addReaction(CHANNEL, MSG, "⏳");
		await env.client.addReaction(CHANNEL, MSG, "🐢");
		await env.client.triggerTyping(CHANNEL);
		await env.client.leaveGuild(GUILD);
		expect(env.rest.calls.map((c) => `${c.method} ${c.route}`)).toEqual([
			`DELETE /channels/${CHANNEL}/messages/${MSG}`,
			`PUT /channels/${CHANNEL}/messages/${MSG}/reactions/%E2%8F%B3/@me`,
			`PUT /channels/${CHANNEL}/messages/${MSG}/reactions/%F0%9F%90%A2/@me`,
			`POST /channels/${CHANNEL}/typing`,
			`DELETE /users/@me/guilds/${GUILD}`,
		]);
		expect(env.rest.calls.every((c) => c.body === undefined)).toBe(true);
		await rejection(env.client.addReaction(CHANNEL, MSG, ""));
	});

	it("propagates reaction errors to the caller", async () => {
		const env = setup({
			handler: () => {
				throw apiError(400, "INVALID_FORM_BODY");
			},
		});
		expect((await rejection(env.client.addReaction(CHANNEL, MSG, "⏳"))).code).toBe("INVALID_FORM_BODY");
	});

	it("fetches and normalizes a message, null when gone or hidden", async () => {
		const restMessage = fixture("message-guild");
		for (const key of ["channel_type", "guild_id", "member"]) delete restMessage[key];
		let mode: "ok" | 404 | 403 | 500 | "junk" = "ok";
		const env = setup({
			handler: (call) => {
				if (call.route === "/applications/@me") return APP;
				if (mode === "ok") return restMessage;
				if (mode === "junk") return { id: MSG };
				if (mode === 500) throw new HTTPError(500, "oops");
				throw apiError(mode, mode === 404 ? "UNKNOWN_MESSAGE" : "MISSING_ACCESS");
			},
		});
		await readyWithGuild(env);

		const msg = await env.client.fetchMessage(CHANNEL, MSG);
		expect(env.rest.api[0]).toMatchObject({ method: "GET", route: `/channels/${CHANNEL}/messages/${MSG}` });
		// guild_id isn't in REST messages: filled from the channel cache.
		expect(msg).toMatchObject({ id: MSG, guildId: GUILD, isDm: false, memberRoles: null, memberNick: null });

		mode = 404;
		expect(await env.client.fetchMessage(CHANNEL, MSG)).toBeNull();
		mode = 403;
		expect(await env.client.fetchMessage(CHANNEL, MSG)).toBeNull();
		mode = "junk";
		expect(await env.client.fetchMessage(CHANNEL, MSG)).toBeNull();
		expect(env.has("warn", "unreadable message")).toBe(true);
		mode = 500;
		expect((await rejection(env.client.fetchMessage(CHANNEL, MSG))).status).toBe(500);
	});

	it("knows a fetched message is in a DM from the channel type seen on the gateway", async () => {
		const restDm = fixture("message-dm");
		delete restDm.channel_type;
		const env = setup({ handler: (call) => (call.route === "/applications/@me" ? APP : restDm) });
		expect((await env.client.fetchMessage(DM_CHANNEL, "1501320000000000020"))?.isDm).toBe(false);
		await connectReady(env);
		env.gw.dispatch("MESSAGE_CREATE", fixture("message-dm"));
		expect((await env.client.fetchMessage(DM_CHANNEL, "1501320000000000020"))?.isDm).toBe(true);
	});

	it("fetches member roles and nick, null when not a member", async () => {
		let response: unknown = { user: { id: ADA, username: "ada" }, roles: ["1"], nick: "Countess", joined_at: "x" };
		const env = setup({
			handler: () => {
				if (response instanceof Error) throw response;
				return response;
			},
		});
		expect(await env.client.fetchMember(GUILD, ADA)).toEqual({ roles: ["1"], nick: "Countess" });
		expect(env.rest.calls[0]).toMatchObject({ method: "GET", route: `/guilds/${GUILD}/members/${ADA}` });

		response = { roles: [] };
		expect(await env.client.fetchMember(GUILD, ADA)).toEqual({ roles: [], nick: null });
		response = apiError(404, "UNKNOWN_MEMBER");
		expect(await env.client.fetchMember(GUILD, ADA)).toBeNull();
		response = apiError(403, "MISSING_ACCESS");
		expect((await rejection(env.client.fetchMember(GUILD, ADA))).status).toBe(403);
		response = { roles: "admin" };
		await rejection(env.client.fetchMember(GUILD, ADA));
	});

	it("opens a DM once per user and remembers it is a DM", async () => {
		const env = setup();
		const [a, b] = await Promise.all([env.client.openDm(ADA), env.client.openDm(ADA)]);
		expect(a).toBe(DM_CHANNEL);
		expect(b).toBe(DM_CHANNEL);
		expect(await env.client.openDm(ADA)).toBe(DM_CHANNEL);
		expect(env.rest.calls).toHaveLength(1);
		expect(env.rest.calls[0]).toMatchObject({
			method: "POST",
			route: "/users/@me/channels",
			body: { recipient_id: ADA },
		});

		// fetchMessage in that channel now knows it's a DM.
		const restDm = fixture("message-dm");
		delete restDm.channel_type;
		env.rest.handler = () => restDm;
		expect((await env.client.fetchMessage(DM_CHANNEL, "1501320000000000020"))?.isDm).toBe(true);
	});

	it("doesn't cache a failed DM open", async () => {
		let fail = true;
		const env = setup({
			handler: () => {
				if (fail) throw apiError(400, "CANNOT_SEND_MESSAGES_TO_USER");
				return { id: DM_CHANNEL, type: 1 };
			},
		});
		expect((await rejection(env.client.openDm(ADA))).code).toBe("CANNOT_SEND_MESSAGES_TO_USER");
		fail = false;
		expect(await env.client.openDm(ADA)).toBe(DM_CHANNEL);
		expect(env.rest.calls).toHaveLength(2);
	});
});

describe("download", () => {
	const URL_OK = "https://fluxerusercontent.com/attachments/1/2/chart.png?ex=1&is=2&hm=3";

	function stream(chunks: number[]): ReadableStream<Uint8Array> {
		return new ReadableStream({
			start(controller) {
				for (const size of chunks) controller.enqueue(new Uint8Array(size));
				controller.close();
			},
		});
	}

	it("returns the bytes and the bare media type", async () => {
		const fetchMock = vi.fn(
			async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "Image/PNG; charset=binary" } }),
		);
		const env = setup({ fetch: fetchMock as unknown as typeof fetch });
		const got = await env.client.download(URL_OK, 3);
		expect([...got.data]).toEqual([1, 2, 3]);
		expect(got.contentType).toBe("image/png");
		const [target, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
		expect(String(target)).toBe(URL_OK);
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(init.redirect).toBe("follow");
		expect(init.headers).toBeUndefined(); // never the bot token
	});

	it("returns an empty buffer and null type for an empty body", async () => {
		const env = setup({ fetch: (async () => new Response(null)) as unknown as typeof fetch });
		const got = await env.client.download(URL_OK, 10);
		expect(got.data.length).toBe(0);
		expect(got.contentType).toBeNull();
	});

	it("rejects when Content-Length is over the limit", async () => {
		const body = stream([4]);
		const cancel = vi.spyOn(body, "cancel");
		const env = setup({
			fetch: (async () => new Response(body, { headers: { "content-length": "11" } })) as unknown as typeof fetch,
		});
		expect(await rejection(env.client.download(URL_OK, 10))).toMatchObject({ code: "TOO_LARGE", status: null });
		expect(cancel).toHaveBeenCalled();
	});

	it("rejects when the streamed body passes the limit", async () => {
		const env = setup({ fetch: (async () => new Response(stream([4, 4, 4]))) as unknown as typeof fetch });
		expect((await rejection(env.client.download(URL_OK, 10))).code).toBe("TOO_LARGE");
		const exact = setup({ fetch: (async () => new Response(stream([4, 4, 2]))) as unknown as typeof fetch });
		expect((await exact.client.download(URL_OK, 10)).data.length).toBe(10);
	});

	it("only fetches http(s) URLs", async () => {
		const fetchMock = vi.fn();
		const env = setup({ fetch: fetchMock as unknown as typeof fetch });
		for (const url of ["file:///etc/passwd", "data:text/plain,hi", "not a url", ""]) {
			expect((await rejection(env.client.download(url, 10))).code).toBe("INVALID_URL");
		}
		expect(fetchMock).not.toHaveBeenCalled();
		await expect(env.client.download(URL_OK, -1)).rejects.toThrow(RangeError);
	});

	it("maps HTTP errors, network errors and timeouts", async () => {
		let next: () => Promise<Response> = async () => new Response("gone", { status: 404 });
		const env = setup({ fetch: (() => next()) as unknown as typeof fetch });
		expect(await rejection(env.client.download(URL_OK, 10))).toMatchObject({ status: 404, code: null });

		next = async () => {
			throw new TypeError("fetch failed");
		};
		expect((await rejection(env.client.download(URL_OK, 10))).status).toBeNull();

		next = async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		};
		expect((await rejection(env.client.download(URL_OK, 10))).message).toMatch(/timed out/);
	});
});

// ---------------------------------------------------------------- gateway

describe("connect", () => {
	it("checks the token, then connects, and resolves on READY", async () => {
		const env = setup();
		const readies: unknown[] = [];
		env.client.on("ready", (info) => readies.push(info));
		expect(env.client.connectionState).toBe("disconnected");

		const connected = env.client.connect();
		expect(env.client.connect()).toBe(connected);
		await until(() => env.gw.connectCalls === 1);
		expect(env.rest.calls[0]?.route).toBe("/applications/@me");
		expect(env.client.connectionState).toBe("connecting");
		expect(env.client.botUser).toBeNull();

		env.gw.dispatch("READY", fixture("ready"));
		await connected;
		expect(env.client.connectionState).toBe("connected");
		expect(env.events.connection).toEqual(["connecting", "connected"]);
		expect(env.client.botUser).toEqual({ id: BOT, username: "clanker", globalName: "Clanker", bot: true });
		expect(readies).toEqual([
			{ user: { id: BOT, username: "clanker", globalName: "Clanker", bot: true }, guildIds: [GUILD, OTHER_GUILD] },
		]);
		expect(env.has("info", "Fluxer application")).toBe(true);
	});

	it("gives the gateway the raw token, the ignored events and the identify presence", () => {
		const env = setup();
		const opts = env.gw.factoryOpts;
		expect(opts?.token).toBe(`${BOT}.secret`);
		expect(opts?.ignoredEvents).toBe(IGNORED_EVENTS);
		expect(opts?.presence).toEqual({ status: "online", afk: false, custom_status: { text: "@mention me to ask" } });
		for (const kept of [
			"MESSAGE_CREATE",
			"GUILD_CREATE",
			"GUILD_UPDATE",
			"GUILD_DELETE",
			"GUILD_MEMBER_UPDATE",
			"GUILD_MEMBER_REMOVE",
			"CHANNEL_CREATE",
			"CHANNEL_UPDATE",
			"CHANNEL_DELETE",
			"THREAD_CREATE",
			"THREAD_UPDATE",
			"THREAD_DELETE",
			"READY",
			"RESUMED",
		]) {
			expect(IGNORED_EVENTS).not.toContain(kept);
		}
		expect(IGNORED_EVENTS).toContain("TYPING_START");
		expect(IGNORED_EVENTS).toContain("MESSAGE_UPDATE");
	});

	it("uses gateway_url instead of discovery when set", async () => {
		const rest = new FakeRest();
		let opts: GatewayFactoryOptions | null = null;
		const client = createFluxerClient({
			token: "1.x",
			apiUrl: "https://api.fluxer.app",
			gatewayUrl: "wss://gateway.example",
			log: captureLog().log,
			rest,
			gatewayFactory: (o) => {
				opts = o;
				return new FakeGateway();
			},
		});
		clients.push(client);
		const gwRest = (opts as GatewayFactoryOptions | null)?.rest;
		expect(await gwRest?.get("/gateway/bot")).toEqual({ url: "wss://gateway.example/", shards: 1 });
		expect(rest.calls).toHaveLength(0);
		await gwRest?.get("/users/@me/guilds");
		expect(rest.calls[0]?.route).toBe("/users/@me/guilds");
	});

	it("discovers the gateway through REST when gateway_url is unset", async () => {
		const env = setup({ handler: (call) => (call.route === "/gateway/bot" ? { url: "wss://g", shards: 1 } : APP) });
		expect(await env.gw.factoryOpts?.rest.get("/gateway/bot")).toEqual({ url: "wss://g", shards: 1 });
		expect(env.rest.calls[0]?.route).toBe("/gateway/bot");
	});

	it("rejects and emits fatal on a 401 token check, without touching the gateway", async () => {
		const env = setup({
			handler: () => {
				throw apiError(401, "INVALID_TOKEN");
			},
		});
		const err = await rejection(env.client.connect());
		expect(err.status).toBe(401);
		expect(err.message).toMatch(/token/);
		expect(env.events.fatal).toHaveLength(1);
		expect(env.events.fatal[0]).toMatch(/401/);
		expect(env.gw.connectCalls).toBe(0);
		await expect(env.client.connect()).rejects.toThrow();
	});

	it.each([
		["a network error", new Error("getaddrinfo ENOTFOUND api.fluxer.app")],
		["a 5xx", new HTTPError(503, null)],
		["a 403", apiError(403, "MISSING_ACCESS")],
	])("warns and connects anyway when the token check fails with %s", async (_name, thrown) => {
		const env = setup({
			handler: (call) => {
				if (call.route === "/applications/@me") throw thrown;
				return undefined;
			},
		});
		await connectReady(env);
		expect(env.has("warn", "couldn't check the bot token")).toBe(true);
		expect(env.events.fatal).toEqual([]);
		expect(env.client.connectionState).toBe("connected");
	});

	it("warns when the bot is public and tolerates an odd application payload", async () => {
		const pub = setup({ handler: () => ({ ...APP, bot_public: true }) });
		await connectReady(pub);
		expect(pub.has("warn", "public")).toBe(true);

		const odd = setup({ handler: () => ({ name: "no id" }) });
		await connectReady(odd);
		expect(odd.has("warn", "unexpected GET /applications/@me")).toBe(true);
	});

	it("fails when the gateway can't connect", async () => {
		const env = setup();
		env.gw.connectError = new Error("Failed to fetch gateway");
		await expect(env.client.connect()).rejects.toThrow("Failed to fetch gateway");
		expect(env.events.fatal[0]).toMatch(/could not connect/);
	});

	it("ignores a READY without a user (the watchdog handles it)", async () => {
		vi.useFakeTimers();
		const env = setup();
		const connected = env.client.connect();
		await until(() => env.gw.connectCalls === 1);
		env.gw.dispatch("READY", { session_id: "x", guilds: [] });
		expect(env.client.connectionState).toBe("connecting");
		expect(env.has("warn", "READY without a usable user")).toBe(true);
		await vi.advanceTimersByTimeAsync(90_000);
		await expect(connected).rejects.toThrow(/no READY/);
	});
});

describe("presence", () => {
	const op3 = (text: string | null, status = "online") => ({
		op: 3,
		d: { status, afk: false, custom_status: text === null ? null : { text } },
	});

	it("is never sent before READY, and is sent after every READY", async () => {
		const env = setup();
		await env.client.setPresence("idle", "before ready");
		const connected = env.client.connect();
		await until(() => env.gw.connectCalls === 1);
		expect(env.gw.sent).toEqual([]);
		env.gw.dispatch("READY", fixture("ready"));
		await connected;
		expect(env.gw.sent).toEqual([op3("before ready", "idle")]);

		// A new session (re-identify) gets it again.
		env.gw.close(1006);
		env.gw.dispatch("READY", fixture("ready"));
		expect(env.gw.sent).toHaveLength(2);
	});

	it("sends immediately while live, waits while disconnected and catches up on RESUMED", async () => {
		const env = setup();
		await connectReady(env);
		await env.client.setPresence("dnd", "busy");
		expect(env.gw.sent.at(-1)).toEqual(op3("busy", "dnd"));
		const count = env.gw.sent.length;

		env.gw.close(1001);
		await env.client.setPresence("online", "");
		expect(env.gw.sent).toHaveLength(count);
		env.gw.dispatch("RESUMED", null);
		expect(env.gw.sent).toHaveLength(count + 1);
		expect(env.gw.sent.at(-1)).toEqual(op3(null));

		// RESUMED with nothing pending sends nothing.
		env.gw.close(1001);
		env.gw.dispatch("RESUMED", {});
		expect(env.gw.sent).toHaveLength(count + 1);
	});

	it("sends nothing when no presence was ever set", async () => {
		const env = setup({ presence: false });
		await connectReady(env);
		expect(env.gw.sent).toEqual([]);
		expect(env.gw.factoryOpts?.presence).toBeNull();
	});

	it("rejects an unknown status", async () => {
		const env = setup();
		await expect(env.client.setPresence("away" as "online", null)).rejects.toThrow(RangeError);
	});
});

describe("guild and channel caches", () => {
	it("caches GUILD_CREATE channels, threads and thread parents", async () => {
		const env = setup();
		const created: unknown[] = [];
		env.client.on("guildCreate", (g) => created.push(g));
		await readyWithGuild(env);

		const guild = env.client.guild(GUILD);
		expect(guild?.name).toBe("Ada's Workshop");
		expect([...(guild?.channels.entries() ?? [])]).toEqual([
			[CATEGORY, "Text"],
			[CHANNEL, "general"],
			[OTHER_CHANNEL, "ask-clanker"],
			[THREAD, "v2 release notes"],
		]);
		expect(created).toEqual([guild]);
		expect(env.client.channelName(CHANNEL)).toBe("general");
		expect(env.client.channelName(THREAD)).toBe("v2 release notes");
		expect(env.client.parentChannel(THREAD)).toBe(CHANNEL);
		// A category is not a thread parent.
		expect(env.client.parentChannel(CHANNEL)).toBeUndefined();
		expect(env.client.guild(OTHER_GUILD)).toBeUndefined();
		expect(env.client.channelName("1")).toBeUndefined();
	});

	it("hands out copies", async () => {
		const env = setup();
		await readyWithGuild(env);
		const copy = env.client.guild(GUILD);
		copy?.channels.clear();
		if (copy) copy.name = "changed";
		expect(env.client.guild(GUILD)?.name).toBe("Ada's Workshop");
		expect(env.client.channelName(CHANNEL)).toBe("general");
	});

	it("accepts a flat guild name and skips unavailable GUILD_CREATEs", async () => {
		const env = setup();
		const created: string[] = [];
		env.client.on("guildCreate", (g) => created.push(g.id));
		await connectReady(env);
		env.gw.dispatch("GUILD_CREATE", { id: OTHER_GUILD, unavailable: true });
		env.gw.dispatch("GUILD_CREATE", { id: GUILD, name: "Flat", channels: [] });
		expect(created).toEqual([GUILD]);
		expect(env.client.guild(GUILD)?.name).toBe("Flat");
	});

	it("updates the guild name on GUILD_UPDATE", async () => {
		const env = setup();
		await readyWithGuild(env);
		env.gw.dispatch("GUILD_UPDATE", { id: GUILD, guild_id: GUILD, name: "Renamed", icon: null });
		expect(env.client.guild(GUILD)?.name).toBe("Renamed");
		env.gw.dispatch("GUILD_UPDATE", { id: OTHER_GUILD, name: "Unknown" });
		expect(env.client.guild(OTHER_GUILD)).toBeUndefined();
	});

	it("keeps the cache on an outage and drops it when the bot is removed", async () => {
		const env = setup();
		const deleted: string[] = [];
		env.client.on("guildDelete", (id) => deleted.push(id));
		await readyWithGuild(env);

		env.gw.dispatch("GUILD_DELETE", { id: GUILD, unavailable: true });
		expect(deleted).toEqual([]);
		expect(env.client.guild(GUILD)).toBeDefined();
		expect(env.client.parentChannel(THREAD)).toBe(CHANNEL);

		env.gw.dispatch("GUILD_DELETE", { id: GUILD });
		expect(deleted).toEqual([GUILD]);
		expect(env.client.guild(GUILD)).toBeUndefined();
		expect(env.client.channelName(CHANNEL)).toBeUndefined();
		expect(env.client.parentChannel(THREAD)).toBeUndefined();

		// Removal of a guild that was never cached is still reported.
		env.gw.dispatch("GUILD_DELETE", { id: OTHER_GUILD, unavailable: false });
		expect(deleted).toEqual([GUILD, OTHER_GUILD]);
	});

	it("follows channel and thread events", async () => {
		const env = setup();
		await readyWithGuild(env);
		const NEW_CHANNEL = "1501314428688998190";
		const NEW_THREAD = "1501314428688998590";

		env.gw.dispatch("CHANNEL_CREATE", { id: NEW_CHANNEL, type: 0, guild_id: GUILD, name: "new", parent_id: CATEGORY });
		expect(env.client.channelName(NEW_CHANNEL)).toBe("new");
		env.gw.dispatch("CHANNEL_UPDATE", { id: NEW_CHANNEL, type: 0, guild_id: GUILD, name: "renamed" });
		expect(env.client.channelName(NEW_CHANNEL)).toBe("renamed");

		env.gw.dispatch("THREAD_CREATE", {
			id: NEW_THREAD,
			type: 12,
			guild_id: GUILD,
			parent_id: NEW_CHANNEL,
			name: "private thread",
			newly_created: true,
		});
		expect(env.client.parentChannel(NEW_THREAD)).toBe(NEW_CHANNEL);
		env.gw.dispatch("THREAD_UPDATE", { id: NEW_THREAD, type: 12, guild_id: GUILD, parent_id: NEW_CHANNEL, name: "t2" });
		expect(env.client.channelName(NEW_THREAD)).toBe("t2");

		// Deleting a channel drops its threads too (Fluxer sends no THREAD_DELETE for them).
		env.gw.dispatch("CHANNEL_DELETE", { id: NEW_CHANNEL, type: 0, guild_id: GUILD, name: "renamed" });
		expect(env.client.channelName(NEW_CHANNEL)).toBeUndefined();
		expect(env.client.parentChannel(NEW_THREAD)).toBeUndefined();
		expect(env.client.channelName(NEW_THREAD)).toBeUndefined();

		env.gw.dispatch("THREAD_DELETE", { id: THREAD, guild_id: GUILD, parent_id: CHANNEL, type: 11 });
		expect(env.client.parentChannel(THREAD)).toBeUndefined();
		expect(env.client.channelName(THREAD)).toBeUndefined();
	});

	it("handles bulk channel updates and thread list syncs", async () => {
		const env = setup();
		await readyWithGuild(env);
		env.gw.dispatch("CHANNEL_UPDATE_BULK", {
			guild_id: GUILD,
			channels: [{ id: CHANNEL, type: 0, name: "lobby" }, { broken: true }],
		});
		expect(env.client.channelName(CHANNEL)).toBe("lobby");
		env.gw.dispatch("THREAD_LIST_SYNC", {
			guild_id: GUILD,
			threads: [{ id: "1501314428688998591", type: 11, parent_id: OTHER_CHANNEL, name: "synced" }],
			members: [],
		});
		expect(env.client.parentChannel("1501314428688998591")).toBe(OTHER_CHANNEL);
		// Threads missing from a sync are only archived, so their parents stay known.
		expect(env.client.parentChannel(THREAD)).toBe(CHANNEL);
	});

	it("forgets guilds missing from a later READY (removed while disconnected)", async () => {
		const env = setup();
		const deleted: string[] = [];
		const order: string[] = [];
		env.client.on("guildDelete", (id) => {
			deleted.push(id);
			order.push("guildDelete");
		});
		env.client.on("ready", () => order.push("ready"));
		await readyWithGuild(env);
		env.gw.dispatch("GUILD_CREATE", { id: OTHER_GUILD, properties: { name: "Other" }, channels: [] });

		env.gw.close(1006);
		env.gw.dispatch("READY", { ...fixture("ready"), guilds: [{ id: OTHER_GUILD, unavailable: true }] });
		expect(deleted).toEqual([GUILD]);
		expect(order).toEqual(["ready", "guildDelete", "ready"]);
		expect(env.client.guild(GUILD)).toBeUndefined();
		expect(env.client.parentChannel(THREAD)).toBeUndefined();
		expect(env.client.channelName(CHANNEL)).toBeUndefined();
		expect(env.client.guild(OTHER_GUILD)?.name).toBe("Other");

		// A READY without a guild list prunes nothing.
		env.gw.close(1006);
		env.gw.dispatch("READY", { user: fixture("ready").user });
		expect(env.client.guild(OTHER_GUILD)).toBeDefined();
		expect(deleted).toEqual([GUILD]);
	});

	it("bounds the thread caches, dropping the oldest entries first", async () => {
		const env = setup();
		await readyWithGuild(env);
		const first = 1501314428700000000n;
		const threads = Array.from({ length: MAX_CACHED_CHANNELS + 1 }, (_, i) => ({
			id: String(first + BigInt(i)),
			type: 11,
			parent_id: OTHER_CHANNEL,
		}));
		env.gw.dispatch("THREAD_LIST_SYNC", { guild_id: GUILD, threads, members: [] });
		// The fixture's thread and the first synced one were the oldest entries.
		expect(env.client.parentChannel(THREAD)).toBeUndefined();
		expect(env.client.parentChannel(String(first))).toBeUndefined();
		expect(env.client.parentChannel(String(first + 1n))).toBe(OTHER_CHANNEL);
		expect(env.client.parentChannel(String(first + BigInt(MAX_CACHED_CHANNELS)))).toBe(OTHER_CHANNEL);
	});

	it("ignores channel events for guilds it doesn't know", async () => {
		const env = setup();
		await connectReady(env);
		env.gw.dispatch("THREAD_CREATE", { id: THREAD, type: 11, guild_id: OTHER_GUILD, parent_id: CHANNEL, name: "x" });
		expect(env.client.parentChannel(THREAD)).toBeUndefined();
	});
});

describe("member events", () => {
	it("emits memberUpdate and memberRemove", async () => {
		const env = setup();
		const updates: unknown[] = [];
		const removes: unknown[] = [];
		env.client.on("memberUpdate", (ev) => updates.push(ev));
		env.client.on("memberRemove", (ev) => removes.push(ev));
		await connectReady(env);

		env.gw.dispatch("GUILD_MEMBER_UPDATE", {
			guild_id: GUILD,
			user: { id: ADA, username: "ada", global_name: "Ada L." },
			roles: ["1501314428688990100"],
			nick: "Countess",
			joined_at: "2026-08-01T10:00:00.000Z",
		});
		env.gw.dispatch("GUILD_MEMBER_UPDATE", { guild_id: GUILD, user: { id: BOB }, roles: [] });
		env.gw.dispatch("GUILD_MEMBER_REMOVE", { guild_id: GUILD, user: { id: ADA } });
		// Malformed: no guild_id / no user.
		env.gw.dispatch("GUILD_MEMBER_UPDATE", { user: { id: ADA }, roles: [] });
		env.gw.dispatch("GUILD_MEMBER_REMOVE", { guild_id: GUILD });

		expect(updates).toEqual([
			{ guildId: GUILD, userId: ADA, roles: ["1501314428688990100"], nick: "Countess" },
			{ guildId: GUILD, userId: BOB, roles: [], nick: null },
		]);
		expect(removes).toEqual([{ guildId: GUILD, userId: ADA }]);
	});
});

describe("MESSAGE_CREATE", () => {
	it("emits normalized messages once per ID", async () => {
		const env = setup();
		await connectReady(env);
		env.gw.dispatch("MESSAGE_CREATE", fixture("message-guild"));
		env.gw.dispatch("MESSAGE_CREATE", fixture("message-guild"));
		env.gw.dispatch("MESSAGE_CREATE", fixture("message-dm"));
		await flush();
		expect(env.events.messages.map((m) => m.id)).toEqual([MSG, "1501320000000000020"]);
		expect(env.events.messages[0]?.memberRoles).toEqual(["1501314428688990100", "1501314428688990101"]);
		expect(env.has("debug", "duplicate MESSAGE_CREATE")).toBe(true);
	});

	it("forgets IDs beyond the last 1000", async () => {
		const env = setup();
		await connectReady(env);
		const first = fixture("message-guild");
		env.gw.dispatch("MESSAGE_CREATE", first);
		for (let i = 0; i < 1000; i++) {
			const raw = fixture("message-dm");
			raw.id = String(1501320000000100000n + BigInt(i));
			env.gw.dispatch("MESSAGE_CREATE", raw);
		}
		env.gw.dispatch("MESSAGE_CREATE", first);
		await flush();
		expect(env.events.messages).toHaveLength(1002);
	});

	it("drops malformed payloads and keeps going", async () => {
		const env = setup();
		await connectReady(env);
		env.gw.dispatch("MESSAGE_CREATE", { id: MSG, content: "no author" });
		env.gw.dispatch("MESSAGE_CREATE", null);
		env.gw.emit("dispatch", { shardId: 0 });
		env.gw.emit("dispatch", "garbage");
		env.gw.dispatch("SOMETHING_NEW", { whatever: [1, 2, 3] });
		env.gw.dispatch("MESSAGE_CREATE", fixture("message-guild"));
		await flush();
		expect(env.events.messages.map((m) => m.id)).toEqual([MSG]);
		expect(env.has("debug", "ignoring malformed MESSAGE_CREATE")).toBe(true);
	});

	it("looks up an unknown thread's parent before emitting", async () => {
		const OLD_THREAD = "1501314428688998600";
		const env = setup({
			handler: (call) =>
				call.route === `/channels/${OLD_THREAD}`
					? { id: OLD_THREAD, type: 11, guild_id: GUILD, parent_id: OTHER_CHANNEL, name: "old thread" }
					: APP,
		});
		const parents: Array<string | undefined> = [];
		env.client.on("messageCreate", (m) => parents.push(env.client.parentChannel(m.channelId)));
		await readyWithGuild(env);

		for (const id of ["1501320000000000061", "1501320000000000062"]) {
			const raw = fixture("message-guild");
			raw.id = id;
			raw.channel_id = OLD_THREAD;
			raw.channel_type = 11;
			env.gw.dispatch("MESSAGE_CREATE", raw);
		}
		await until(() => parents.length === 2);
		expect(parents).toEqual([OTHER_CHANNEL, OTHER_CHANNEL]);
		expect(env.rest.api.map((c) => c.route)).toEqual([`/channels/${OLD_THREAD}`]);
		expect(env.client.channelName(OLD_THREAD)).toBe("old thread");

		// Known threads need no lookup.
		const known = fixture("message-guild");
		known.id = "1501320000000000063";
		known.channel_id = THREAD;
		known.channel_type = 11;
		env.gw.dispatch("MESSAGE_CREATE", known);
		await until(() => parents.length === 3);
		expect(env.rest.api).toHaveLength(1);
	});

	it("doesn't look up threads of guilds it hasn't cached", async () => {
		const env = setup();
		await connectReady(env);
		const raw = fixture("message-guild");
		raw.channel_id = "1501314428688998601";
		raw.channel_type = 11;
		env.gw.dispatch("MESSAGE_CREATE", raw);
		expect(env.events.messages).toHaveLength(1); // emitted at once, no await
		expect(env.rest.api).toEqual([]);
	});

	it("still emits when the thread lookup fails", async () => {
		const env = setup({
			handler: (call) => {
				if (call.route === "/applications/@me") return APP;
				throw apiError(403, "MISSING_ACCESS");
			},
		});
		await readyWithGuild(env);
		const raw = fixture("message-guild");
		raw.channel_id = "1501314428688998601";
		raw.channel_type = 11;
		env.gw.dispatch("MESSAGE_CREATE", raw);
		await until(() => env.events.messages.length === 1);
		expect(env.client.parentChannel("1501314428688998601")).toBeUndefined();
		expect(env.has("warn", "thread lookup failed")).toBe(true);
	});
});

describe("listener isolation", () => {
	it("logs a throwing or rejecting listener and keeps delivering", async () => {
		const env = setup();
		env.client.on("messageCreate", () => {
			throw new Error("boom");
		});
		env.client.on("messageCreate", async () => {
			throw new Error("async boom");
		});
		await connectReady(env);
		env.gw.dispatch("MESSAGE_CREATE", fixture("message-guild"));
		env.gw.dispatch("MESSAGE_CREATE", fixture("message-dm"));
		await flush();
		expect(env.events.messages).toHaveLength(2);
		const failures = env.lines.filter((l) => l.level === "error" && l.msg.includes("listener failed"));
		expect(failures).toHaveLength(4);
	});

	it("survives a throwing ready listener", async () => {
		const env = setup();
		env.client.on("ready", () => {
			throw new Error("boom");
		});
		await connectReady(env);
		expect(env.client.connectionState).toBe("connected");
	});
});

describe("log hygiene", () => {
	it("never writes message text above debug level", async () => {
		const SECRET = "zebra-umbrella-42";
		const env = setup({
			handler: (call) => {
				if (call.route === "/applications/@me") return APP;
				if (call.method === "GET" && call.route.includes("/messages/")) return { id: MSG, content: SECRET };
				if (call.method === "GET") throw apiError(403, "MISSING_ACCESS");
				throw apiError(403, "CONTENT_BLOCKED");
			},
		});
		await readyWithGuild(env);
		const guildMsg = fixture("message-guild");
		guildMsg.content = SECRET;
		const reply = fixture("message-reply");
		reply.content = SECRET;
		(reply.referenced_message as Record<string, unknown>).content = SECRET;
		const inThread = fixture("message-guild");
		inThread.id = "1501320000000000070";
		inThread.channel_id = "1501314428688998601";
		inThread.channel_type = 11;
		inThread.content = SECRET;
		for (const raw of [guildMsg, reply, inThread, guildMsg]) env.gw.dispatch("MESSAGE_CREATE", raw);
		env.gw.dispatch("MESSAGE_CREATE", { id: MSG, content: SECRET }); // malformed
		await until(() => env.events.messages.length === 3);
		expect(await env.client.fetchMessage(CHANNEL, MSG)).toBeNull(); // unreadable
		await rejection(env.client.sendMessage(CHANNEL, { content: SECRET, replyTo: MSG }));
		await rejection(env.client.editMessage(CHANNEL, MSG, { content: SECRET }));

		const visible = env.lines.filter((l) => l.level !== "debug");
		expect(visible.filter((l) => l.level === "warn").length).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify(visible)).not.toContain(SECRET);
	});
});

describe("connection state, fatal and watchdog", () => {
	it("goes disconnected on close and connected again on RESUMED", async () => {
		const env = setup();
		await connectReady(env);
		env.gw.close(1006);
		expect(env.client.connectionState).toBe("disconnected");
		env.gw.dispatch("RESUMED", null);
		expect(env.events.connection).toEqual(["connecting", "connected", "disconnected", "connected"]);
		expect(env.events.fatal).toEqual([]);
	});

	it("emits fatal on close 4004 and on other codes the library won't retry", async () => {
		const bad = setup();
		await connectReady(bad);
		bad.gw.close(4004);
		expect(bad.events.fatal).toHaveLength(1);
		expect(bad.events.fatal[0]).toMatch(/4004/);
		expect(bad.client.connectionState).toBe("disconnected");

		const early = setup();
		await connectReady(early);
		early.gw.close(4003);
		expect(early.events.fatal[0]).toMatch(/4003/);

		for (const code of [1000, 1001, 1006, 4000, 4007, 4009]) {
			const ok = setup();
			await connectReady(ok);
			ok.gw.close(code);
			expect(ok.events.fatal, `code ${code}`).toEqual([]);
		}
	});

	it("stops the gateway on fatal and ignores it from then on", async () => {
		const env = setup();
		const readies: unknown[] = [];
		env.client.on("ready", (r) => readies.push(r));
		await connectReady(env);
		env.gw.close(4004);
		expect(env.gw.destroyCalls).toBe(1);
		expect(env.client.connectionState).toBe("disconnected");

		// Whatever the dying socket still delivers changes nothing.
		env.gw.dispatch("READY", fixture("ready"));
		env.gw.dispatch("RESUMED", null);
		env.gw.dispatch("MESSAGE_CREATE", fixture("message-guild"));
		env.gw.shard.emit("ping", 40);
		env.gw.close(1006);
		await flush();
		expect(readies).toHaveLength(1);
		expect(env.client.connectionState).toBe("disconnected");
		expect(env.events.messages).toEqual([]);
		expect(env.events.heartbeats).toBe(0);
		expect(env.events.connection).toEqual(["connecting", "connected", "disconnected"]);

		// REST still works for replies in flight, and destroy() doesn't stop the gateway twice.
		expect(await env.client.sendMessage(CHANNEL, { content: "bye" })).toEqual({ id: SENT_ID });
		await env.client.destroy();
		expect(env.gw.destroyCalls).toBe(1);
	});

	it("ignores a RESUMED that comes before any READY", async () => {
		vi.useFakeTimers();
		const env = setup();
		const connected = env.client.connect();
		connected.catch(() => {});
		await until(() => env.gw.connectCalls === 1);
		env.gw.dispatch("RESUMED", null);
		expect(env.client.connectionState).toBe("connecting");
		expect(env.has("warn", "RESUMED before any READY")).toBe(true);
		// The watchdog still runs.
		await vi.advanceTimersByTimeAsync(90_000);
		expect(env.events.fatal).toHaveLength(1);
	});

	it("rejects a pending connect() on 4004", async () => {
		const env = setup();
		const connected = env.client.connect();
		await until(() => env.gw.connectCalls === 1);
		env.gw.close(4004);
		await expect(connected).rejects.toThrow(/4004/);
	});

	it("emits fatal once, even if the watchdog fires later", async () => {
		vi.useFakeTimers();
		const env = setup();
		await connectReady(env);
		env.gw.close(1006);
		env.gw.close(4004);
		await vi.advanceTimersByTimeAsync(200_000);
		expect(env.events.fatal).toHaveLength(1);
	});

	it("fails when no READY arrives within 90 s of connect()", async () => {
		vi.useFakeTimers();
		const env = setup();
		const connected = env.client.connect();
		connected.catch(() => {});
		await until(() => env.gw.connectCalls === 1);
		await vi.advanceTimersByTimeAsync(89_999);
		expect(env.events.fatal).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(env.events.fatal).toEqual(["no READY from the Fluxer gateway within 90 s"]);
		await expect(connected).rejects.toThrow(/no READY/);
		expect(env.gw.destroyCalls).toBe(1);
		// A READY that comes too late is ignored.
		env.gw.dispatch("READY", fixture("ready"));
		expect(env.client.connectionState).toBe("disconnected");
	});

	it("fails when the gateway stays down for 90 s after a close", async () => {
		vi.useFakeTimers();
		const env = setup();
		await connectReady(env);
		env.gw.close(1006);
		await vi.advanceTimersByTimeAsync(60_000);
		env.gw.close(1006); // another failed attempt doesn't restart the clock
		await vi.advanceTimersByTimeAsync(29_999);
		expect(env.events.fatal).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(env.events.fatal).toHaveLength(1);
	});

	it("doesn't fail when the session resumes or re-identifies in time", async () => {
		vi.useFakeTimers();
		const env = setup();
		await connectReady(env);
		env.gw.close(1006);
		await vi.advanceTimersByTimeAsync(30_000);
		env.gw.dispatch("RESUMED", null);
		env.gw.close(1000);
		await vi.advanceTimersByTimeAsync(80_000);
		env.gw.dispatch("READY", fixture("ready"));
		await vi.advanceTimersByTimeAsync(300_000);
		expect(env.events.fatal).toEqual([]);
	});

	it("emits heartbeat on shard pings only while connected", async () => {
		const env = setup();
		await connectReady(env);
		env.gw.shard.emit("ping", 42);
		env.gw.shard.emit("ping", 40);
		env.gw.close(1006);
		env.gw.shard.emit("ping", 41);
		expect(env.events.heartbeats).toBe(2);
		env.gw.dispatch("RESUMED", null);
		env.gw.shard.emit("ping", 39);
		expect(env.events.heartbeats).toBe(3);
	});

	it("logs gateway errors without failing", async () => {
		const env = setup();
		await connectReady(env);
		env.gw.emit("error", { shardId: 0, error: new Error("ECONNRESET") });
		env.gw.emit("error", "odd");
		env.gw.emit("debug", "[Shard 0] Heartbeat ack missed; reconnecting");
		expect(env.lines.filter((l) => l.msg === "Fluxer gateway error")).toHaveLength(2);
		expect(env.has("debug", "gateway debug")).toBe(true);
		expect(env.events.fatal).toEqual([]);
	});

	it("keeps the text of an unparsable frame out of warn logs", async () => {
		const env = setup();
		await connectReady(env);
		const parseError = new SyntaxError(`Unexpected token 'd', "do my homework" is not valid JSON`);
		env.gw.emit("error", { shardId: 0, error: parseError });
		expect(env.has("warn", "isn't valid JSON")).toBe(true);
		const visible = env.lines.filter((l) => l.level !== "debug");
		expect(JSON.stringify(visible)).not.toContain("homework");
		expect(env.lines.some((l) => l.level === "debug" && JSON.stringify(l).includes("homework"))).toBe(true);
	});

	it("stops the gateway's discovery retries once destroyed", async () => {
		const env = setup({
			handler: (call) => {
				if (call.route === "/gateway/bot") throw new Error("fetch failed");
				return APP;
			},
		});
		const gwRest = env.gw.factoryOpts?.rest;
		// While running, errors pass through untouched so the manager retries them.
		await expect(gwRest?.get("/gateway/bot")).rejects.toThrow("fetch failed");
		await env.client.destroy();
		await expect(gwRest?.get("/gateway/bot")).rejects.toMatchObject({ isRetryable: false });
	});
});

describe("destroy", () => {
	it("is idempotent and stops everything", async () => {
		vi.useFakeTimers();
		const env = setup();
		const connected = env.client.connect();
		await until(() => env.gw.connectCalls === 1);
		await Promise.all([env.client.destroy(), env.client.destroy()]);
		expect(env.gw.destroyCalls).toBe(1);
		expect(env.client.connectionState).toBe("disconnected");
		await expect(connected).rejects.toThrow(/destroyed/);
		await expect(env.client.connect()).rejects.toThrow(/destroyed/);

		// No events, no watchdog after destroy.
		env.gw.dispatch("MESSAGE_CREATE", fixture("message-guild"));
		env.gw.close(4004);
		await vi.advanceTimersByTimeAsync(200_000);
		expect(env.events.messages).toEqual([]);
		expect(env.events.fatal).toEqual([]);
	});

	it("aborts requests in flight and never starts queued ones", async () => {
		const env = setup({ handler: hang });
		const first = rejection(env.client.sendMessage(CHANNEL, { content: "a" }));
		const queued = rejection(env.client.editMessage(CHANNEL, MSG, { content: "b" }));
		await until(() => env.rest.calls.length === 1);
		await env.client.destroy();
		expect((await first).message).toMatch(/destroyed/);
		expect((await queued).message).toMatch(/destroyed/);
		expect(env.rest.calls).toHaveLength(1);
		// Reads after destroy() fail the same way.
		expect((await rejection(env.client.fetchMessage(CHANNEL, MSG))).message).toMatch(/destroyed/);
		expect(env.lines.filter((l) => l.level === "warn")).toEqual([]);
	});

	it("drops a message whose thread lookup is cut short by destroy()", async () => {
		const env = setup({ handler: (call) => (call.route === "/applications/@me" ? APP : hang(call)) });
		await readyWithGuild(env);
		const raw = fixture("message-guild");
		raw.channel_id = "1501314428688998601";
		raw.channel_type = 11;
		env.gw.dispatch("MESSAGE_CREATE", raw);
		await until(() => env.rest.api.length === 1);
		await env.client.destroy();
		await flush();
		expect(env.events.messages).toEqual([]);
		expect(env.has("warn", "thread lookup failed")).toBe(false);
	});

	it("aborts a rate-limit wait", async () => {
		const env = setup({
			handler: () => {
				throw rateLimited(30);
			},
		});
		const sending = env.client.sendMessage(CHANNEL, { content: "x" });
		await until(() => env.rest.calls.length === 1);
		await flush();
		await env.client.destroy();
		expect((await rejection(sending)).message).toMatch(/destroyed/);
		expect(env.rest.calls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------- real classes, no Fluxer

describe("with the real @fluxerjs classes", () => {
	it("constructs REST and the gateway without touching the network", async () => {
		const client = createFluxerClient({
			token: `Bot ${BOT}.secret`,
			apiUrl: "https://api.fluxer.app/v1/",
			log: captureLog().log,
		});
		expect(client.connectionState).toBe("disconnected");
		expect(client.botUser).toBeNull();
		expect(client.guild(GUILD)).toBeUndefined();
		const gw = createGateway({
			token: "1.x",
			rest: { get: async () => ({}) },
			ignoredEvents: IGNORED_EVENTS,
			presence: null,
		});
		expect(gw.getShard(0)).toBeUndefined(); // shards exist only after connect()
		gw.destroy();
		await client.destroy();
		await client.destroy();
	});

	it("rejects an empty token or a bad API or gateway URL up front", () => {
		const log = captureLog().log;
		const apiUrl = "https://api.fluxer.app";
		expect(() => createFluxerClient({ token: "Bot  ", apiUrl, log })).toThrow(/empty/);
		expect(() => createFluxerClient({ token: "1.x", apiUrl: "nope", log })).toThrow(/api_url/);
		expect(() => createFluxerClient({ token: "1.x", apiUrl, gatewayUrl: "wss://g/?v=2", log })).toThrow(/gateway_url/);
	});

	it("speaks the gateway protocol over a real ws socket to a local server", async () => {
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await once(server, "listening");
		const { port } = server.address() as AddressInfo;
		const frames: Array<{ op: number; d?: unknown }> = [];
		const urls: string[] = [];
		let socket: WebSocket | null = null;
		server.on("connection", (ws, req) => {
			socket = ws;
			urls.push(req.url ?? "");
			ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
			ws.on("message", (data) => {
				const frame = JSON.parse(String(data)) as { op: number; d?: unknown };
				frames.push(frame);
				if (frame.op === 2) {
					ws.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: fixture("ready") }));
					ws.send(JSON.stringify({ op: 0, t: "GUILD_CREATE", s: 2, d: fixture("guild-create") }));
				}
				if (frame.op === 1) ws.send(JSON.stringify({ op: 11 }));
			});
		});

		const { log } = captureLog();
		const client = createFluxerClient({
			token: `Bot ${BOT}.secret`,
			apiUrl: "https://api.fluxer.app",
			gatewayUrl: `ws://127.0.0.1:${port}`,
			log,
			rest: new FakeRest(),
			presence: { status: "online", customStatus: "@mention me to ask" },
		});
		clients.push(client);
		try {
			const guildNames: string[] = [];
			client.on("guildCreate", (g) => guildNames.push(g.name));
			await client.connect();
			expect(client.botUser?.id).toBe(BOT);
			expect(urls).toEqual(["/?v=1&encoding=json"]);

			await vi.waitFor(() => expect(frames.some((f) => f.op === 3)).toBe(true));
			const identifyAt = frames.findIndex((f) => f.op === 2);
			const presenceAt = frames.findIndex((f) => f.op === 3);
			expect(identifyAt).toBeGreaterThanOrEqual(0);
			expect(presenceAt).toBeGreaterThan(identifyAt);
			expect(frames[identifyAt]?.d).toMatchObject({
				token: `${BOT}.secret`,
				ignored_events: [...IGNORED_EVENTS],
				presence: { status: "online", custom_status: { text: "@mention me to ask" } },
				properties: { e2ee_capable: false },
			});
			expect(frames[presenceAt]?.d).toEqual({
				status: "online",
				afk: false,
				custom_status: { text: "@mention me to ask" },
			});
			await vi.waitFor(() => expect(guildNames).toEqual(["Ada's Workshop"]));

			// The server asks for a heartbeat; the ACK reaches us as a 'heartbeat' event.
			const beat = new Promise<void>((resolve) => client.on("heartbeat", resolve));
			(socket as WebSocket | null)?.send(JSON.stringify({ op: 1 }));
			await beat;

			const message = new Promise<ChatMessage>((resolve) => client.on("messageCreate", resolve));
			(socket as WebSocket | null)?.send(
				JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 3, d: fixture("message-guild") }),
			);
			expect((await message).id).toBe(MSG);

			const fatal = new Promise<string>((resolve) => client.on("fatal", resolve));
			(socket as WebSocket | null)?.close(4004, "invalid token");
			expect(await fatal).toMatch(/4004/);
			expect(client.connectionState).toBe("disconnected");
		} finally {
			await client.destroy();
			for (const ws of server.clients) ws.terminate();
			server.close();
		}
	}, 15_000);
});
