# Clanker

Clanker is a self-hosted bot for [Fluxer](https://fluxer.app) that answers questions with Claude, Anthropic's AI model. You decide which communities it serves, who may use it and how much it may spend. Approved users mention it, reply to it or DM it, and it answers in the chat, using web search when it needs current information. It is meant for small communities where one person runs the bot and pays for the API.

- Answers mentions, replies to its messages, and DMs, streaming the answer as it's written
- Sees only the reply chain it was called from, never the rest of the channel
- Web search and web fetch (reading links), with numbered sources under the answer
- Access by user, by role per community, and per channel; leaves communities you didn't list
- Daily caps per user, a monthly cap for everyone, and alerts to the operator
- Prompt caching to keep costs down; Claude Haiku 5.5 by default
- Stores no message content; one container image, one config file, two secrets

## How it works

- **Triggers.** A message triggers Clanker when it mentions the bot, replies to one of its messages, or is a DM. Messages from users who aren't allowed are ignored silently, with no API calls of any kind. Fluxer only lets people DM the bot if they share a community with it.
- **Context.** Clanker sends Claude the reply chain that ends at your message: the message, the one it replies to, and so on back to the start (up to 50 messages by default). Nothing else from the channel or DM is sent. To continue a conversation, reply to the bot's answer. Images in the chain (up to 4) are included; other files are listed by name.
- **Web.** Claude can search the web and read pages (each up to 3 times per answer by default). Sources are listed under the answer, and link previews are turned off.
- **Spending caps.** Before every call to Claude, Clanker reserves the worst-case cost of that call against the user's daily cap and the monthly cap for everyone. If it doesn't fit, the user gets a short notice the first time in that period, and a ⏳ reaction after that. The real cost is recorded after the call.
- **Owner alerts.** The owner gets a DM at 80% and 100% of the monthly cap, when the bot leaves a community that isn't listed, when Anthropic rejects the API key, and after 3 failed calls to Claude in a row.
- **Abuse guards.** Each user waits 5 seconds between requests and can have one request running at a time (extra messages get a 🐢 reaction, at most once a minute). At most 4 requests run at once; a few more wait in a queue, and the rest get a "busy" reply.
- **Commands.** Mention the bot (or DM it) with only the word:
  - `help`: what the bot does, the model, the caps and a link to the source
  - `usage`: your spend today and everyone's spend this month
  - `usage all` (owner, in a DM): spend per user
  - `status` (owner, in a DM): uptime, connection, model, communities, cache hit rate and today's totals

Commands, notices and reactions never call Claude.

## Privacy

- **Fluxer has no gateway intents**, so the bot receives every message in every channel it can view. Messages that don't trigger it are dropped as soon as the checks fail; they are never logged or stored. Use channel permissions to keep the bot out of channels it shouldn't see.
- **Sent to Anthropic** for each answer: the system prompt, the reply chain (author display names, timestamps, text and images), and a header with the community and channel names and the date. Web search queries and fetched pages are handled by Anthropic; the websites see Anthropic's servers, not yours, and may log the request. Anthropic processes this under its [Commercial Terms](https://www.anthropic.com/legal/commercial-terms). How long it keeps API data is described in its [data retention policy](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) and the [API data retention docs](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention).
- **Stored on disk** (`/data/clanker.db`): a spending ledger with one row per API call (time, user ID, community ID, model, token counts, number of searches and fetches, cost) and flags for notices already sent. No message content. Rows are kept until you delete them.
- **Held in memory only**: the exact API turns of recent answers, for 5 minutes after their last use (so follow-ups can reuse the prompt cache), and members' roles for 5 minutes.
- **Logs** contain event types, IDs, costs, token counts and errors, never message text, unless you set `log.level = "debug"` (the bot warns about this at startup).
- The `help` reply, and the bio you set when [setting up Fluxer](#set-up-fluxer), say that it's an AI and link to the source.

## Requirements

- A Fluxer account, and a community where you have the **Manage community** permission
- An Anthropic API account with billing set up
- Podman (rootless, with Quadlet) or Docker on a Linux host, amd64 or arm64. Or Node.js 24.15 or newer to run from source.
- Outbound HTTPS to `api.fluxer.app`, `gateway.fluxer.app` (WebSocket), `fluxerusercontent.com` (images) and `api.anthropic.com`. No inbound ports.

## Set up Fluxer

1. In Fluxer, open **User settings > Applications** and create an application, for example "Clanker". The bot's user ID is the same as the application ID.
2. Turn off **Public bot**, so that only you can install it. Leave **Require OAuth2 code grant** off.
3. Copy the **bot token**. It looks like `<application id>.<secret>` and is shown only once (regenerate it if you lose it; the old one stops working).
4. Under the bot profile, set the avatar and a **bot bio** that says what it is, for example:
   > AI bot, not a person. Answers with Claude by Anthropic: the reply chain you send it goes to Anthropic. Source: https://github.com/Linus-Sexy-Tips/clanker
5. Install the bot in your community by opening this link while signed in (put in your application ID):
   ```
   https://web.fluxer.app/oauth2/authorize?client_id=<application id>&scope=bot&permissions=68672
   ```
   You can also build the link with the URL builder on the application's page. `68672` grants exactly these permissions, which is all the bot needs:

   | Permission | Value | Why |
   |---|---|---|
   | View channel | 1024 | see messages |
   | Send messages | 2048 | answer and edit its answers |
   | Read message history | 65536 | fetch older messages in a reply chain |
   | Add reactions | 64 | ⏳ and 🐢 reactions |

   Fluxer creates a role for the bot with these permissions. Don't give it Administrator or Mention Everyone. If your community uses threads, also allow **Send messages in threads** for the bot's role. On a self-hosted Fluxer instance, use your instance's web app address instead of `web.fluxer.app`.
6. Turn on **Developer mode** in User settings (search for it) to get **Copy user ID**, **Copy community ID** and **Copy role ID** in the context menus. You need these IDs for the config.

## Set up Anthropic

1. In the [Claude Console](https://platform.claude.com), create a workspace just for the bot.
2. Set a monthly **spend limit** on that workspace, a little above `limits.monthly_usd`. It's a backstop in case the bot's own accounting is ever wrong.
3. Create an API key in that workspace.
4. Web search and web fetch must be allowed for your organization in the Console. If they aren't, requests fail; turn the tools off in the config instead.

## Run it

Releases are published as `ghcr.io/linus-sexy-tips/clanker` for amd64 and arm64, tagged `X.Y.Z` and `X.Y` (there is no `latest`). Each [GitHub release](https://github.com/Linus-Sexy-Tips/clanker/releases) lists the image digest. Pin the digest, and [verify the signature](#verify-the-image) before you run a new one.

The container:

- reads its config from `/config/clanker.toml` (mount `/config` read-only; change the path with `CLANKER_CONFIG`)
- keeps its ledger and heartbeat file in `/data` (a volume)
- reads the secrets from `FLUXER_BOT_TOKEN_FILE` and `ANTHROPIC_API_KEY_FILE` (files), or `FLUXER_BOT_TOKEN` and `ANTHROPIC_API_KEY` (plain variables)
- runs as UID 65532 with a read-only root filesystem, needs no capabilities and opens no ports
- exits with code 78 if the config is invalid (after printing every problem it found) or Fluxer rejects the bot token

### Podman (Quadlet)

Run it as its own unprivileged user. [docs/deploy.md](docs/deploy.md) walks through the whole setup: the user, the secrets, the health check, logs, updates and backups. The unit, `~/.config/containers/systemd/clanker.container`:

```ini
[Unit]
Description=Clanker Fluxer bot

[Container]
ContainerName=clanker
# Clanker X.Y.Z. Update by hand: see docs/deploy.md.
Image=ghcr.io/linus-sexy-tips/clanker@sha256:<digest>
Volume=clanker-data:/data
Volume=%h/clanker/config:/config:ro,Z
Secret=fluxer_bot_token
Secret=anthropic_api_key
Environment=FLUXER_BOT_TOKEN_FILE=/run/secrets/fluxer_bot_token
Environment=ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_api_key
ReadOnly=true
NoNewPrivileges=true
DropCapability=ALL
# Podman ignores the image's HEALTHCHECK, so define it here (JSON form: the image has no shell).
HealthCmd=["/nodejs/bin/node","/app/dist/healthcheck.js"]
HealthInterval=60s
HealthTimeout=10s
HealthStartPeriod=120s
HealthRetries=3
HealthOnFailure=kill
# Give answers in progress time to finish when stopping.
StopTimeout=30

[Service]
Restart=always
RestartSec=10
# 78 = invalid config or bot token: don't restart until it's fixed.
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
```

Before starting it, put `clanker.toml` in `~/clanker/config` (readable by everyone; it holds no secrets) and create the two secrets with `podman secret create fluxer_bot_token -` and `podman secret create anthropic_api_key -` (they read the value from stdin). Then run `systemctl --user daemon-reload` and `systemctl --user start clanker`.

### Docker

```sh
docker volume create clanker-data
docker run -d --name clanker --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges --stop-timeout 30 \
  -v clanker-data:/data \
  -v "$PWD/config:/config:ro" \
  -v "$PWD/secrets:/run/secrets:ro" \
  -e FLUXER_BOT_TOKEN_FILE=/run/secrets/fluxer_bot_token \
  -e ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_api_key \
  ghcr.io/linus-sexy-tips/clanker@sha256:<digest>
```

`config/clanker.toml` must be readable by everyone (it holds no secrets). The two files in `secrets/` must be readable by UID 65532 inside the container; with rootful Docker, `sudo chown 65532 secrets/* && sudo chmod 400 secrets/*` does that. Docker runs the image's health check and marks the container unhealthy, but doesn't restart it.

## Configuration

Copy [clanker.example.toml](clanker.example.toml) to `clanker.toml` and edit it. It lists every key with its default and a short explanation. Only `owner_id` is required. The owner may always use the bot; everyone else must be listed in `access.users` or have a listed role. List your community under `[guilds]`, or the bot leaves it. Unknown keys and out-of-range values stop the bot with a clear error. The important keys:

| Key | Default | What it does |
|---|---|---|
| `owner_id` | (required) | Your Fluxer user ID: receives alerts by DM and can use the owner commands |
| `access.users` | `[]` | Users allowed everywhere, including DMs |
| `[guilds."<community id>"]` `roles`, `channels` | none | Communities the bot serves; members with any listed role may use it; `channels` restricts where (empty = any channel it can see) |
| `access.guilds_leave_unlisted` | `true` | Leave any community not listed under `[guilds]` and tell the owner |
| `dms.enabled` | `true` | Allowed users may DM the bot |
| `timezone` | `"UTC"` | When days and months start for the caps, and the timestamps Claude sees |
| `model.name`, `model.effort` | `"claude-haiku-5-5"`, `"medium"` | Model and thinking effort |
| `tools.web_search`, `tools.web_fetch` | on, 3 uses each | Web tools; optional domain allow or block lists |
| `context.max_messages`, `context.max_chain_tokens` | `50`, `50000` | Longest reply chain; longer threads get a "start a new thread" notice |
| `limits.user_daily_usd`, `limits.monthly_usd` | `5.00`, `100.00` | Spending caps; `[[limits.overrides]]` raises the daily cap for some users or roles |
| `limits.notice` | `"reply"` | Send limit notices in the channel, or by `"dm"` to keep them private |
| `source_url` | this repository | Linked from `help`; point it at your fork if you change the code |
| `health.ping_url` | `""` | Optional URL (e.g. Healthchecks.io) pinged every 5 minutes while connected |

`model.system_prompt_file` replaces the built-in system prompt; a relative path is resolved against the config file's directory, so you can keep it in `/config` too. If you change `data_dir` or `health.heartbeat_file`, set `CLANKER_HEARTBEAT_FILE` to the same path for the health check.

## Costs

Claude Haiku 5.5 costs US$0.10 per million input tokens and US$0.50 per million output tokens (thinking counts as output). Cache writes cost 1.25× the input price for 5 minutes or 2× for an hour, and cache reads 0.1×. A request whose prompt adds up to more than 100,000 tokens pays 5× these prices for the whole request. Each web search costs US$0.01; web fetch costs only the tokens of the page.

**The reservation is deliberately pessimistic.** With the defaults, one API call is reserved at about **US$0.40**: a full 100,000-token prompt read once for the first step and again after each of the 6 possible searches and fetches (700,000 tokens, which also crosses into the higher price tier: US$0.35), plus 8,000 output tokens (US$0.02) and 3 searches (US$0.03). A user can start a request only while that much is still free under their daily cap and the monthly cap, and the reservation is replaced by the real cost as soon as the call ends. To make it smaller, lower the tools' `max_uses`, `model.max_tokens` or `context.max_request_tokens` (the chain and tool budgets must still fit in it).

**Real costs are much lower.** Rough figures with the defaults: a short answer without the web costs about a tenth of a cent; each search adds about a cent; a long answer that searches and reads several pages stays around US$0.05 to 0.15. Caching helps: the system prompt and tool definitions are cached for an hour and shared by every conversation, and a follow-up within 5 minutes of the bot's answer reuses the cached chain at a tenth of the input price. `status` shows the day's cache hit rate.

## Verify the image

Releases are signed with [cosign](https://github.com/sigstore/cosign) (keyless, from the release workflow) and carry GitHub build provenance and an SBOM. Use cosign 3.1.4 or newer, the version the release workflow signs with; older versions may not find its signatures on GHCR.

```sh
cosign verify ghcr.io/linus-sexy-tips/clanker@sha256:<digest> \
  --certificate-identity-regexp '^https://github\.com/Linus-Sexy-Tips/clanker/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

```sh
gh attestation verify oci://ghcr.io/linus-sexy-tips/clanker@sha256:<digest> --repo Linus-Sexy-Tips/clanker
```

The release notes show the same `cosign verify` command with the exact tag in `--certificate-identity`. The SPDX SBOM is attached to each GitHub release.

## Development

You need Node.js 24.15 or newer.

```sh
npm ci            # install scripts are off (.npmrc)
npm run check     # typecheck, lint and tests
npm run build     # compile to dist/
```

To run from source, copy `clanker.example.toml` to `clanker.toml`, set `data_dir = "./data"`, put the two secrets in files outside the repository, and start it:

```sh
CLANKER_CONFIG=./clanker.toml \
FLUXER_BOT_TOKEN_FILE="$HOME/.config/clanker/fluxer_bot_token" \
ANTHROPIC_API_KEY_FILE="$HOME/.config/clanker/anthropic_api_key" \
npm start
```

Logs are JSON lines on stdout. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [docs/design.md](docs/design.md) for how it works inside.

## Licence

Clanker is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later). If you run a modified version, the AGPL requires you to offer its source code to the people who use it: publish your fork and set `source_url` to it, so that `help` links to your code. Update the link in the bot's bio too.
