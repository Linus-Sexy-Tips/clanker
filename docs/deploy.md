# Deploying Clanker

Setup with a rootless Podman Quadlet, Docker, or a source checkout.

## Prerequisites

- Linux (amd64 or arm64) with systemd and Podman 5, Docker, or Node.js 24.15 or newer.
- [cosign](https://github.com/sigstore/cosign) 3.1.4 or newer and `gh`.
- Outbound HTTPS to `api.fluxer.app`, `gateway.fluxer.app`, `fluxerusercontent.com`, and `api.anthropic.com`.
- A Fluxer account with Manage Community in your community, and an Anthropic API account with billing.

## Fluxer

1. In **User settings > Applications**, create an application.
2. Turn off **Public bot** so only you can install it. Leave **Require OAuth2 code grant** off.
3. Copy the **bot token** (`<application id>.<secret>`).
4. Set an avatar and a bio that says what the bot is, for example:

   > AI bot, not a person. Answers with Claude by Anthropic: the reply chain you send it goes to Anthropic. Source: https://github.com/Linus-Sexy-Tips/clanker

5. Install it with this link while signed in:

   ```
   https://web.fluxer.app/oauth2/authorize?client_id=<application id>&scope=bot&permissions=309237713984
   ```

   `309237713984` is View channel (1024), Send messages (2048), Read message history (65536), Add reactions (64), Create public threads (2^35, for long answers), and Send messages in threads (2^38). Fluxer drops the thread permissions if your account can't grant them; add it to the bot's role later in that case. Don't give the bot's role Administrator or Mention Everyone. On a self-hosted instance, use its web app address and set `api_url`.
6. The bot receives every message in channels it can view. Limit those with channel permissions.
7. DMs need a community shared with the bot: Fluxer only lets users DM a bot they share a community with. For a DM-only setup, use a small private community and list it under `[guilds]`, or the bot leaves it.
8. Turn on **Developer mode** in User settings, then copy your user ID, the community ID, and the allowed role IDs from their context menus.

## Anthropic

1. In the [Claude Console](https://platform.claude.com), create a workspace for the bot and an API key in it.
2. Set the workspace's monthly spend limit a little above `limits.monthly_usd`, as a backstop for the bot's own accounting. A fetched PDF isn't capped by `max_content_tokens` and can push a request past its [reservation](design.md#spending-caps).
3. Allow web search and web fetch for the organization, or turn them off in the config.

## Config

Start from [clanker.example.toml](../clanker.example.toml) of your release. Set at least `owner_id`, `timezone`, a `[guilds."<community id>"]` table with `roles`, and the caps under `[limits]`. Also:

- The container reads `/config/clanker.toml`; `CLANKER_CONFIG` overrides it. Keep `data_dir = "/data"`.
- A relative `model.system_prompt_file` is read from the config file's folder.
- A `[prices."<model>"]` entry replaces the built-in one completely. For `claude-haiku-5-5` it needs a `long_context` table.
- If you change `data_dir` or `health.heartbeat_file`, set `CLANKER_HEARTBEAT_FILE` (default `/data/heartbeat`) to match. `CLANKER_HEARTBEAT_MAX_AGE` defaults to 120 seconds.
- Set each secret as a variable or as `*_FILE`, not both.

Clanker prints config problems by key and exits with code 78, as it does for a rejected bot token.

## Podman Quadlet

Create the user, enable lingering, and check that it has subordinate IDs (one line per file):

```sh
sudo useradd --create-home --comment "Clanker bot" clanker && sudo loginctl enable-linger clanker && grep clanker /etc/subuid /etc/subgid
```

Switch to it. Everything else runs as `clanker`.

```sh
sudo -iu clanker
```

```sh
export XDG_RUNTIME_DIR=/run/user/$(id -u)
```

[Verify](#verifying-the-image) and pull the image:

```sh
podman pull ghcr.io/linus-sexy-tips/clanker@sha256:<digest>
```

Store the secrets in a password manager.

```sh
read -rsp 'Fluxer bot token: ' s && echo && printf '%s' "$s" | podman secret create fluxer_bot_token - && unset s
```

```sh
read -rsp 'Anthropic API key: ' s && echo && printf '%s' "$s" | podman secret create anthropic_api_key - && unset s
```

Fetch and edit the config. The container runs as UID 65532.

```sh
mkdir -p ~/clanker/config && curl -fsSL -o ~/clanker/config/clanker.toml https://raw.githubusercontent.com/Linus-Sexy-Tips/clanker/vX.Y.Z/clanker.example.toml
```

```sh
chmod 755 ~/clanker/config && chmod 644 ~/clanker/config/*
```

Write the unit with your digest and version:

```sh
mkdir -p ~/.config/containers/systemd && cat > ~/.config/containers/systemd/clanker.container <<'EOF'
[Unit]
Description=Clanker Fluxer bot

[Container]
ContainerName=clanker
# Clanker X.Y.Z. Update by hand: see "Updating" in docs/deploy.md.
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
# Podman ignores the image's HEALTHCHECK. Only a JSON array of two or more
# elements runs without /bin/sh, which the image doesn't have.
HealthCmd=["/nodejs/bin/node","/app/dist/healthcheck.js"]
HealthInterval=60s
HealthTimeout=10s
HealthStartPeriod=120s
HealthRetries=3
HealthOnFailure=kill
# Answers in progress get up to 15 s to finish; the process exits after 20 s.
StopTimeout=30

[Service]
Restart=always
RestartSec=10
# 78 = invalid config or rejected bot token: don't restart until it's fixed.
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
EOF
```

Start it. `[Install]` covers boot, so there's no `enable` step.

```sh
systemctl --user daemon-reload && systemctl --user start clanker
```

The log should show `starting`, then `connected`. Test with a `help` mention. If the bot is silent, check your access, its channel permissions, and `channels`.

```sh
journalctl --user -u clanker -n 50
```

The health check fails after about 2 minutes without a gateway heartbeat. After 3 failures, Podman kills the container and systemd starts a new one.

```sh
podman healthcheck run clanker && echo healthy
```

## Docker

```sh
docker run -d --name clanker --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges --stop-timeout 30 \
  -v clanker-data:/data \
  -v "$PWD/config:/config:ro" \
  -v "$PWD/secrets:/run/secrets:ro" \
  -e FLUXER_BOT_TOKEN_FILE=/run/secrets/fluxer_bot_token \
  -e ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_api_key \
  ghcr.io/linus-sexy-tips/clanker@sha256:<digest>
```

`config/clanker.toml` must be readable by everyone, and the files in `secrets/` by UID 65532. With rootful Docker, run `sudo chown 65532 secrets/* && sudo chmod 400 secrets/*`. Docker doesn't restart unhealthy containers, but does restart after exit code 78.

## From source

In a checkout of the release tag, run `npm ci && npm run build`. Set `data_dir = "./data"`, point `CLANKER_CONFIG` and the `*_FILE` variables at the config and at secret files outside the checkout, and run `npm start`.

## Logs

Logs are JSON lines on stdout, without message text unless `log.level = "debug"`. Startup errors and crashes are plain text on stderr. With Docker, use `docker logs -f clanker`.

```sh
journalctl --user -u clanker -f -o cat
```

## Verifying the image

Images are built for amd64 and arm64 and tagged `X.Y.Z` and `X.Y`, never `latest`. Each [release](https://github.com/Linus-Sexy-Tips/clanker/releases) lists the digest to pin, the `cosign verify` command with its exact tag, and the SPDX SBOM. Check the keyless signature and the build provenance:

```sh
cosign verify ghcr.io/linus-sexy-tips/clanker@sha256:<digest> --certificate-identity https://github.com/Linus-Sexy-Tips/clanker/.github/workflows/release.yml@refs/tags/vX.Y.Z --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

```sh
gh attestation verify oci://ghcr.io/linus-sexy-tips/clanker@sha256:<digest> --repo Linus-Sexy-Tips/clanker
```

## Updating

1. Read the release notes and compare the new `clanker.example.toml` with your config.
2. Take a [backup](#backups).
3. Verify and pull the new digest, then update the unit:

   ```sh
   sed -i 's|^Image=.*|Image=ghcr.io/linus-sexy-tips/clanker@sha256:<new digest>|; s|^# Clanker .*|# Clanker <new version>. Update by hand: see "Updating" in docs/deploy.md.|' ~/.config/containers/systemd/clanker.container
   ```

4. Restart and check the log:

   ```sh
   systemctl --user daemon-reload && systemctl --user restart clanker
   ```

To roll back, put the old digest back with the same `sed`, run `systemctl --user daemon-reload`, and restore the backup. Config changes need only a restart. `podman image prune -a` deletes unused images.

To rotate a secret, stop the service, run `podman secret rm anthropic_api_key` (or `fluxer_bot_token`), create it again as above, and start the service.

## Backups

Back up `~/clanker/config` and the `clanker-data` volume, which holds the ledger. Losing the ledger only resets spending counts. Neither holds the secrets.

Export the volume with a brief stop:

```sh
mkdir -p ~/backups && systemctl --user stop clanker && podman volume export clanker-data --output ~/backups/clanker-data.tar; systemctl --user start clanker
```

Or copy the ledger while it runs, with SQLite's `VACUUM INTO`:

```sh
podman exec clanker /nodejs/bin/node -e "const fs = require('node:fs'); const { DatabaseSync } = require('node:sqlite'); fs.rmSync('/data/backup.db', { force: true }); const db = new DatabaseSync('/data/clanker.db'); db.exec(\"VACUUM INTO '/data/backup.db'\"); db.close();"
```

```sh
podman cp clanker:/data/backup.db ~/backups/clanker-$(date +%F).db
```

Before restoring an export, delete leftover write-ahead log files, or SQLite applies them to the restored ledger:

```sh
systemctl --user stop clanker && mp=$(podman volume inspect clanker-data --format '{{.Mountpoint}}') && podman unshare rm -f "$mp/clanker.db-wal" "$mp/clanker.db-shm" && podman volume import clanker-data ~/backups/clanker-data.tar && systemctl --user start clanker
```
