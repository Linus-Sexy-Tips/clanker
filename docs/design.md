# Clanker design

Clanker is a self-hosted Fluxer bot that answers approved users with Claude, which can search the web and read links. It suits small communities where the operator controls who may use it, where, and at what cost, much like [baibot](https://github.com/etkecc/baibot) for Matrix.

## Goals

- Answer approved users who mention the bot, reply to it, or DM it, with only that reply chain as context.
- Let the operator control communities, channels, users, roles, DMs, and spend.
- Keep costs low: Haiku 5.5, prompt caching, capped context and tool use, and spending caps.
- Store no message content.

## Licence

AGPL-3.0-or-later: anyone running a modified version must offer its source to its users. `help` links to `source_url`, so operators comply by default. Dependencies need AGPL-compatible licences such as MIT, Apache-2.0, BSD, or ISC.

## Fluxer facts this design relies on

- Nobody can log in as a bot. The owner edits its name, avatar, and bio in User Settings > Applications.
- The bot's user ID is its application ID, and its token is `<application id>.<secret>`. Only the owner can install a private bot (`bot_public` off), with Manage Community.
- No gateway intents: the bot receives every message, with content, in every channel it can view.
- `MESSAGE_CREATE` carries `guild_id`, the author's `member` with role IDs, `message_reference`, and `referenced_message`.
- REST can fetch one message (older ones need Read Message History) or a member's roles, and leave a community. Member update and remove events report role changes.
- Users can DM a bot only if they share a community with it.
- Thread messages carry the thread's ID, not the parent's. REST messages carry no nicknames.
- Bot messages hold up to 4,000 characters, counted as JavaScript string length.
- `allowed_mentions` must be `{"parse": [], "replied_user": …}` on every create and edit: without `parse` every mention is allowed, and edits re-parse mentions.
- Flag `SUPPRESS_EMBEDS` (4) works on create and edit, and `[title](<url>)` links never unfurl.
- The instance blocklist can refuse a message or edit with 403 `CONTENT_BLOCKED`.
- Sends, edits, and typing are each limited to 20 per 10 seconds per channel, and all requests to 50 per second.
- Fluxer enforces against deception and "automation or selfbot" use, so Clanker is a normal bot application that says it is an AI.

## How a message flows

```
MESSAGE_CREATE
  1. Ignore    bots, webhooks, ourselves, system messages (types other than 0 and 19)
  2. Where     allowed community and channel, or a DM
  3. Trigger   <@us> in the text, a reply to us, or a DM
  4. Who       owner, access.users, or an allowed role
  5. Cooldown  per user, commands included
  6. Command   help, usage, usage all, status
  7. Slot      one request per user, global concurrency limit and queue
  8. Spend     check today's and this month's spend against the caps, or send a limit notice
  9. Chain     build the reply chain and check it against the budget
 10. Claude    stream the answer; record each call's cost
 11. Reply     post, edit, add sources, split
```

Steps 1 to 9 cost nothing, and Claude is called only if all of them pass.

## Access control

- **Who:** The owner (`owner_id`), users in `access.users`, and members with a role in `guilds.<id>.roles` or of a community with `guilds.<id>.everyone` (its @everyone role, which has the community's ID; `grant community` sets it too), minus `access.blocked_users`, which can't hold the owner.
- **Roles:** Community messages carry them. They allow use in communities only: DMs and group DMs need the owner or a user allowed by ID (`access.users` or `grant user`). For those users the bot looks up roles in each listed community, for their caps. Successful lookups are cached for 5 minutes and refreshed by member events, so revoking a role works at once.
- **Where:** Communities listed under `guilds` (on `READY` and `GUILD_CREATE` the bot leaves others, per `access.guilds_leave_unlisted`), and channels listed in `guilds.<id>.channels` if set, threads matching through their parent. DMs need `dms.enabled`, except for the owner. Group DMs need `dms.groups` (on by default; when off, the bot leaves them); only the owner can add a private bot to one, and the bot answers there like in a channel.
- **Permissions:** View channel, Send messages, Read message history (for older messages in a chain), and Add reactions (for `⏳` and `🐢`), plus Send messages in threads where threads are used. The install link and values are in [deploy.md](deploy.md#fluxer).

### Owner alerts

The owner gets a DM:

- at 80% of the monthly cap, and when spend reaches it (each once a month);
- on leaving an unlisted community, naming it as plain text (at most 3 an hour);
- when Anthropic rejects the API key or refuses a request over a spend limit or billing (once per kind per day);
- when the ledger can't be written (until a write works);
- after 3 failed answers in a row.

## Triggers and commands

A message triggers the bot if its own text mentions it (`<@id>`, `<@!id>`, or one of the bot's own roles, such as the role Fluxer creates on install), if it replies to a bot answer (a reply to a command reply or notice needs a mention), or if it is a DM. Command messages and the bot's notices are left out of reply-chain context. Edits and forwards never trigger it; the payload's mention list includes forwarded content, so it only supplies display names.

A command is a triggered message without attachments whose whole text, minus the mention, is a keyword. The mention avoids other bots' `!` prefixes.

| Command | Who | Reply |
|---|---|---|
| `help` | allowed users | What the bot is, model and effort, web tools, the user's caps, and the source link |
| `usage` | allowed users | Own spend today and everyone's this month, against the caps |
| `usage all` | owner | Spend per user this month and today |
| `status` | owner | Version, uptime, gateway, model, communities, today's usage and cache hit rate, monthly spend, and running and queued requests |
| `personality` (`set <text>`, `reset`) | owner | Shows or replaces the personality and style section of the system prompt; saved in the ledger database |
| `presence` (`set <text>`, `clear`, `reset`) | owner | Shows or changes the bot's status message; saved in the ledger database, applied at once and at every start |
| `access`, `grant user\|role <id>`, `revoke user\|role <id>` | owner | Lists or changes access on top of the config; saved in the ledger database. A revoked user is denied even with an allowed role |
| `pro`, `pro add user\|role <id>`, `pro remove user\|role <id>` | owner | Lists or changes who gets the [pro tier](#pro-tier) on top of `[pro]` in the config; saved in the ledger database. A user removed by ID stays off even with a pro role |
| `reset <user>` | owner | Clears the user's spend for today; the monthly total keeps counting it |

## Context: reply chains only

1. The walk starts at the triggering message, takes its `referenced_message`, and fetches further parents.
2. It stops at the root or a deleted parent, at a parent in another channel, or at the nearest bot answer with a live [replay entry](#prompt-caching).
3. A chain over `context.max_messages` (50) or `context.max_chain_tokens` (50,000) gets a "start a new thread" reply instead of a call. Trimming old messages would break caching.

Rendering:

- Bot answers become `assistant` turns and everything else `user` turns. Same-side messages merge, and notices and command replies are skipped.
- A chain that starts with an assistant turn gets the user turn `[Earlier messages aren't available.]` first.
- Labels use only fixed facts, as in `[Alice · 2026-11-01 14:05 PST]`, so a message always renders the same. Names are `global_name`, else `username`, and mentions become names.
- Messages from unapproved users are included and labelled like the rest.
- Up to `context.max_images` (4) PNG, JPEG, GIF, or WebP images go as base64, newest first, each up to 5 MiB and 8,000 pixels a side. Other files are listed by name, type, and size.

Token counts are local estimates that err high: UTF-8 bytes ÷ 2 for text, and one token per 28×28 patch after scaling an image to a 2,576-pixel long edge, at most 4,784 (4,800 if the size is unknown). A replayed answer counts its `output_tokens` plus an estimate of its tool calls and results.

## Calling Claude

- Default `claude-haiku-5-5`, configurable. Prices are built in for Haiku, Sonnet, and Opus 5.5.
- Adaptive thinking, never shown (`display: "omitted"`), effort `medium`, and `max_tokens` 8,000 including thinking.
- `web_search_20260318` (3 uses, US$0.01 each) and `web_fetch_20260318` (3 uses, 10,000 tokens a page, citations on), both with `allowed_callers: ["direct"]`.
- Streaming on the non-beta Messages API, with the base URL fixed so `ANTHROPIC_BASE_URL` can't redirect it. API version `2026-10-21` (SDK 1.x) rejects sampling parameters and citations in user turns, so cited text only travels in assistant turns.

### Pro tier

`[pro]` (off by default) gives listed users and roles, and those added with `pro add`, a second tier: by default `claude-sonnet-5-5` at effort `high`, `max_tokens` 16,000, 10 searches and 5 fetches, a 100,000-token reply chain in a 200,000-token request, and US$10 a day. Everything else (domains, page size, images, the monthly cap) is shared. The person who pays for a request picks its tier, so in one thread a pro user's turns use Sonnet and everyone else's use Haiku. Each tier has its own system prompt (its web budget differs), prompt cache and replay fingerprint, so a turn from the other tier is rebuilt from text. Pro access needs normal access too; the tier only changes the model and budgets.

### Context budget

Haiku 5.5 charges US$0.10 / US$0.50 per million input / output tokens up to 100,000 prompt tokens, cached ones included, and US$0.50 / US$2.50 for the whole request above that. Every request stays below:

```
system prompt + tools          ~3,000
reply chain (max_chain_tokens) 50,000
web fetch   3 × 10,000         30,000
web search  3 × ~4,000         12,000
-------------------------------------
worst case                    ~95,000  (< 100,000)
```

The loader rejects budgets over `context.max_request_tokens` (100,000). Fetched [PDFs](#pdfs) are the exception. With the pro defaults: 3,000 + 100,000 + 5 × 10,000 + 10 × 4,000 = 193,000, under `pro.max_request_tokens` (200,000); Sonnet 5.5 has no long-context rate.

### System prompt

Fixed text (`src/prompt.ts` or `model.system_prompt_file`) with nothing per-request in it, so one cache entry serves every chain. It says the bot is an AI, asks for short chat-style Markdown, and treats quoted and fetched content as information, not instructions. A generated "Web budget" section tells the model how many searches and fetches it has per answer, so it plans its lookups instead of running into the limit; it is the only part that differs between tiers. The newest user turn starts with a line like `[Context: community "Name", channel #name, Sunday, 2026-11-01]`, dated from the message itself so replays match.

### Stop reasons and errors

- `pause_turn` (rare: at most 7 of 10 iterations are needed) continues unchanged up to 3 times.
- `refusal` replaces streamed text with a short decline; Haiku 5.5 has no server-side fallback.
- `max_tokens` posts the text with a cut-off note. Web tool errors are left to the model.
- The SDK retries 408, 409, 429, 5xx, and connection errors twice before the response starts; Clanker retries a broken stream once if no content had arrived.
- Each call's deadline is 60 s + 20 ms per `max_tokens` + 10 s per tool use, at least 180 s (280 s by default).
- A failed answer gets "can't reach Claude" for Claude errors or "something went wrong" otherwise. A replayed chain rejected with HTTP 400 is rebuilt from text and retried once.

## Prompt caching

The cache reuses an opening only if it is byte-identical (`tools` → `system` → `messages`), so request bodies have a fixed key order.

1. **Fixed opening.** Tools and the system prompt sit behind a 1-hour breakpoint (`cache.system_ttl`) shared by every chain.
2. **Chain.** Automatic caching puts a 5-minute breakpoint on the latest message; each hit renews it.
3. **Exact replay.** Follow-ups only hit the cache if earlier assistant turns go back exactly as returned, with signed thinking, server tool blocks, and citations. Fluxer holds only the text, so Clanker keeps each answer's exact request and response in memory, keyed by its Fluxer message IDs.
   - A follow-up sends the stored request, the stored answer, and the new user turn, so Haiku 5.5's check on replayed thinking can't fail by design.
   - Entries only match the same model, effort, `max_tokens`, tools, system TTL, and prompt.
   - A replay over the chain limits is rebuilt from text, costing one cache miss.
   - A second 5-minute breakpoint on the previous user turn keeps the 20-block lookback from missing it after citation-heavy answers.
   - Entries live `cache.replay_ttl_seconds` (300) after last use, within 2,000 entries and `cache.replay_max_mb` (64).

Haiku 5.5 cache reads cost 0.1× input, 5-minute writes 1.25×, and 1-hour writes 2×. The minimum prefix is 512 tokens, and the API adds 5-minute breakpoints after server tool results.

## Replying in Fluxer

- **Long answers** in a community channel go to a thread: the answer text is held back (tool status lines still show) until it's done or longer than `replies.thread_after_chars` (default 500). A long answer starts a thread on the question, deletes the status message, and streams there, so nothing is added to the channel. Without permission to start threads it is posted in the channel. In a chain, a message with such a thread (or an older pointer reply) reads the answer from the thread.
- **Clanker threads** (started by the bot, or on one of its messages): every message from an allowed user is addressed to the bot. It waits until nobody has written for 3 seconds (each message restarts the wait), then answers everything since its last answer in one turn; messages from others are context only. Threads have no replies, so the context is the chain that led to the starting message plus the thread's messages in order.
- **Other threads**: only mentions trigger it; the context is that message and the thread's first message.
- A typing indicator repeats every 8 seconds until the first post.
- The first text posts as a reply, then is edited at most every 1.5 seconds. It pings the author only in communities.
- While a web tool runs, a subtext line shows `🔎 searching: <query>` or `📄 reading: <host>`.
- Up to 10 deduplicated citations are listed under **Sources** as `[title](<url>)` links without previews. Fetch citations are mapped from document index to URL.
- Replies over 4,000 characters split at paragraph or line breaks, closing and reopening a split code block. Each part replies to the previous one.
- `allowed_mentions` permits only the reply ping, and a part refused with `CONTENT_BLOCKED` becomes a short note.

## Spending caps

### Accounting

Each API call's cost comes from its `usage`:

```
input_tokens                        × input price
cache_creation_input_tokens         × 1-hour write price for the 1-hour part, 5-minute for the rest
cache_read_input_tokens             × read price
output_tokens                       × output price
server_tool_use.web_search_requests × US$0.01
```

Long-context rates apply when the call's prompt tokens exceed the threshold. The streamed TTL breakdown covers only the first iteration, so later writes count as 5-minute; without a breakdown, all writes count as 1-hour. Each call adds a ledger row (`<data_dir>/clanker.db`): time, user, community, model, tokens, searches, fetches, and cost.

### Caps

- Per user per day: US$5.00 (`limits.user_daily_usd`). `[[limits.overrides]]` per user or role can only raise it (the highest match applies); a default of 0 leaves the bot to users and roles with an override.
- Pro users per day: US$10.00 (`pro.user_daily_usd`), unless an override is higher. A pro user who reaches it waits for the next day; there is no fallback to the standard tier.
- All users per month: US$100.00 (`limits.monthly_usd`).

Days start at midnight in `timezone`, months on the 1st. A request starts if the user's spend today and everyone's spend this month are both below their caps; its actual cost is recorded per API call once it's known. Nothing is estimated in advance, so the requests running when a cap is reached go over it, by at most one request per user. A cap of 0 blocks. If the ledger can't be written, costs are held in memory, still count, and are written once a write works.

### Typical costs

Actual costs with the defaults: a short answer about a tenth of a cent, each search about a cent more, and a long answer with several searches and pages US$0.05 to US$0.15.

### PDFs

`max_content_tokens` applies only to text, so a fetched PDF arrives whole, sometimes over 100,000 tokens. Its actual cost is recorded like any other.

### Limit notices

A user's first block in a period gets a notice:

> @Alice, you've reached your daily limit of US$5.00. It resets at midnight UTC (in 3 h 12 min).

> I've reached my monthly spend limit of US$100.00. It resets on 2026-12-01.

Later blocks get only a `⏳` reaction. With `limits.notice = "dm"`, community notices go by DM to keep a user's limit private, falling back to the channel, and the channel gets `⏳`. Once monthly spend reaches the cap, the owner is [alerted](#owner-alerts) and every request is refused until next month.

## Abuse guards

- `limits.cooldown_seconds` (5) per user, commands included, and one request in flight per user. Extra messages get a `🐢` at most once a minute.
- `limits.max_concurrent` (4) requests at once. Up to `limits.max_queue` (8) more wait up to 60 seconds for a slot; a full queue or a timeout gets a "busy" notice, at most once a minute per channel.
- The REST client follows rate-limit headers, waits out a 429 up to 3 times (at most 60 seconds each), retries a send that failed with a 5xx or network error twice, and sends one request at a time per channel.
- No tool acts on anything, so injected instructions can only change the text.

## Privacy and data

- Only channel permissions limit what the bot receives. Messages that don't trigger it are dropped at the first failed check, never logged or stored.
- Sent to Anthropic: the system prompt, the reply chain (names, timestamps, text, and images), and the context line, under Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) and [data retention policy](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data). Websites see Anthropic's servers, not the host.
- On disk: the ledger and flags for notices and alerts already sent, kept until the operator deletes them. In memory: exact turns and role IDs, 5 minutes each.
- Logs carry IDs, costs, and token counts. Message text appears only with `log.level = "debug"`, which warns at startup.
- `help` and the bio say the bot is an AI that sends messages to Anthropic.

## Configuration

One TOML file, `/config/clanker.toml` or the path in `CLANKER_CONFIG`. [clanker.example.toml](../clanker.example.toml) documents every key.

- The schema rejects unknown keys and out-of-range values and lists every problem. Cross-key checks (budget, prices, caps, and the prompt file) follow once it passes.
- Secrets come from `FLUXER_BOT_TOKEN` and `ANTHROPIC_API_KEY` or their `*_FILE` variants, not both. The token must look like `<application id>.<secret>`.
- `[prices."<model>"]` adds a model or replaces a built-in one completely; replacing Haiku 5.5 needs a `long_context` table.
- `model.system_prompt_file` and `health.heartbeat_file` resolve against the config's directory, and `data_dir` against the working directory.
- `CLANKER_HEARTBEAT_FILE` (default `/data/heartbeat`) must match a changed `data_dir` or `health.heartbeat_file`.
- Each tool takes `allowed_domains` or `blocked_domains`, not both.

## Stack

- TypeScript 7 on Node.js 24.15 or newer. The container runs Node 26.
- `@fluxerjs/rest`, `@fluxerjs/ws`, and `@fluxerjs/types`, not `@fluxerjs/core`'s `Client`, which caches users, members, and message content and drops member events on cache misses. Clanker adds send retries, a 90-second READY watchdog, socket timeouts, and de-duplication.
- `@anthropic-ai/sdk`, `zod`, `smol-toml`, and `node:sqlite`, which needs no native modules. `vitest` and `biome` for development.
- Exact versions in `package-lock.json`, installed without scripts.

## Repository layout

```
src/
  index.ts          startup, heartbeat, shutdown
  app.ts            message flow, owner alerts
  config.ts         schema, secrets, tiers, context budget
  fluxer.ts         gateway and REST
  access.ts         who and where
  triggers.ts       triggers and commands
  commands.ts       command and notice texts
  chain.ts          reply chains
  replay.ts         exact-turn cache
  claude.ts         requests, streaming, errors
  render.ts         edits, sources, splitting
  spend.ts          costs, caps
  store.ts          SQLite ledger
  guards.ts         cooldown, concurrency
  prompt.ts         system prompt
  healthcheck.ts    health check
  log.ts, money.ts, time.ts, types.ts
test/               unit tests, fixtures, fakes
docs/               design.md, deploy.md
.github/workflows/  ci.yml, release.yml
clanker.example.toml, Containerfile, renovate.json
```

## Container and releases

- **Image.** Distroless `nodejs26-debian13:nonroot`, pinned by digest, running as UID 65532. No native modules, so arm64 builds without emulation.
- **Runtime.** Read-only `/config`, a `/data` volume for the ledger and heartbeat, a read-only root, no capabilities, and no ports. Outbound only to `api.fluxer.app`, `gateway.fluxer.app`, `fluxerusercontent.com`, `api.anthropic.com`, and `health.ping_url`.
- **Exit codes.** 78 for an invalid config or a rejected bot token, so service managers stop retrying. 70 for other fatal errors. On SIGTERM answers get up to 15 seconds, and the process exits within 20.
- **Health.** The heartbeat file is touched on each gateway heartbeat acknowledgement (about every 41 seconds) and must be younger than `CLANKER_HEARTBEAT_MAX_AGE` (120 seconds). Podman ignores `HEALTHCHECK` in OCI images, so Quadlet units set `HealthCmd=`.
- **Releases.** A `vX.Y.Z` tag matching `package.json` pushes `ghcr.io/linus-sexy-tips/clanker:X.Y.Z` and `:X.Y` for amd64 and arm64, never `latest`. The image is cosign-signed by digest (keyless, identity `release.yml` at the tag), with build provenance for `gh attestation verify` and an SPDX SBOM on the GitHub release. Verification commands are in [deploy.md](deploy.md#verifying-the-image).
- **CI.** SHA-pinned actions run typecheck, lint, tests, and build on Node 24 and 26, `npm audit`, a base-image signature check, and a two-architecture build with a smoke test. Renovate proposes updates, and `SECURITY.md` covers reporting.

## To check against the live services

- Whether a server-tool request is priced on its summed input (assumed) or per iteration. One test request with searches, compared with the Console's cost, settles it.
- Whether `max_uses` counts across a `pause_turn` continuation.
- Which form of the `⏳` and `🐢` emoji Fluxer's reaction route accepts.
- Whether fluxer.app's attachment URLs are signed and expire.
- A live login with the REST and gateway packages on Node 26.
