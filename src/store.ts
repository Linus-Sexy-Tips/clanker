// SPDX-License-Identifier: AGPL-3.0-or-later
// SQLite spending ledger. Stores token counts and costs per request, never message content.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Micros, UsageRow } from "./types.js";

const MIGRATIONS: string[] = [
	// 1: initial schema
	`CREATE TABLE usage (
		id INTEGER PRIMARY KEY,
		ts INTEGER NOT NULL,
		user_id TEXT NOT NULL,
		guild_id TEXT,
		model TEXT NOT NULL,
		input_tokens INTEGER NOT NULL,
		output_tokens INTEGER NOT NULL,
		cache_write_5m_tokens INTEGER NOT NULL,
		cache_write_1h_tokens INTEGER NOT NULL,
		cache_read_tokens INTEGER NOT NULL,
		web_searches INTEGER NOT NULL,
		web_fetches INTEGER NOT NULL,
		cost INTEGER NOT NULL,
		day TEXT NOT NULL,
		month TEXT NOT NULL
	);
	CREATE INDEX usage_user_day ON usage (user_id, day);
	CREATE INDEX usage_month ON usage (month, user_id);
	CREATE TABLE marks (
		kind TEXT NOT NULL,
		subject TEXT NOT NULL,
		period TEXT NOT NULL,
		ts INTEGER NOT NULL,
		PRIMARY KEY (kind, subject, period)
	) WITHOUT ROWID;`,
	// 2: owner commands (personality, access grants and revokes, daily usage resets)
	`CREATE TABLE settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		ts INTEGER NOT NULL
	) WITHOUT ROWID;
	CREATE TABLE access_overrides (
		kind TEXT NOT NULL CHECK (kind IN ('user', 'role')),
		id TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('grant', 'revoke')),
		ts INTEGER NOT NULL,
		PRIMARY KEY (kind, id)
	) WITHOUT ROWID;
	CREATE TABLE daily_resets (
		user_id TEXT PRIMARY KEY,
		ts INTEGER NOT NULL
	) WITHOUT ROWID;`,
	// 3: pro tier members added and removed with owner commands
	`CREATE TABLE pro_overrides (
		kind TEXT NOT NULL CHECK (kind IN ('user', 'role')),
		id TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('add', 'remove')),
		ts INTEGER NOT NULL,
		PRIMARY KEY (kind, id)
	) WITHOUT ROWID;`,
];

export interface DayStats {
	requests: number;
	cost: Micros;
	inputTokens: number;
	cacheWriteTokens: number;
	cacheReadTokens: number;
	webSearches: number;
	webFetches: number;
}

export interface AccessOverride {
	kind: "user" | "role";
	id: string;
	state: "grant" | "revoke";
}

export interface ProOverride {
	kind: "user" | "role";
	id: string;
	state: "add" | "remove";
}

export class Store {
	private constructor(private readonly db: DatabaseSync) {
		db.exec("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	/** Opens (or creates) the ledger file. The directory must exist and be writable. */
	static open(path: string): Store {
		const db = new DatabaseSync(path);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		db.exec("PRAGMA busy_timeout = 5000");
		return new Store(db);
	}

	/** In-memory ledger for tests. */
	static memory(): Store {
		return new Store(new DatabaseSync(":memory:"));
	}

	private migrate(): void {
		const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
		const current = row?.user_version ?? 0;
		if (current > MIGRATIONS.length) {
			throw new Error(
				`Ledger schema version ${current} is newer than this Clanker (${MIGRATIONS.length}). Upgrade Clanker.`,
			);
		}
		for (let v = current; v < MIGRATIONS.length; v++) {
			this.db.exec("BEGIN");
			try {
				this.db.exec(MIGRATIONS[v] as string);
				this.db.exec(`PRAGMA user_version = ${v + 1}`);
				this.db.exec("COMMIT");
			} catch (err) {
				this.db.exec("ROLLBACK");
				throw err;
			}
		}
	}

	insertUsage(r: UsageRow): void {
		this.db
			.prepare(
				`INSERT INTO usage (ts, user_id, guild_id, model, input_tokens, output_tokens,
				cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens, web_searches, web_fetches, cost, day, month)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				r.ts,
				r.userId,
				r.guildId,
				r.model,
				r.inputTokens,
				r.outputTokens,
				r.cacheWrite5mTokens,
				r.cacheWrite1hTokens,
				r.cacheReadTokens,
				r.webSearches,
				r.webFetches,
				Math.round(r.cost),
				r.day,
				r.month,
			);
	}

	private sum(sql: string, ...params: SQLInputValue[]): Micros {
		const row = this.db.prepare(sql).get(...params) as { total: number | bigint | null } | undefined;
		return Number(row?.total ?? 0);
	}

	/** The user's spend on `day`, counting only calls recorded after `since` (a daily reset). */
	sumUserDay(userId: string, day: string, since = 0): Micros {
		return this.sum(
			"SELECT SUM(cost) AS total FROM usage WHERE user_id = ? AND day = ? AND ts > ?",
			userId,
			day,
			since,
		);
	}

	sumUserMonth(userId: string, month: string): Micros {
		return this.sum("SELECT SUM(cost) AS total FROM usage WHERE user_id = ? AND month = ?", userId, month);
	}

	sumMonth(month: string): Micros {
		return this.sum("SELECT SUM(cost) AS total FROM usage WHERE month = ?", month);
	}

	/** Spend per user this month (and today), highest monthly spend first. */
	perUser(day: string, month: string): Array<{ userId: string; today: Micros; month: Micros }> {
		const rows = this.db
			.prepare(
				`SELECT u.user_id AS userId,
					SUM(CASE WHEN u.day = ? AND u.ts > COALESCE(r.ts, 0) THEN u.cost ELSE 0 END) AS today,
					SUM(u.cost) AS month
				FROM usage u LEFT JOIN daily_resets r ON r.user_id = u.user_id
				WHERE u.month = ? GROUP BY u.user_id ORDER BY month DESC, u.user_id`,
			)
			.all(day, month) as Array<{ userId: string; today: number | bigint; month: number | bigint }>;
		return rows.map((r) => ({ userId: r.userId, today: Number(r.today), month: Number(r.month) }));
	}

	dayStats(day: string): DayStats {
		const r = this.db
			.prepare(
				`SELECT COUNT(*) AS requests, SUM(cost) AS cost, SUM(input_tokens) AS input,
					SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cw, SUM(cache_read_tokens) AS cr,
					SUM(web_searches) AS ws, SUM(web_fetches) AS wf
				FROM usage WHERE day = ?`,
			)
			.get(day) as Record<string, number | bigint | null> | undefined;
		const n = (v: number | bigint | null | undefined) => Number(v ?? 0);
		return {
			requests: n(r?.requests),
			cost: n(r?.cost),
			inputTokens: n(r?.input),
			cacheWriteTokens: n(r?.cw),
			cacheReadTokens: n(r?.cr),
			webSearches: n(r?.ws),
			webFetches: n(r?.wf),
		};
	}

	/** Records a one-off event (notice sent, alert sent). Returns true only the first time. */
	markOnce(kind: string, subject: string, period: string, ts = Date.now()): boolean {
		const res = this.db
			.prepare("INSERT OR IGNORE INTO marks (kind, subject, period, ts) VALUES (?, ?, ?, ?)")
			.run(kind, subject, period, ts);
		return Number(res.changes) > 0;
	}

	/** Forgets a one-off mark, so the event can happen again (a limit notice after a reset). */
	unmark(kind: string, subject: string, period: string): void {
		this.db.prepare("DELETE FROM marks WHERE kind = ? AND subject = ? AND period = ?").run(kind, subject, period);
	}

	getSetting(key: string): string | null {
		const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
		return row?.value ?? null;
	}

	/** Stores a setting; null deletes it. */
	setSetting(key: string, value: string | null, ts = Date.now()): void {
		if (value === null) this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
		else
			this.db
				.prepare(
					"INSERT INTO settings (key, value, ts) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = ?, ts = ?",
				)
				.run(key, value, ts, value, ts);
	}

	accessOverrides(): AccessOverride[] {
		return this.db
			.prepare("SELECT kind, id, state FROM access_overrides ORDER BY kind, ts")
			.all() as unknown as AccessOverride[];
	}

	setAccessOverride(kind: "user" | "role", id: string, state: "grant" | "revoke", ts = Date.now()): void {
		this.db
			.prepare(
				"INSERT INTO access_overrides (kind, id, state, ts) VALUES (?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET state = ?, ts = ?",
			)
			.run(kind, id, state, ts, state, ts);
	}

	proOverrides(): ProOverride[] {
		return this.db
			.prepare("SELECT kind, id, state FROM pro_overrides ORDER BY kind, ts")
			.all() as unknown as ProOverride[];
	}

	setProOverride(kind: "user" | "role", id: string, state: "add" | "remove", ts = Date.now()): void {
		this.db
			.prepare(
				"INSERT INTO pro_overrides (kind, id, state, ts) VALUES (?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET state = ?, ts = ?",
			)
			.run(kind, id, state, ts, state, ts);
	}

	/** When the user's daily usage was last reset (ms), or 0. */
	dailyReset(userId: string): number {
		const row = this.db.prepare("SELECT ts FROM daily_resets WHERE user_id = ?").get(userId) as
			| { ts: number | bigint }
			| undefined;
		return Number(row?.ts ?? 0);
	}

	setDailyReset(userId: string, ts: number): void {
		this.db
			.prepare("INSERT INTO daily_resets (user_id, ts) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET ts = ?")
			.run(userId, ts, ts);
	}

	close(): void {
		if (this.db.isOpen) this.db.close();
	}
}
