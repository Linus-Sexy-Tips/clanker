// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notices } from "../src/commands.js";
import { createLogger } from "../src/log.js";
import {
	composeReply,
	formatAnswer,
	MAX_SOURCES,
	MESSAGE_LIMIT,
	ReplyStreamer,
	type ReplyStreamerOptions,
	splitMessage,
	statusLine,
} from "../src/render.js";
import {
	type ContentBlock,
	type EditOptions,
	type FluxerApi,
	FluxerRequestError,
	type MessageParam,
	type SendOptions,
	type ToolStatus,
} from "../src/types.js";

// ---------------------------------------------------------------- fixtures

type TextBlock = Extract<ContentBlock, { type: "text" }>;
type Citation = NonNullable<TextBlock["citations"]>[number];

const DIRECT = { type: "direct" } as const;
const WIKI = "https://en.wikipedia.org/wiki/Claude_Shannon";
const BRIT = "https://www.britannica.com/biography/Claude-Shannon";

function text(t: string, citations: Citation[] | null = null): ContentBlock {
	return { type: "text", text: t, citations };
}

function searchCite(url: string, title: string | null = "A page"): Citation {
	return { type: "web_search_result_location", url, title, cited_text: "…", encrypted_index: "Eo8B" };
}

function charCite(index: number, title: string | null, start = 0, end = 0, cited = ""): Citation {
	return {
		type: "char_location",
		document_index: index,
		document_title: title,
		start_char_index: start,
		end_char_index: end,
		cited_text: cited,
		file_id: null,
	};
}

function thinking(): ContentBlock {
	return { type: "thinking", thinking: "", signature: "EqQBCkYI" };
}

function toolUse(id: string, name: "web_search" | "web_fetch", input: unknown): ContentBlock {
	return { type: "server_tool_use", id, name, input, caller: DIRECT };
}

function searchResults(toolUseId: string, urls: string[]): ContentBlock {
	return {
		type: "web_search_tool_result",
		tool_use_id: toolUseId,
		caller: DIRECT,
		content: urls.map((url) => ({
			type: "web_search_result",
			url,
			title: "t",
			encrypted_content: "Eqgf",
			page_age: null,
		})),
	};
}

function fetchResult(toolUseId: string, url: string, title: string | null, data: string): ContentBlock {
	return {
		type: "web_fetch_tool_result",
		tool_use_id: toolUseId,
		caller: DIRECT,
		content: {
			type: "web_fetch_result",
			url,
			retrieved_at: "2026-11-01T12:00:00Z",
			content: {
				type: "document",
				title,
				citations: { enabled: true },
				source: { type: "text", media_type: "text/plain", data },
			},
		},
	};
}

function pdfFetchResult(toolUseId: string, url: string, title: string): ContentBlock {
	return {
		type: "web_fetch_tool_result",
		tool_use_id: toolUseId,
		caller: DIRECT,
		content: {
			type: "web_fetch_result",
			url,
			retrieved_at: null,
			content: {
				type: "document",
				title,
				citations: { enabled: true },
				source: { type: "base64", media_type: "application/pdf", data: "JVBERi0" },
			},
		},
	};
}

// ---------------------------------------------------------------- formatAnswer

describe("formatAnswer", () => {
	it("joins text blocks as returned, numbers cited sources and ignores other blocks", () => {
		const content: ContentBlock[] = [
			thinking(),
			toolUse("srv1", "web_search", { query: "claude shannon birth" }),
			searchResults("srv1", [WIKI, BRIT]),
			text("Claude Shannon "),
			text("was born on April 30, 1916", [searchCite(WIKI, "Claude Shannon - Wikipedia")]),
			text(" in Petoskey, Michigan. He "),
			{ type: "redacted_thinking", data: "EmwK" },
			text("founded information theory", [
				searchCite(BRIT, "Claude Shannon | Biography"),
				searchCite(WIKI, "Claude Shannon - Wikipedia"),
			]),
			text("."),
		];
		expect(formatAnswer(content)).toEqual({
			text: "Claude Shannon was born on April 30, 1916 [1] in Petoskey, Michigan. He founded information theory [2][1].",
			sources: [
				{ url: WIKI, title: "Claude Shannon - Wikipedia" },
				{ url: BRIT, title: "Claude Shannon | Biography" },
			],
		});
	});

	it("puts a paragraph break between text before a tool call and text after it", () => {
		// The shape of the web search example in Anthropic's docs.
		const content: ContentBlock[] = [
			text("I'll search for when Claude Shannon was born."),
			toolUse("srv1", "web_search", { query: "claude shannon birth date" }),
			searchResults("srv1", [WIKI]),
			text("Based on the search results, "),
			text("Claude Shannon was born on April 30, 1916, in Petoskey, Michigan", [searchCite(WIKI)]),
		];
		expect(formatAnswer(content).text).toBe(
			"I'll search for when Claude Shannon was born.\n\nBased on the search results, Claude Shannon was born on April 30, 1916, in Petoskey, Michigan [1]",
		);
	});

	it("adds no break where there is whitespace already, at the start, or for empty blocks", () => {
		const call = toolUse("s", "web_search", { query: "q" });
		expect(formatAnswer([text("Let me check.\n"), call, text("Answer")]).text).toBe("Let me check.\nAnswer");
		expect(formatAnswer([text("Let me check."), call, text(" Answer")]).text).toBe("Let me check. Answer");
		expect(formatAnswer([thinking(), call, text("Answer")]).text).toBe("Answer");
		expect(formatAnswer([text("A."), call, text(""), thinking(), text("B")]).text).toBe("A.\n\nB");
		expect(formatAnswer([text("Half "), text("sentence.")]).text).toBe("Half sentence.");
	});

	it("dedupes URLs in their standard form and skips URLs with credentials", () => {
		const { text: t, sources } = formatAnswer([
			text("a", [searchCite("HTTPS://EN.Wikipedia.org/wiki/Claude_Shannon"), searchCite(WIKI)]),
			text(" b", [searchCite("https://a.example"), searchCite("https://a.example/")]),
			text(" c", [searchCite("https://user:pw@b.example/")]),
		]);
		expect(t).toBe("a [1] b [2] c");
		expect(sources.map((s) => s.url)).toEqual([WIKI, "https://a.example/"]);
	});

	it("returns empty text and no sources without text blocks", () => {
		expect(formatAnswer([])).toEqual({ text: "", sources: [] });
		expect(formatAnswer([thinking(), toolUse("s", "web_search", { query: "q" })])).toEqual({ text: "", sources: [] });
	});

	it("marks a URL cited twice in one block only once", () => {
		const { text: t, sources } = formatAnswer([text("Claim", [searchCite(WIKI), searchCite(WIKI)])]);
		expect(t).toBe("Claim [1]");
		expect(sources).toHaveLength(1);
	});

	it("caps the list at 10 sources; later sources get no marker, known ones keep theirs", () => {
		const urls = Array.from({ length: 12 }, (_, i) => `https://site${i + 1}.example/page`);
		const { text: t, sources } = formatAnswer([
			text(
				"Many",
				urls.map((u) => searchCite(u)),
			),
			text(". Only new"),
			text(" here", [searchCite(urls[11] as string)]),
			text(" and old", [searchCite(urls[2] as string), searchCite(urls[10] as string)]),
		]);
		expect(sources).toHaveLength(MAX_SOURCES);
		expect(sources.map((s) => s.url)).toEqual(urls.slice(0, 10));
		expect(t).toBe("Many [1][2][3][4][5][6][7][8][9][10]. Only new here and old [3]");
	});

	it("puts markers before trailing whitespace, and without a space when there's no text yet", () => {
		expect(formatAnswer([text("First claim.\n\n", [searchCite(WIKI)]), text("Next.")]).text).toBe(
			"First claim. [1]\n\nNext.",
		);
		expect(formatAnswer([text("", [searchCite(WIKI)]), text(" follows")]).text).toBe("[1] follows");
	});

	it("fills in a missing title from a later citation of the same URL", () => {
		const { sources } = formatAnswer([text("a", [searchCite(WIKI, null)]), text("b", [searchCite(WIKI, "Wiki")])]);
		expect(sources).toEqual([{ url: WIKI, title: "Wiki" }]);
	});

	it("skips citations without an http(s) URL", () => {
		const { text: t, sources } = formatAnswer([
			text("x", [searchCite("javascript:alert(1)"), searchCite("ftp://files.example/a"), searchCite("not a url")]),
		]);
		expect(t).toBe("x");
		expect(sources).toEqual([]);
	});

	it("keeps markers out of code blocks but still lists the source", () => {
		const open = formatAnswer([text("Example:\n```py\nprint(1)", [searchCite(WIKI)]), text("\n```\nDone.")]);
		expect(open.text).toBe("Example:\n```py\nprint(1)\n```\nDone.");
		expect(open.sources).toHaveLength(1);
		// Right after a closing fence the marker would turn "```" into an opening fence.
		const closed = formatAnswer([text("```\ncode\n```\n", [searchCite(WIKI)]), text("After [x]")]);
		expect(closed.text).toBe("```\ncode\n```\nAfter [x]");
		// After a finished block the marker goes back to normal.
		expect(formatAnswer([text("```\ncode\n```\nProse", [searchCite(WIKI)])]).text).toBe("```\ncode\n```\nProse [1]");
	});

	it("maps web fetch citations to the fetched URL by document index, confirmed by title", () => {
		const content: ContentBlock[] = [
			toolUse("f1", "web_fetch", { url: "https://a.example/one" }),
			fetchResult("f1", "https://a.example/one", "Page One", "alpha beta gamma"),
			toolUse("f2", "web_fetch", { url: "https://b.example/two" }),
			fetchResult("f2", "https://b.example/two", "Page Two", "delta epsilon"),
			text("Delta", [charCite(1, "Page Two", 0, 5, "delta")]),
			text(" and alpha", [charCite(0, "Page One", 0, 5, "alpha")]),
		];
		expect(formatAnswer(content)).toEqual({
			text: "Delta [1] and alpha [2]",
			sources: [
				{ url: "https://b.example/two", title: "Page Two" },
				{ url: "https://a.example/one", title: "Page One" },
			],
		});
	});

	it("counts documents from earlier assistant turns first", () => {
		const history: MessageParam[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [fetchResult("old", "https://old.example/", "Old page", "old text")] },
			{ role: "assistant", content: "plain text turn" },
			{ role: "user", content: [{ type: "text", text: "more" }] },
		];
		const content = [fetchResult("new", "https://new.example/", "New page", "new text")];
		const cited = [text("x", [charCite(1, "New page"), charCite(0, "Old page")])];
		expect(formatAnswer([...content, ...cited], history).sources.map((s) => s.url)).toEqual([
			"https://new.example/",
			"https://old.example/",
		]);
	});

	it("falls back to the title when the index doesn't match, then to the cited text, else skips", () => {
		const content: ContentBlock[] = [
			fetchResult("f1", "https://a.example/", "Alpha", "first document"),
			fetchResult("f2", "https://b.example/", null, "second document"),
			pdfFetchResult("f3", "https://c.example/paper.pdf", "Paper"),
		];
		// Index 5 doesn't exist, title matches the PDF.
		expect(formatAnswer([...content, text("a", [charCite(5, "Paper")])]).sources).toEqual([
			{ url: "https://c.example/paper.pdf", title: "Paper" },
		]);
		// Index 0 has another title, but the cited text matches document 0's text there.
		expect(formatAnswer([...content, text("b", [charCite(0, "Other", 0, 5, "first")])]).sources).toEqual([
			{ url: "https://a.example/", title: "Other" },
		]);
		// Both titles null at the index: accepted.
		expect(formatAnswer([...content, text("c", [charCite(1, null)])]).sources).toEqual([
			{ url: "https://b.example/", title: null },
		]);
		// Nothing matches: no marker, no source.
		expect(formatAnswer([...content, text("d", [charCite(0, "Unknown", 0, 3, "zzz")])])).toEqual({
			text: "d",
			sources: [],
		});
		// No title to search by.
		expect(formatAnswer([text("e", [charCite(3, null)])]).sources).toEqual([]);
	});

	it("handles page locations and other citation types with a URL-like field", () => {
		const page: Citation = {
			type: "page_location",
			document_index: 0,
			document_title: "Paper",
			start_page_number: 1,
			end_page_number: 2,
			cited_text: "x",
			file_id: null,
		};
		const searchResult: Citation = {
			type: "search_result_location",
			source: "https://kb.example/article",
			title: "KB article",
			cited_text: "y",
			search_result_index: 0,
			start_block_index: 0,
			end_block_index: 1,
		};
		const unknown = { type: "future_location", url: "https://future.example/", document_title: "Future" };
		const { sources } = formatAnswer([
			pdfFetchResult("f", "https://c.example/paper.pdf", "Paper"),
			text("p", [page, searchResult, unknown as unknown as Citation]),
		]);
		expect(sources).toEqual([
			{ url: "https://c.example/paper.pdf", title: "Paper" },
			{ url: "https://kb.example/article", title: "KB article" },
			{ url: "https://future.example/", title: "Future" },
		]);
	});
});

// ---------------------------------------------------------------- composeReply

describe("composeReply", () => {
	it("adds notes as paragraphs and a numbered Sources list with angle-bracket links", () => {
		const reply = composeReply(
			"  The answer.\n",
			[
				{ url: "https://a.example/x", title: "Page A" },
				{ url: "https://b.example/y", title: null },
			],
			["_(note one)_", "  ", "_(note two)_"],
		);
		expect(reply).toBe(
			[
				"The answer.",
				"",
				"_(note one)_",
				"",
				"_(note two)_",
				"",
				"**Sources**",
				"1. [Page A](<https://a.example/x>)",
				"2. [b.example](<https://b.example/y>)",
			].join("\n"),
		);
	});

	it("closes a code block the answer stopped in, before the notes and sources", () => {
		expect(composeReply("Code:\n```py\nprint(i", [{ url: "https://a.example/x", title: "A" }], ["_(cut)_"])).toBe(
			"Code:\n```py\nprint(i\n```\n\n_(cut)_\n\n**Sources**\n1. [A](<https://a.example/x>)",
		);
		expect(composeReply("Code:\n```py\nok\n```", [], ["_(cut)_"])).toBe("Code:\n```py\nok\n```\n\n_(cut)_");
	});

	it("leaves out empty parts", () => {
		expect(composeReply("Text", [], [])).toBe("Text");
		expect(composeReply("", [], ["_(cut off)_"])).toBe("_(cut off)_");
		expect(composeReply(" \n ", [], [])).toBe("");
	});

	it("cleans titles: whitespace, brackets, backticks, Markdown, length", () => {
		const long = "word ".repeat(40);
		const reply = composeReply(
			"x",
			[
				{ url: "https://a.example/", title: "  A [bracketed]\n `code` *title*  " },
				{ url: "https://b.example/", title: long },
				{ url: "https://c.example/", title: "<@123> @everyone a_b ~x~ ||s|| back\\slash" },
			],
			[],
		);
		const lines = reply.split("\n").slice(3);
		expect(lines[0]).toBe("1. [A bracketed code \\*title\\*](<https://a.example/>)");
		const label = /^2\. \[(.*)\]\(</.exec(lines[1] as string)?.[1] as string;
		expect(label.length).toBeLessThanOrEqual(100);
		expect(label.endsWith("…")).toBe(true);
		expect(lines[2]).toBe(
			"3. [\\<\\@123\\> \\@everyone a\\_b \\~x\\~ \\|\\|s\\|\\| back\\\\slash](<https://c.example/>)",
		);
	});

	it("never uses a URL or an email-like title as link text", () => {
		const reply = composeReply(
			"x",
			[
				{ url: "https://docs.example.org/a", title: "https://evil.example/" },
				{ url: "https://docs.example.org/b", title: "HTTP://docs.example.org/b" },
				{ url: "https://mail.example/", title: "someone@example.com" },
				{ url: "https://plain.example/", title: "   " },
				{ url: "https://bsky.example/", title: "@anthropic.bsky.social" },
				{ url: "https://ok.example/", title: "@handle on Example" },
			],
			[],
		);
		expect(reply).toContain("5. [bsky.example](<https://bsky.example/>)");
		expect(reply).toContain("6. [\\@handle on Example](<https://ok.example/>)");
		expect(reply).toContain("1. [docs.example.org](<https://docs.example.org/a>)");
		expect(reply).toContain("2. [docs.example.org](<https://docs.example.org/b>)");
		expect(reply).toContain("3. [mail.example](<https://mail.example/>)");
		expect(reply).toContain("4. [plain.example](<https://plain.example/>)");
	});

	it("percent-encodes characters that would break the link (tabs are dropped, as browsers do)", () => {
		const reply = composeReply("x", [{ url: 'HTTPS://a.example/p q>r<s"t`u|v\tw?q=`|>#f`|', title: "T" }], []);
		expect(reply).toContain("1. [T](<https://a.example/p%20q%3Er%3Cs%22t%60u%7Cvw?q=%60%7C%3E#f%60%7C>)");
	});

	it("uses the browser form of the URL: punycode host, percent-encoded non-ASCII", () => {
		const reply = composeReply("x", [{ url: "https://Bücher.example/Größe?q=é", title: "T" }], []);
		expect(reply).toContain("1. [T](<https://xn--bcher-kva.example/Gr%C3%B6%C3%9Fe?q=%C3%A9>)");
	});

	it("measures the URL limit in bytes, as Fluxer does", () => {
		// 340 × "ж" is only 359 UTF-16 units in all, but 2,059 bytes once encoded: too long for a link.
		const long = `https://ru.example/${"ж".repeat(340)}`;
		const short = `https://ru.example/${"ж".repeat(330)}`;
		const lines = composeReply(
			"x",
			[
				{ url: long, title: "Long" },
				{ url: short, title: "Short" },
			],
			[],
		)
			.split("\n")
			.slice(3);
		expect(lines[0]).toBe("1. Long");
		expect(lines[1]?.startsWith("2. [Short](<https://ru.example/%D0%B6%D0%B6")).toBe(true);
		expect((lines[1] as string).length).toBeLessThan(2100);
	});

	it("doesn't link URLs with a user name or password", () => {
		const reply = composeReply("x", [{ url: "https://user:secret@a.example/", title: "T" }], []);
		expect(reply.split("\n").slice(3)).toEqual(["1. T"]);
		expect(reply).not.toContain("secret");
	});

	it("falls back to the hostname for titles with nothing visible", () => {
		const reply = composeReply("x", [{ url: "https://a.example/", title: "​⁠ ️" }], []);
		expect(reply).toContain("1. [a.example](<https://a.example/>)");
	});

	it("strips control and bidi-override characters from titles", () => {
		const reply = composeReply("x", [{ url: "https://a.example/", title: "Safe‮⁦ report\u0007.pdf" }], []);
		expect(reply).toContain("1. [Safe report .pdf](<https://a.example/>)");
	});

	it("escapes ':' so a title can't carry a link of its own", () => {
		const reply = composeReply("x", [{ url: "https://a.example/", title: "Log in at https://evil.example :x:" }], []);
		expect(reply).toContain("1. [Log in at https\\://evil.example \\:x\\:](<https://a.example/>)");
	});

	it("shows unusable URLs as plain text so the numbers still line up", () => {
		const reply = composeReply(
			"x",
			[
				{ url: "javascript:alert(1)", title: "Bad" },
				{ url: `https://a.example/${"x".repeat(2100)}`, title: null },
				{ url: "https://ok.example/", title: "Ok" },
			],
			[],
		);
		expect(reply.split("\n").slice(3)).toEqual(["1. Bad", "2. a.example", "3. [Ok](<https://ok.example/>)"]);
	});
});

// ---------------------------------------------------------------- statusLine

describe("statusLine", () => {
	it("shows the search query as subtext", () => {
		expect(statusLine({ tool: "web_search", query: "fluxer bot api" })).toBe("-# 🔎 searching: fluxer bot api");
	});

	it("collapses newlines, truncates to 80 characters and escapes Markdown", () => {
		const line = statusLine({ tool: "web_search", query: `a\n\nb ${"c".repeat(100)}` });
		expect(line.startsWith("-# 🔎 searching: a b ccc")).toBe(true);
		expect(line.slice("-# 🔎 searching: ".length)).toHaveLength(80);
		expect(line.endsWith("…")).toBe(true);
		expect(statusLine({ tool: "web_search", query: "*bold* _it_ `code` <@1> @here" })).toBe(
			"-# 🔎 searching: \\*bold\\* \\_it\\_ \\`code\\` \\<\\@1\\> \\@here",
		);
	});

	it("shows the hostname being read, or the truncated URL when it doesn't parse", () => {
		expect(statusLine({ tool: "web_fetch", url: "https://docs.fluxer.app/bots/intro?x=1" })).toBe(
			"-# 📄 reading: docs.fluxer.app",
		);
		expect(statusLine({ tool: "web_fetch", url: "not a url" })).toBe("-# 📄 reading: not a url");
		expect(statusLine({ tool: "web_fetch", url: "x".repeat(200) })).toHaveLength("-# 📄 reading: ".length + 80);
	});

	it("escapes ':' and drops control and bidi-override characters", () => {
		expect(statusLine({ tool: "web_search", query: "site:example.com‮\u0000 x" })).toBe(
			"-# 🔎 searching: site\\:example.com x",
		);
	});

	it("handles input that isn't known yet", () => {
		expect(statusLine({ tool: "web_search", query: " " })).toBe("-# 🔎 searching…");
		expect(statusLine({ tool: "web_fetch", url: "" })).toBe("-# 📄 reading…");
	});

	it("stays short for hostile input", () => {
		expect(statusLine({ tool: "web_search", query: "*_".repeat(500) }).length).toBeLessThanOrEqual(180);
		expect(statusLine({ tool: "web_fetch", url: `x ${"<".repeat(500)}` }).length).toBeLessThanOrEqual(180);
	});
});

// ---------------------------------------------------------------- splitMessage

describe("splitMessage", () => {
	it("returns short text unchanged and empty text as no parts", () => {
		expect(splitMessage("hello  \n")).toEqual(["hello  \n"]);
		expect(splitMessage("x".repeat(MESSAGE_LIMIT))).toEqual(["x".repeat(MESSAGE_LIMIT)]);
		expect(splitMessage("")).toEqual([]);
	});

	it("rejects limits that can't make progress", () => {
		expect(() => splitMessage("abc", 1)).toThrow(RangeError);
		expect(() => splitMessage("abc", 2.5)).toThrow(RangeError);
	});

	it("uses the default limit of 4,000", () => {
		const parts = splitMessage(`${"a".repeat(3000)}\n\n${"b".repeat(3000)}`);
		expect(parts).toEqual(["a".repeat(3000), "b".repeat(3000)]);
	});

	it("breaks at a paragraph break in the second half", () => {
		expect(splitMessage("aaaa bbbb cccc\n\ndddd\neeee", 22)).toEqual(["aaaa bbbb cccc", "dddd\neeee"]);
	});

	it("prefers a line break in the second half over an early paragraph break", () => {
		expect(splitMessage("aaaa bbbb\n\ncccc dddd\neeee ffff gggg", 25)).toEqual([
			"aaaa bbbb\n\ncccc dddd",
			"eeee ffff gggg",
		]);
	});

	it("breaks at spaces, then anywhere", () => {
		expect(splitMessage("one two three four five six", 12)).toEqual(["one two", "three four", "five six"]);
		expect(splitMessage("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
	});

	it("uses an early line break rather than cutting a long word", () => {
		expect(splitMessage(`ab\n${"x".repeat(20)}`, 12)).toEqual(["ab", "x".repeat(12), "x".repeat(8)]);
	});

	it("never splits a surrogate pair", () => {
		expect(splitMessage("😀".repeat(6), 5)).toEqual(["😀😀", "😀😀", "😀😀"]);
	});

	it("trims trailing whitespace and leading newlines of continuation parts", () => {
		expect(splitMessage("aaaa   \n\n\n\nbbbb", 8)).toEqual(["aaaa", "bbbb"]);
		expect(splitMessage(`${" ".repeat(30)}\n\n${" ".repeat(30)}`, 20)).toEqual([]);
	});

	it("drops parts with nothing visible, which Fluxer refuses to send", () => {
		expect(splitMessage(`${"a".repeat(10)}\n\n${"​".repeat(8)} ${"⁠".repeat(8)}`, 12)).toEqual(["a".repeat(10)]);
	});

	it("closes a code block at the end of a part and reopens it with its language", () => {
		expect(splitMessage("Intro\n```ts\nline1\nline2\nline3\nline4\n```\nOutro", 30)).toEqual([
			"Intro\n```ts\nline1\nline2\n```",
			"```ts\nline3\nline4\n```\nOutro",
		]);
	});

	it("takes the closing fence along instead of leaving an empty block", () => {
		expect(splitMessage("Intro words\n```\nabc\n\n```\nmore words after", 24)).toEqual([
			"Intro words\n```\nabc\n\n```",
			"more words after",
		]);
	});

	it("moves a block to the next part rather than leaving only its closing line behind", () => {
		expect(splitMessage("Some intro text\n```\nabc\n```\nmore text after the block", 26)).toEqual([
			"Some intro text",
			"```\nabc\n```\nmore text",
			"after the block",
		]);
	});

	it("doesn't end a part on an opening fence", () => {
		expect(splitMessage("Text before the code\n```py\nprint(1)\n```", 26)).toEqual([
			"Text before the code",
			"```py\nprint(1)\n```",
		]);
	});

	it("cuts inside a long first line of code rather than leave an empty block", () => {
		const parts = splitMessage(`\`\`\`\n${"y".repeat(3994)}\nmore code`);
		expect(parts).toEqual([`\`\`\`\n${"y".repeat(3992)}\n\`\`\``, "```\nyy\nmore code"]);
		expect(splitMessage(`Intro\n\n\`\`\`py\n${"y".repeat(60)}\nz`, 40)).toEqual([
			"Intro",
			`\`\`\`py\n${"y".repeat(30)}\n\`\`\``,
			`\`\`\`py\n${"y".repeat(30)}\nz`,
		]);
	});

	it("treats shorter fences inside a longer one as code", () => {
		expect(splitMessage("````md\n```js\nlet a = 1;\n```\nmore\n````\nend", 24)).toEqual([
			"````md\n```js\n````",
			"````md\nlet a = 1;\n````",
			"````md\n```\nmore\n````\nend",
		]);
	});

	it("doesn't treat a one-line ```code``` block as a fence", () => {
		expect(splitMessage("```a b c```\nword word word word", 15)).toEqual(["```a b c```", "word word word", "word"]);
	});

	it("doesn't repeat code written on the opening line", () => {
		const parts = splitMessage(`\`\`\`print('hi')\n${"line\n".repeat(10)}\`\`\``, 30);
		expect(parts.length).toBeGreaterThan(1);
		for (const part of parts.slice(1)) expect(part.startsWith("```\nline")).toBe(true);
		expect(parts.join("\n").match(/print/g)).toHaveLength(1);
	});

	it("closes a block that is still open at the end of a part but not at the end of the text", () => {
		const parts = splitMessage(`Code:\n\`\`\`sh\n${"echo hello\n".repeat(8)}`, 40);
		for (const part of parts.slice(0, -1)) expect(fencesBalanced(part)).toBe(true);
		expect(fencesBalanced(parts.at(-1) as string)).toBe(false);
	});

	describe("invariants on random input", () => {
		it("keeps parts within the limit, fences balanced and the content intact", () => {
			const rand = rng(1);
			for (let round = 0; round < 400; round++) {
				const input = randomMarkdown(rand);
				const limit = 40 + Math.floor(rand() * 400);
				const parts = splitMessage(input, limit);
				checkParts(input, parts, limit);
			}
		});

		it("handles big answers at the real limit", () => {
			const rand = rng(2);
			for (let round = 0; round < 20; round++) {
				let input = "";
				while (input.length < 20_000) input += `${randomMarkdown(rand)}\n\n`;
				checkParts(input, splitMessage(input), MESSAGE_LIMIT);
			}
		});

		it("terminates on hostile input with tiny limits", () => {
			const rand = rng(3);
			const alphabet = ["`", "```", "\n", " ", "a", "😀", "\t", "\n\n"];
			for (let round = 0; round < 500; round++) {
				let input = "";
				const length = Math.floor(rand() * 120);
				for (let i = 0; i < length; i++) input += pick(rand, alphabet);
				const limit = 2 + Math.floor(rand() * 14);
				const parts = splitMessage(input, limit);
				for (const part of parts) {
					expect(part.length).toBeLessThanOrEqual(limit);
					expect(part).not.toBe("");
					expect(hasLoneSurrogate(part)).toBe(false);
				}
				// Small limits never add fence lines, so only whitespace may differ.
				if (input.length > limit) expect(parts.join("").replace(/\s/g, "")).toBe(input.replace(/\s/g, ""));
			}
		});

		it("terminates on long lines, long fences and many fences", () => {
			const rand = rng(4);
			const alphabet = ["`", "````````", "```js", "\n", " ", "word", "x".repeat(50), "😀"];
			for (let round = 0; round < 300; round++) {
				let input = "";
				const length = Math.floor(rand() * 300);
				for (let i = 0; i < length; i++) input += pick(rand, alphabet);
				const limit = 16 + Math.floor(rand() * 200);
				for (const part of splitMessage(input, limit)) {
					expect(part.length).toBeLessThanOrEqual(limit);
					expect(hasLoneSurrogate(part)).toBe(false);
				}
			}
		});
	});
});

/** Every part fits, is trimmed, has balanced fences (except a block the input itself leaves open), and nothing is lost. */
function checkParts(input: string, parts: string[], limit: number): void {
	if (input.length <= limit) {
		expect(parts).toEqual(input === "" ? [] : [input]);
		return;
	}
	for (const [i, part] of parts.entries()) {
		expect(part.length).toBeLessThanOrEqual(limit);
		expect(part.trim()).not.toBe("");
		expect(part).toBe(part.trimEnd());
		if (i > 0) expect(part.startsWith("\n")).toBe(false);
		expect(hasLoneSurrogate(part)).toBe(false);
		if (i < parts.length - 1) expect(fencesBalanced(part)).toBe(true);
	}
	if (parts.length > 0) expect(fencesBalanced(parts.at(-1) as string)).toBe(fencesBalanced(input));
	expect(contentOf(parts.join("\n"))).toBe(contentOf(input));
}

/** Text without fence lines and whitespace: what splitting must preserve. */
function contentOf(s: string): string {
	return s
		.split("\n")
		.filter((line) => !/^\s*`{3,}/.test(line))
		.join("")
		.replace(/\s/g, "");
}

/** A simple CommonMark-style fence checker, independent of the one in render.ts. */
function fencesBalanced(s: string): boolean {
	let open = 0;
	for (const line of s.split("\n")) {
		const run = /^\s*(`{3,})(.*)$/.exec(line);
		if (!run) continue;
		const ticks = (run[1] as string).length;
		const rest = run[2] as string;
		if (open === 0) {
			if (!rest.includes("`".repeat(ticks))) open = ticks;
		} else if (ticks >= open && rest.trim() === "") {
			open = 0;
		}
	}
	return open === 0;
}

function hasLoneSurrogate(s: string): boolean {
	return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rand: () => number, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)] as T;
}

const WORDS = ["a", "word", "Markdown", "**bold**", "émoji😀", "split", "the", "x".repeat(12), "[1]", "-", "#"];

/** Paragraphs, lists, long words, emoji runs and fenced code (sometimes nested or unclosed). */
function randomMarkdown(rand: () => number): string {
	const blocks: string[] = [];
	const count = 1 + Math.floor(rand() * 30);
	for (let b = 0; b < count; b++) {
		const kind = rand();
		if (kind < 0.25) {
			const outer = rand() < 0.2 ? "````" : "```";
			const lines = [`${pick(rand, ["  ", ""])}${outer}${pick(rand, ["", "ts", "python", "c++"])}`];
			const n = Math.floor(rand() * 25);
			for (let i = 0; i < n; i++) {
				const r = rand();
				if (outer === "````" && r < 0.1) lines.push("```");
				else if (r < 0.15) lines.push("");
				else if (r < 0.25) lines.push("y".repeat(Math.floor(rand() * 300)));
				else lines.push(`${" ".repeat(Math.floor(rand() * 6))}${pick(rand, WORDS)} = ${pick(rand, WORDS)};`);
			}
			if (rand() < 0.9 || b < count - 1) lines.push(outer);
			blocks.push(lines.join("\n"));
		} else if (kind < 0.32) {
			blocks.push("z".repeat(Math.floor(rand() * 600)));
		} else if (kind < 0.38) {
			blocks.push("😀".repeat(Math.floor(rand() * 200)));
		} else {
			const words: string[] = [];
			const n = 1 + Math.floor(rand() * 120);
			for (let i = 0; i < n; i++) words.push(pick(rand, WORDS), rand() < 0.08 ? "\n" : " ");
			blocks.push(words.join(""));
		}
	}
	return blocks.map((block, i) => (i === 0 ? block : `${pick(rand, ["\n\n", "\n", "\n\n\n"])}${block}`)).join("");
}

// ---------------------------------------------------------------- ReplyStreamer

const BLOCKED = new FluxerRequestError("Content blocked", 403, "CONTENT_BLOCKED");

interface Attempt {
	op: "send" | "edit" | "delete" | "typing";
	id?: string;
	content?: string;
	at: number;
}

/** In-memory Fluxer with optional latency, one-off failures and a content blocklist. */
class FakeApi implements FluxerApi {
	readonly botUser = null;
	readonly connectionState = "connected" as const;
	/** Current content of every live message. */
	readonly messages = new Map<string, string>();
	readonly sends: Array<SendOptions & { id: string }> = [];
	readonly edits: Array<EditOptions & { id: string }> = [];
	readonly deletes: string[] = [];
	readonly attempts: Attempt[] = [];
	typing = 0;
	latencyMs = 0;
	blockWord: string | null = null;
	active = 0;
	maxActive = 0;
	private readonly failures: Array<{ op: Attempt["op"]; error: Error }> = [];
	private nextId = 1;

	failNext(op: Attempt["op"], error: Error = new FluxerRequestError("Bad gateway", 502, null)): void {
		this.failures.push({ op, error });
	}

	async sendMessage(_channelId: string, opts: SendOptions): Promise<{ id: string }> {
		await this.request({ op: "send", content: opts.content, at: Date.now() });
		const id = `m${this.nextId++}`;
		this.sends.push({ ...opts, id });
		this.messages.set(id, opts.content);
		return { id };
	}

	async editMessage(_channelId: string, id: string, opts: EditOptions): Promise<void> {
		await this.request({ op: "edit", id, content: opts.content, at: Date.now() });
		this.edits.push({ ...opts, id });
		this.messages.set(id, opts.content);
	}

	async deleteMessage(_channelId: string, id: string): Promise<void> {
		await this.request({ op: "delete", id, at: Date.now() });
		this.deletes.push(id);
		this.messages.delete(id);
	}

	async triggerTyping(_channelId: string): Promise<void> {
		this.typing++;
		await this.request({ op: "typing", at: Date.now() });
	}

	/** Message contents in posting order. */
	contents(): string[] {
		return [...this.messages.values()];
	}

	private async request(attempt: Attempt): Promise<void> {
		this.attempts.push(attempt);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
			const i = this.failures.findIndex((f) => f.op === attempt.op);
			if (i >= 0) throw this.failures.splice(i, 1)[0]?.error;
			if (this.blockWord && attempt.content?.includes(this.blockWord)) throw BLOCKED;
		} finally {
			this.active--;
		}
	}

	addReaction(): Promise<void> {
		throw new Error("not used");
	}
	fetchMessage(): Promise<null> {
		throw new Error("not used");
	}
	fetchMember(): Promise<null> {
		throw new Error("not used");
	}
	leaveGuild(): Promise<void> {
		throw new Error("not used");
	}
	openDm(): Promise<string> {
		throw new Error("not used");
	}
	download(): Promise<{ data: Buffer; contentType: string | null }> {
		throw new Error("not used");
	}
	guild(): undefined {
		return undefined;
	}
	channelName(): undefined {
		return undefined;
	}
	parentChannel(): undefined {
		return undefined;
	}
}

function recordingLog() {
	const lines: Array<{ level: string; msg: string }> = [];
	const log = createLogger({ level: "debug", write: (line) => lines.push(JSON.parse(line)) });
	return { log, lines };
}

function setup(opts: Partial<ReplyStreamerOptions> = {}) {
	const api = new FakeApi();
	const { log, lines } = recordingLog();
	const streamer = new ReplyStreamer({
		fluxer: api,
		channelId: "500",
		replyTo: "trigger",
		pingReplied: true,
		log,
		...opts,
	});
	return { api, streamer, lines };
}

/** Advances fake time and lets promise chains settle. */
async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

const SEARCH: ToolStatus = { tool: "web_search", query: "fluxer api" };

function paragraphs(count: number, size = 300): string {
	return Array.from({ length: count }, (_, i) => `Paragraph ${i}: ${"lorem ipsum ".repeat(size / 12)}`.trim()).join(
		"\n\n",
	);
}

describe("ReplyStreamer", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: Date.parse("2026-11-01T12:00:00Z") });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("typing", () => {
		it("types now and every 8 s until the first message is posted", async () => {
			const { api, streamer } = setup();
			streamer.start();
			streamer.start();
			expect(api.typing).toBe(1);
			await advance(8000);
			expect(api.typing).toBe(2);
			await advance(8000);
			expect(api.typing).toBe(3);
			streamer.update("Hello");
			await advance(0);
			expect(api.sends).toHaveLength(1);
			await advance(30_000);
			expect(api.typing).toBe(3);
		});

		it("logs and ignores typing errors", async () => {
			const { api, streamer, lines } = setup({ typingIntervalMs: 1000 });
			api.failNext("typing");
			streamer.start();
			await advance(0);
			expect(lines.some((l) => l.level === "warn" && l.msg === "typing indicator failed")).toBe(true);
			await advance(1000);
			expect(api.typing).toBe(2);
		});

		it("stops on stop() and finish()", async () => {
			const a = setup();
			a.streamer.start();
			a.streamer.stop();
			a.streamer.stop();
			await advance(30_000);
			expect(a.api.typing).toBe(1);

			const b = setup();
			b.streamer.start();
			const ids = b.streamer.finish("Done");
			await advance(30_000);
			expect(await ids).toEqual(["m1"]);
			expect(b.api.typing).toBe(1);
			b.streamer.start();
			expect(b.api.typing).toBe(1);
		});
	});

	describe("streaming", () => {
		it("posts the status line first, as a reply that pings, with embeds suppressed", async () => {
			const { api, streamer } = setup();
			streamer.status(SEARCH);
			await advance(0);
			expect(api.sends).toEqual([
				{
					id: "m1",
					content: "-# 🔎 searching: fluxer api",
					replyTo: "trigger",
					pingReplied: true,
					suppressEmbeds: true,
				},
			]);
			streamer.update("The answer");
			await advance(1500);
			expect(api.messages.get("m1")).toBe("The answer\n\n-# 🔎 searching: fluxer api");
			streamer.status(null);
			await advance(1500);
			expect(api.messages.get("m1")).toBe("The answer");
			expect(api.edits.every((e) => e.pingReplied === true && e.suppressEmbeds === true)).toBe(true);
		});

		it("respects pingReplied and suppressEmbeds options", async () => {
			const { api, streamer } = setup({ pingReplied: false, suppressEmbeds: false });
			streamer.update("Hi");
			await advance(0);
			streamer.update("Hi there");
			await advance(1500);
			expect(api.sends[0]).toMatchObject({ pingReplied: false, suppressEmbeds: false });
			expect(api.edits[0]).toMatchObject({ pingReplied: false, suppressEmbeds: false });
		});

		it("posts nothing for blank text without a status", async () => {
			const { api, streamer } = setup();
			streamer.update(" \n ");
			await advance(5000);
			expect(api.attempts).toEqual([]);
		});

		it("edits at most once per interval and shows the latest text", async () => {
			const { api, streamer } = setup();
			let answer = "Start";
			streamer.update(answer);
			await advance(0);
			for (let i = 0; i < 100; i++) {
				answer += ` word${i}`;
				streamer.update(answer);
				await advance(100);
			}
			expect(api.edits.length).toBeGreaterThanOrEqual(6);
			expect(api.edits.length).toBeLessThanOrEqual(Math.ceil(10_000 / 1500) + 1);
			const times = api.attempts.map((a) => a.at);
			for (let i = 1; i < times.length; i++)
				expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(1500);
			await advance(1500);
			expect(api.messages.get("m1")).toBe(answer);
			const edits = api.edits.length;
			await advance(10_000);
			expect(api.edits.length).toBe(edits);
		});

		it("keeps one request in flight and coalesces to the latest state", async () => {
			const { api, streamer } = setup();
			api.latencyMs = 3000;
			streamer.update("one");
			await advance(100);
			streamer.update("two");
			streamer.update("three");
			await advance(2900);
			expect(api.sends.map((s) => s.content)).toEqual(["one"]);
			await advance(3000);
			expect(api.edits.map((e) => e.content)).toEqual(["three"]);
			expect(api.maxActive).toBe(1);
		});

		it("closes an open code block before the status line", async () => {
			const { api, streamer } = setup();
			streamer.update("Code:\n```ts\nconst x = 1;");
			await advance(0);
			expect(api.messages.get("m1")).toBe("Code:\n```ts\nconst x = 1;\n```");
			streamer.status(SEARCH);
			await advance(1500);
			expect(api.messages.get("m1")).toBe("Code:\n```ts\nconst x = 1;\n```\n\n-# 🔎 searching: fluxer api");
		});

		it("rolls over into a new part that replies to the previous one", async () => {
			const { api, streamer } = setup();
			const full = paragraphs(16);
			streamer.update(full.slice(0, 1000));
			await advance(0);
			streamer.status(SEARCH);
			streamer.update(full.slice(0, 5000));
			await advance(1500);
			expect(api.sends).toHaveLength(2);
			expect(api.sends[1]).toMatchObject({ replyTo: "m1", pingReplied: false });
			const first = api.messages.get("m1") as string;
			const second = api.messages.get("m2") as string;
			expect(first).not.toContain("searching");
			expect(first.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
			expect(second.endsWith("\n\n-# 🔎 searching: fluxer api")).toBe(true);
			expect(`${first}\n\n${second.replace("\n\n-# 🔎 searching: fluxer api", "")}`).toBe(
				full.slice(0, 5000).trimEnd(),
			);
			// Later text only edits the new part.
			streamer.update(full.slice(0, 6000));
			await advance(1500);
			expect(api.messages.get("m1")).toBe(first);
			expect(api.edits.at(-1)?.id).toBe("m2");
		});

		it("posts several parts at once when a lot of text arrives", async () => {
			const { api, streamer } = setup();
			streamer.update(paragraphs(30));
			await advance(0);
			expect(api.sends.map((s) => [s.replyTo, s.pingReplied])).toEqual([
				["trigger", true],
				["m1", false],
				["m2", false],
			]);
			expect(api.contents().every((c) => c.length <= MESSAGE_LIMIT)).toBe(true);
		});

		it("keeps code blocks intact across a roll-over", async () => {
			const { api, streamer } = setup();
			const code = `Here:\n\`\`\`py\n${"print('hello world')\n".repeat(300)}\`\`\`\nDone.`;
			streamer.update(code.slice(0, 5000));
			await advance(0);
			const [first, second] = api.contents();
			expect(fencesBalanced(first as string)).toBe(true);
			expect(second?.startsWith("```py\nprint")).toBe(true);
			expect(fencesBalanced(second as string)).toBe(true);
		});

		it("cuts parts where the final split cuts them, so finish() has nothing left to fix", async () => {
			const { api, streamer } = setup();
			const full = paragraphs(60);
			streamer.start();
			for (let at = 250; at < full.length; at += 250) {
				streamer.update(full.slice(0, at));
				if (at === 5000) streamer.status(SEARCH);
				if (at === 6000) streamer.status(null);
				await advance(700);
			}
			streamer.update(full);
			await advance(1500);
			const wanted = splitMessage(full);
			expect(wanted.length).toBeGreaterThanOrEqual(4);
			expect(api.contents()).toEqual(wanted);
			const requests = api.attempts.length;
			expect(await streamer.finish(full)).toEqual(api.sends.map((s) => s.id));
			expect(api.attempts.length).toBe(requests);
		});

		it("leaves out the status line when a nearly full part has no room for it", async () => {
			const { api, streamer } = setup();
			const nearlyFull = `${"word ".repeat(797)}end`;
			expect(nearlyFull.length).toBe(3988);
			streamer.update(nearlyFull);
			streamer.status(SEARCH);
			await advance(0);
			expect(api.sends.map((s) => s.content)).toEqual([nearlyFull]);
			streamer.update(`${nearlyFull}.`);
			await advance(1500);
			expect(api.messages.get("m1")).toBe(`${nearlyFull}.`);
		});

		it("keeps the last view when even the temporary closing fence wouldn't fit", async () => {
			const { api, streamer } = setup();
			streamer.update("```\nyy");
			await advance(0);
			expect(api.messages.get("m1")).toBe("```\nyy\n```");
			const nearlyFull = `\`\`\`\n${"y".repeat(3994)}`;
			streamer.update(nearlyFull);
			await advance(1500);
			expect(api.edits).toHaveLength(0);
			streamer.update(`${nearlyFull}\nmore code`);
			await advance(1500);
			expect(api.contents()).toEqual([`\`\`\`\n${"y".repeat(3992)}\n\`\`\``, "```\nyy\nmore code\n```"]);
		});

		it("posts a part again on the next flush when it failed, leaving no gap", async () => {
			const { api, streamer } = setup();
			const full = paragraphs(31);
			streamer.update(full.slice(0, 1000));
			await advance(0);
			api.failNext("send");
			streamer.update(full.slice(0, 9000));
			await advance(1500);
			expect(api.sends).toHaveLength(1);
			expect(api.messages.get("m1")?.length).toBeGreaterThan(3500);
			streamer.update(full);
			await advance(1500);
			expect(api.contents().join("\n\n")).toBe(full);
			expect(api.sends.map((s) => s.replyTo)).toEqual(["trigger", "m1", "m2"]);
		});

		it("stops editing a part whose message was deleted, and leaves it out of the result", async () => {
			const { api, streamer, lines } = setup();
			streamer.update("a");
			await advance(0);
			api.failNext("edit", new FluxerRequestError("Unknown message", 404, "UNKNOWN_MESSAGE"));
			streamer.update("ab");
			await advance(1500);
			expect(lines.filter((l) => l.msg === "a reply part was deleted; leaving it out")).toHaveLength(1);
			const attempts = api.attempts.length;
			streamer.update("abc");
			await advance(5000);
			expect(api.attempts.length).toBe(attempts);
			expect(await streamer.finish("final")).toEqual([]);
			expect(api.attempts.length).toBe(attempts);
		});

		it("doesn't post text with nothing visible", async () => {
			const { api, streamer } = setup();
			streamer.update("​ ⁠️");
			await advance(5000);
			expect(api.attempts).toEqual([]);
		});

		it("logs other edit errors and carries on with the next edit", async () => {
			const { api, streamer, lines } = setup();
			streamer.update("a");
			await advance(0);
			api.failNext("edit");
			streamer.update("ab");
			await advance(1500);
			expect(lines.some((l) => l.level === "warn" && l.msg === "streaming edit failed")).toBe(true);
			streamer.update("abc");
			await advance(1500);
			expect(api.messages.get("m1")).toBe("abc");
		});

		it("retries a failed first post on the next update", async () => {
			const { api, streamer } = setup();
			api.failNext("send");
			streamer.update("a");
			await advance(0);
			expect(api.sends).toHaveLength(0);
			streamer.update("ab");
			await advance(1500);
			expect(api.sends.map((s) => [s.content, s.replyTo])).toEqual([["ab", "trigger"]]);
		});

		it("replaces a blocked part with a notice and stops streaming into it", async () => {
			const { api, streamer } = setup();
			api.blockWord = "BADWORD";
			streamer.update("fine");
			await advance(0);
			streamer.update("fine BADWORD");
			await advance(1500);
			expect(api.messages.get("m1")).toBe(notices.blocked());
			const attempts = api.attempts.length;
			streamer.update("fine BADWORD and more");
			await advance(5000);
			expect(api.attempts.length).toBe(attempts);
		});

		it("posts the notice when the first post is blocked", async () => {
			const { api, streamer } = setup();
			api.blockWord = "BADWORD";
			streamer.start();
			streamer.update("BADWORD");
			await advance(0);
			expect(api.sends).toEqual([
				expect.objectContaining({ content: notices.blocked(), replyTo: "trigger", pingReplied: true }),
			]);
			await advance(20_000);
			expect(api.typing).toBe(1);
		});

		it("ignores updates after stop(), including a pending edit", async () => {
			const { api, streamer } = setup();
			streamer.update("a");
			await advance(0);
			streamer.update("ab");
			streamer.stop();
			streamer.update("abc");
			streamer.status(SEARCH);
			await advance(10_000);
			expect(api.attempts.map((a) => a.op)).toEqual(["send"]);
		});
	});

	describe("finish", () => {
		it("posts all parts when nothing was streamed", async () => {
			const { api, streamer } = setup();
			const long = paragraphs(30);
			const ids = await streamer.finish(long);
			expect(ids).toEqual(["m1", "m2", "m3"]);
			expect(api.contents()).toEqual(splitMessage(long));
			expect(api.sends.map((s) => [s.replyTo, s.pingReplied])).toEqual([
				["trigger", true],
				["m1", false],
				["m2", false],
			]);
		});

		it("uses the empty-answer notice for blank text", async () => {
			const { api, streamer } = setup();
			expect(await streamer.finish("  \n")).toEqual(["m1"]);
			expect(api.contents()).toEqual([notices.empty()]);
		});

		it("doesn't edit parts that are already right", async () => {
			const { api, streamer } = setup();
			streamer.update("Hello");
			await advance(0);
			expect(await streamer.finish("Hello")).toEqual(["m1"]);
			expect(api.edits).toEqual([]);
		});

		it("edits the streamed part and adds missing parts", async () => {
			const { api, streamer } = setup();
			streamer.update("Start");
			streamer.status(SEARCH);
			await advance(0);
			const long = paragraphs(30);
			const ids = await streamer.finish(long);
			expect(ids).toEqual(["m1", "m2", "m3"]);
			expect(api.contents()).toEqual(splitMessage(long));
			expect(api.edits).toEqual([expect.objectContaining({ id: "m1", pingReplied: true })]);
			expect(api.sends.slice(1).map((s) => [s.replyTo, s.pingReplied])).toEqual([
				["m1", false],
				["m2", false],
			]);
		});

		it("deletes parts the final text doesn't need", async () => {
			const { api, streamer } = setup();
			streamer.update(paragraphs(30));
			await advance(0);
			expect(api.sends).toHaveLength(3);
			expect(await streamer.finish("Short after all.")).toEqual(["m1"]);
			expect(api.deletes).toEqual(["m2", "m3"]);
			expect(api.contents()).toEqual(["Short after all."]);
		});

		it("waits for the request in flight", async () => {
			const { api, streamer } = setup();
			api.latencyMs = 1000;
			streamer.update("partial");
			await advance(10);
			const ids = streamer.finish("final");
			await advance(1000);
			await advance(1000);
			expect(await ids).toEqual(["m1"]);
			expect(api.sends).toHaveLength(1);
			expect(api.messages.get("m1")).toBe("final");
		});

		it("can be called again to replace the content", async () => {
			const { api, streamer } = setup();
			expect(await streamer.finish(paragraphs(20))).toEqual(["m1", "m2"]);
			expect(await streamer.finish(notices.unavailable())).toEqual(["m1"]);
			expect(api.contents()).toEqual([notices.unavailable()]);
			expect(api.deletes).toEqual(["m2"]);
		});

		it("works after stop()", async () => {
			const { api, streamer } = setup();
			streamer.update("a");
			await advance(0);
			streamer.stop();
			expect(await streamer.finish("final")).toEqual(["m1"]);
			expect(api.messages.get("m1")).toBe("final");
		});

		it("retries a failed final edit once", async () => {
			const { api, streamer, lines } = setup();
			streamer.update("a");
			await advance(0);
			api.failNext("edit");
			const ids = streamer.finish("final");
			await advance(1000);
			expect(await ids).toEqual(["m1"]);
			expect(api.messages.get("m1")).toBe("final");
			expect(lines.some((l) => l.msg === "final edit failed, retrying")).toBe(true);
		});

		it("logs a final edit that fails twice and still returns the part", async () => {
			const { api, streamer, lines } = setup();
			streamer.update("a");
			await advance(0);
			api.failNext("edit");
			api.failNext("edit");
			const ids = streamer.finish("final");
			await advance(1000);
			expect(await ids).toEqual(["m1"]);
			expect(lines.some((l) => l.level === "error" && l.msg === "final edit failed")).toBe(true);
		});

		it("doesn't retry a final request that got a 4xx answer", async () => {
			const { api, streamer, lines } = setup();
			streamer.update("a");
			await advance(0);
			api.failNext("edit", new FluxerRequestError("Invalid form body", 400, "INVALID_FORM_BODY"));
			expect(await streamer.finish("final")).toEqual(["m1"]);
			expect(api.attempts.filter((a) => a.op === "edit")).toHaveLength(1);
			expect(lines.some((l) => l.msg === "final edit failed, retrying")).toBe(false);
			expect(lines.some((l) => l.level === "error" && l.msg === "final edit failed")).toBe(true);
		});

		it("retries a final edit that got no answer at all", async () => {
			const { api, streamer } = setup();
			streamer.update("a");
			await advance(0);
			api.failNext("edit", new FluxerRequestError("editMessage was aborted or timed out", null, null));
			const ids = streamer.finish("final");
			await advance(1000);
			expect(await ids).toEqual(["m1"]);
			expect(api.messages.get("m1")).toBe("final");
		});

		it("doesn't send a final part again after the client's own retries failed (a new nonce could duplicate it)", async () => {
			const { api, streamer, lines } = setup();
			api.failNext("send", new FluxerRequestError("sendMessage was aborted or timed out", null, null));
			const ids = streamer.finish("final");
			await advance(1000);
			expect(await ids).toEqual([]);
			expect(api.attempts.filter((a) => a.op === "send")).toHaveLength(1);
			expect(lines.some((l) => l.level === "error" && l.msg === "posting a reply part failed")).toBe(true);
		});

		it("leaves out parts someone else deleted, and doesn't post their text again", async () => {
			const { api, streamer, lines } = setup();
			streamer.update(paragraphs(30));
			await advance(0);
			expect(api.sends).toHaveLength(3);
			const gone = new FluxerRequestError("Unknown message", 404, "UNKNOWN_MESSAGE");
			api.failNext("edit", gone);
			api.failNext("delete", gone);
			// m1 was deleted (its edit fails), m2 gets the second part, m3 was deleted already (not a failure).
			expect(await streamer.finish(`Changed.\n\n${paragraphs(20)}`)).toEqual(["m2"]);
			expect(api.attempts.filter((a) => a.op === "edit").map((a) => a.id)).toEqual(["m1", "m2"]);
			expect(lines.some((l) => l.msg === "deleting a surplus reply part failed")).toBe(false);
			// The first slot stays empty: a moderator's deletion isn't undone by reposting.
			expect(await streamer.finish("Again.")).toEqual([]);
			expect(api.attempts.filter((a) => a.op === "delete").map((a) => a.id)).toEqual(["m3", "m2"]);
			expect(api.sends).toHaveLength(3);
		});

		it("uses the empty-answer notice for text with nothing visible", async () => {
			const { api, streamer } = setup();
			expect(await streamer.finish("​⁠")).toEqual(["m1"]);
			expect(api.contents()).toEqual([notices.empty()]);
		});

		it("leaves no timers behind", async () => {
			const { api, streamer } = setup();
			streamer.start();
			streamer.update("a");
			await advance(0);
			streamer.update("ab");
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			api.failNext("edit");
			const ids = streamer.finish("final");
			await advance(1000);
			expect(await ids).toEqual(["m1"]);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("chains around a final post that fails", async () => {
			const { api, streamer } = setup();
			const long = paragraphs(30);
			api.failNext("send");
			const ids = streamer.finish(long);
			await advance(1000);
			expect(await ids).toEqual(["m1", "m2"]);
			// The first part was lost; the second replies to the trigger and pings in its place.
			expect(api.sends.map((s) => [s.replyTo, s.pingReplied])).toEqual([
				["trigger", true],
				["m1", false],
			]);
		});

		it("replaces blocked final parts with the notice, without retrying the blocked text", async () => {
			const { api, streamer } = setup();
			streamer.update("ok");
			await advance(0);
			api.blockWord = "BADWORD";
			const ids = await streamer.finish(`ok BADWORD\n\n${"x".repeat(MESSAGE_LIMIT)}\n\nBADWORD again`);
			expect(ids).toEqual(["m1", "m2", "m3"]);
			expect(api.contents()).toEqual([notices.blocked(), "x".repeat(MESSAGE_LIMIT), notices.blocked()]);
			const blockedTries = api.attempts.filter((a) => a.content?.includes("BADWORD"));
			expect(blockedTries).toHaveLength(2);
		});

		it("doesn't touch a part that already shows the blocked notice", async () => {
			const { api, streamer } = setup();
			api.blockWord = "BADWORD";
			streamer.update("BADWORD");
			await advance(0);
			const before = api.attempts.length;
			expect(await streamer.finish("BADWORD final")).toEqual(["m1"]);
			expect(api.attempts.length).toBe(before + 1);
			expect(api.contents()).toEqual([notices.blocked()]);
		});
	});

	it("keeps every message within the limit while streaming random answers", async () => {
		const rand = rng(5);
		for (let round = 0; round < 15; round++) {
			const { api, streamer } = setup();
			let full = "";
			while (full.length < 12_000) full += `${randomMarkdown(rand)}\n\n`;
			const statuses: Array<ToolStatus | null> = [
				null,
				{ tool: "web_search", query: "*_".repeat(200) },
				{ tool: "web_fetch", url: `https://${"a".repeat(60)}.example/x` },
			];
			streamer.start();
			for (let at = 0; at < full.length; at += 1 + Math.floor(rand() * 400)) {
				streamer.update(full.slice(0, at));
				if (rand() < 0.1) streamer.status(pick(rand, statuses));
				await advance(Math.floor(rand() * 800));
			}
			for (const s of api.sends) expect(s.content.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
			for (const e of api.edits) expect(e.content.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
			const ids = await streamer.finish(full);
			expect(api.contents()).toEqual(splitMessage(full));
			expect(ids).toEqual([...api.messages.keys()]);
			expect(api.maxActive).toBe(1);
		}
	});
});
