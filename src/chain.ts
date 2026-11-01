// SPDX-License-Identifier: AGPL-3.0-or-later
// Reply chains: walk from the trigger toward the root, render Fluxer messages into API
// messages, estimate their size, and assemble the request either as an exact replay of an
// earlier request plus one new user turn, or rebuilt from Fluxer text.

import type { NoticeIds, ReplayCache, ReplayEntry } from "./replay.js";
import { formatDate, formatLabelTime, weekday } from "./time.js";
import {
	type ChatAttachment,
	type ChatMessage,
	type ChatUser,
	type ContentBlockParam,
	type FluxerApi,
	FluxerRequestError,
	type LogFields,
	type Logger,
	type MessageParam,
} from "./types.js";

// ---------------------------------------------------------------- constants

/** Token budget for an image whose dimensions are unknown (just above the per-image maximum). */
export const IMAGE_TOKENS = 4800;
/** Most visual tokens one image can cost: larger images are downscaled by the API. */
export const MAX_IMAGE_TOKENS = 4784;
/** Images are downscaled to fit this long edge (pixels). */
const MAX_IMAGE_EDGE = 2576;
/** Each 28×28 patch is one visual token. */
const PATCH = 28;
/** The API rejects images larger than this on either side (pixels). */
const MAX_IMAGE_SIDE = 8000;
/** Largest attachment sent as an image (bytes); 5 MiB is about 7 MB as base64, under the API's 10 MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** All images of one request together, raw bytes: about 90 MB as base64, inside the API's 128 MB request limit. */
const MAX_REQUEST_IMAGE_BYTES = 64 * 1024 * 1024;
/** Image downloads running at the same time. */
const DOWNLOAD_CONCURRENCY = 3;

/** First user turn when a chain would otherwise start with an assistant turn. */
export const EARLIER_MESSAGES_UNAVAILABLE = "[Earlier messages aren't available.]";

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
const IMAGE_TYPES: ReadonlySet<string> = new Set<ImageMediaType>([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

// ---------------------------------------------------------------- public types

export interface ChainDeps {
	fluxer: Pick<FluxerApi, "fetchMessage" | "download" | "guild" | "channelName">;
	botId: string;
	replay: Pick<ReplayCache, "get">;
	notices: Pick<NoticeIds, "has">;
	/** Config fingerprint; replay entries made with another config are ignored. */
	fingerprint: string;
	timezone: string;
	log: Logger;
}

export interface ChainLimits {
	maxMessages: number;
	maxChainTokens: number;
	maxImages: number;
}

export type BuildResult =
	| {
			ok: true;
			mode: "replay" | "rebuilt";
			messages: MessageParam[];
			/** Estimated size of `messages` (replay mode: the entry's real size plus the new turn's estimate). */
			tokens: number;
			/** Fluxer messages rendered in this request (replay mode: only those after the anchor). */
			count: number;
			/** The bot message whose replay entry was used; null in rebuilt mode. */
			anchorId: string | null;
	  }
	| {
			ok: false;
			reason: "too_long";
			/** Values when the walk stopped, so they are lower bounds of the whole chain. */
			tokens: number;
			count: number;
	  };

// ---------------------------------------------------------------- estimates

/** Conservative token estimate for text: 2 UTF-8 bytes per token (the real average is about 2.5 characters). */
export function estimateTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 2);
}

/**
 * Visual tokens of an image: one per 28×28 patch after the API's downscaling; unknown size → IMAGE_TOKENS.
 * The API shrinks to the largest size within both limits; scaling to the long edge and then capping
 * the tokens never comes out below that, so this errs high by a few patches at most.
 */
export function imageTokens(width: number | null, height: number | null): number {
	if (!isDimension(width) || !isDimension(height)) return IMAGE_TOKENS;
	const long = Math.max(width, height);
	// Multiply before dividing so exact results (like the long edge itself) stay exact.
	const w = long > MAX_IMAGE_EDGE ? Math.ceil((width * MAX_IMAGE_EDGE) / long) : width;
	const h = long > MAX_IMAGE_EDGE ? Math.ceil((height * MAX_IMAGE_EDGE) / long) : height;
	return Math.min(Math.ceil(w / PATCH) * Math.ceil(h / PATCH), MAX_IMAGE_TOKENS);
}

function isDimension(n: number | null): n is number {
	return n !== null && Number.isFinite(n) && n > 0;
}

/**
 * Largest attachment sent as an image: MAX_IMAGE_BYTES, or less when max_images is high, so that
 * a request (which never carries more than max_images images) stays under the API's size limit.
 */
export function imageByteLimit(maxImages: number): number {
	return Math.min(MAX_IMAGE_BYTES, Math.floor(MAX_REQUEST_IMAGE_BYTES / Math.max(1, maxImages)));
}

// ---------------------------------------------------------------- rendering helpers

/** The name used in labels and mentions: display name, else username. Never the guild nickname. */
export function displayName(user: Pick<ChatUser, "globalName" | "username">): string {
	return oneLine(user.globalName ?? "") || oneLine(user.username) || "unknown-user";
}

/** The first block of the newest user turn: where the conversation is and what day it is there. */
export function contextLine(
	trigger: ChatMessage,
	guildName: string | null,
	channelName: string | null,
	timezone: string,
): string {
	const ts = Date.parse(trigger.timestamp);
	const day = Number.isFinite(ts) ? `${weekday(ts, timezone)}, ${formatDate(ts, timezone)}` : "unknown date";
	if (trigger.isGroupDm) return `[Context: group DM, ${day}]`;
	if (trigger.isDm || trigger.guildId === null) return `[Context: direct message, ${day}]`;
	const guild = oneLine(guildName ?? "") || "unknown";
	const channel = oneLine(channelName ?? "") || "unknown";
	return `[Context: community "${guild}", channel #${channel}, ${day}]`;
}

/** "12 KB", "1.5 MB" (binary units, as chat apps show them). */
export function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
	const kb = bytes === 0 ? 0 : Math.max(1, Math.round(bytes / 1024));
	if (kb < 1024) return `${kb} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Names go inside one-line labels: line breaks and control characters become spaces. */
function oneLine(text: string): string {
	return text
		.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

/** One pass, so a resolved name that looks like markup is never resolved again. */
const MENTION = /<(@!?|@&|#)(\d+)>/g;

function resolveMentions(msg: ChatMessage, channelName: (id: string) => string | undefined): string {
	if (!msg.content.includes("<")) return msg.content;
	const users = new Map(msg.mentions.map((u) => [u.id, displayName(u)]));
	return msg.content.replace(MENTION, (_match, kind: string, id: string) => {
		if (kind === "@&") return "@role";
		if (kind === "#") return `#${oneLine(channelName(id) ?? "") || "channel"}`;
		return `@${users.get(id) ?? "unknown-user"}`;
	});
}

function labelTime(msg: ChatMessage, timezone: string): string {
	const ts = Date.parse(msg.timestamp);
	return Number.isFinite(ts) ? formatLabelTime(ts, timezone) : "unknown time";
}

function mediaType(contentType: string | null): ImageMediaType | null {
	const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
	return IMAGE_TYPES.has(type) ? (type as ImageMediaType) : null;
}

/** Attachments the API can take as images. Everything else is listed by name. */
function isImageCandidate(a: ChatAttachment, maxBytes: number): boolean {
	return (
		mediaType(a.contentType) !== null &&
		a.url !== "" && // expired
		a.size <= maxBytes &&
		(a.width ?? 0) <= MAX_IMAGE_SIDE &&
		(a.height ?? 0) <= MAX_IMAGE_SIDE
	);
}

function attachmentLine(a: ChatAttachment, failed: boolean): string {
	const type = oneLine(a.contentType ?? "") || "unknown type";
	const name = oneLine(a.filename) || "unnamed";
	return `[attachment: ${name} (${type}, ${formatSize(a.size)})${failed ? " (couldn't load)" : ""}]`;
}

/** Identifies the image format from its first bytes, so media_type always matches the data. */
function sniffImageType(data: Buffer): ImageMediaType | null {
	const starts = (bytes: number[], at = 0) => bytes.every((b, i) => data[at + i] === b);
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
	if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif"; // "GIF8"
	if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp"; // "RIFF....WEBP"
	return null;
}

function textBlock(text: string): ContentBlockParam {
	return { type: "text", text };
}

// ---------------------------------------------------------------- build state

interface UserItem {
	role: "user";
	msg: ChatMessage;
	/** Attachments chosen to be sent as images. */
	images: ChatAttachment[];
}

interface AnswerItem {
	role: "assistant";
	msg: ChatMessage;
}

type Item = UserItem | AnswerItem;

interface Anchor {
	msg: ChatMessage;
	entry: ReplayEntry;
}

interface Walk {
	/** Chain messages from the trigger back toward the root (newest first); notices left out. */
	items: Item[];
	/** Running estimate including the context line, assuming every chosen image loads. */
	tokens: number;
	tooLong: boolean;
	anchor: Anchor | null;
}

/** State for one buildChain call. Fetched messages and downloaded images are reused by a second walk. */
interface Build {
	trigger: ChatMessage;
	deps: ChainDeps;
	limits: ChainLimits;
	context: string;
	/** Largest attachment sent as an image. */
	imageBytes: number;
	/** Message ID → message, or null when it couldn't be fetched. */
	fetched: Map<string, ChatMessage | null>;
	fetches: number;
	/** Attachment ID → image block, or null when it couldn't be loaded. */
	images: Map<string, ContentBlockParam | null>;
	/** Parents given by the caller (thread conversations, which have no replies): message ID → parent, null = root. */
	parents: ReadonlyMap<string, ChatMessage | null>;
}

export interface BuildOptions {
	/** Ignore replay entries and render the whole chain from Fluxer text. */
	forceRebuild?: boolean;
	/**
	 * Parents to use instead of replies, by message ID (null = the chain starts there). Threads have no
	 * replies, so a thread conversation links each message to the one before it, and the first to the
	 * message the thread started from. Other messages follow their replies as usual.
	 */
	parents?: ReadonlyMap<string, ChatMessage | null>;
}

// ---------------------------------------------------------------- buildChain

/**
 * Builds the `messages` for a request answering `trigger`.
 *
 * The walk stops at the first Claude answer (the anchor). If that answer has a live replay entry
 * made with the same config, the request is the entry's exact messages and answer plus one new
 * user turn ("replay"). Otherwise the whole chain is rendered from Fluxer text ("rebuilt").
 * Fluxer errors other than "message not found" propagate to the caller.
 */
export async function buildChain(
	trigger: ChatMessage,
	deps: ChainDeps,
	limits: ChainLimits,
	opts: BuildOptions = {},
): Promise<BuildResult> {
	const build: Build = {
		trigger,
		deps,
		limits,
		context: triggerContext(trigger, deps),
		imageBytes: imageByteLimit(limits.maxImages),
		fetched: new Map(),
		fetches: 0,
		images: new Map(),
		parents: opts.parents ?? new Map(),
	};
	const first = await walk(build, !opts.forceRebuild);
	if (!first.tooLong && first.anchor) {
		const replayed = await replay(build, first, first.anchor);
		if (replayed) return replayed;
		return rebuild(build, await walk(build, false));
	}
	return rebuild(build, first);
}

function triggerContext(trigger: ChatMessage, deps: ChainDeps): string {
	if (trigger.isDm || trigger.guildId === null) return contextLine(trigger, null, null, deps.timezone);
	const guild = deps.fluxer.guild(trigger.guildId);
	const channel = deps.fluxer.channelName(trigger.channelId) ?? guild?.channels.get(trigger.channelId) ?? null;
	return contextLine(trigger, guild?.name ?? null, channel, deps.timezone);
}

/** Walks from the trigger toward the root, stopping early at an anchor or when a limit is exceeded. */
async function walk(build: Build, useReplay: boolean): Promise<Walk> {
	const { deps, limits, trigger } = build;
	const items: Item[] = [];
	const seen = new Set<string>();
	let tokens = estimateTokens(build.context);
	let imagesLeft = limits.maxImages;
	let anchorPending = useReplay;

	let msg: ChatMessage | null = trigger;
	while (msg) {
		if (seen.has(msg.id)) {
			deps.log.warn("reply chain loops back on itself", { messageId: msg.id });
			break;
		}
		seen.add(msg.id);

		const fromBot = msg !== trigger && msg.author.id === deps.botId;
		if (msg !== trigger && deps.notices.has(msg.id)) {
			// Notices, command replies and the commands themselves aren't context; the chain goes on above them.
		} else if (fromBot) {
			if (anchorPending) {
				// Only the answer nearest to the trigger can anchor a replay.
				anchorPending = false;
				const entry = deps.replay.get(msg.id, deps.fingerprint);
				if (entry) return { items, tokens, tooLong: false, anchor: { msg, entry } };
			}
			items.push({ role: "assistant", msg });
			tokens += estimateTokens(answerText(msg));
		} else {
			const images =
				imagesLeft > 0 ? msg.attachments.filter((a) => isImageCandidate(a, build.imageBytes)).slice(0, imagesLeft) : [];
			imagesLeft -= images.length;
			items.push({ role: "user", msg, images });
			tokens += estimateTokens(userText(build, msg, images, () => false)) + sumImageTokens(images);
		}

		if (items.length > limits.maxMessages || tokens > limits.maxChainTokens) {
			return { items, tokens, tooLong: true, anchor: null };
		}
		msg = await parentOf(build, msg);
	}
	return { items, tokens, tooLong: false, anchor: null };
}

/**
 * The message `msg` replies to: the copy in the payload if present, else fetched (once per build).
 * Fluxer replies always stay in their channel, so a hop into another channel (a forward, say) ends
 * the chain: context never comes from a channel or community the operator didn't allow.
 */
async function parentOf(build: Build, msg: ChatMessage): Promise<ChatMessage | null> {
	if (build.parents.has(msg.id)) return build.parents.get(msg.id) ?? null;
	const ref = msg.reference;
	const parentChannel = msg.referenced ? msg.referenced.channelId : ref?.channelId;
	if (parentChannel && parentChannel !== msg.channelId) {
		build.deps.log.warn("reply chain points into another channel; stopping there", { messageId: msg.id });
		return null;
	}
	if (msg.referenced !== undefined) return msg.referenced; // null: deleted
	if (!ref) return null; // root
	const known = build.fetched.get(ref.messageId);
	if (known !== undefined) return known;
	build.fetches++;
	const parent = await build.deps.fluxer.fetchMessage(msg.channelId, ref.messageId);
	build.fetched.set(ref.messageId, parent);
	return parent;
}

/** Exact replay: the entry's messages and answer, then the messages after the anchor as one new user turn. */
async function replay(build: Build, walked: Walk, anchor: Anchor): Promise<BuildResult | null> {
	const { deps, limits } = build;
	const { items } = walked;
	const { entry } = anchor;
	const fallBack = (why: string, fields: LogFields) => {
		deps.log.info(`replayed chain ${why}; rebuilding from text`, { anchorId: anchor.msg.id, ...fields });
		return null;
	};
	const overBudget = (tokens: number) => fallBack("over budget", { tokens, maxChainTokens: limits.maxChainTokens });

	// A request never carries more than max_images images, replayed ones included (the rebuilt
	// chain keeps the newest). That also keeps requests under the API's many-image and size limits.
	const images = countImageBlocks(entry.messages) + countChosenImages(items);
	if (images > limits.maxImages) return fallBack("has too many images", { images, maxImages: limits.maxImages });

	// The message limit covers the whole chain, the replayed part included.
	const count = (entry.count ?? 0) + items.length;
	if (count > limits.maxMessages) return fallBack("has too many messages", { count, maxMessages: limits.maxMessages });

	// With every chosen image loaded the estimate is exact, so skip downloads when it can't fit.
	const estimate = entry.tokens + walked.tokens;
	if (estimate > limits.maxChainTokens) return overBudget(estimate);

	await loadImages(build, items);
	const turn = assemble(build, items);
	const tokens = entry.tokens + turn.tokens;
	if (tokens > limits.maxChainTokens) return overBudget(tokens);

	const messages: MessageParam[] = [
		...withReplayMarker(entry.messages),
		...entry.assistant.map((piece): MessageParam => ({ role: "assistant", content: piece })),
		...turn.messages,
	];
	logBuilt(build, "replay", items, tokens);
	return { ok: true, mode: "replay", messages, tokens, count, anchorId: anchor.msg.id };
}

/** Rebuilt mode: the whole chain rendered from Fluxer text. */
async function rebuild(build: Build, walked: Walk): Promise<BuildResult> {
	const { limits } = build;
	if (walked.tooLong) {
		build.deps.log.debug("reply chain too long", { count: walked.items.length, tokens: walked.tokens });
		return { ok: false, reason: "too_long", tokens: walked.tokens, count: walked.items.length };
	}
	await loadImages(build, walked.items);
	const { messages, tokens } = assemble(build, walked.items);
	const count = walked.items.length;
	if (tokens > limits.maxChainTokens) return { ok: false, reason: "too_long", tokens, count };
	logBuilt(build, "rebuilt", walked.items, tokens);
	return { ok: true, mode: "rebuilt", messages, tokens, count, anchorId: null };
}

function logBuilt(build: Build, mode: "replay" | "rebuilt", items: Item[], tokens: number): void {
	let images = 0;
	for (const item of items) {
		if (item.role === "user") images += item.images.filter((a) => build.images.get(a.id)).length;
	}
	build.deps.log.debug("reply chain built", { mode, count: items.length, tokens, images, fetches: build.fetches });
}

// ---------------------------------------------------------------- assembling turns

/**
 * Renders walked items (newest first) into API messages, oldest first. Consecutive messages
 * with the same role share a turn; the newest user turn starts with the context line; a chain
 * that would start with an assistant turn gets a fixed first user turn.
 */
function assemble(build: Build, newestFirst: Item[]): { messages: MessageParam[]; tokens: number } {
	const groups = groupByRole([...newestFirst].reverse());
	const messages: MessageParam[] = [];
	let tokens = 0;

	if (groups[0]?.[0]?.role === "assistant") {
		messages.push({ role: "user", content: [textBlock(EARLIER_MESSAGES_UNAVAILABLE)] });
		tokens += estimateTokens(EARLIER_MESSAGES_UNAVAILABLE);
	}
	groups.forEach((group, i) => {
		const isNewest = i === groups.length - 1;
		const turn = renderTurn(build, group, isNewest);
		messages.push(turn.message);
		tokens += turn.tokens;
	});
	return { messages, tokens };
}

function groupByRole(items: Item[]): Item[][] {
	const groups: Item[][] = [];
	for (const item of items) {
		const last = groups.at(-1);
		if (last?.[0]?.role === item.role) last.push(item);
		else groups.push([item]);
	}
	return groups;
}

function renderTurn(build: Build, group: Item[], isNewest: boolean): { message: MessageParam; tokens: number } {
	if (group[0]?.role === "assistant") {
		// A reply split into several Fluxer messages (or answers in a row) is one assistant turn.
		const text = group.map((item) => answerText(item.msg)).join("\n");
		return { message: { role: "assistant", content: [textBlock(text)] }, tokens: estimateTokens(text) };
	}
	const content: ContentBlockParam[] = [];
	let tokens = 0;
	if (isNewest) {
		content.push(textBlock(build.context));
		tokens += estimateTokens(build.context);
	}
	for (const item of group) {
		if (item.role !== "user") continue;
		const loaded = item.images.filter((a) => build.images.get(a.id));
		const text = userText(build, item.msg, item.images, (a) => !build.images.get(a.id));
		content.push(textBlock(text));
		tokens += estimateTokens(text) + sumImageTokens(loaded);
		for (const a of loaded) {
			const block = build.images.get(a.id);
			if (block) content.push(block);
		}
	}
	return { message: { role: "user", content }, tokens };
}

/**
 * "[Name · 2026-11-01 14:05 PST]" and the message text with mentions resolved, then a line per
 * attachment that isn't sent as an image. `failed` marks chosen images that couldn't be loaded.
 */
function userText(
	build: Build,
	msg: ChatMessage,
	images: ChatAttachment[],
	failed: (a: ChatAttachment) => boolean,
): string {
	const { deps } = build;
	const lines = [`[${displayName(msg.author)} · ${labelTime(msg, deps.timezone)}]`];
	const content = resolveMentions(msg, (id) => deps.fluxer.channelName(id));
	if (content.trim() !== "") lines.push(content);
	let sentImages = 0;
	for (const a of msg.attachments) {
		const chosen = images.includes(a);
		if (chosen && !failed(a)) sentImages++;
		else lines.push(attachmentLine(a, chosen));
	}
	if (lines.length === 1 && sentImages === 0) lines.push("(no text)");
	return lines.join("\n");
}

/** The bot's answer as posted in Fluxer (the API rejects empty text blocks). */
function answerText(msg: ChatMessage): string {
	return msg.content.trim() === "" ? "(no text)" : msg.content;
}

function sumImageTokens(images: ChatAttachment[]): number {
	return images.reduce((sum, a) => sum + imageTokens(a.width, a.height), 0);
}

function countChosenImages(items: Item[]): number {
	return items.reduce((sum, item) => sum + (item.role === "user" ? item.images.length : 0), 0);
}

function countImageBlocks(messages: readonly MessageParam[]): number {
	let count = 0;
	for (const m of messages) {
		if (typeof m.content === "string") continue;
		for (const block of m.content) if (block.type === "image") count++;
	}
	return count;
}

// ---------------------------------------------------------------- replay prefix

/**
 * A copy of a replay entry's messages for the next request: earlier cache markers removed, and a
 * 5-minute marker on the last block of the last user turn, where the previous request's automatic
 * breakpoint wrote. Unchanged messages and blocks are shared, the stored entry is never modified.
 */
function withReplayMarker(messages: readonly MessageParam[]): MessageParam[] {
	const lastUser = messages.findLastIndex((m) => m.role === "user");
	return messages.map((message, i) => {
		const isTarget = i === lastUser;
		if (message.role === "system") return message; // never produced by Clanker
		if (typeof message.content === "string") {
			if (!isTarget) return message;
			return { ...message, content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }] };
		}
		let changed = false;
		const content = message.content.map((block, j) => {
			const target = isTarget && j === message.content.length - 1;
			const next = target ? withMarker(block) : withoutMarker(block);
			if (next !== block) changed = true;
			return next;
		});
		return changed ? { ...message, content } : message;
	});
}

function withoutMarker(block: ContentBlockParam): ContentBlockParam {
	if (!("cache_control" in block) || block.cache_control === undefined) return block;
	const { cache_control: _marker, ...rest } = block;
	return rest as ContentBlockParam; // TS widens the rest of a union; it is the same block without the key
}

function withMarker(block: ContentBlockParam): ContentBlockParam {
	if (block.type === "thinking" || block.type === "redacted_thinking") return block; // can't carry a marker
	const rest = withoutMarker(block);
	return { ...rest, cache_control: { type: "ephemeral" } } as ContentBlockParam;
}

// ---------------------------------------------------------------- images

/** Downloads the chosen images not loaded yet in this build, a few at a time. */
async function loadImages(build: Build, items: Item[]): Promise<void> {
	const todo: Array<{ msg: ChatMessage; attachment: ChatAttachment }> = [];
	for (const item of items) {
		if (item.role !== "user") continue;
		for (const attachment of item.images) {
			if (!build.images.has(attachment.id)) todo.push({ msg: item.msg, attachment });
		}
	}
	await forEachLimit(todo, DOWNLOAD_CONCURRENCY, async ({ msg, attachment }) => {
		build.images.set(attachment.id, await loadImage(build, msg, attachment));
	});
}

async function loadImage(build: Build, msg: ChatMessage, a: ChatAttachment): Promise<ContentBlockParam | null> {
	const { log } = build.deps;
	const ids = { messageId: msg.id, attachmentId: a.id };
	try {
		const { data } = await build.deps.fluxer.download(a.url, build.imageBytes);
		if (data.length > build.imageBytes) {
			log.warn("image is larger than its size limit", { ...ids, bytes: data.length });
			return null;
		}
		const type = sniffImageType(data);
		if (!type) {
			log.warn("attachment isn't a supported image", { ...ids, bytes: data.length });
			return null;
		}
		return { type: "image", source: { type: "base64", media_type: type, data: data.toString("base64") } };
	} catch (err) {
		// Error messages can contain the attachment URL, so only the error kind goes above debug.
		log.warn("couldn't load an image", { ...ids, ...errorKind(err) });
		log.debug("image download error", { ...ids, err });
		return null;
	}
}

function errorKind(err: unknown): { error: string; status?: number; code?: string } {
	if (!(err instanceof FluxerRequestError)) return { error: err instanceof Error ? err.name : typeof err };
	const out: { error: string; status?: number; code?: string } = { error: err.name };
	if (err.status !== null) out.status = err.status;
	if (err.code !== null) out.code = err.code;
	return out;
}

/** Runs `fn` over `items` with at most `limit` calls in flight. `fn` must not throw. */
async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const item = items[next++] as T;
			await fn(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
