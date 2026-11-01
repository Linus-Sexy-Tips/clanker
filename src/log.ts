// SPDX-License-Identifier: AGPL-3.0-or-later
// Structured JSON-lines logging to stdout. Message text is only logged at debug level,
// and that's the caller's job; this module just redacts obvious secret fields.

import type { Clock, LogFields, Logger, LogLevel } from "./types.js";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT = new Set(["token", "apikey", "api_key", "authorization", "password", "secret"]);

export interface LoggerOptions {
	level: LogLevel;
	write?: (line: string) => void;
	clock?: Clock;
	base?: LogFields;
}

export function createLogger(opts: LoggerOptions): Logger {
	const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const clock = opts.clock ?? { now: () => Date.now() };
	return make(opts.level, write, clock, opts.base ?? {});
}

function make(level: LogLevel, write: (line: string) => void, clock: Clock, base: LogFields): Logger {
	const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
		if (ORDER[lvl] < ORDER[level]) return;
		const record: LogFields = { time: new Date(clock.now()).toISOString(), level: lvl, msg };
		for (const [k, v] of Object.entries(base)) record[k] = clean(k, v, level);
		if (fields) for (const [k, v] of Object.entries(fields)) record[k] = clean(k, v, level);
		let line: string;
		try {
			line = JSON.stringify(record);
		} catch {
			line = JSON.stringify({ time: record.time, level: lvl, msg, note: "unserializable fields" });
		}
		write(line);
	};
	return {
		level,
		debug: (m, f) => emit("debug", m, f),
		info: (m, f) => emit("info", m, f),
		warn: (m, f) => emit("warn", m, f),
		error: (m, f) => emit("error", m, f),
		child: (fields) => make(level, write, clock, { ...base, ...fields }),
	};
}

function clean(key: string, value: unknown, level: LogLevel): unknown {
	if (REDACT.has(key.toLowerCase())) return "[redacted]";
	if (value instanceof Error) {
		const e = value as Error & { status?: unknown; code?: unknown };
		const out: LogFields = { name: e.name, message: e.message };
		if (e.status !== undefined) out.status = e.status;
		if (e.code !== undefined) out.code = e.code;
		if (level === "debug" && e.stack) out.stack = e.stack;
		return out;
	}
	if (typeof value === "bigint") return value.toString();
	return value;
}
