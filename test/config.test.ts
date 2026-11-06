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
import { composeSystemPrompt, DEFAULT_PERSONALITY, DEFAULT_SYSTEM_PROMPT, toolLimitsSection } from "../src/prompt.js";

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
		expect(systemPrompt).toBe(
			composeSystemPrompt(DEFAULT_SYSTEM_PROMPT, DEFAULT_PERSONALITY, { searches: 3, fetches: 3 }),
		);
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
		expect(config.guilds).toEqual({
			"100": { everyone: false, roles: ["200"], channels: [] },
			"101": { everyone: false, roles: [], channels: [] },
		});
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
		expect(loaded.systemPrompt).toBe(
			composeSystemPrompt("Be brief.", DEFAULT_PERSONALITY, { searches: 3, fetches: 3 }),
		);
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

describe("pro tier config", () => {
	const PRO = `${minimal}\n[pro]\nenabled = true\n[limits]\nmonthly_usd = 150`;

	it("is off by default", () => {
		const loaded = parseConfig(minimal, env);
		expect(loaded.pro).toBeNull();
		expect(loaded.name).toBe("standard");
	});

	it("defaults to Sonnet 5.5 on high with 10 searches, 5 fetches and 200k requests", () => {
		const loaded = parseConfig(PRO, env);
		const pro = loaded.pro!;
		expect(pro.name).toBe("pro");
		expect(pro.config.model).toMatchObject({ name: "claude-sonnet-5-5", effort: "high", max_tokens: 16_000 });
		expect(pro.config.tools.web_search.max_uses).toBe(10);
		expect(pro.config.tools.web_fetch.max_uses).toBe(5);
		expect(pro.config.context).toMatchObject({ max_chain_tokens: 100_000, max_request_tokens: 200_000 });
		expect(pro.prices).toBe(DEFAULT_PRICES["claude-sonnet-5-5"]);
		// The standard tier is unchanged.
		expect(loaded.config.model.name).toBe("claude-haiku-5-5");
		expect(loaded.config.tools.web_search.max_uses).toBe(3);
	});

	it("tells each tier's model its own web budget", () => {
		const loaded = parseConfig(PRO, env);
		expect(loaded.systemPrompt).toContain("run up to 3 web searches and fetch up to 3 pages");
		expect(loaded.pro!.systemPrompt).toContain("run up to 10 web searches and fetch up to 5 pages");
		expect(loaded.pro!.fingerprint).not.toBe(loaded.fingerprint);
	});

	it("applies a personality change to both tiers", () => {
		const loaded = parseConfig(PRO, env);
		const before = loaded.pro!.fingerprint;
		applyPersonality(loaded, "Talk like a pirate.");
		expect(loaded.systemPrompt.endsWith("Talk like a pirate.")).toBe(true);
		expect(loaded.pro!.systemPrompt.endsWith("Talk like a pirate.")).toBe(true);
		expect(loaded.pro!.fingerprint).not.toBe(before);
	});

	it("checks the pro context budget", () => {
		const text = PRO.replace("enabled = true", "enabled = true\nmax_chain_tokens = 150000");
		expect(errorOf(() => parseConfig(text, env))).toMatch(
			/pro: the worst-case pro request .* over pro.max_request_tokens/,
		);
	});

	it("checks the pro caps against the pro reservation", () => {
		const text = PRO.replace("enabled = true", "enabled = true\nuser_daily_usd = 5");
		expect(errorOf(() => parseConfig(text, env))).toMatch(/pro.user_daily_usd \(US\$5\.00\) is below/);
		const low = PRO.replace("monthly_usd = 150", "monthly_usd = 6");
		expect(errorOf(() => parseConfig(low, env))).toMatch(/limits.monthly_usd \(for the pro tier\)/);
	});

	it("needs prices for the pro model", () => {
		const text = PRO.replace("enabled = true", 'enabled = true\nmodel = "claude-new"');
		expect(errorOf(() => parseConfig(text, env))).toMatch(/pro.model: no prices known for "claude-new"/);
	});

	it("skips the pro checks while [pro] is off", () => {
		expect(() => parseConfig(`${minimal}\n[pro]\nuser_daily_usd = 1`, env)).not.toThrow();
	});
});

describe("toolLimitsSection", () => {
	it("names only the tools that are on, in the right number", () => {
		expect(toolLimitsSection({ searches: 1, fetches: null })).toContain("run up to 1 web search.");
		expect(toolLimitsSection({ searches: null, fetches: 1 })).toContain("fetch up to 1 page.");
		expect(toolLimitsSection({ searches: null, fetches: null })).toBe("");
		expect(composeSystemPrompt("Base.", "Be nice.", { searches: null, fetches: null })).toBe(
			"Base.\n\n## Personality and style\n\nBe nice.",
		);
	});
});
