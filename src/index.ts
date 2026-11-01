// SPDX-License-Identifier: AGPL-3.0-or-later
// Process entry point: load the config, wire everything up, keep the heartbeat, shut down cleanly.

import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Access } from "./access.js";
import { App } from "./app.js";
import { ClaudeRunner, createTransport } from "./claude.js";
import { ConfigError, type LoadedConfig, loadConfig } from "./config.js";
import { createFluxerClient } from "./fluxer.js";
import { Guards } from "./guards.js";
import { createLogger } from "./log.js";
import { NoticeIds, ReplayCache } from "./replay.js";
import { Spend } from "./spend.js";
import { Store } from "./store.js";
import { type Logger, systemClock } from "./types.js";

const EXIT_CONFIG = 78; // EX_CONFIG
const EXIT_FATAL = 70; // EX_SOFTWARE
const HEALTH_PING_MS = 5 * 60_000;
const SWEEP_MS = 60_000;
const DRAIN_MS = 15_000;

function version(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

function touch(path: string, log: Logger): void {
	try {
		const now = new Date();
		try {
			utimesSync(path, now, now);
		} catch {
			writeFileSync(path, "");
		}
	} catch (err) {
		log.warn("couldn't update the heartbeat file", { path, err });
	}
}

async function main(): Promise<void> {
	const configPath = process.env.CLANKER_CONFIG ?? "/config/clanker.toml";
	let loaded: LoadedConfig;
	try {
		loaded = await loadConfig(configPath);
	} catch (err) {
		if (err instanceof ConfigError) {
			process.stderr.write(`Clanker can't start: the configuration has problems.\n${err.message}\n`);
			process.exit(EXIT_CONFIG);
		}
		throw err;
	}
	const { config, secrets } = loaded;
	const log = createLogger({ level: config.log.level, base: { app: "clanker" } });
	const ver = version();
	log.info("starting", { version: ver, model: config.model.name, guilds: Object.keys(config.guilds).length });
	if (config.log.level === "debug") {
		log.warn("DEBUG LOGGING IS ON: message text and model output will be written to the logs");
	}

	mkdirSync(config.data_dir, { recursive: true });
	mkdirSync(dirname(loaded.heartbeatFile), { recursive: true });
	const store = Store.open(join(config.data_dir, "clanker.db"));
	const clock = systemClock;

	const fluxer = createFluxerClient({
		token: secrets.fluxerToken,
		apiUrl: config.api_url,
		gatewayUrl: config.gateway_url,
		log: log.child({ part: "fluxer" }),
		clock,
		presence: { status: config.presence.status, customStatus: config.presence.custom_status || null },
	});
	const runner = new ClaudeRunner({
		loaded,
		transport: createTransport(secrets.anthropicApiKey, { log: log.child({ part: "anthropic" }) }),
		log: log.child({ part: "claude" }),
	});
	const replay = new ReplayCache({
		ttlMs: config.cache.replay_ttl_seconds * 1000,
		maxBytes: config.cache.replay_max_mb * 1024 * 1024,
		clock,
	});
	const access = new Access({
		config,
		fetchMember: (g, u) => fluxer.fetchMember(g, u),
		parentChannel: (c) => fluxer.parentChannel(c),
		clock,
		log: log.child({ part: "access" }),
	});
	const app = new App({
		loaded,
		fluxer,
		runner,
		store,
		spend: new Spend({ config, prices: loaded.prices, store, clock, log: log.child({ part: "spend" }) }),
		replay,
		notices: new NoticeIds(),
		access,
		guards: new Guards({
			cooldownMs: config.limits.cooldown_seconds * 1000,
			maxConcurrent: config.limits.max_concurrent,
			maxQueue: config.limits.max_queue,
			clock,
		}),
		log,
		clock,
		version: ver,
		startedAt: clock.now(),
	});
	app.attach();

	// Health: the heartbeat file is touched only while the gateway session is live.
	fluxer.on("connection", (state) => {
		log.info("gateway", { state });
		if (state === "connected") touch(loaded.heartbeatFile, log);
	});
	fluxer.on("heartbeat", () => touch(loaded.heartbeatFile, log));

	const timers: Array<ReturnType<typeof setInterval>> = [];
	timers.push(
		setInterval(() => {
			replay.sweep();
			access.sweep();
		}, SWEEP_MS),
	);
	if (config.health.ping_url) {
		const url = config.health.ping_url;
		const ping = () => {
			if (fluxer.connectionState !== "connected") return;
			fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((err: unknown) =>
				log.warn("health ping failed", { err }),
			);
		};
		timers.push(setInterval(ping, HEALTH_PING_MS));
	}

	let stopping = false;
	const shutdown = async (code: number, why: string) => {
		if (stopping) return;
		stopping = true;
		log.info("shutting down", { why });
		for (const t of timers) clearInterval(t);
		const hardExit = setTimeout(() => process.exit(code), DRAIN_MS + 5_000);
		hardExit.unref();
		try {
			await app.drain(DRAIN_MS);
			await fluxer.destroy();
		} catch (err) {
			log.warn("error during shutdown", { err });
		}
		store.close();
		process.exit(code);
	};
	fluxer.on("fatal", (reason) => {
		log.error("fatal gateway error", { reason });
		// A rejected token won't fix itself: exit as a config error so the service manager stops retrying.
		void shutdown(/rejected the bot token/.test(reason) ? EXIT_CONFIG : EXIT_FATAL, reason);
	});
	process.on("SIGTERM", () => void shutdown(0, "SIGTERM"));
	process.on("SIGINT", () => void shutdown(0, "SIGINT"));
	process.on("unhandledRejection", (err) => log.error("unhandled rejection", { err }));

	try {
		await fluxer.connect();
	} catch (err) {
		log.error("couldn't connect to Fluxer", { err });
		await shutdown(EXIT_FATAL, "connect failed");
		return;
	}
	log.info("connected", { bot: fluxer.botUser?.id });
}

main().catch((err: unknown) => {
	process.stderr.write(`Clanker crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	process.exit(EXIT_FATAL);
});
