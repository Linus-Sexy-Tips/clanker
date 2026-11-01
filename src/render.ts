// SPDX-License-Identifier: AGPL-3.0-or-later
// Turns Claude's answer into Fluxer messages: citations become numbered sources, long answers are
// split into parts of at most 4,000 characters without breaking code blocks, and ReplyStreamer shows
// the answer while it's written (typing, first post, throttled edits, a tool status line, more parts).

import { notices } from "./commands.js";
import {
	type Clock,
	type ContentBlock,
	type ContentBlockParam,
	type FluxerApi,
	FluxerRequestError,
	type Logger,
	type MessageParam,
	systemClock,
	type ToolStatus,
} from "./types.js";

/** Fluxer's length limit for bot messages, in UTF-16 code units (JS string length). */
export const MESSAGE_LIMIT = 4000;
/** At most this many sources are numbered and listed. */
export const MAX_SOURCES = 10;

const TITLE_MAX = 100;
const STATUS_TEXT_MAX = 80;
/** Fluxer shows masked links with longer URLs (in bytes) as plain text. */
const LINK_URL_MAX = 2048;
/** The live view only closes fences up to this many backticks (longer runs aren't real code blocks). */
const MAX_DISPLAY_FENCE = 32;
const FINAL_RETRY_DELAY_MS = 1000;
const BACKTICK = 96;
/** Put between text written before a tool call and text written after it, when neither side has whitespace. */
const TOOL_BREAK = "\n\n";

// ---------------------------------------------------------------- answer and sources

export interface Source {
	url: string;
	title: string | null;
}

type TextBlock = Extract<ContentBlock, { type: "text" }>;
type Citation = NonNullable<TextBlock["citations"]>[number];
type DocumentCitation = Extract<Citation, { type: "char_location" | "page_location" | "content_block_location" }>;

/** A page read by web fetch, in the order the API counts documents. */
interface FetchedDoc {
	url: string;
	title: string | null;
	/** Plain-text content, when the page wasn't a PDF. */
	text: string | null;
}

/**
 * The visible answer: the text blocks joined as returned, with numbered markers ("[1][2]") after
 * each cited block, and the cited sources (deduplicated by URL, first-seen order, at most 10).
 * Consecutive text blocks are fragments of one sentence and are joined as they are; text on either
 * side of a tool call (or another non-text block) gets a paragraph break when neither side has
 * whitespace there ("I'll search for that." + "Based on the results, …").
 * `history` is the request's messages: web fetch citations point at documents by index across
 * the whole request, so earlier assistant turns count.
 */
export function formatAnswer(
	content: ContentBlock[],
	history: MessageParam[] = [],
): { text: string; sources: Source[] } {
	const docs = fetchedDocs(content, history);
	const sources: Source[] = [];
	const numbers = new Map<string, number>();
	let text = "";
	let separated = false;
	for (const block of content) {
		if (block.type !== "text") {
			separated = true;
			continue;
		}
		if (separated && block.text !== "") {
			if (needsBreak(text, block.text)) text += TOOL_BREAK;
			separated = false;
		}
		text += block.text;
		const cited: number[] = [];
		for (const citation of block.citations ?? []) {
			const n = numberSource(citationSource(citation, docs), sources, numbers);
			if (n !== null && !cited.includes(n)) cited.push(n);
		}
		if (cited.length > 0) text = withMarkers(text, cited);
	}
	return { text, sources };
}

function needsBreak(before: string, after: string): boolean {
	return before !== "" && !/\s$/.test(before) && !/^\s/.test(after);
}

function fetchedDocs(content: ContentBlock[], history: MessageParam[]): FetchedDoc[] {
	const docs: FetchedDoc[] = [];
	for (const message of history) {
		if (message.role !== "assistant" || typeof message.content === "string") continue;
		for (const block of message.content) addFetchedDoc(docs, block);
	}
	for (const block of content) addFetchedDoc(docs, block);
	return docs;
}

function addFetchedDoc(docs: FetchedDoc[], block: ContentBlock | ContentBlockParam): void {
	if (block.type !== "web_fetch_tool_result" || block.content.type !== "web_fetch_result") return;
	const doc = block.content.content;
	docs.push({
		url: block.content.url,
		title: doc.title ?? null,
		text: doc.source.type === "text" ? doc.source.data : null,
	});
}

function citationSource(citation: Citation, docs: FetchedDoc[]): Source | null {
	switch (citation.type) {
		case "web_search_result_location":
			return { url: citation.url, title: citation.title };
		case "char_location":
		case "page_location":
		case "content_block_location":
			return fetchedSource(citation, docs);
		default: {
			// Search results, or citation types added to the API later: use a URL if there is one.
			// The cast reads optional fields that the SDK types don't promise.
			const fields = citation as unknown as Record<string, unknown>;
			const url = stringField(fields.url) ?? stringField(fields.source);
			return url ? { url, title: stringField(fields.title) ?? stringField(fields.document_title) } : null;
		}
	}
}

function stringField(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Web fetch citations carry no URL, only a document index and title. Take the document at that index
 * if the title (or the cited text) confirms it, else the latest document with the same title.
 */
function fetchedSource(citation: DocumentCitation, docs: FetchedDoc[]): Source | null {
	const byIndex = docs[citation.document_index];
	if (byIndex && confirms(byIndex, citation))
		return { url: byIndex.url, title: citation.document_title ?? byIndex.title };
	if (citation.document_title === null) return null;
	const byTitle = docs.findLast((doc) => doc.title === citation.document_title);
	return byTitle ? { url: byTitle.url, title: citation.document_title } : null;
}

function confirms(doc: FetchedDoc, citation: DocumentCitation): boolean {
	if (doc.title === citation.document_title) return true;
	return (
		citation.type === "char_location" &&
		doc.text !== null &&
		doc.text.slice(citation.start_char_index, citation.end_char_index) === citation.cited_text
	);
}

/** The source's number (1-based), adding it if new. null when it has no usable URL or the list is full. */
function numberSource(source: Source | null, sources: Source[], numbers: Map<string, number>): number | null {
	if (!source) return null;
	const url = normalizeUrl(source.url);
	if (url === null) return null;
	const known = numbers.get(url);
	if (known !== undefined) {
		const entry = sources[known - 1];
		if (entry && entry.title === null && source.title) entry.title = source.title;
		return known;
	}
	if (sources.length >= MAX_SOURCES) return null;
	sources.push({ url, title: source.title || null });
	numbers.set(url, sources.length);
	return sources.length;
}

/** Appends " [1][2]" before any trailing whitespace, unless that would land in or on a code fence. */
function withMarkers(text: string, cited: number[]): string {
	const body = text.trimEnd();
	const last = scanFences(body).at(-1);
	// Inside an open block the markers would show as code; right after a closing fence they'd break it.
	if (last && (last.close === null || last.closeEnd === body.length)) return text;
	const markers = cited.map((n) => `[${n}]`).join("");
	return `${body}${body === "" ? "" : " "}${markers}${text.slice(body.length)}`;
}

/**
 * The message text: the answer, each note as its own paragraph, then the numbered sources as
 * `[Title](<url>)` links (angle brackets: never unfurled).
 */
export function composeReply(text: string, sources: Source[], notes: string[]): string {
	// An answer cut off inside a code block: close it, or the notes and sources would end up in it.
	const sections = [closeOpenFence(text.trim()), ...notes.map((note) => note.trim())];
	if (sources.length > 0) {
		const lines = sources.map((source, i) => `${i + 1}. ${sourceLink(source)}`);
		sections.push(["**Sources**", ...lines].join("\n"));
	}
	return sections.filter((section) => section !== "").join("\n\n");
}

function sourceLink(source: Source): string {
	const target = linkTarget(source.url);
	const label = sourceLabel(source.title, source.url);
	// Without a usable link the entry stays as plain text, so the numbers still match the markers.
	return target ? `[${label}](<${target}>)` : label;
}

/**
 * The link target: the URL as a browser reads it, with characters that would end or confuse the
 * `<...>` form percent-encoded. null when Fluxer wouldn't show it as a link.
 */
function linkTarget(raw: string): string | null {
	const url = normalizeUrl(raw);
	if (url === null) return null;
	const encoded = Array.from(url, (c) => (unsafeInLink(c) ? encodeURIComponent(c) : c)).join("");
	// The serialized URL is ASCII, so its length is also its size in bytes, which is what Fluxer checks.
	return encoded.length <= LINK_URL_MAX ? encoded : null;
}

/** Characters the URL serializer leaves alone that could end the link or start Markdown. */
function unsafeInLink(c: string): boolean {
	const code = c.charCodeAt(0);
	return code <= 0x20 || code === 0x7f || '<>"`|'.includes(c);
}

/**
 * An http(s) URL in its standard (WHATWG) form: lowercase scheme and host, punycode, non-ASCII and
 * spaces percent-encoded. null for other schemes, and for URLs with a user name or password (Fluxer
 * shows those links as plain text, and they shouldn't be repeated in a chat anyway).
 */
function normalizeUrl(raw: string): string | null {
	const url = parseUrl(raw);
	if (url === null || (url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return null;
	return url.username === "" && url.password === "" ? url.href : null;
}

/**
 * Link text, escaped: the cleaned title, else the hostname. Never a URL or an email-like text:
 * Fluxer shows such links as plain text.
 */
function sourceLabel(title: string | null, url: string): string {
	const clean = title ? oneLine(title.replace(/[[\]`]/g, "")) : "";
	if (hasVisibleContent(clean) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) {
		const label = escapeMarkdown(truncate(clean, TITLE_MAX));
		if (!isEmailLike(label)) return label;
	}
	return escapeMarkdown(hostnameOf(url) ?? "source");
}

/** Fluxer's test for link texts it refuses (links.rs is_email_like), applied to the text as sent. */
function isEmailLike(text: string): boolean {
	const at = text.indexOf("@");
	if (at <= 0 || at + 1 >= text.length || text.includes("@", at + 1) || /[ \t\r\n]/.test(text)) return false;
	return text.slice(at + 1).includes(".");
}

// ---------------------------------------------------------------- status line

/** Subtext shown under the answer while a web tool runs. */
export function statusLine(status: ToolStatus): string {
	if (status.tool === "web_search") {
		const query = oneLine(status.query);
		return query === "" ? "-# 🔎 searching…" : `-# 🔎 searching: ${escapeMarkdown(truncate(query, STATUS_TEXT_MAX))}`;
	}
	const target = hostnameOf(status.url) ?? oneLine(status.url);
	return target === "" ? "-# 📄 reading…" : `-# 📄 reading: ${escapeMarkdown(truncate(target, STATUS_TEXT_MAX))}`;
}

// ---------------------------------------------------------------- text helpers

/**
 * Untrusted text (a community name, say) made safe to quote inside a message: one line, cut to
 * `max` characters, Markdown, links and mentions escaped. "" when nothing visible is left.
 */
export function untrustedInline(text: string, max: number): string {
	const clean = oneLine(text);
	return hasVisibleContent(clean) ? escapeMarkdown(truncate(clean, max)) : "";
}

/** Escapes Markdown, mentions, and ":" (no autolinks such as "https://other.example" or :emoji: inside). */
function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_~|<>[\]@:]/g, "\\$&");
}

/** Untrusted text (page titles, search queries) as one line: no control or bidi-override characters. */
function oneLine(text: string): string {
	return text
		.replace(/\p{Cc}/gu, " ")
		.replace(BIDI_CONTROLS, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** These can reorder the text around them on screen, e.g. to disguise a link. */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

/** Fluxer's own test (schema MessageValidators.ts): it refuses messages and link texts without visible content. */
function hasVisibleContent(text: string): boolean {
	for (const char of text) {
		if (char.trim() === "") continue;
		const code = char.codePointAt(0) ?? 0;
		if (!isInvisible(code)) return true;
	}
	return false;
}

function isInvisible(code: number): boolean {
	return (
		code === 0x0000 ||
		code === 0x00ad ||
		code === 0x034f ||
		code === 0x061c ||
		code === 0x115f ||
		code === 0x1160 ||
		code === 0x17b4 ||
		code === 0x17b5 ||
		code === 0x180e ||
		(code >= 0x200b && code <= 0x200f) ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2060 && code <= 0x2069) ||
		code === 0x2800 ||
		code === 0x3164 ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		code === 0xfeff ||
		code === 0xffa0 ||
		(code >= 0xe0100 && code <= 0xe01ef)
	);
}

/** Cuts to at most `max` characters including the "…", never inside a surrogate pair. */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max - 1;
	if (isHighSurrogate(text.charCodeAt(end - 1))) end--;
	return `${text.slice(0, end).trimEnd()}…`;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function parseUrl(url: string): URL | null {
	try {
		return new URL(url.trim());
	} catch {
		return null;
	}
}

function hostnameOf(url: string): string | null {
	return parseUrl(url)?.hostname || null;
}

// ---------------------------------------------------------------- code fences (Fluxer's rules)

interface Fence {
	/** Start of the opening line, and its end (index of its "\n", or the text length). */
	open: number;
	openEnd: number;
	/** Index just after the opening backtick run. */
	tickEnd: number;
	ticks: number;
	/** The opening line, e.g. "```ts". */
	line: string;
	/** Start and end of the closing line; null while the block is still open. */
	close: number | null;
	closeEnd: number | null;
}

/**
 * Fenced code blocks in order. A block that is never closed runs to the end of the text (for
 * splitting; Fluxer itself shows an unclosed fence as plain text).
 */
function scanFences(text: string): Fence[] {
	const fences: Fence[] = [];
	let open: Fence | null = null;
	let start = 0;
	for (;;) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline;
		const line = text.slice(start, end);
		if (open) {
			if (closesFence(line, open.ticks)) {
				open.close = start;
				open.closeEnd = end;
				open = null;
			}
		} else {
			const ticks = openingTicks(line);
			if (ticks > 0) {
				const indent = line.length - line.trimStart().length;
				open = { open: start, openEnd: end, tickEnd: start + indent + ticks, ticks, line, close: null, closeEnd: null };
				fences.push(open);
			}
		}
		if (newline === -1) return fences;
		start = newline + 1;
	}
}

/** Length of the backtick run if the line opens a code block, else 0. */
function openingTicks(line: string): number {
	const trimmed = line.trimStart();
	let ticks = 0;
	while (trimmed.charCodeAt(ticks) === BACKTICK) ticks++;
	if (ticks < 3) return 0;
	// "```code```" on one line is a whole block, not an opening fence.
	return trimmed.includes("`".repeat(ticks), ticks) ? 0 : ticks;
}

/** Whether the line closes a block opened with `ticks` backticks. Fluxer also accepts "code```". */
function closesFence(line: string, ticks: number): boolean {
	const trimmed = line.trimStart();
	const fence = "`".repeat(ticks);
	const at = trimmed.indexOf(fence);
	if (at === -1) return false;
	let end = at;
	while (trimmed.charCodeAt(end) === BACKTICK) end++;
	const after = trimmed[end];
	return after === undefined || after === " " || after === "\t" || trimmed.includes(fence, end);
}

/** The line that reopens a block in the next part: indentation, backticks, and the language if it is one. */
function reopenLine(fence: Fence, limit: number): string {
	const trimmed = fence.line.trimStart();
	const indent = fence.line.slice(0, fence.line.length - trimmed.length);
	const ticks = "`".repeat(fence.ticks);
	const language = trimmed.slice(fence.ticks).trimEnd();
	// Anything else after the backticks is code on the opening line; repeating it would duplicate it.
	const line = /^[A-Za-z0-9_+.#/-]+$/.test(language) ? `${indent}${ticks}${language}` : `${indent}${ticks}`;
	return line.length <= limit / 4 ? line : ticks;
}

/** Fences whose close and reopen lines take up so much of a part that splitting them can't help are left alone. */
function splittable(fence: Fence, limit: number): boolean {
	return reopenLine(fence, limit).length + fence.ticks + 2 <= limit / 2;
}

// ---------------------------------------------------------------- splitting

interface Break {
	/** The part ends here (before trimming)... */
	end: number;
	/** ...and the rest starts here; anything in between is a dropped separator. */
	next: number;
}

interface Cut {
	/** The finished part ("" when it would hold nothing but whitespace). */
	part: string;
	/** Where the rest starts in the body. */
	next: number;
	/** The fence line to reopen at the start of the next part, when the cut fell inside a code block. */
	reopen: string | null;
}

/**
 * Splits text into parts of at most `limit` characters. Breaks at the last paragraph break, else
 * line break, else space (in the second half of the part when possible), else anywhere outside a
 * surrogate pair. A code block that has to be split is closed at the end of one part and reopened
 * at the start of the next. Parts are trimmed at the end; parts with nothing visible are dropped
 * (Fluxer refuses them). A text that fits is returned as it is.
 */
export function splitMessage(text: string, limit = MESSAGE_LIMIT): string[] {
	if (!Number.isInteger(limit) || limit < 2) throw new RangeError(`split limit must be an integer >= 2, got ${limit}`);
	if (text.length <= limit) return text === "" ? [] : [text];
	const parts: string[] = [];
	let pos = 0;
	let reopen: string | null = null;
	for (;;) {
		const { body, prefix, skipped } = partBody(text.slice(pos), reopen, pos > 0);
		if (body.length <= limit) {
			if (hasVisibleContent(body.slice(prefix))) parts.push(body.trimEnd());
			return parts;
		}
		const cut = cutPart(body, prefix, limit);
		if (cut.part !== "") parts.push(cut.part);
		pos += skipped + cut.next - prefix;
		reopen = cut.reopen;
	}
}

/** A part's text: the reopened fence line, if any, then the rest (continuations lose leading newlines). */
function partBody(
	rest: string,
	reopen: string | null,
	continuation: boolean,
): { body: string; prefix: number; skipped: number } {
	const content = continuation ? rest.replace(/^\n+/, "") : rest;
	const prefix = reopen === null ? "" : `${reopen}\n`;
	return { body: prefix + content, prefix: prefix.length, skipped: rest.length - content.length };
}

/** Cuts the first part off `body`, whose first `prefix` characters are a reopened fence line. */
function cutPart(body: string, prefix: number, limit: number): Cut {
	const fences = scanFences(body).filter((fence) => splittable(fence, limit));
	const minEnd = prefix + 1;
	let budget = limit;
	while (budget > minEnd) {
		const cut = avoidFenceLines(body, fences, findBreak(body, budget, minEnd), minEnd, budget, limit);
		const fence = fenceOpenAt(fences, cut.end);
		const head = body.slice(0, cut.end).trimEnd();
		const closer = fence ? `\n${"`".repeat(fence.ticks)}` : "";
		const size = head.length + closer.length;
		if (size <= limit) {
			const blank = !hasVisibleContent(body.slice(prefix, cut.end));
			return { part: blank ? "" : head + closer, next: cut.next, reopen: fence ? reopenLine(fence, limit) : null };
		}
		// Make room for the closing fence and try again.
		budget -= size - limit;
	}
	// Not reached for splittable fences; a plain cut keeps this finite whatever the input.
	const end = hardBreak(body, limit);
	return { part: body.slice(0, end).trimEnd(), next: end, reopen: null };
}

function findBreak(body: string, budget: number, minEnd: number): Break {
	const threshold = Math.max(minEnd, Math.floor(budget / 2));
	for (const separator of ["\n\n", "\n", " "]) {
		const at = body.lastIndexOf(separator, budget);
		if (at >= threshold) return { end: at, next: at + separator.length };
	}
	// No break in the second half: an earlier line break or space still beats cutting a word.
	for (const separator of ["\n", " "]) {
		const at = body.lastIndexOf(separator, budget);
		if (at >= minEnd) return { end: at, next: at + 1 };
	}
	const end = hardBreak(body, budget);
	return { end, next: end };
}

/** A cut at `at` that never splits a surrogate pair. */
function hardBreak(body: string, at: number): number {
	return isHighSurrogate(body.charCodeAt(at - 1)) && isLowSurrogate(body.charCodeAt(at)) ? at - 1 : at;
}

/**
 * Moves a break off fence lines: a part shouldn't end on an opening line (no code yet), and the
 * next part shouldn't start with the closing line (an empty block).
 */
function avoidFenceLines(
	body: string,
	fences: Fence[],
	cut: Break,
	minEnd: number,
	budget: number,
	limit: number,
): Break {
	const fence = fences.find((f) => f.open < cut.end && (f.closeEnd === null || cut.end < f.closeEnd));
	if (!fence) return cut;
	if (cut.end <= fence.openEnd + 1) {
		if (fence.open >= minEnd) return { end: fence.open, next: fence.open };
		// The block starts the part and its first line of code is too long to break at a line: cut inside it.
		const end = hardBreak(body, budget);
		if (end > fence.openEnd + 1) return { end, next: end };
	}
	if (fence.close === null || fence.closeEnd === null || body.slice(cut.next, fence.close).trim() !== "") return cut;
	// Only the closing line would be left: take it along if it fits...
	if (fence.closeEnd <= limit) return { end: fence.closeEnd, next: fence.closeEnd };
	// ...else leave the last line of code for the next part...
	let last = fence.close - 1;
	while (last > fence.openEnd && /\s/.test(body[last] ?? "")) last--;
	const newline = body.lastIndexOf("\n", last);
	if (newline > fence.openEnd && newline >= minEnd) return { end: newline, next: newline + 1 };
	// ...else move the whole block to the next part.
	if (fence.open >= minEnd) return { end: fence.open, next: fence.open };
	return fence.close >= minEnd ? { end: fence.close, next: fence.close } : cut;
}

/** The code block that is still open at `end`, if any. */
function fenceOpenAt(fences: Fence[], end: number): Fence | null {
	return fences.find((f) => end >= f.tickEnd && (f.close === null || end <= f.close)) ?? null;
}

/**
 * Closes a code block left open at the end, so the text renders as code: while streaming, and in
 * the final text of an answer that stopped inside one.
 */
function closeOpenFence(text: string): string {
	const last = scanFences(text).at(-1);
	if (!last || last.close !== null || last.ticks > MAX_DISPLAY_FENCE) return text;
	return `${text}\n${"`".repeat(last.ticks)}`;
}

// ---------------------------------------------------------------- streaming

export interface ReplyStreamerOptions {
	fluxer: FluxerApi;
	channelId: string;
	/** The triggering message; the first part replies to it. */
	replyTo: string;
	/** Whether the first part pings the author of `replyTo`. Later parts never ping. */
	pingReplied: boolean;
	log: Logger;
	clock?: Clock;
	/** Minimum time between edits (default 1,500 ms). */
	editIntervalMs?: number;
	/** How often the typing indicator is refreshed until the first post (default 8,000 ms). */
	typingIntervalMs?: number;
	/** Suppress link previews (default true). */
	suppressEmbeds?: boolean;
}

type PartState =
	/** Streaming may edit it. */
	| "ok"
	/** The instance's content filter refused its text: it shows a notice, and streaming leaves it alone. */
	| "blocked"
	/** Its message was deleted (404): it is never edited again and its ID isn't returned. */
	| "gone";

interface Part {
	id: string;
	/** What the message shows now, as far as we know. */
	content: string;
	/** Sent again on every edit: edits re-parse mentions. */
	pingReplied: boolean;
	state: PartState;
}

/**
 * Shows an answer while Claude writes it. One request at a time, edits at most once per
 * `editIntervalMs`, and the latest state wins. Long answers roll over into more messages, each
 * replying to the one before. Parts are cut exactly where `splitMessage` cuts the final text, so
 * `finish`, which puts the final text in place and returns the message IDs, usually only has to
 * edit the last one.
 */
export class ReplyStreamer {
	private readonly fluxer: FluxerApi;
	private readonly log: Logger;
	private readonly clock: Clock;
	private readonly editIntervalMs: number;
	private readonly typingIntervalMs: number;
	private readonly suppressEmbeds: boolean;

	/** Posted messages, in order. */
	private parts: Part[] = [];
	/** Parts before this index hold their final streamed text; the one at it (if posted) is live. */
	private frozen = 0;
	/** Where the live part's text starts in `text`, and the fence line it reopens, if any. */
	private liveStart = 0;
	private liveReopen: string | null = null;

	private text = "";
	private tool: ToolStatus | null = null;
	private streaming = true;
	private typingStarted = false;
	private typingTimer: ReturnType<typeof setTimeout> | null = null;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private dirty = false;
	private inFlight: Promise<void> | null = null;
	private lastRequestAt: number | null = null;
	private finishing: Promise<string[]> | null = null;

	constructor(private readonly opts: ReplyStreamerOptions) {
		this.fluxer = opts.fluxer;
		this.log = opts.log;
		this.clock = opts.clock ?? systemClock;
		this.editIntervalMs = opts.editIntervalMs ?? 1500;
		this.typingIntervalMs = opts.typingIntervalMs ?? 8000;
		this.suppressEmbeds = opts.suppressEmbeds ?? true;
	}

	/** Shows the typing indicator now and every `typingIntervalMs` until the first message is posted. */
	start(): void {
		if (!this.streaming || this.typingStarted) return;
		this.typingStarted = true;
		this.typingTick();
	}

	/** The full answer text so far. It should only grow; finish() puts anything else right. */
	update(text: string): void {
		if (!this.streaming) return;
		this.text = text;
		this.changed();
	}

	/** The tool that is running now, or null when none is. */
	status(status: ToolStatus | null): void {
		if (!this.streaming) return;
		this.tool = status;
		this.changed();
	}

	/**
	 * Replaces whatever was streamed with the final text (split into parts; text without anything
	 * visible gets a short notice) and returns the IDs of all parts in order. Never rejects. Works
	 * after stop(). A later call replaces the content again, e.g. with an error notice.
	 */
	finish(finalText: string): Promise<string[]> {
		this.halt();
		const previous = this.finishing ?? Promise.resolve([]);
		this.finishing = previous.catch(() => []).then(() => this.finalize(finalText));
		return this.finishing;
	}

	/** Stops typing and streaming; nothing more is posted except by finish(). Idempotent. */
	stop(): void {
		this.halt();
	}

	// ------------------------------------------------ typing

	private typingTick(): void {
		this.typingTimer = null;
		if (!this.streaming || this.parts.length > 0) return;
		void this.sendTyping();
		this.typingTimer = setTimeout(() => this.typingTick(), this.typingIntervalMs);
	}

	private async sendTyping(): Promise<void> {
		try {
			await this.fluxer.triggerTyping(this.opts.channelId);
		} catch (err) {
			this.log.warn("typing indicator failed", { channelId: this.opts.channelId, err });
		}
	}

	private halt(): void {
		this.streaming = false;
		if (this.typingTimer) clearTimeout(this.typingTimer);
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.typingTimer = null;
		this.flushTimer = null;
	}

	// ------------------------------------------------ streaming edits

	private changed(): void {
		this.dirty = true;
		this.pump(false);
	}

	/** Starts a flush if one is due, or schedules one. `timerFired` skips the clock check (the wait is over). */
	private pump(timerFired: boolean): void {
		if (!this.streaming || !this.dirty || this.inFlight || this.flushTimer) return;
		if (!timerFired && this.lastRequestAt !== null) {
			// Capped, in case the clock went backwards.
			const wait = Math.min(this.lastRequestAt + this.editIntervalMs - this.clock.now(), this.editIntervalMs);
			if (wait > 0) {
				this.flushTimer = setTimeout(() => {
					this.flushTimer = null;
					this.pump(true);
				}, wait);
				return;
			}
		}
		this.dirty = false;
		this.inFlight = this.flush()
			.catch((err: unknown) => this.log.error("streaming update failed", { channelId: this.opts.channelId, err }))
			.finally(() => {
				this.inFlight = null;
				this.pump(false);
			});
	}

	/** Brings the messages up to date with the latest state, freezing full parts first. */
	private async flush(): Promise<void> {
		while (this.streaming) {
			const { body, prefix, skipped } = partBody(this.text.slice(this.liveStart), this.liveReopen, this.liveStart > 0);
			if (body.length <= MESSAGE_LIMIT) {
				const view = this.liveView(body, prefix);
				if (view !== null) await this.showLive(view);
				return;
			}
			// The text outgrew this part: give it its final piece and continue in the next part.
			const cut = cutPart(body, prefix, MESSAGE_LIMIT);
			// If that request failed, the next flush tries the same piece again (skipping it would leave a gap).
			if (cut.part !== "" && !(await this.freeze(cut.part))) return;
			this.liveStart += skipped + cut.next - prefix;
			this.liveReopen = cut.reopen;
		}
	}

	/** The live part: its text (with an open code block closed) and the status line; null if it can't fit. */
	private liveView(body: string, prefix: number): string | null {
		const text = hasVisibleContent(body.slice(prefix)) ? closeOpenFence(body.trimEnd()) : "";
		const status = this.tool ? statusLine(this.tool) : "";
		const full = text !== "" && status !== "" ? `${text}\n\n${status}` : text || status;
		if (full.length <= MESSAGE_LIMIT) return full;
		// A nearly full part may have no room for the status line, or even for the temporary closing
		// fence: show the text alone, or keep the last view until the part rolls over.
		return text.length <= MESSAGE_LIMIT ? text : null;
	}

	private async showLive(content: string): Promise<void> {
		if (content === "") return;
		const live = this.parts[this.frozen];
		if (!live) {
			await this.streamPost(content);
		} else if (live.state === "ok" && live.content !== content) {
			await this.streamEdit(live, content);
		}
	}

	/** Gives the live part (or a new one) its final streamed text. False if the request failed. */
	private async freeze(content: string): Promise<boolean> {
		const live = this.parts[this.frozen];
		const done = live
			? live.state !== "ok" || live.content === content || (await this.streamEdit(live, content))
			: await this.streamPost(content);
		if (done) this.frozen++;
		return done;
	}

	/** Posts the next part. True when a message was posted, with the text or the content filter notice. */
	private async streamPost(content: string): Promise<boolean> {
		this.lastRequestAt = this.clock.now();
		try {
			this.addPart(await this.send(content), content, "ok");
			return true;
		} catch (err) {
			if (!isContentBlocked(err)) {
				this.log.warn("posting a reply part failed", { channelId: this.opts.channelId, part: this.parts.length, err });
				return false;
			}
		}
		const notice = notices.blocked();
		try {
			this.addPart(await this.send(notice), notice, "blocked");
			return true;
		} catch (err) {
			this.log.warn("posting the content filter notice failed", { channelId: this.opts.channelId, err });
			return false;
		}
	}

	/** Edits a streamed part. True when the part is settled: edited, blocked, or deleted. */
	private async streamEdit(part: Part, content: string): Promise<boolean> {
		this.lastRequestAt = this.clock.now();
		try {
			await this.edit(part, content);
			part.content = content;
			return true;
		} catch (err) {
			if (this.markGone(part, err)) return true;
			if (!isContentBlocked(err)) {
				// The next edit carries the latest state anyway.
				this.log.warn("streaming edit failed", { channelId: this.opts.channelId, messageId: part.id, err });
				return false;
			}
		}
		part.state = "blocked";
		const notice = notices.blocked();
		if (part.content === notice) return true;
		try {
			await this.edit(part, notice);
			part.content = notice;
		} catch (err) {
			if (!this.markGone(part, err)) {
				this.log.warn("showing the content filter notice failed", {
					channelId: this.opts.channelId,
					messageId: part.id,
					err,
				});
			}
		}
		return true;
	}

	/** Marks a part whose message was deleted (by a moderator, say). True if `err` says so. */
	private markGone(part: Part, err: unknown): boolean {
		if (!isGone(err)) return false;
		part.state = "gone";
		this.log.warn("a reply part was deleted; leaving it out", { channelId: this.opts.channelId, messageId: part.id });
		return true;
	}

	// ------------------------------------------------ final state

	private async finalize(finalText: string): Promise<string[]> {
		await this.inFlight;
		const wanted = splitMessage(hasVisibleContent(finalText) ? finalText : notices.empty());
		const posted = this.parts;
		const final: Part[] = [];
		for (const [i, content] of wanted.entries()) {
			const existing = posted[i];
			if (existing) {
				if (existing.state !== "gone" && existing.content !== content) await this.finalEdit(existing, content);
				final.push(existing);
			} else {
				const part = await this.finalPost(content, final.at(-1)?.id ?? null);
				if (part) final.push(part);
			}
		}
		const leftover: Part[] = [];
		for (const part of posted.slice(wanted.length)) {
			if (part.state !== "gone" && !(await this.deleteSurplus(part))) leftover.push(part);
		}
		// Keep undeleted parts after the final ones, so a later finish() can reuse or delete them.
		this.parts = [...final, ...leftover];
		this.frozen = this.parts.length;
		// A deleted part's text isn't posted again: whoever deleted it presumably meant to.
		return final.filter((part) => part.state !== "gone").map((part) => part.id);
	}

	private async finalEdit(part: Part, content: string): Promise<void> {
		try {
			await this.withRetry("final edit", () => this.edit(part, content));
			part.content = content;
			part.state = "ok";
			return;
		} catch (err) {
			if (this.markGone(part, err)) return;
			if (!isContentBlocked(err)) {
				this.log.error("final edit failed", { channelId: this.opts.channelId, messageId: part.id, err });
				return;
			}
		}
		part.state = "blocked";
		const notice = notices.blocked();
		if (part.content === notice) return;
		try {
			await this.withRetry("final edit", () => this.edit(part, notice));
			part.content = notice;
		} catch (err) {
			if (!this.markGone(part, err)) {
				this.log.error("showing the content filter notice failed", {
					channelId: this.opts.channelId,
					messageId: part.id,
					err,
				});
			}
		}
	}

	/** Posts a final part replying to `after` (or to the trigger when it's the first part). */
	private async finalPost(content: string, after: string | null): Promise<Part | null> {
		const pingReplied = after === null && this.opts.pingReplied;
		const replyTo = after ?? this.opts.replyTo;
		// No retry here: the client already retries a send with the same nonce, so the server can drop a
		// duplicate. Another send would get a new nonce and could post the part twice.
		const post = async (text: string, state: PartState): Promise<Part> => {
			const { id } = await this.fluxer.sendMessage(this.opts.channelId, {
				content: text,
				replyTo,
				pingReplied,
				suppressEmbeds: this.suppressEmbeds,
			});
			return { id, content: text, pingReplied, state };
		};
		try {
			return await post(content, "ok");
		} catch (err) {
			if (!isContentBlocked(err)) {
				this.log.error("posting a reply part failed", { channelId: this.opts.channelId, err });
				return null;
			}
		}
		try {
			return await post(notices.blocked(), "blocked");
		} catch (err) {
			this.log.error("posting the content filter notice failed", { channelId: this.opts.channelId, err });
			return null;
		}
	}

	/** True when the message is gone afterwards (deleted now, or already). */
	private async deleteSurplus(part: Part): Promise<boolean> {
		try {
			await this.fluxer.deleteMessage(this.opts.channelId, part.id);
			return true;
		} catch (err) {
			if (isGone(err)) return true;
			this.log.warn("deleting a surplus reply part failed", {
				channelId: this.opts.channelId,
				messageId: part.id,
				err,
			});
			return false;
		}
	}

	/**
	 * One retry of an edit after a short pause, for failures that may pass: no response at all, or a
	 * server error. Edits are safe to repeat, and the client doesn't retry them itself.
	 */
	private async withRetry<T>(what: string, request: () => Promise<T>): Promise<T> {
		try {
			return await request();
		} catch (err) {
			if (!isRetryable(err)) throw err;
			this.log.warn(`${what} failed, retrying`, { channelId: this.opts.channelId, err });
			await new Promise((resolve) => setTimeout(resolve, FINAL_RETRY_DELAY_MS));
			return await request();
		}
	}

	// ------------------------------------------------ requests

	/** Sends a streaming part: the first replies to the trigger, the others to the part before. */
	private send(content: string): Promise<{ id: string }> {
		const previous = this.parts.at(-1);
		return this.fluxer.sendMessage(this.opts.channelId, {
			content,
			replyTo: previous ? previous.id : this.opts.replyTo,
			pingReplied: previous ? false : this.opts.pingReplied,
			suppressEmbeds: this.suppressEmbeds,
		});
	}

	private addPart(sent: { id: string }, content: string, state: PartState): void {
		this.parts.push({ id: sent.id, content, pingReplied: this.parts.length === 0 && this.opts.pingReplied, state });
		if (this.typingTimer) clearTimeout(this.typingTimer);
		this.typingTimer = null;
	}

	private edit(part: Part, content: string): Promise<void> {
		return this.fluxer.editMessage(this.opts.channelId, part.id, {
			content,
			pingReplied: part.pingReplied,
			suppressEmbeds: this.suppressEmbeds,
		});
	}
}

function isContentBlocked(err: unknown): boolean {
	return err instanceof FluxerRequestError && err.code === "CONTENT_BLOCKED";
}

/** The message (or its channel) doesn't exist any more. */
function isGone(err: unknown): boolean {
	return err instanceof FluxerRequestError && err.status === 404;
}

/** A 4xx answer (blocked, deleted, invalid, rate limited for too long) won't change on a retry. */
function isRetryable(err: unknown): boolean {
	return !(err instanceof FluxerRequestError) || err.status === null || err.status >= 500;
}
