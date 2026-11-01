// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";

describe("logger", () => {
	it("writes JSON lines at or above the level, with child fields and redaction", () => {
		const lines: string[] = [];
		const log = createLogger({ level: "info", write: (l) => lines.push(l), clock: { now: () => 0 } });
		log.debug("hidden");
		const child = log.child({ guild: "g1" });
		child.info("hello", { user: "u1", token: "secret-value", count: 3n });
		const err = Object.assign(new Error("boom"), { status: 500 });
		log.error("failed", { err });
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] as string)).toEqual({
			time: "1970-01-01T00:00:00.000Z",
			level: "info",
			msg: "hello",
			guild: "g1",
			user: "u1",
			token: "[redacted]",
			count: "3",
		});
		expect(JSON.parse(lines[1] as string).err).toEqual({ name: "Error", message: "boom", status: 500 });
	});
});
