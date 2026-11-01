// SPDX-License-Identifier: AGPL-3.0-or-later
// Configuration: one TOML file, validated strictly at startup, plus two secrets from the environment.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { formatUsd, tokenCost, usd } from "./money.js";
import { composeSystemPrompt, DEFAULT_PERSONALITY, DEFAULT_SYSTEM_PROMPT, MAX_PERSONALITY_CHARS } from "./prompt.js";
import { isValidTimeZone } from "./time.js";
import type { Micros } from "./types.js";

export class ConfigError extends Error {
	override name = "ConfigError";
}

/** Prices in USD per million tokens. */
export interface ModelPrices {
	input: number;
	output: number;
	cache_write_5m: number;
	cache_write_1h: number;
	cache_read: number;
	/** Higher rates that apply to the whole request when its prompt is longer than `threshold` tokens. */
	long_context?: {
		threshold: number;
		input: number;
		output: number;
		cache_write_5m: number;
		cache_write_1h: number;
		cache_read: number;
	};
}

/**
 * Built-in prices (checked 2026-11-01). Operators can add models under [prices]; an entry there for a
 * built-in model replaces it completely (long_context included).
 */
export const DEFAULT_PRICES: Record<string, ModelPrices> = {
	"claude-haiku-5-5": {
		input: 0.1,
		output: 0.5,
		cache_write_5m: 0.125,
		cache_write_1h: 0.2,
		cache_read: 0.01,
		long_context: {
			threshold: 100_000,
			input: 0.5,
			output: 2.5,
			cache_write_5m: 0.625,
			cache_write_1h: 1.0,
			cache_read: 0.05,
		},
	},
	// Cache reads on Sonnet 5.5 and Opus 5.5 are 0.05x input (the pricing page; older notes say $0.20 for Sonnet).
	"claude-sonnet-5-5": { input: 2, output: 10, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.1 },
	"claude-opus-5-5": { input: 4, output: 20, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2 },
};

export const WEB_SEARCH_USD_PER_REQUEST = 0.01;
/** System prompt plus tool definitions, estimated. */
export const SYSTEM_OVERHEAD_TOKENS = 3000;
/** Results of one web search, estimated. */
export const SEARCH_RESULT_TOKENS = 4000;

// ---------------------------------------------------------------- schema

const id = z.string().regex(/^\d{1,20}$/, "must be a Fluxer ID (a string of digits)");
const idList = z.array(id).prefault([]);
const domainList = z.array(z.string().min(1).max(253)).max(100).prefault([]);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const money = z.number().min(0).max(1_000_000);

const pricesSchema = z.strictObject({
	input: z.number().min(0),
	output: z.number().min(0),
	cache_write_5m: z.number().min(0),
	cache_write_1h: z.number().min(0),
	cache_read: z.number().min(0),
	long_context: z
		.strictObject({
			threshold: z.number().int().positive(),
			input: z.number().min(0),
			output: z.number().min(0),
			cache_write_5m: z.number().min(0),
			cache_write_1h: z.number().min(0),
			cache_read: z.number().min(0),
		})
		.optional(),
});

export const ConfigSchema = z.strictObject({
	owner_id: id,
	api_url: z
		.url({ protocol: /^https?$/ })
		.refine((u) => !u.includes("?") && !u.includes("#"), "must not contain a query or fragment")
		.prefault("https://api.fluxer.app/v1"),
	gateway_url: z
		.url({ protocol: /^wss?$/ })
		.refine((u) => !u.includes("?") && !u.includes("#"), "must not contain a query or fragment")
		.optional(),
	timezone: z
		.string()
		.refine(isValidTimeZone, "must be an IANA time zone such as UTC or America/Vancouver")
		.prefault("UTC"),
	data_dir: z.string().min(1).prefault("/data"),
	source_url: z.url().prefault("https://github.com/Linus-Sexy-Tips/clanker"),

	access: z
		.strictObject({
			users: idList,
			blocked_users: idList,
			guilds_leave_unlisted: z.boolean().prefault(true),
		})
		.prefault({}),

	guilds: z
		.record(
			id,
			z
				.strictObject({
					roles: idList,
					channels: idList,
				})
				.prefault({}),
		)
		.prefault({}),

	dms: z.strictObject({ enabled: z.boolean().prefault(true), groups: z.boolean().prefault(true) }).prefault({}),

	model: z
		.strictObject({
			name: z.string().min(1).prefault("claude-haiku-5-5"),
			effort: z.enum(["low", "medium", "high", "xhigh", "max"]).prefault("medium"),
			max_tokens: int(1024, 128_000).prefault(8000),
			system_prompt_file: z.string().prefault(""),
			personality: z.string().max(MAX_PERSONALITY_CHARS).prefault(""),
		})
		.prefault({}),

	tools: z
		.strictObject({
			web_search: z
				.strictObject({
					enabled: z.boolean().prefault(true),
					max_uses: int(1, 10).prefault(3),
					allowed_domains: domainList,
					blocked_domains: domainList,
					user_location: z
						.strictObject({
							city: z.string().min(1).max(255).optional(),
							region: z.string().min(1).max(255).optional(),
							country: z
								.string()
								.regex(/^[A-Z]{2}$/, "must be a two-letter country code")
								.optional(),
							timezone: z.string().refine(isValidTimeZone, "must be an IANA time zone").optional(),
						})
						.optional(),
				})
				.prefault({}),
			web_fetch: z
				.strictObject({
					enabled: z.boolean().prefault(true),
					max_uses: int(1, 10).prefault(3),
					max_content_tokens: int(1000, 100_000).prefault(10_000),
					allowed_domains: domainList,
					blocked_domains: domainList,
					citations: z.boolean().prefault(true),
				})
				.prefault({}),
		})
		.prefault({}),

	context: z
		.strictObject({
			max_messages: int(1, 200).prefault(50),
			max_chain_tokens: int(1000, 900_000).prefault(50_000),
			max_request_tokens: int(10_000, 1_000_000).prefault(100_000),
			max_images: int(0, 20).prefault(4),
		})
		.prefault({}),

	cache: z
		.strictObject({
			system_ttl: z.enum(["5m", "1h"]).prefault("1h"),
			replay_ttl_seconds: int(0, 86_400).prefault(300),
			replay_max_mb: int(1, 4096).prefault(64),
		})
		.prefault({}),

	limits: z
		.strictObject({
			user_daily_usd: money.prefault(5),
			monthly_usd: money.prefault(100),
			notice: z.enum(["reply", "dm"]).prefault("reply"),
			cooldown_seconds: int(0, 3600).prefault(5),
			max_concurrent: int(1, 64).prefault(4),
			max_queue: int(0, 256).prefault(8),
			overrides: z
				.array(
					z
						.strictObject({
							user: id.optional(),
							role: id.optional(),
							user_daily_usd: money,
						})
						.refine((o) => (o.user === undefined) !== (o.role === undefined), "set exactly one of user or role"),
				)
				.prefault([]),
		})
		.prefault({}),

	prices: z.record(z.string().min(1), pricesSchema).prefault({}),

	presence: z
		.strictObject({
			status: z.enum(["online", "idle", "dnd", "invisible"]).prefault("online"),
			custom_status: z.string().max(128).prefault("@mention me to ask"),
		})
		.prefault({}),

	log: z.strictObject({ level: z.enum(["debug", "info", "warn", "error"]).prefault("info") }).prefault({}),

	health: z
		.strictObject({
			ping_url: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]).prefault(""),
			heartbeat_file: z.string().prefault(""),
		})
		.prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface Secrets {
	fluxerToken: string;
	anthropicApiKey: string;
}

export interface LoadedConfig {
	config: Config;
	secrets: Secrets;
	/** The system prompt without the personality section (built-in, or model.system_prompt_file). */
	basePrompt: string;
	/** Personality from the config (model.personality), or the built-in one. */
	defaultPersonality: string;
	/** Personality in use: the default, or one set with the `personality` command. Change it with applyPersonality. */
	personality: string;
	/** basePrompt plus the personality section, as sent to Claude. */
	systemPrompt: string;
	prices: ModelPrices;
	/** Hash of everything that changes the request prefix. Replay entries only match the same fingerprint. */
	fingerprint: string;
	/** Absolute path of the heartbeat file. */
	heartbeatFile: string;
}

// ---------------------------------------------------------------- budget

/** Worst-case prompt size of one request, by part. */
export function contextBudget(config: Config): { total: number; parts: Record<string, number> } {
	const parts: Record<string, number> = {
		system_and_tools: SYSTEM_OVERHEAD_TOKENS,
		reply_chain: config.context.max_chain_tokens,
	};
	const { web_search: search, web_fetch: fetch } = config.tools;
	if (fetch.enabled) parts.web_fetch = fetch.max_uses * fetch.max_content_tokens;
	if (search.enabled) parts.web_search = search.max_uses * SEARCH_RESULT_TOKENS;
	const total = Object.values(parts).reduce((a, b) => a + b, 0);
	return { total, parts };
}

// ---------------------------------------------------------------- worst-case cost

export type Rates = Omit<ModelPrices, "long_context">;

/** The rates that apply to a call whose prompt (summed over its iterations) is `prompt` tokens. */
export function ratesFor(prices: ModelPrices, prompt: number): Rates {
	const long = prices.long_context;
	return long && prompt > long.threshold ? long : prices;
}

/**
 * Worst-case cost of one API call, from the context budget. Every server tool iteration
 * re-reads a full-size prompt at the uncached rate, the output is max_tokens, and every
 * allowed search happens. Usage of a server tool loop is summed over its iterations, and
 * we assume the long-context threshold applies to that sum (unconfirmed; the safe reading).
 * It is never less than one full-size prompt written to the cache at the dearest write rate,
 * which is what a cold call costs when both tools are off.
 */
export function estimateCall(config: Config, prices: ModelPrices): Micros {
	const { web_search: search, web_fetch: fetch } = config.tools;
	const searches = search.enabled ? search.max_uses : 0;
	const fetches = fetch.enabled ? fetch.max_uses : 0;
	const summedPrompt = config.context.max_request_tokens * (1 + searches + fetches);
	const rates = ratesFor(prices, summedPrompt);
	// A cold first step writes its whole prompt to the cache (1.25x for 5m, 2x for 1h). With both tools off
	// there is only one step, so the uncached-rate sum alone would be below a cold call's cost.
	const writeRate = Math.max(rates.input, rates.cache_write_5m, rates.cache_write_1h);
	const prompt = Math.max(
		tokenCost(summedPrompt, rates.input),
		tokenCost(config.context.max_request_tokens, writeRate),
	);
	const total = prompt + tokenCost(config.model.max_tokens, rates.output) + searches * usd(WEB_SEARCH_USD_PER_REQUEST);
	return Math.ceil(total);
}

/** Caps above zero that are smaller than one call's reservation: no request could ever start under them. */
function capProblems(config: Config, prices: ModelPrices): string[] {
	const perCall = estimateCall(config, prices);
	const atLeast = formatUsd(Math.ceil(perCall / 10_000) * 10_000);
	const caps: Array<[string, number]> = [
		["limits.user_daily_usd", config.limits.user_daily_usd],
		["limits.monthly_usd", config.limits.monthly_usd],
		...config.limits.overrides.map((o, i): [string, number] => [
			`limits.overrides.${i}.user_daily_usd`,
			o.user_daily_usd,
		]),
	];
	return caps
		.filter(([, amount]) => amount > 0 && usd(amount) < perCall)
		.map(
			([key, amount]) =>
				`${key} (${formatUsd(usd(amount))}) is below the worst-case cost reserved for one request (${formatUsd(perCall)} with this model and config), so no request could ever start under it. Raise it to at least ${atLeast}, set it to 0 to block, or shrink the reservation with model.max_tokens, context.max_request_tokens or the web tools' max_uses.`,
		);
}

// ---------------------------------------------------------------- loading

type Env = Record<string, string | undefined>;

function secret(env: Env, name: string, read: (path: string) => string, problems: string[]): string {
	const direct = env[name];
	const file = env[`${name}_FILE`];
	if (direct && file) {
		problems.push(`${name} and ${name}_FILE are both set; set only one`);
		return "";
	}
	if (file) {
		try {
			const value = read(file).trim();
			if (!value) problems.push(`${name}_FILE (${file}) is empty`);
			return value;
		} catch (err) {
			problems.push(`${name}_FILE (${file}) can't be read: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
			return "";
		}
	}
	if (direct?.trim()) return direct.trim();
	problems.push(`${name} (or ${name}_FILE) is not set`);
	return "";
}

function formatIssues(error: z.ZodError): string[] {
	return error.issues.map((issue) => {
		const path = issue.path.map(String).join(".");
		return path ? `${path}: ${issue.message}` : issue.message;
	});
}

export interface ParseOptions {
	/** Reads secret files and the system prompt file. */
	readFile?: (path: string) => string;
	/** Directory that relative paths in the config are resolved against. */
	configDir?: string;
}

/**
 * Parses and validates a config. Throws ConfigError listing the problems found: schema and secret
 * problems first; the cross-field checks run only once the schema passes.
 */
export function parseConfig(tomlText: string, env: Env, opts: ParseOptions = {}): LoadedConfig {
	const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
	const configDir = opts.configDir ?? process.cwd();

	let raw: unknown;
	try {
		raw = parseToml(tomlText);
	} catch (err) {
		throw new ConfigError(`The config file isn't valid TOML: ${(err as Error).message}`);
	}

	const parsed = ConfigSchema.safeParse(raw);
	const problems: string[] = parsed.success ? [] : formatIssues(parsed.error);

	const secrets: Secrets = {
		fluxerToken: secret(env, "FLUXER_BOT_TOKEN", read, problems),
		anthropicApiKey: secret(env, "ANTHROPIC_API_KEY", read, problems),
	};
	if (secrets.fluxerToken && !/^\d+\.\S+$/.test(secrets.fluxerToken.replace(/^Bot\s+/i, ""))) {
		problems.push("FLUXER_BOT_TOKEN doesn't look like a Fluxer bot token (<application id>.<secret>)");
	}

	if (!parsed.success) {
		problems.push("(More checks run once these are fixed.)");
		throw new ConfigError(problems.join("\n"));
	}
	const config = parsed.data;

	// Cross-field checks.
	const budget = contextBudget(config);
	if (budget.total > config.context.max_request_tokens) {
		const detail = Object.entries(budget.parts)
			.map(([k, v]) => `${k} ${v}`)
			.join(" + ");
		problems.push(
			`context: the worst-case request (${detail} = ${budget.total} tokens) is over context.max_request_tokens (${config.context.max_request_tokens}). Lower max_chain_tokens, max_uses or max_content_tokens.`,
		);
	}
	if (config.access.blocked_users.includes(config.owner_id)) {
		problems.push("access.blocked_users: the owner can't be blocked");
	}
	const prices = config.prices[config.model.name] ?? DEFAULT_PRICES[config.model.name];
	if (!prices) {
		problems.push(
			`model.name: no prices known for "${config.model.name}"; add them under [prices."${config.model.name}"]`,
		);
	} else {
		const builtIn = DEFAULT_PRICES[config.model.name];
		if (config.prices[config.model.name] && builtIn?.long_context && !prices.long_context) {
			problems.push(
				`prices."${config.model.name}": this replaces the built-in prices, which charge more above ${builtIn.long_context.threshold} prompt tokens; add [prices."${config.model.name}".long_context] (threshold, input, output, cache_write_5m, cache_write_1h, cache_read), or the caps would undercount long requests`,
			);
		}
		problems.push(...capProblems(config, prices));
	}
	for (const [name, t] of [
		["tools.web_search", config.tools.web_search],
		["tools.web_fetch", config.tools.web_fetch],
	] as const) {
		if (t.allowed_domains.length > 0 && t.blocked_domains.length > 0) {
			problems.push(`${name}: set allowed_domains or blocked_domains, not both`);
		}
	}
	let basePrompt = DEFAULT_SYSTEM_PROMPT;
	if (config.model.system_prompt_file) {
		const path = isAbsolute(config.model.system_prompt_file)
			? config.model.system_prompt_file
			: resolve(configDir, config.model.system_prompt_file);
		try {
			basePrompt = read(path).trim();
			if (!basePrompt) problems.push(`model.system_prompt_file (${path}) is empty`);
		} catch (err) {
			problems.push(
				`model.system_prompt_file (${path}) can't be read: ${(err as NodeJS.ErrnoException).code ?? "error"}`,
			);
		}
	}

	if (problems.length > 0) throw new ConfigError(problems.join("\n"));

	const heartbeatFile = config.health.heartbeat_file
		? resolve(configDir, config.health.heartbeat_file)
		: resolve(config.data_dir, "heartbeat");

	const defaultPersonality = config.model.personality.trim() || DEFAULT_PERSONALITY;
	const loaded: LoadedConfig = {
		config,
		secrets,
		basePrompt,
		defaultPersonality,
		personality: defaultPersonality,
		systemPrompt: "",
		prices: prices as ModelPrices,
		fingerprint: "",
		heartbeatFile,
	};
	applyPersonality(loaded, null);
	return loaded;
}

/**
 * Sets the personality in use (null = the default) and recomputes the system prompt and fingerprint.
 * Changing it starts fresh prompt caches and drops exact replay of earlier turns.
 */
export function applyPersonality(loaded: LoadedConfig, personality: string | null): void {
	loaded.personality = personality?.trim() || loaded.defaultPersonality;
	loaded.systemPrompt = composeSystemPrompt(loaded.basePrompt, loaded.personality);
	loaded.fingerprint = fingerprintOf(loaded.config, loaded.systemPrompt);
}

/** Everything that changes the bytes at the start of a request, hashed. */
function fingerprintOf(config: Config, systemPrompt: string): string {
	const relevant = {
		model: config.model.name,
		effort: config.model.effort,
		max_tokens: config.model.max_tokens,
		tools: config.tools,
		system_ttl: config.cache.system_ttl,
		systemPrompt,
	};
	return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

/** Reads and validates the config file at `path`. */
export async function loadConfig(path: string, env: Env = process.env): Promise<LoadedConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		throw new ConfigError(`Can't read the config file ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
	}
	return parseConfig(text, env, { configDir: dirname(resolve(path)) });
}
