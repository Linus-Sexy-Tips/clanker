// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	applyPersonality,
	ConfigError,
	contextBudget,
	DEFAULT_PRICES,
	estimateCall,
	parseConfig,
} from "../src/config.js";
import { composeSystemPrompt, DEFAULT_PERSONALITY, DEFAULT_SYSTEM_PROMPT } from "../src/prompt.js";

const env = { FLUXER_BOT_TOKEN: "1234.abcdef", ANTHROPIC_API_KEY: "sk-ant-test" };
const minimal = 'owner_id = "42"';

function errorOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ConfigError);
		return (err as Error).message;
	}
	throw new Error("expected a ConfigError");
}

describe("parseConfig", () => {
	it("applies every default from a minimal file", () => {
		const { config, secrets, systemPrompt, prices, heartbeatFile } = parseConfig(minimal, env);
		expect(config.owner_id).toBe("42");
		expect(config.api_url).toBe("https://api.fluxer.app/v1");
		expect(config.timezone).toBe("UTC");
		expect(config.access).toEqual({ users: [], blocked_users: [], guilds_leave_unlisted: true });
		expect(config.guilds).toEqual({});
		expect(config.dms.enabled).toBe(true);
		expect(config.model).toEqual({
			name: "claude-haiku-5-5",
			effort: "medium",
			max_tokens: 8000,
			system_prompt_file: "",
			personality: "",
		});
		expect(config.tools.web_search).toMatchObject({ enabled: true, max_uses: 3 });
		expect(config.tools.web_fetch).toMatchObject({ enabled: true, max_uses: 3, max_content_tokens: 10_000 });
		expect(config.context).toEqual({
			max_messages: 50,
			max_chain_tokens: 50_000,
			max_request_tokens: 100_000,
			max_images: 4,
		});
		expect(config.cache).toEqual({ system_ttl: "1h", replay_ttl_seconds: 300, replay_max_mb: 64 });
		expect(config.limits).toMatchObject({
			user_daily_usd: 5,
			monthly_usd: 100,
			notice: "reply",
			cooldown_seconds: 5,
			max_concurrent: 4,
			max_queue: 8,
			overrides: [],
		});
		expect(config.presence).toEqual({ status: "online", custom_status: "@mention me to ask" });
		expect(secrets).toEqual({ fluxerToken: "1234.abcdef", anthropicApiKey: "sk-ant-test" });
		expect(systemPrompt).toBe(composeSystemPrompt(DEFAULT_SYSTEM_PROMPT, DEFAULT_PERSONALITY));
		expect(prices).toBe(DEFAULT_PRICES["claude-haiku-5-5"]);
		expect(heartbeatFile).toBe("/data/heartbeat");
	});

	it("parses the example config", () => {
		const text = readFileSync(new URL("../clanker.example.toml", import.meta.url), "utf8");
		const { config } = parseConfig(text, env);
		expect(config.owner_id).toBe("1234567890");
	});

	it("parses guilds and overrides", () => {
		const { config } = parseConfig(
			`${minimal}
[guilds."100"]
roles = ["200"]
[guilds."101"]
[[limits.overrides]]
role = "200"
user_daily_usd = 10`,
			env,
		);
		expect(config.guilds).toEqual({ "100": { roles: ["200"], channels: [] }, "101": { roles: [], channels: [] } });
		expect(config.limits.overrides).toEqual([{ role: "200", user_daily_usd: 10 }]);
	});

	it("rejects unknown keys and bad values, listing them all", () => {
		const msg = errorOf(() =>
			parseConfig(
				`owner_id = "42"
colour = "red"
timezone = "Mars/Base"
[model]
effort = "extreme"
[access]
users = [123]`,
				env,
			),
		);
		expect(msg).toMatch(/colour/);
		expect(msg).toMatch(/^timezone: /m);
		expect(msg).toMatch(/^model\.effort: /m);
		expect(msg).toMatch(/^access\.users\.0: /m);
		expect(msg).toMatch(/More checks run once these are fixed/);
	});

	it("requires owner_id", () => {
		expect(errorOf(() => parseConfig("", env))).toMatch(/owner_id/);
	});

	it("rejects a context budget over max_request_tokens", () => {
		const msg = errorOf(() => parseConfig(`${minimal}\n[context]\nmax_chain_tokens = 90000`, env));
		expect(msg).toMatch(/worst-case request/);
		// Turning web fetch off frees room.
		const ok = parseConfig(`${minimal}\n[context]\nmax_chain_tokens = 80000\n[tools.web_fetch]\nenabled = false`, env);
		expect(contextBudget(ok.config).total).toBe(3000 + 80_000 + 12_000);
	});

	it("checks overrides, the owner, domains and prices; fallbacks is not an option", () => {
		expect(errorOf(() => parseConfig(`${minimal}\n[[limits.overrides]]\nuser_daily_usd = 1`, env))).toMatch(
			/exactly one of user or role/,
		);
		expect(errorOf(() => parseConfig(`${minimal}\n[access]\nblocked_users = ["42"]`, env))).toMatch(
			/owner can't be blocked/,
		);
		expect(
			errorOf(() =>
				parseConfig(`${minimal}\n[tools.web_search]\nallowed_domains = ["a.com"]\nblocked_domains = ["b.com"]`, env),
			),
		).toMatch(/not both/);
		expect(errorOf(() => parseConfig(`${minimal}\n[model]\nname = "claude-unknown"`, env))).toMatch(/no prices/);
		expect(errorOf(() => parseConfig(`${minimal}\n[model]\nfallbacks = true`, env))).toMatch(/fallbacks/);
		const custom = parseConfig(
			`${minimal}\n[model]\nname = "claude-x"\n[prices."claude-x"]\ninput = 1\noutput = 5\ncache_write_5m = 1.25\ncache_write_1h = 2\ncache_read = 0.1`,
			env,
		);
		expect(custom.prices.input).toBe(1);
	});

	it("rejects caps above zero that can't fit one call's reservation", () => {
		const daily = errorOf(() => parseConfig(`${minimal}\n[limits]\nuser_daily_usd = 0.30`, env));
		expect(daily).toMatch(/^limits\.user_daily_usd \(US\$0\.30\) is below .*\(US\$0\.40 with this model/m);
		expect(errorOf(() => parseConfig(`${minimal}\n[limits]\nmonthly_usd = 0.30`, env))).toMatch(
			/^limits\.monthly_usd \(US\$0\.30\)/m,
		);
		expect(
			errorOf(() =>
				parseConfig(
					`${minimal}\n[limits]\nuser_daily_usd = 0\n[[limits.overrides]]\nrole = "7"\nuser_daily_usd = 0.25`,
					env,
				),
			),
		).toMatch(/^limits\.overrides\.0\.user_daily_usd \(US\$0\.25\)/m);
		// 0 blocks on purpose; a cap equal to the reservation lets exactly one call start.
		expect(
			parseConfig(`${minimal}\n[limits]\nuser_daily_usd = 0\nmonthly_usd = 0`, env).config.limits.monthly_usd,
		).toBe(0);
		expect(parseConfig(`${minimal}\n[limits]\nuser_daily_usd = 0.40`, env).config.limits.user_daily_usd).toBe(0.4);
		// With both tools off the reservation is about US$0.02.
		const small = parseConfig(
			`${minimal}\n[limits]\nuser_daily_usd = 0.30\n[tools.web_search]\nenabled = false\n[tools.web_fetch]\nenabled = false`,
			env,
		);
		expect(estimateCall(small.config, small.prices)).toBe(24_000);
	});

	it("rejects an override of a built-in model that drops its long-context prices", () => {
		const base = `${minimal}\n[prices."claude-haiku-5-5"]\ninput = 0.1\noutput = 0.5\ncache_write_5m = 0.125\ncache_write_1h = 0.2\ncache_read = 0.01`;
		expect(errorOf(() => parseConfig(base, env))).toMatch(/^prices\."claude-haiku-5-5": .*long_context/m);
		const full = parseConfig(
			`${base}\n[prices."claude-haiku-5-5".long_context]\nthreshold = 100000\ninput = 0.5\noutput = 2.5\ncache_write_5m = 0.625\ncache_write_1h = 1.0\ncache_read = 0.05`,
			env,
		);
		expect(estimateCall(full.config, full.prices)).toBe(400_000);
	});

	it("rejects an api_url with a query or fragment", () => {
		expect(errorOf(() => parseConfig(`${minimal}\napi_url = "https://api.fluxer.app/v1?x=1"`, env))).toMatch(
			/^api_url: must not contain a query or fragment/m,
		);
		expect(errorOf(() => parseConfig(`${minimal}\napi_url = "https://api.fluxer.app/v1#frag"`, env))).toMatch(
			/^api_url: /m,
		);
		expect(parseConfig(`${minimal}\napi_url = "http://fluxer.local:8080/api"`, env).config.api_url).toBe(
			"http://fluxer.local:8080/api",
		);
	});

	it("has the pricing page's cache-read prices for Sonnet and Opus 5.5", () => {
		expect(DEFAULT_PRICES["claude-sonnet-5-5"]?.cache_read).toBe(0.1);
		expect(DEFAULT_PRICES["claude-opus-5-5"]?.cache_read).toBe(0.2);
	});

	it("reads secrets from files and never echoes them", () => {
		const files: Record<string, string> = {
			"/run/secrets/fluxer": "999.secretpart\n",
			"/run/secrets/key": "sk-file\n",
		};
		const read = (p: string) => {
			const v = files[p];
			if (v === undefined) throw Object.assign(new Error("nope"), { code: "ENOENT" });
			return v;
		};
		const loaded = parseConfig(
			minimal,
			{ FLUXER_BOT_TOKEN_FILE: "/run/secrets/fluxer", ANTHROPIC_API_KEY_FILE: "/run/secrets/key" },
			{ readFile: read },
		);
		expect(loaded.secrets).toEqual({ fluxerToken: "999.secretpart", anthropicApiKey: "sk-file" });

		const missing = errorOf(() => parseConfig(minimal, {}, { readFile: read }));
		expect(missing).toMatch(/FLUXER_BOT_TOKEN \(or FLUXER_BOT_TOKEN_FILE\) is not set/);
		expect(missing).toMatch(/ANTHROPIC_API_KEY/);
		const both = errorOf(() => parseConfig(minimal, { ...env, ANTHROPIC_API_KEY_FILE: "/x" }, { readFile: read }));
		expect(both).toMatch(/both set/);
		const bad = errorOf(() => parseConfig(minimal, { ...env, FLUXER_BOT_TOKEN: "not-a-token-secretvalue" }));
		expect(bad).toMatch(/doesn't look like/);
		expect(bad).not.toMatch(/secretvalue/);
	});

	it("loads a custom system prompt relative to the config directory", () => {
		const read = (p: string) => {
			if (p === "/etc/clanker/prompt.md") return "Be brief.\n";
			throw Object.assign(new Error("nope"), { code: "ENOENT" });
		};
		const loaded = parseConfig(`${minimal}\n[model]\nsystem_prompt_file = "prompt.md"`, env, {
			readFile: read,
			configDir: "/etc/clanker",
		});
		expect(loaded.basePrompt).toBe("Be brief.");
		expect(loaded.systemPrompt).toBe(composeSystemPrompt("Be brief.", DEFAULT_PERSONALITY));
		expect(
			errorOf(() => parseConfig(`${minimal}\n[model]\nsystem_prompt_file = "x.md"`, env, { readFile: read })),
		).toMatch(/can't be read: ENOENT/);
	});

	it("fingerprint changes with prefix-relevant settings only", () => {
		const a = parseConfig(minimal, env).fingerprint;
		expect(parseConfig(`${minimal}\n[limits]\nuser_daily_usd = 1`, env).fingerprint).toBe(a);
		expect(parseConfig(`${minimal}\n[model]\neffort = "low"`, env).fingerprint).not.toBe(a);
		expect(parseConfig(`${minimal}\n[tools.web_search]\nmax_uses = 2`, env).fingerprint).not.toBe(a);
	});

	it("reports invalid TOML", () => {
		expect(errorOf(() => parseConfig("owner_id = ", env))).toMatch(/isn't valid TOML/);
	});

	it("uses the configured personality, and applyPersonality swaps it and the fingerprint", () => {
		const custom = parseConfig(`${minimal}\n[model]\npersonality = "Be terse."`, env);
		expect(custom.personality).toBe("Be terse.");
		expect(custom.systemPrompt.endsWith("## Personality and style\n\nBe terse.")).toBe(true);
		const loaded = parseConfig(minimal, env);
		const before = loaded.fingerprint;
		applyPersonality(loaded, "Talk like a pirate.");
		expect(loaded.systemPrompt.endsWith("Talk like a pirate.")).toBe(true);
		expect(loaded.fingerprint).not.toBe(before);
		applyPersonality(loaded, null);
		expect(loaded.personality).toBe(DEFAULT_PERSONALITY);
		expect(loaded.fingerprint).toBe(before);
	});
});
