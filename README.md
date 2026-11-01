# Clanker

A self-hosted [Fluxer](https://fluxer.app) bot that answers approved users with Claude. It responds when mentioned, when someone replies to it, or in a DM, and can search the web and read links.

- Context is only the reply chain the bot was called from, never the rest of the channel.
- Access by user ID or by role per community, optionally limited to some channels. The bot leaves communities that aren't listed.
- A daily spending cap per user and a monthly cap overall. The owner gets alerts by DM.
- Web search and fetch, with sources listed under the answer.
- Prompt caching. Claude Haiku 5.5 by default.
- Stores no message content. One container image, one config file, two secrets.

## Usage

Mention the bot, reply to one of its messages, or DM it. To continue a conversation, reply to its answer.

Commands (mention the bot with only the word): `help` and `usage`. The owner can also DM it `status` and `usage all`.

## Running it

You need:

- a private Fluxer bot application, installed in your community with the View channel, Send messages, Read message history and Add reactions permissions
- an Anthropic API key, ideally in its own workspace with a spend limit
- Podman or Docker (amd64 or arm64), or Node.js 24.15 or newer

The image is `ghcr.io/linus-sexy-tips/clanker`, signed with cosign. [docs/deploy.md](docs/deploy.md) covers the setup step by step: Fluxer and Anthropic, a Podman Quadlet unit or Docker, updates, backups and image verification.

## Configuration

Copy [clanker.example.toml](clanker.example.toml) to `/config/clanker.toml` and edit it. Only `owner_id` is required. List your community under `[guilds]` with the roles that may use the bot. The secrets come from `FLUXER_BOT_TOKEN` and `ANTHROPIC_API_KEY`, or from files named in `FLUXER_BOT_TOKEN_FILE` and `ANTHROPIC_API_KEY_FILE`.

## Costs

Haiku 5.5 costs US$0.10 per million input tokens and US$0.50 per million output tokens, and each web search US$0.01. A short answer costs about a tenth of a cent; one that searches and reads a few pages costs a few cents. Before each call the bot reserves a worst-case amount against the caps (about US$0.40 with the defaults) and replaces it with the actual cost afterwards. See [docs/design.md](docs/design.md#spending-caps) for how this is calculated.

## Privacy

Fluxer delivers every message in the channels the bot can see; the bot discards those that don't trigger it. For each answer it sends the reply chain (display names, timestamps, text and images) to Anthropic. On disk it keeps only a spending ledger (IDs, token counts and costs). Recent API turns stay in memory for 5 minutes. Logs contain no message text unless debug logging is on.

## Development

Requires Node.js 24.15 or newer.

```sh
npm ci
npm run check   # typecheck, lint and tests
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/design.md](docs/design.md).

## License

[AGPL-3.0-or-later](LICENSE). If you run a modified version, publish its source and set `source_url` in the config to it.
