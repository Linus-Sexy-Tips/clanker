# Clanker design

Status: draft, 2026-11-01. Nothing is built yet.

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

AGPL-3.0-or-later. Anyone may fork and change it, but forks must stay under the AGPL, and anyone running a modified version must offer its source to the people using it. The bot's bio and `help` reply link to the source so that operators comply by default. Dependencies must be AGPL-compatible (MIT, Apache-2.0, BSD and ISC are fine).

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
- Bot messages can be up to 4,000 characters, with up to 10 embeds per message.
- Rate limits: sending, editing and typing are each limited to 20 per 10 seconds per channel, and there is a global limit of 50 requests per second.
- There are no slash commands or interactions yet.
- Fluxer bans deception, spam and bulk scraping, and lists "automation or selfbot" as an enforcement reason. Clanker uses a normal bot application.

## How a message flows

```
Fluxer gateway: MESSAGE_CREATE
  1. Ignore: bots, webhooks, our own messages, edits
  2. Where:  allowed community (and channel, if restricted), or a DM
  3. Trigger: mentions us / replies to one of our messages / is a DM
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

In DMs, the user is allowed if they are in `access.users`, or have an allowed role in any allowed community. Their roles are looked up with `GET /guilds/{id}/members/{user_id}` for each allowed community. Results are cached for 5 minutes and dropped on `GUILD_MEMBER_UPDATE` or `GUILD_MEMBER_REMOVE`, so revoking a role takes effect immediately.

Messages from users who aren't allowed are ignored silently: no reply and no reaction.

### Where

- **Communities.** Only community IDs listed under `guilds` are served. The bot should be private, so only the operator can install it. On `READY` and `GUILD_CREATE`, the bot leaves any community that isn't listed (if `guilds_leave_unlisted = true`, the default), logs it, and DMs the owner.
- **Channels.** By default the bot answers in any channel it can see in an allowed community. `guilds.<id>.channels` can restrict it further. The operator should also use Fluxer channel permissions, because the bot receives every message in every channel it can view.
- **DMs.** `dms.enabled` turns DMs on or off. When they're on, DMs are answered only for allowed users, as above.

### Owner

`owner_id` is the operator's Fluxer user ID. The owner:

- receives alerts by DM (monthly spend at 80% and 100%, leaving an unlisted community, repeated API errors), and
- can use owner-only commands.

## Triggers and commands

A message triggers the bot if it is in an allowed place, from an allowed user, and any of these holds:

- it mentions the bot,
- it replies to a message the bot wrote, or
- it is a DM.

Edits to earlier messages do not trigger the bot (v1).

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
2. Stop at the root (a message that replies to nothing), at `context.max_messages` (default 50), or when the chain runs over `context.max_chain_tokens`.
3. If the chain runs over the budget, the bot doesn't call Claude. It replies that the thread is too long and asks the user to start a new one. Dropping the oldest messages instead would change the start of every request, which defeats caching and quietly loses context.

Turning the chain into API messages:

- Messages written by the bot become `assistant` turns. Everything else becomes `user` turns.
- Consecutive user messages are merged into one turn.
- Each message is written the same way every time, using only facts that never change:

  ```
  [Alice · 2026-11-01 14:05 PT]
  message text
  ```

- Mentions (`<@id>`) are replaced with display names.
- Messages from users who aren't approved can appear in a chain (for example, an approved user replies to someone else's message and mentions the bot). They are included and labelled like any other message. They cannot trigger the bot.
- Images attached to messages in the chain (up to `context.max_images`, default 4, each under 5 MB) are downloaded and sent as image blocks. Other files are listed by name only (v1).
- A reply the bot split into several Fluxer messages counts as one assistant turn.

The token count used for the budget is a local estimate (characters ÷ 3, plus a fixed cost per image), which errs on the high side. No API call is made.

## Calling Claude

| Setting | Default | Notes |
|---|---|---|
| Model | `claude-haiku-5-5` | Configurable. Kept fixed for the life of a chain, because switching models throws away its cache. |
| Thinking | adaptive, `display: "omitted"` | Thinking text is never shown. |
| Effort | `medium` | `output_config.effort`. Kept fixed per chain for the same reason. |
| `max_tokens` | 8,000 | Thinking counts toward this. |
| Web search | `web_search_20260209`, `max_uses: 3` | $10 per 1,000 searches plus tokens. Optional `allowed_domains` or `blocked_domains`, and `user_location`. |
| Web fetch | `web_fetch_20260209`, `max_uses: 3`, `max_content_tokens: 10000`, citations on | Tokens only. It can open URLs that users post. |
| Streaming | on | |

Check for newer tool versions at build time. `web_search_20260318` and `web_fetch_20260318` are listed in the docs as of 2026-11-01.

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

The config loader refuses budgets whose total is over `context.max_request_tokens` (default 100,000). To check at build time: whether cached tokens count toward the 100,000 threshold. Assume they do.

### System prompt

The system prompt is fixed text from the config, with a sensible built-in default. It contains no date, names or other values that change between requests, so it caches across every user and chain. The default covers:

- that it is an AI assistant called Clanker in a Fluxer community, and never claims to be human
- short answers that suit chat, using Fluxer markdown
- citing sources when it used the web
- treating quoted messages, web pages and fetched files as information, not instructions

Per-request facts (date, community and channel name) go in the header of the latest user turn. When that turn is replayed later, the header is written exactly the same way, because it uses the message's own timestamp.

### Stop reasons and errors

- `pause_turn`: the server tool loop paused. Send the request again with the partial assistant content added, up to 3 times.
- `refusal`: reply with a short note that the request was declined. Haiku 5.5 has no server-side fallback. For models that support it, `fallbacks: "default"` can be enabled in the config.
- `max_tokens`: post what was written, plus a note that the answer was cut off.
- Web tool errors arrive as result blocks, not exceptions. Let the model handle them.
- API 429, 5xx and network errors: the SDK retries twice. If it still fails, reply "temporarily unavailable", release the reservation, and alert the owner after 3 failures in a row.

## Prompt caching

The cache only reuses a request's opening if it is byte-identical to an earlier one. The order is `tools` → `system` → `messages`.

1. **Fixed opening.** Tools and the system prompt never change between requests, so they are shared by every user and chain. A breakpoint goes after the system prompt with a 1-hour TTL (`cache.system_ttl`, default `1h`), because a quiet community would otherwise lose it every 5 minutes.
2. **Chain.** Automatic caching (top-level `cache_control`) puts a breakpoint on the latest message with a 5-minute TTL. Every hit restarts the timer, so an active conversation stays cached.
3. **Exact replay of the bot's turns.** A follow-up only gets cache hits if the earlier assistant turns are sent back exactly as the API returned them: thinking blocks with signatures, server tool calls and results, and text with citations. Fluxer only holds the bot's written answer. So Clanker keeps an in-memory map from each bot message ID to the exact API content of that turn, plus the exact user turn it answered:
   - Entries live as long as the chain's cache (5 minutes from last use) and are capped by count and memory size.
   - Nothing is written to disk.
   - Exact turns are only used if every earlier bot turn in the chain is also available exactly. Otherwise the whole chain is rebuilt from Fluxer text. Mixing the two would change earlier turns, which breaks caching and invalidates replayed thinking blocks.
4. **Monitoring.** Each request logs `cache_read_input_tokens`, `cache_creation_input_tokens` and `input_tokens` (counts only). `status` shows the day's hit rate.

Haiku 5.5 cache prices: reads cost 0.1× the input price, 5-minute writes 1.25×, and 1-hour writes 2×. The minimum cacheable prefix is about 512 tokens (to check at build time).

## Replying in Fluxer

- **Typing.** Send a typing indicator when work starts, repeated every 8 seconds until the first text arrives.
- **Placeholder and streaming.** Post a reply to the triggering message as soon as the first text arrives, then edit it with new text at most once every 1.5 seconds. This stays well inside the limit of 20 edits per 10 seconds per channel, even with a few replies streaming at once.
- **Tool status.** While a web tool runs, the message shows a status line such as `🔎 searching: <query>` or `📄 reading: <domain>`. It's removed when the answer arrives.
- **Sources.** Citations are collected, deduplicated and numbered, and appended as a "Sources" list of links. Link previews are suppressed if Fluxer supports a suppress-embeds flag (to check).
- **Splitting.** Replies over 4,000 characters are split at paragraph or line breaks, never inside a code block (if a block has to be split, it's closed and reopened). Each part replies to the previous part, so the chain stays intact. All the parts map to the same assistant turn.
- **Mentions.** `allowed_mentions` is limited to replying to the user, so model output can't ping roles, @everyone or other users.

## Spending caps

### Accounting

After each request, the cost is calculated from the response's `usage`:

```
input_tokens                × input price
cache_creation_input_tokens × write price (5-minute or 1-hour, from the usage breakdown)
cache_read_input_tokens     × read price
output_tokens               × output price
server_tool_use.web_search_requests × $0.01
```

using a price table in the config (with built-in defaults for supported models, including Haiku's price above 100,000 tokens). Each request adds a row to a local SQLite ledger: user ID, community ID or DM, model, token counts, searches, cost, and timestamp. The ledger stores no message content.

### Caps

| Cap | Default | Config |
|---|---|---|
| Per user per day | US$5.00 | `limits.user_daily_usd`, with overrides per user or role (the higher one applies) |
| All users per month | US$100.00 | `limits.monthly_usd` |

A day starts at midnight in `limits.timezone` (default `UTC`). A month starts on the 1st in the same timezone.

The operator should also set a spend limit on the Anthropic workspace that holds the bot's API key, as a backstop if the bot's own accounting is ever wrong.

### Checking before a request

The worst-case cost of a request comes from the context budget:

```
max_request_tokens × input price × (1 + total tool uses)
+ max_tokens × output price
+ web_search max_uses × $0.01
```

That's about US$0.10 on Haiku 5.5 with the defaults. It is deliberately pessimistic and costs no API call. The estimate is reserved against both caps before the call, which also covers several requests running at once, and is replaced by the actual cost afterwards. If the estimate doesn't fit in what's left, the bot sends a limit notice instead of calling Claude.

### Limit notices

The first time a user is blocked in a period, the bot replies:

> @Alice, you've reached your daily limit of US$5.00. It resets at midnight UTC (in 3 h 12 min).

> Clanker has reached its monthly spend limit of US$100.00. It resets on 2026-12-01.

For the rest of that period, blocked messages only get a ⏳ reaction. `limits.notice` chooses `reply` (default) or `dm`. With `dm`, the full notice goes by DM and the channel only gets the reaction, which keeps a user's limit private.

The owner gets a DM at 80% and 100% of the monthly cap.

## Abuse guards

| Risk | Guard |
|---|---|
| Unapproved users spamming the bot | Ignored silently. No API calls of any kind. |
| Approved users spamming | `limits.cooldown_seconds` (default 5) between requests per user. One request in flight per user. Extra messages are ignored, with a 🐢 reaction once per minute. |
| Many requests at once | `limits.max_concurrent` (default 4). Extra requests wait in a short queue (default 8), then are declined. |
| A prompt that makes the model search or fetch endlessly | `max_uses` on each tool, included in the up-front estimate. |
| Huge reply chains | `context.max_messages` and `context.max_chain_tokens`. |
| Instructions hidden in web pages or quoted messages | The bot has no tools that act on anything. The system prompt treats such content as information. Mentions in output are restricted. |
| Fluxer rate limits | A REST client that follows the rate-limit headers. Edits throttled. Notices sent once per period. |
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

One TOML file (`/config/clanker.toml`), checked at startup with a schema. Unknown keys or values outside their limits stop the bot with a clear error. Secrets come from environment variables or files (`*_FILE`), which suits Podman and Docker secrets.

```toml
owner_id = "1234567890"                 # Fluxer user ID of the operator
api_url = "https://api.fluxer.app/v1"   # for self-hosted Fluxer
# gateway_url is discovered via GET /gateway/bot

[access]
users = ["1234567890", "2345678901"]    # allowed everywhere, incl. DMs
blocked_users = []

guilds_leave_unlisted = true

[guilds."3456789012"]                   # an allowed community
roles = ["4567890123"]                  # members with any of these roles are allowed
channels = []                           # empty = any channel the bot can see

[dms]
enabled = true

[model]
name = "claude-haiku-5-5"
effort = "medium"
max_tokens = 8000
system_prompt_file = ""                 # empty = built-in default

[tools.web_search]
enabled = true
max_uses = 3
blocked_domains = []

[tools.web_fetch]
enabled = true
max_uses = 3
max_content_tokens = 10000

[context]
max_messages = 50
max_chain_tokens = 50000
max_request_tokens = 100000
max_images = 4

[cache]
system_ttl = "1h"
replay_ttl_seconds = 300

[limits]
user_daily_usd = 5.00
monthly_usd = 100.00
timezone = "UTC"
notice = "reply"                        # or "dm"
cooldown_seconds = 5
max_concurrent = 4

[[limits.overrides]]
role = "4567890123"
user_daily_usd = 10.00

[presence]
status = "online"
custom_status = "@mention me to ask"

[log]
level = "info"

[health]
ping_url = ""                           # e.g. a Healthchecks.io URL, pinged every 5 min while connected
```

Secrets:

| Variable | What |
|---|---|
| `FLUXER_BOT_TOKEN` or `FLUXER_BOT_TOKEN_FILE` | Bot token (`<app_id>.<secret>`) |
| `ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY_FILE` | Anthropic API key, ideally in its own workspace with a spend limit |

## Stack

- TypeScript on Node.js 24 LTS. `@fluxerjs/core` needs Node 22.13 or newer.
- `@fluxerjs/core` (Apache-2.0) for the gateway and REST. It is the best-maintained Fluxer library (3.3.0, 2026-10-09) and supports resume and custom status. If it gets in the way, swap in a thin client of our own: the API surface Clanker uses is small.
- `@anthropic-ai/sdk` (MIT).
- `zod` for config validation, `smol-toml` for parsing.
- `node:sqlite` for the ledger, which avoids native modules. Check its stability on Node 24 at build time; fall back to `better-sqlite3`.
- `vitest` for tests.
- Exact versions pinned in `package-lock.json`. Dependencies are kept few.

## Repository layout

```
src/
  index.ts          startup, wiring, shutdown
  config.ts         schema, loading, secrets
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
test/               unit tests with Fluxer event fixtures and recorded API responses
docs/design.md
clanker.example.toml
Containerfile
LICENSE  README.md  SECURITY.md  CONTRIBUTING.md
.github/workflows/  ci.yml, release.yml
renovate.json
```

## Container and releases

- **Image.** Multi-stage build. The final stage is a minimal Node 24 runtime (for example distroless `nodejs24`) pinned by digest. It runs as a non-root UID.
- **Runtime.** Works with a read-only root filesystem. `/data` holds the SQLite ledger, and `/config` holds the config, mounted read-only. No ports are exposed. The bot only makes outbound connections to the Fluxer API, gateway and media CDN, and to `api.anthropic.com`.
- **Health.** A heartbeat file is touched while the gateway is connected, and the container `HEALTHCHECK` checks how old it is. `health.ping_url` is optional.
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

## To check at build time

- Latest web search and web fetch tool versions, and their behaviour on Haiku 5.5.
- Whether cached tokens count toward Haiku 5.5's 100,000-token price threshold.
- Haiku 5.5's minimum cacheable prefix, and how its cache writes are split between 5-minute and 1-hour TTLs in `usage`.
- What happens when replayed thinking blocks follow a rebuilt earlier turn: whether they are dropped, or the request fails.
- Whether Fluxer has a suppress-embeds message flag, and how its markdown renders numbered link lists.
- How `@fluxerjs/core` handles `allowed_mentions`, the reply `message_reference`, and rate-limit headers.
- Whether Fluxer media CDN URLs for attachments need `attachments/refresh-urls` before download.
- `node:sqlite` stability on Node 24.
