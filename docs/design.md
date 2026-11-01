# Clanker design

Status: 2026-11-01. Implemented (v0.1 to v0.3 code, not yet run against live Fluxer or Anthropic with real credentials). Research done during the build changed some details; they are folded in below.

Clanker is a self-hosted Fluxer bot that answers approved users with Claude. It uses Anthropic's web search and web fetch tools. It is meant for small communities where the operator decides exactly who may use it and where it may run. It is a rough Fluxer counterpart of [baibot](https://github.com/etkecc/baibot) for Matrix.

## Goals

- Answer approved users when they mention the bot, reply to it, or DM it.
- Use only the reply chain that triggered the bot as context, never the rest of the channel or DM.
- Give the operator full control: which communities, which users and roles, which DMs, and how much money it can spend.
- Keep costs low by default: Claude Haiku 5.5, prompt caching, capped context and tool use, and per-user and monthly spending caps.
- Store no message content.
- Be easy for others to run: one container image, one config file, and two secrets.

## Non-goals (for now)

- Slash commands (Fluxer has none yet).
- Voice, image generation, or tools that act on anything (shell, files, code execution beyond what web search uses internally).
- Long-term memory, user profiles, or per-user conversation history.
- Multiple Fluxer bot accounts per process.
- A web dashboard.

## Licence

AGPL-3.0-or-later. Anyone may fork and change it, but forks must stay under the AGPL, and anyone running a modified version must offer its source to the people using it. The bot's bio and `help` reply link to the source so that operators comply by default. Dependencies must be AGPL-compatible (MIT, Apache-2.0, BSD and ISC are fine). The Anthropic SDK is Apache-2.0 since 1.0.

## Fluxer facts this design relies on

Checked against the Fluxer docs (`fluxerapp/fluxer`, `fluxer_docs/`) on 2026-11-01.

- Nobody can log in as a bot. The owner edits the bot's profile (username, avatar, banner, bio) in User Settings > Applications. The bot sets its own presence and custom status (up to 128 characters) through the gateway.
- A private bot (`bot_public` off) can only be installed by its owner. Installing needs the Manage Community permission in the target community.
- There are no gateway intents. The bot receives every message, including its content, in every channel it can view.
- `MESSAGE_CREATE` includes `guild_id`, the author's `member` object (with role IDs) in community channels, `message_reference`, and `referenced_message` (one hop).
- `GET /v1/channels/{channel_id}/messages/{message_id}` fetches a single message. It needs Read Message History for older messages.
- `GET /v1/guilds/{guild_id}/members/{user_id}` returns a member's roles. `GUILD_MEMBER_UPDATE` and `GUILD_MEMBER_REMOVE` events report changes.
- `DELETE /v1/users/@me/guilds/{guild_id}` lets the bot leave a community.
- Users can DM the bot only if they share a community with it.
- Bot messages can be up to 4,000 characters (counted as JavaScript string length), with up to 10 embeds per message.
- `allowed_mentions` must be exactly `{"parse": [], "replied_user": true}` (or `false`) on every create **and every edit**: without `parse`, Fluxer allows every mention, and edits re-parse mentions.
- Flag `SUPPRESS_EMBEDS` (4) works on create and edit. Links written as `[title](<url>)` are never unfurled.
- The instance blocklist can refuse a message or an edit with 403 `CONTENT_BLOCKED`. Error codes are strings.
- Bots can also be added to group DMs (channel type 3). Only type 1 counts as a DM. Messages in threads carry the thread's ID, so channel allowlists are checked against the parent channel too.
- Nicknames only appear in gateway events, never in REST messages, so names come from `global_name`, falling back to `username`.
- Rate limits: sending, editing and typing are each limited to 20 per 10 seconds per channel, and there is a global limit of 50 requests per second.
- There are no slash commands or interactions yet.
- Fluxer bans deception, spam and bulk scraping, and lists "automation or selfbot" as an enforcement reason. Clanker uses a normal bot application.

## How a message flows

```
Fluxer gateway: MESSAGE_CREATE
  1. Ignore: bots, webhooks, our own messages, edits
  2. Where:  allowed community (and channel, if restricted), or a DM
  3. Trigger: <@us> in its own text / replies to one of our messages / is a DM
  4. Who:    user is in allowed_users, or has an allowed role
             (if this fails, ignore silently)
  5. Command? (help, usage, status)  -> answer from code, done
  6. Guards: per-user cooldown, one request in flight per user,
             global concurrency limit
  7. Build the reply chain (from memory cache or Fluxer)
             and check its size against the context budget
  8. Spend:  worst-case estimate fits the user's daily cap
             and the monthly cap? Otherwise send a limit notice, done
  9. Reserve the estimate, then call Claude (streaming)
 10. Post and edit the reply in Fluxer, add sources, split if long
 11. Record the actual cost and release the reservation
```

Steps 1 to 8 are plain code. Nothing reaches Claude unless every check passes. Commands, limit notices, reactions and estimates cost nothing.

## Access control

### Who

A user may trigger the bot if either:

- their user ID is in `access.users` (global), or
- they have any role listed for that community in `guilds.<id>.roles`.

`access.blocked_users` overrides both.

In community channels, the author's roles come from the `member` object in `MESSAGE_CREATE`, so no extra API call is needed.

The owner (`owner_id`) is always allowed.

In DMs, the user is allowed if they are in `access.users`, or have an allowed role in any allowed community. Their roles are looked up with `GET /guilds/{id}/members/{user_id}` for each allowed community. Results (role IDs only) are cached for 5 minutes and updated on `GUILD_MEMBER_UPDATE` or `GUILD_MEMBER_REMOVE`, so revoking a role takes effect immediately. Member events only update people already in the cache, that is, people who wrote to the bot; expired entries are swept every minute.

Messages from users who aren't allowed are ignored silently: no reply and no reaction.

### Where

- **Communities.** Only community IDs listed under `guilds` are served. The bot should be private, so only the operator can install it. On `READY` and `GUILD_CREATE`, the bot leaves any community that isn't listed (if `guilds_leave_unlisted = true`, the default), logs it, and DMs the owner (at most 3 such DMs an hour, with the community's name quoted as plain text, since whoever added the bot chose it).
- **Channels.** By default the bot answers in any channel it can see in an allowed community. `guilds.<id>.channels` can restrict it further. The operator should also use Fluxer channel permissions, because the bot receives every message in every channel it can view.
- **DMs.** `dms.enabled` turns DMs on or off. When they're on, DMs are answered only for allowed users, as above. When they're off, only the owner can DM the bot (for owner commands, and to answer alerts).

### Owner

`owner_id` is the operator's Fluxer user ID. The owner:

- receives alerts by DM (monthly spend at 80% and when the cap is reached, leaving an unlisted community, a rejected API key or a spend limit at Anthropic, an unwritable ledger, repeated failed answers), and
- can use owner-only commands.

## Triggers and commands

A message triggers the bot if it is in an allowed place, from an allowed user, and any of these holds:

- its own text mentions the bot (`<@bot>`),
- it replies to a message the bot wrote, or
- it is a DM.

Edits to earlier messages do not trigger the bot (v1). Neither do forwards: the payload's `users` list also names users mentioned in forwarded messages and embeds, so the mention lists are used only for display names, never as a trigger.

Commands are a mention (or a DM) whose entire text is one of the keywords below. Using the mention avoids clashing with other bots' `!` prefixes, and requiring the whole message avoids catching questions such as "help me write…".

| Command | Who | Reply |
|---|---|---|
| `help` | allowed users | What the bot does, how to use it, the model, your caps, and a link to the source |
| `usage` | allowed users | Your spend today against your daily cap, and the monthly total against the monthly cap |
| `usage all` | owner (DM) | Spend per user today and this month |
| `status` | owner (DM) | Uptime, gateway state, model, communities, and cache hit rate today |

Commands never call Claude.

## Context: reply chains only

The context is the chain of replies that ends at the triggering message, and nothing else. There is no channel history and no DM history.

Building the chain:

1. Start at the triggering message. If it replies to something, use `referenced_message` from the event. For each further hop, fetch the message with `GET /channels/{id}/messages/{id}`.
2. Stop at the root (a message that replies to nothing, or whose parent was deleted), or at the first bot answer that still has an exact replay entry (see "Prompt caching").
3. If the chain has more than `context.max_messages` (default 50) messages or runs over `context.max_chain_tokens`, the bot doesn't call Claude. It replies that the thread is too long and asks the user to start a new one. Dropping the oldest messages instead would change the start of every request, which defeats caching and quietly loses context.

Turning the chain into API messages:

- Messages written by the bot become `assistant` turns. Everything else becomes `user` turns.
- The bot's notices and command replies (limits, busy, help, usage) are skipped: they are not context.
- Consecutive messages from the same side are merged into one turn.
- If the first turn would be an assistant turn (its parent was deleted), a fixed user turn `[Earlier messages aren't available.]` goes first.
- Each message is written the same way every time, using only facts that never change:

  ```
  [Alice · 2026-11-01 14:05 PST]
  message text
  ```

- Mentions (`<@id>`) are replaced with display names.
- Messages from users who aren't approved can appear in a chain (for example, an approved user replies to someone else's message and mentions the bot). They are included and labelled like any other message. They cannot trigger the bot.
- Images attached to messages in the chain (up to `context.max_images`, default 4, the most recent first, each under 5 MB) are downloaded and sent as base64 image blocks. Other files are listed by name only (v1).
- A reply the bot split into several Fluxer messages counts as one assistant turn.

The token count used for the budget is a local estimate, which errs on the high side, with no API call: UTF-8 bytes ÷ 2 for text (Anthropic's figure for the current tokenizer is about 2.5 characters per token, so characters ÷ 3 would under-count), and `⌈width/28⌉ × ⌈height/28⌉` per image after scaling to Haiku 5.5's limits (at most 4,784 tokens; 4,800 when the size is unknown). For exact-replay chains the size of earlier turns comes from the API's `usage`, which also counts their hidden thinking.

## Calling Claude

| Setting | Default | Notes |
|---|---|---|
| Model | `claude-haiku-5-5` | Configurable. Kept fixed for the life of a chain, because switching models throws away its cache. |
| Thinking | adaptive, `display: "omitted"` | Thinking text is never shown. Omitted is Haiku 5.5's default. |
| Effort | `medium` | `output_config.effort`. Kept fixed per chain for the same reason. |
| `max_tokens` | 8,000 | Thinking counts toward this. |
| Web search | `web_search_20260318`, `max_uses: 3`, `allowed_callers: ["direct"]` | $10 per 1,000 searches plus tokens. Optional `allowed_domains` or `blocked_domains`, and `user_location`. |
| Web fetch | `web_fetch_20260318`, `max_uses: 3`, `max_content_tokens: 10000`, citations on, `allowed_callers: ["direct"]` | Tokens only. It can open URLs that users post. |
| Streaming | on | |

The `_20260209` and later tool versions run the web tools from inside a code-execution container by default ("dynamic filtering"), which adds code-execution blocks, more sampling iterations and a container to every answer. `allowed_callers: ["direct"]` keeps the simple shape. The SDK (1.x) sends API version `2026-10-21`, which rejects sampling parameters and citations inside user turns; cited text only ever travels back inside the bot's own (assistant) turns.

### Context budget

Haiku 5.5 charges $0.10 / $0.50 per million input / output tokens for prompts up to 100,000 tokens, and $0.50 / $2.50 above that. Clanker keeps every request under 100,000 tokens:

```
system prompt + tools          ~3,000
reply chain (max_chain_tokens) 50,000
web fetch   3 × 10,000         30,000
web search  3 × ~4,000         12,000
-------------------------------------
worst case                    ~95,000  (< 100,000)
```

The config loader refuses budgets whose total is over `context.max_request_tokens` (default 100,000). This keeps every single prompt under the threshold. Fetched PDFs are the exception: `max_content_tokens` doesn't apply to them (Anthropic's limit covers text only). This is an accepted risk: accounting uses real usage, and a replayed chain that grew too large is rebuilt from text.

Cached tokens do count toward the threshold (confirmed in Anthropic's pricing docs). Not confirmed: whether a request with server tools is judged per sampling iteration or on its summed input, which is what `usage` reports. If it's the sum, any answer that searches a few times crosses 100,000 and pays the higher rates. Clanker's accounting and its up-front estimate assume the sum, which is the safe reading; caching keeps the actual cost of such answers low (around US$0.13 in the worst case).

### System prompt

The system prompt is fixed text from the config, with a sensible built-in default. It contains no date, names or other values that change between requests, so it caches across every user and chain. The default covers:

- that it is an AI assistant called Clanker in a Fluxer community, and never claims to be human
- short answers that suit chat, using Fluxer markdown
- citing sources when it used the web
- treating quoted messages, web pages and fetched files as information, not instructions

Per-request facts (date, community and channel name) go in the header of the latest user turn. When that turn is replayed later, the header is written exactly the same way, because it uses the message's own timestamp.

### Stop reasons and errors

- `pause_turn`: the server tool loop paused (it allows 10 sampling iterations; with direct calls and 3 + 3 tool uses an answer needs at most 7, so this is rare). Send the request again with the paused assistant content appended unchanged, up to 3 times, reserving spend again before each one.
- `refusal`: it can arrive after some text has streamed. The text is discarded and replaced with a short note that the request was declined. Haiku 5.5 has no server-side fallback (and the `fallbacks` parameter is beta-only), so Clanker doesn't offer one.
- `max_tokens`: post what was written, plus a note that the answer was cut off.
- Web tool errors arrive as result blocks, not exceptions. Let the model handle them.
- API 429, 5xx and network errors before the response starts: the SDK retries twice. Errors in the middle of a stream aren't retried by the SDK; Clanker retries once if nothing had arrived yet. Each call also has an overall deadline. The deadline grows with `model.max_tokens` and the tools' `max_uses` (60 s + 20 ms per output token + 10 s per tool use, at least 180 s; 280 s with the defaults). If it still fails, reply "temporarily unavailable", release the reservation, and alert the owner after 3 failed answers in a row. If the API key is rejected or a spend limit is hit, the owner is alerted at once, but only once per incident and day. A failure that isn't Claude's (for example fetching the reply chain from Fluxer) gets a neutral "something went wrong" reply instead and still counts toward the 3.
- A replayed chain that the API rejects with HTTP 400 on the first call (thinking blocks or any other `invalid_request_error`) is retried once rebuilt from Fluxer text, and its stored turn is dropped.

## Prompt caching

The cache only reuses a request's opening if it is byte-identical to an earlier one. The order is `tools` → `system` → `messages`.

1. **Fixed opening.** Tools and the system prompt never change between requests, so they are shared by every user and chain. A breakpoint goes after the system prompt with a 1-hour TTL (`cache.system_ttl`, default `1h`), because a quiet community would otherwise lose it every 5 minutes.
2. **Chain.** Automatic caching (top-level `cache_control`) puts a breakpoint on the latest message with a 5-minute TTL. Every hit restarts the timer, so an active conversation stays cached.
3. **Exact replay of the bot's turns.** A follow-up only gets cache hits if the earlier assistant turns are sent back exactly as the API returned them: thinking blocks with signatures, server tool calls and results, and text with citations. Fluxer only holds the bot's written answer. So for every answered request Clanker keeps, in memory, the exact `messages` it sent and the exact assistant content that came back, keyed by the Fluxer IDs of the reply:
   - A follow-up that replies to that answer sends the stored messages, the stored assistant turn, and the new user turn. Every request is therefore either a pure extension of an earlier one or contains no replayed thinking at all, so Haiku 5.5's check that replayed thinking blocks follow an unchanged history can't fail by design. If it does fail (a bug), Clanker drops the entry, rebuilds the chain from Fluxer text and retries once.
   - Only complete answers (`end_turn`) are stored. A cut-off turn can end in an unrun tool call, which would break the next request.
   - Replayed turns include web results, so they grow fast. If the exact chain is over `context.max_chain_tokens`, the chain is rebuilt from text instead (one cache miss) before giving up.
   - In exact-replay requests, a second 5-minute breakpoint goes on the last block of the previous user turn. Citations split an answer into many blocks, and without it the cache lookback (20 blocks) could miss the previous request's entry.
   - Entries live for `cache.replay_ttl_seconds` (default 300) after last use and are capped by count and `cache.replay_max_mb`. Nothing is written to disk.
4. **Monitoring.** Each request logs `cache_read_input_tokens`, `cache_creation_input_tokens` and `input_tokens` (counts only). `status` shows the day's hit rate.

Haiku 5.5 cache prices: reads cost 0.1× the input price, 5-minute writes 1.25×, and 1-hour writes 2×. The minimum cacheable prefix is 512 tokens. The API also adds its own 5-minute breakpoints after server tool results. Adding the first image to a chain invalidates its messages cache once.

## Replying in Fluxer

- **Typing.** Send a typing indicator when work starts, repeated every 8 seconds until the first text arrives.
- **Placeholder and streaming.** Post a reply to the triggering message as soon as the first text arrives, then edit it with new text at most once every 1.5 seconds. This stays well inside the limit of 20 edits per 10 seconds per channel, even with a few replies streaming at once.
- **Tool status.** While a web tool runs, the message shows a status line such as `🔎 searching: <query>` or `📄 reading: <domain>`. It's removed when the answer arrives.
- **Sources.** Citations are collected, deduplicated and numbered, and appended as a "Sources" list of `[title](<url>)` links, with link previews suppressed (flag 4). Web fetch citations carry no URL; they point at the fetched document by index, which Clanker maps back to the fetched page.
- **Splitting.** Replies over 4,000 characters are split at paragraph or line breaks, never inside a code block (if a block has to be split, it's closed and reopened). Each part replies to the previous part, so the chain stays intact. All the parts map to the same assistant turn.
- **Mentions.** `allowed_mentions` is limited to replying to the user, so model output can't ping roles, @everyone or other users.
- **Blocked text.** If the instance blocklist refuses a part (403 `CONTENT_BLOCKED`), that part is replaced with a short note.

## Spending caps

### Accounting

After each request, the cost is calculated from the response's `usage`:

```
input_tokens                × input price
cache_creation_input_tokens × write price (1-hour for the breakdown's 1-hour part, 5-minute for the rest)
cache_read_input_tokens     × read price
output_tokens               × output price
server_tool_use.web_search_requests × $0.01
```

The streamed `usage` has the total of cache writes over all server tool iterations, but its 5-minute/1-hour breakdown covers only the first iteration. Later writes come from the API's own 5-minute breakpoints after tool results, so everything beyond the breakdown's 1-hour part is charged at the 5-minute price.

using a price table in the config (with built-in defaults for supported models, including Haiku's price above 100,000 tokens). Each request adds a row to a local SQLite ledger: user ID, community ID or DM, model, token counts, searches, cost, and timestamp. The ledger stores no message content.

### Caps

| Cap | Default | Config |
|---|---|---|
| Per user per day | US$5.00 | `limits.user_daily_usd`, with overrides per user or role (the higher one applies) |
| All users per month | US$100.00 | `limits.monthly_usd` |

A day starts at midnight in `timezone` (default `UTC`). A month starts on the 1st in the same timezone.

The operator should also set a spend limit on the Anthropic workspace that holds the bot's API key, as a backstop if the bot's own accounting is ever wrong.

Each cap above zero must be at least one call's worst-case reservation (below), or no request could ever start under it: the config loader rejects such caps. Zero is allowed and means blocked (a daily cap of 0 leaves the bot to users and roles with overrides).

If the ledger can't be written (a full disk, say), costs are kept in memory and still count against both caps, the owner is told once, and the rows are written as soon as a write works again.

### Checking before a request

The worst-case cost of a request comes from the context budget:

```
max_request_tokens × input price × (1 + total tool uses)
  (or, if higher, max_request_tokens × the highest cache-write price: a cold call with both tools off)
+ max_tokens × output price
+ web_search max_uses × $0.01
```

Assuming the long-context rates apply to the summed input of a tool loop (see "Context budget"), that's 7 × 100,000 tokens at $0.50, plus 8,000 at $2.50, plus 3 searches: about US$0.40 per call on Haiku 5.5 with the defaults. It is deliberately pessimistic, costs no API call, and is replaced by the actual cost (usually a few cents or less) as soon as the call finishes. The estimate is reserved against both caps before the call, which also covers several requests running at once, and is replaced by the actual cost afterwards. If the estimate doesn't fit in what's left, the bot sends a limit notice instead of calling Claude.

### Limit notices

The first time a user is blocked in a period, the bot replies:

> @Alice, you've reached your daily limit of US$5.00. It resets at midnight UTC (in 3 h 12 min).

> Clanker has reached its monthly spend limit of US$100.00. It resets on 2026-12-01.

For the rest of that period, blocked messages only get a ⏳ reaction. `limits.notice` chooses `reply` (default) or `dm`. With `dm`, the full notice goes by DM and the channel only gets the reaction, which keeps a user's limit private. If the DM can't be delivered (the user blocks DMs from bots), the notice is posted in the channel instead.

The owner gets a DM at 80% of the monthly cap, and another when what's left can't cover one more request's worst case. From then on every request is refused until next month, so recorded spend usually stops a little below the cap.

## Abuse guards

| Risk | Guard |
|---|---|
| Unapproved users spamming the bot | Ignored silently: no reply, no reaction, no call to Claude. At most one Fluxer role lookup per listed community (DMs only, or when the event has no member object), cached for 5 minutes on success. |
| Approved users spamming | `limits.cooldown_seconds` (default 5) between triggers per user, commands included. One request in flight per user. Extra messages are ignored, with a 🐢 reaction once per minute. |
| Many requests at once | `limits.max_concurrent` (default 4). Extra requests wait up to 60 seconds in a short queue (`limits.max_queue`, default 8), then get a "busy" notice (once per minute per channel). |
| A prompt that makes the model search or fetch endlessly | `max_uses` on each tool, included in the up-front estimate. |
| Huge reply chains | `context.max_messages` and `context.max_chain_tokens`. |
| Instructions hidden in web pages or quoted messages | The bot has no tools that act on anything. The system prompt treats such content as information. Mentions in output are restricted. |
| Fluxer rate limits | A REST client that follows the rate-limit headers, retries rate-limited sends, and sends one request at a time per channel. Edits throttled. Notices sent once per period. |
| Bots triggering each other | Messages from bots and webhooks are ignored. |
| Someone adding the bot elsewhere | Private bot, community allowlist, auto-leave, owner alert. |

## Privacy and data

- The bot receives every message in the channels it can see (Fluxer has no intents). Messages that don't trigger it are dropped as soon as the checks fail. They are never logged or stored.
- Sent to Anthropic: the reply chain of a triggered request (text and images), the system prompt, and the latest turn's header. Anthropic processes it under its commercial API terms. The README links to Anthropic's data-retention policy.
- Stored on disk: the spending ledger (no content), and limit-notice flags.
- Held in memory: exact API turns for up to 5 minutes after last use, and member-role lookups for 5 minutes.
- Logs: event types, user, community and channel IDs, costs, token and cache counts, and errors. No message text, unless `log.level = "debug"`, which says so loudly at startup.
- The bot's Fluxer bio says it's an AI that sends messages to Anthropic, and links to the source.

## Configuration

One TOML file (`/config/clanker.toml`, or the path in `CLANKER_CONFIG`), checked at startup with a schema. Unknown keys or values outside their limits stop the bot with a clear error that lists every schema problem. Checks that span several keys or files (the context budget, prices, caps against the reservation, the system prompt file) run once those pass. Secrets come from environment variables or files (`*_FILE`), which suits Podman and Docker secrets.

`clanker.example.toml` in the repository lists every key with its default and a comment. In short:

| Section | Keys |
|---|---|
| top level | `owner_id` (required), `api_url`, `gateway_url`, `timezone`, `data_dir`, `source_url` |
| `[access]` | `users`, `blocked_users`, `guilds_leave_unlisted` |
| `[guilds."<id>"]` | `roles`, `channels` |
| `[dms]` | `enabled` |
| `[model]` | `name`, `effort`, `max_tokens`, `system_prompt_file` |
| `[tools.web_search]` | `enabled`, `max_uses`, `allowed_domains`, `blocked_domains`, `user_location` |
| `[tools.web_fetch]` | `enabled`, `max_uses`, `max_content_tokens`, `allowed_domains`, `blocked_domains`, `citations` |
| `[context]` | `max_messages`, `max_chain_tokens`, `max_request_tokens`, `max_images` |
| `[cache]` | `system_ttl`, `replay_ttl_seconds`, `replay_max_mb` |
| `[limits]` | `user_daily_usd`, `monthly_usd`, `notice`, `cooldown_seconds`, `max_concurrent`, `max_queue`, `[[limits.overrides]]` |
| `[prices."<model>"]` | per-million-token prices; adds a model or replaces a built-in entry completely; optional `long_context` table (threshold plus the same five prices), required when replacing a built-in model that has one |
| `[presence]` | `status`, `custom_status` |
| `[log]` | `level` |
| `[health]` | `ping_url`, `heartbeat_file` |

Secrets:

| Variable | What |
|---|---|
| `FLUXER_BOT_TOKEN` or `FLUXER_BOT_TOKEN_FILE` | Bot token (`<app_id>.<secret>`) |
| `ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY_FILE` | Anthropic API key, ideally in its own workspace with a spend limit |

## Stack

- TypeScript (7.x, the native compiler), running on Node.js 24.15 or newer. The container uses Node 26, the Active LTS line since 2026-10-28.
- `@fluxerjs/rest`, `@fluxerjs/ws` and `@fluxerjs/types` (Apache-2.0) for REST and the gateway: rate-limit buckets, heartbeats, resume and reconnects. Not the `Client` from `@fluxerjs/core`, which always caches users, members and (by default) message content, and drops member events when its guild cache misses. Clanker adds its own retry of rate-limited sends, a READY watchdog, a socket with close and handshake timeouts, and message de-duplication.
- `@anthropic-ai/sdk` (Apache-2.0).
- `zod` for config validation, `smol-toml` for parsing.
- `node:sqlite` for the ledger, which avoids native modules. It is a release candidate on Node 24.15+ and prints no warning.
- `vitest` for tests, `biome` for linting and formatting.
- Exact versions pinned in `package-lock.json`, installed with scripts disabled. Dependencies are kept few.

## Repository layout

```
src/
  index.ts          startup, wiring, heartbeat, shutdown
  app.ts            the message flow
  config.ts         schema, loading, secrets
  prompt.ts         built-in system prompt
  fluxer.ts         gateway and REST wrapper (events in, sends, edits, reactions)
  access.ts         who and where checks, role cache
  triggers.ts       trigger and command detection
  commands.ts       help, usage, status
  chain.ts          reply-chain walking and rendering into API messages
  replay.ts         in-memory exact-turn cache
  claude.ts         request building, streaming, pause_turn, errors
  render.ts         streaming edits, tool status, sources, splitting
  spend.ts          prices, estimates, reservations, caps, notices
  store.ts          SQLite ledger
  guards.ts         cooldowns, concurrency, queue
  log.ts            structured JSON logs
  money.ts, time.ts helpers
  healthcheck.ts    container health check
test/               unit tests with Fluxer event fixtures and scripted API responses
docs/design.md
clanker.example.toml
Containerfile
LICENSE  README.md  SECURITY.md  CONTRIBUTING.md
.github/workflows/  ci.yml, release.yml
renovate.json
```

## Container and releases

- **Image.** Multi-stage build. The final stage is distroless `nodejs26-debian13:nonroot`, pinned by digest. It runs as UID 65532. There are no native modules, so the build stage runs on the build machine's architecture and the arm64 image needs no emulation.
- **Runtime.** Works with a read-only root filesystem. `/data` holds the SQLite ledger, and `/config` holds the config, mounted read-only. No ports are exposed. The bot only makes outbound connections to the Fluxer API, gateway and media CDN, and to `api.anthropic.com`.
- **Health.** A heartbeat file is touched on every gateway heartbeat acknowledgement while the session is live (about every 41 seconds), and the health check fails when it's older than 120 seconds. Podman ignores `HEALTHCHECK` in OCI images, so Quadlet users set `HealthCmd=` themselves. `health.ping_url` is optional.
- **Releases.** A tag `vX.Y.Z` triggers a GitHub Actions build that:
  - publishes `ghcr.io/linus-sexy-tips/clanker:X.Y.Z` (no `latest` tag) for amd64 and arm64
  - signs it with cosign (keyless)
  - attaches an SBOM and build provenance
- **CI.** Every action is pinned by commit SHA. CI runs typecheck, lint, tests and `npm audit` on every push and pull request. Renovate proposes dependency updates.
- **Security.** `SECURITY.md` says how to report vulnerabilities (GitHub private advisories).

## Milestones

1. **v0.1**: config, access checks, triggers, reply chains (text only), a single non-streamed answer, web search and fetch, spending ledger and caps with notices, and commands. Runs from source.
2. **v0.2**: streaming edits, tool status, sources, splitting, exact-turn replay and caching metrics, images.
3. **v0.3**: container image, release pipeline, documentation, first public release.

## To check against the live services

Answered during the build (2026-11-01): newest tool versions (`_20260318`), that cached tokens count toward the 100,000 threshold, Haiku 5.5's 512-token cache minimum and its usage TTL breakdown, what happens to replayed thinking after an edited history (a 400 on accounts created since 2026-08-31), Fluxer's suppress-embeds flag and Markdown, `allowed_mentions` and rate-limit headers, and `node:sqlite` on Node 24.

Still to check once the bot runs:

- Whether a server-tool request is priced on its summed input (assumed) or per iteration. One test request with searches, compared with the Console's cost, settles it.
- Whether `max_uses` counts across a `pause_turn` continuation.
- Which form of the ⏳ and 🐢 emoji Fluxer's reaction route accepts.
- Whether fluxer.app's attachment URLs are signed and expire.
- A live login with the REST and gateway packages on Node 26.
