// SPDX-License-Identifier: AGPL-3.0-or-later
// Container health check. The bot touches a heartbeat file while its gateway session is live;
// this script reports healthy while that file is recent. It runs as its own short-lived process
// (image HEALTHCHECK or Quadlet HealthCmd), so it imports nothing but node: builtins.
//
// Environment:
//   CLANKER_HEARTBEAT_FILE     path of the heartbeat file (default /data/heartbeat)
//   CLANKER_HEARTBEAT_MAX_AGE  maximum age in seconds (default 120)
// Exit code 0 = healthy, 1 = unhealthy. Prints one line either way.

import { realpathSync, type Stats, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_HEARTBEAT_FILE = "/data/heartbeat";
export const DEFAULT_MAX_AGE_SECONDS = 120;

export interface HealthResult {
	healthy: boolean;
	message: string;
}

/** Checks that the file at `path` was modified less than `maxAgeMs` before `now` (ms since epoch). */
export function checkHeartbeat(path: string, maxAgeMs: number, now: number): HealthResult {
	let stats: Stats;
	try {
		stats = statSync(path);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { healthy: false, message: `unhealthy: no heartbeat file at ${path}` };
		return { healthy: false, message: `unhealthy: can't read ${path} (${code ?? "error"})` };
	}
	if (!stats.isFile()) return { healthy: false, message: `unhealthy: ${path} is not a file` };

	const ageMs = now - stats.mtimeMs;
	if (ageMs < 0) {
		// The clock moved back since the last touch. A live bot rewrites the time within one heartbeat,
		// so a time far in the future means it has stopped; don't count that as fresh forever.
		if (-ageMs < maxAgeMs) return { healthy: true, message: "healthy: heartbeat 0 s old" };
		return { healthy: false, message: `unhealthy: heartbeat is ${seconds(-ageMs)} in the future (clock changed?)` };
	}
	if (ageMs < maxAgeMs) return { healthy: true, message: `healthy: heartbeat ${seconds(ageMs)} old` };
	return { healthy: false, message: `unhealthy: heartbeat ${seconds(ageMs)} old (max ${maxAgeMs / 1000} s)` };
}

function seconds(ms: number): string {
	return `${Math.round(ms / 1000)} s`;
}

export type HealthOptions = { ok: true; path: string; maxAgeMs: number } | { ok: false; message: string };

/** Reads the settings from the environment. Empty values count as unset. */
export function healthOptions(env: Record<string, string | undefined>): HealthOptions {
	const path = env.CLANKER_HEARTBEAT_FILE || DEFAULT_HEARTBEAT_FILE;
	const raw = env.CLANKER_HEARTBEAT_MAX_AGE?.trim();
	if (!raw) return { ok: true, path, maxAgeMs: DEFAULT_MAX_AGE_SECONDS * 1000 };

	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return {
			ok: false,
			message: `unhealthy: CLANKER_HEARTBEAT_MAX_AGE must be a positive number of seconds, got "${raw}"`,
		};
	}
	return { ok: true, path, maxAgeMs: seconds * 1000 };
}

/** Runs the check and prints its line. Returns the exit code. */
export function main(
	env: Record<string, string | undefined>,
	now: number,
	print: (line: string, healthy: boolean) => void,
): number {
	const opts = healthOptions(env);
	const result = opts.ok ? checkHeartbeat(opts.path, opts.maxAgeMs, now) : { healthy: false, message: opts.message };
	print(result.message, result.healthy);
	return result.healthy ? 0 : 1;
}

/** True when `entry` (process.argv[1]) is the file behind `moduleUrl` (import.meta.url), symlinks resolved. */
export function isEntryPoint(entry: string | undefined, moduleUrl: string): boolean {
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
	} catch {
		return false;
	}
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
	process.exitCode = main(process.env, Date.now(), (line, healthy) => {
		(healthy ? process.stdout : process.stderr).write(`${line}\n`);
	});
}
