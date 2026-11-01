// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkHeartbeat,
	DEFAULT_HEARTBEAT_FILE,
	DEFAULT_MAX_AGE_SECONDS,
	healthOptions,
	isEntryPoint,
	main,
} from "../src/healthcheck.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const SCRIPT = fileURLToPath(new URL("../src/healthcheck.ts", import.meta.url));

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "clanker-health-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Creates a heartbeat file whose modification time is `ageMs` before NOW. */
function heartbeat(ageMs: number, name = "heartbeat"): string {
	const path = join(dir, name);
	writeFileSync(path, "");
	const mtime = (NOW - ageMs) / 1000;
	utimesSync(path, mtime, mtime);
	return path;
}

describe("checkHeartbeat", () => {
	it("is healthy when the file is younger than the limit", () => {
		const r = checkHeartbeat(heartbeat(30_000), 120_000, NOW);
		expect(r).toEqual({ healthy: true, message: "healthy: heartbeat 30 s old" });
	});

	// Whole seconds, so the boundary holds on file systems with coarse timestamps too.
	it("is healthy just under the limit and unhealthy at the limit", () => {
		expect(checkHeartbeat(heartbeat(119_000, "a"), 120_000, NOW).healthy).toBe(true);
		expect(checkHeartbeat(heartbeat(120_000, "b"), 120_000, NOW).healthy).toBe(false);
	});

	it("is unhealthy when the file is stale and says how old it is", () => {
		const r = checkHeartbeat(heartbeat(300_000), 120_000, NOW);
		expect(r).toEqual({ healthy: false, message: "unhealthy: heartbeat 300 s old (max 120 s)" });
	});

	it("counts a modification time slightly in the future as fresh", () => {
		const r = checkHeartbeat(heartbeat(-60_000), 120_000, NOW);
		expect(r).toEqual({ healthy: true, message: "healthy: heartbeat 0 s old" });
	});

	// After the clock moves back, a stalled bot never rewrites the time; that must not stay healthy.
	it("is unhealthy when the modification time is at least the limit in the future", () => {
		expect(checkHeartbeat(heartbeat(-120_000, "a"), 120_000, NOW)).toEqual({
			healthy: false,
			message: "unhealthy: heartbeat is 120 s in the future (clock changed?)",
		});
		expect(checkHeartbeat(heartbeat(-3_600_000, "b"), 120_000, NOW).healthy).toBe(false);
	});

	it("is unhealthy when the file is missing", () => {
		const path = join(dir, "missing");
		expect(checkHeartbeat(path, 120_000, NOW)).toEqual({
			healthy: false,
			message: `unhealthy: no heartbeat file at ${path}`,
		});
	});

	it("is unhealthy when the path is a directory", () => {
		const path = join(dir, "sub");
		mkdirSync(path);
		expect(checkHeartbeat(path, 120_000, NOW)).toEqual({
			healthy: false,
			message: `unhealthy: ${path} is not a file`,
		});
	});

	it("reports other stat errors by code", () => {
		const file = heartbeat(0, "file");
		const path = join(file, "below-a-file");
		expect(checkHeartbeat(path, 120_000, NOW)).toEqual({
			healthy: false,
			message: `unhealthy: can't read ${path} (ENOTDIR)`,
		});
	});

	it("follows a symlink to the heartbeat file", () => {
		const target = heartbeat(10_000);
		const link = join(dir, "link");
		symlinkSync(target, link);
		expect(checkHeartbeat(link, 120_000, NOW).healthy).toBe(true);
	});
});

describe("healthOptions", () => {
	it("uses the defaults when nothing is set", () => {
		expect(healthOptions({})).toEqual({
			ok: true,
			path: DEFAULT_HEARTBEAT_FILE,
			maxAgeMs: DEFAULT_MAX_AGE_SECONDS * 1000,
		});
		expect(DEFAULT_HEARTBEAT_FILE).toBe("/data/heartbeat");
		expect(DEFAULT_MAX_AGE_SECONDS).toBe(120);
	});

	it("treats empty values as unset", () => {
		expect(healthOptions({ CLANKER_HEARTBEAT_FILE: "", CLANKER_HEARTBEAT_MAX_AGE: "  " })).toEqual({
			ok: true,
			path: "/data/heartbeat",
			maxAgeMs: 120_000,
		});
	});

	it("reads the path and the age in seconds, fractions and padding allowed", () => {
		expect(healthOptions({ CLANKER_HEARTBEAT_FILE: "/tmp/hb", CLANKER_HEARTBEAT_MAX_AGE: " 90 " })).toEqual({
			ok: true,
			path: "/tmp/hb",
			maxAgeMs: 90_000,
		});
		expect(healthOptions({ CLANKER_HEARTBEAT_MAX_AGE: "1.5" })).toMatchObject({ ok: true, maxAgeMs: 1500 });
	});

	it.each(["0", "-5", "abc", "Infinity", "NaN", "12s"])("rejects a max age of %j", (value) => {
		const r = healthOptions({ CLANKER_HEARTBEAT_MAX_AGE: value });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain(`got "${value}"`);
	});
});

describe("main", () => {
	function run(env: Record<string, string | undefined>) {
		const lines: Array<{ line: string; healthy: boolean }> = [];
		const code = main(env, NOW, (line, healthy) => lines.push({ line, healthy }));
		return { code, lines };
	}

	it("exits 0 and prints one line when healthy", () => {
		const { code, lines } = run({ CLANKER_HEARTBEAT_FILE: heartbeat(5_000) });
		expect(code).toBe(0);
		expect(lines).toEqual([{ line: "healthy: heartbeat 5 s old", healthy: true }]);
	});

	it("exits 1 when the heartbeat is older than CLANKER_HEARTBEAT_MAX_AGE", () => {
		const { code, lines } = run({ CLANKER_HEARTBEAT_FILE: heartbeat(45_000), CLANKER_HEARTBEAT_MAX_AGE: "30" });
		expect(code).toBe(1);
		expect(lines).toEqual([{ line: "unhealthy: heartbeat 45 s old (max 30 s)", healthy: false }]);
	});

	it("exits 1 without touching the file system when the max age is invalid", () => {
		const { code, lines } = run({ CLANKER_HEARTBEAT_FILE: heartbeat(0), CLANKER_HEARTBEAT_MAX_AGE: "soon" });
		expect(code).toBe(1);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.line).toMatch(/^unhealthy: CLANKER_HEARTBEAT_MAX_AGE/);
	});
});

describe("isEntryPoint", () => {
	it("matches the module's own path", () => {
		const file = heartbeat(0, "script.js");
		expect(isEntryPoint(file, pathToFileURL(file).href)).toBe(true);
	});

	it("matches through a symlinked entry path", () => {
		const file = heartbeat(0, "script.js");
		const link = join(dir, "link.js");
		symlinkSync(file, link);
		expect(isEntryPoint(link, pathToFileURL(file).href)).toBe(true);
	});

	it("does not match another file, a missing entry or a missing path", () => {
		const file = heartbeat(0, "script.js");
		const other = heartbeat(0, "other.js");
		expect(isEntryPoint(other, pathToFileURL(file).href)).toBe(false);
		expect(isEntryPoint(undefined, pathToFileURL(file).href)).toBe(false);
		expect(isEntryPoint(join(dir, "gone.js"), pathToFileURL(file).href)).toBe(false);
	});

	it("is false while the module is imported by the test runner", () => {
		expect(isEntryPoint(process.argv[1], pathToFileURL(SCRIPT).href)).toBe(false);
	});
});

// The script must run on its own, even next to a broken or partial node_modules.
it("imports nothing but node: builtins", () => {
	const source = readFileSync(SCRIPT, "utf8");
	const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
	expect(specifiers.length).toBeGreaterThan(0);
	for (const s of specifiers) expect(s).toMatch(/^node:/);
});

// Runs the script the way the container does: as its own process.
describe("as a script", () => {
	function exec(env: Record<string, string>) {
		const { CLANKER_HEARTBEAT_FILE: _f, CLANKER_HEARTBEAT_MAX_AGE: _a, ...base } = process.env;
		return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", SCRIPT], {
			env: { ...base, ...env },
			encoding: "utf8",
			timeout: 20_000,
		});
	}

	it("exits 0 with a fresh heartbeat", () => {
		const path = join(dir, "heartbeat");
		writeFileSync(path, "");
		const r = exec({ CLANKER_HEARTBEAT_FILE: path });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^healthy: heartbeat \d+ s old\n$/);
		expect(r.stderr).toBe("");
	});

	it("exits 1 with a missing heartbeat and prints to stderr", () => {
		const path = join(dir, "missing");
		const r = exec({ CLANKER_HEARTBEAT_FILE: path });
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe(`unhealthy: no heartbeat file at ${path}\n`);
	});
});
