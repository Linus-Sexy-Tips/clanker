# Clanker

A [Fluxer](https://fluxer.app) bot that answers users with Claude. It responds when mentioned, when someone replies to it, or in a DM, and can search the web and read links via Anthropic API tools.

- Context is only the reply chain the bot was called from, not the entire channel/chat.
- Access by user ID or by role per community, optionally limited to some channels. The bot leaves communities that aren't listed.
- A daily spending cap per user and a monthly cap overall. The owner gets alerts by DM.
- Web search and fetch, with sources listed under the answer.
- Supports Anthropic prompt caching.

## Usage

Mention the bot, reply to one of its messages, or DM it. To continue a conversation, reply to its answer.

Commands (mention the bot with only the word): `help` and `usage`. The owner can also DM it `status` and `usage all`.

## Running it

You need:

- a private Fluxer bot application, installed in your community with the View channel, Send messages, Read message history, Add reactions and Send messages in threads permissions
- an Anthropic API key
- Podman or Docker (amd64 or arm64), or Node.js 24.15 or newer

The image is `ghcr.io/linus-sexy-tips/clanker`, signed with cosign. [docs/deploy.md](docs/deploy.md) covers the setup.

## Configuration

Copy [clanker.example.toml](clanker.example.toml) to `/config/clanker.toml` and edit it. Only `owner_id` is required. List your community under `[guilds]` with the roles that may use the bot. The secrets come from `FLUXER_BOT_TOKEN` and `ANTHROPIC_API_KEY`, or from files named in `FLUXER_BOT_TOKEN_FILE` and `ANTHROPIC_API_KEY_FILE`.

## Privacy

Fluxer delivers every message in the channels the bot can see; the bot discards those that don't trigger it. For each answer it sends the reply chain (display names, timestamps, text and images) to Anthropic. On disk it keeps only a spending ledger (IDs, token counts and costs). Recent API turns stay in memory for 5 minutes. Logs contain no message text unless debug logging is on.

## Development

Requires Node.js 24.15 or newer.

```sh
npm ci
npm run check
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/design.md](docs/design.md).

## License

[AGPL-3.0-or-later](LICENSE). If you run a modified version, publish its source and set `source_url` in the config to it.
