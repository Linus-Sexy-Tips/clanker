# Deploying Clanker with Podman

This guide runs Clanker as a rootless Podman container, managed by systemd through a Quadlet unit, under its own unprivileged user. It assumes a Linux server with systemd and Podman 5. The `:Z` volume option sets an SELinux label and is ignored where SELinux is off. The [README](../README.md) covers the Fluxer and Anthropic setup; have these ready:

- the bot token (`<application id>.<secret>`) and the Anthropic API key
- your Fluxer user ID, your community ID, and the IDs of the roles that may use the bot
- [cosign](https://github.com/sigstore/cosign) 3.1.4 or newer on the server, to verify the image

Commands marked "admin" run as a user with sudo. Everything else runs as the `clanker` user.

## 1. Create the user (admin)

```sh
sudo useradd --create-home --comment "Clanker bot" clanker
```

Let its services run without a login session and start at boot:

```sh
sudo loginctl enable-linger clanker
```

Rootless Podman needs subordinate ID ranges. This should print one line from each file:

```sh
grep clanker /etc/subuid /etc/subgid
```

Switch to the user:

```sh
sudo -iu clanker
```

Point systemd and Podman at the user's session (needed after `sudo -iu`):

```sh
export XDG_RUNTIME_DIR=/run/user/$(id -u)
```

## 2. Pick and verify the image

Open the [releases page](https://github.com/Linus-Sexy-Tips/clanker/releases) and copy the image digest of the version you want. Releases are signed in the release workflow; check the signature with the exact tag. The examples here use `v0.3.0`; put in your version and digest:

```sh
cosign verify ghcr.io/linus-sexy-tips/clanker@sha256:<digest> --certificate-identity https://github.com/Linus-Sexy-Tips/clanker/.github/workflows/release.yml@refs/tags/v0.3.0 --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

It should list the checks it performed and print the signature as JSON, with no error. Then pull the image by digest:

```sh
podman pull ghcr.io/linus-sexy-tips/clanker@sha256:<digest>
```

## 3. Store the secrets

Each command asks for the value without echoing it or saving it in the shell history. Paste the bot token:

```sh
read -rsp 'Fluxer bot token: ' s && echo && printf '%s' "$s" | podman secret create fluxer_bot_token - && unset s
```

Paste the Anthropic API key:

```sh
read -rsp 'Anthropic API key: ' s && echo && printf '%s' "$s" | podman secret create anthropic_api_key - && unset s
```

Podman's default secret driver keeps them in this user's container storage, readable only by this user. Inside the container they appear as files under `/run/secrets/`, and the unit points `FLUXER_BOT_TOKEN_FILE` and `ANTHROPIC_API_KEY_FILE` at them. Keep a copy in your password manager; backups of the server shouldn't be the only place they live.

## 4. Write the config

Create the config folder:

```sh
mkdir -p ~/clanker/config
```

Download the example config for the same version you pulled (it lists every key with its default):

```sh
curl -fsSL -o ~/clanker/config/clanker.toml https://raw.githubusercontent.com/Linus-Sexy-Tips/clanker/v0.3.0/clanker.example.toml
```

Edit it:

```sh
nano ~/clanker/config/clanker.toml
```

At least set `owner_id`, `timezone`, one `[guilds."<community id>"]` table with the `roles` that may use the bot, and the caps under `[limits]`. Leave `data_dir` at `/data`. A custom system prompt can go in the same folder (`system_prompt_file = "prompt.md"`).

The container runs as UID 65532, which is not this user, so the folder and file must be readable by everyone. They contain no secrets:

```sh
chmod 755 ~/clanker/config && chmod 644 ~/clanker/config/*
```

## 5. Write the Quadlet unit

Create the folder for user units:

```sh
mkdir -p ~/.config/containers/systemd
```

Write the unit (one command; put in your digest and version):

```sh
cat > ~/.config/containers/systemd/clanker.container <<'EOF'
[Unit]
Description=Clanker Fluxer bot

[Container]
ContainerName=clanker
# Clanker 0.3.0. Update by hand: see "Updating" in docs/deploy.md.
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
EOF
```

What the lines do:

| Line | Why |
|---|---|
| `Image=…@sha256:…` | Pinned by digest: the image can't change under you. There is no `latest` tag and no auto-update. |
| `Volume=clanker-data:/data` | A named volume for the ledger (`clanker.db`) and the heartbeat file. Podman creates it on first start, owned by the container's user. |
| `Volume=%h/clanker/config:/config:ro,Z` | The config, read-only. `Z` gives it an SELinux label only this container can use. |
| `Secret=` and `Environment=…_FILE` | The secrets as files under `/run/secrets`, never as plain environment variables. |
| `ReadOnly=true` | Read-only root filesystem. Podman adds small writable tmpfs mounts for `/tmp` and `/run`. |
| `NoNewPrivileges=true`, `DropCapability=ALL` | The process can't gain privileges and has no Linux capabilities. It needs none. |
| `HealthCmd=` and friends | The health check (next section). `HealthOnFailure=kill` stops an unhealthy container, and `Restart=always` starts a fresh one. |
| `StopTimeout=30` | On stop, Clanker waits up to 15 seconds for answers in progress, and exits after 20 at the latest. Podman's default of 10 seconds would cut that short. |
| `RestartPreventExitStatus=78` | Clanker exits with 78 when the config is invalid or Fluxer rejects the bot token; restarting wouldn't help. |

Load the unit:

```sh
systemctl --user daemon-reload
```

Start it. Quadlet units start at boot through `[Install]`, so there's no `enable` step:

```sh
systemctl --user start clanker
```

## 6. Check it

The service should be `active (running)`:

```sh
systemctl --user status clanker
```

The log should show `starting`, then `connected` within a few seconds:

```sh
journalctl --user -u clanker -n 50
```

If the config has problems, the log lists them with their TOML keys, and the service stops with status 78. Checks that involve several keys or files (the context budget, model prices, caps against the per-call reservation, the system prompt file) run only once the file passes the schema, so fixing the first batch can bring up more on the next start. Fix the file and start it again.

Then mention the bot with `help` in your community. If it doesn't answer, check that you're allowed in the config (or are the owner), that the bot's role can view the channel and read its history, and that the channel isn't excluded by `channels`.

## Health check

While its gateway session is live, Clanker touches `/data/heartbeat` every time the gateway acknowledges a heartbeat (about every 41 seconds). `/app/dist/healthcheck.js` exits 0 if that file is younger than 120 seconds, and 1 otherwise, printing one line either way. So the check fails once the bot has been disconnected for about two minutes. After three failed checks in a row, Podman stops the container (`HealthOnFailure=kill`) and systemd starts a fresh one. During the first 120 seconds (`HealthStartPeriod`) failures don't count.

Run the check by hand:

```sh
podman healthcheck run clanker && echo healthy
```

See the last results, including the line the script printed:

```sh
podman inspect --format '{{json .State.Health}}' clanker
```

Two environment variables tune it (set them with `Environment=` in the unit): `CLANKER_HEARTBEAT_FILE` (default `/data/heartbeat`; it must match `health.heartbeat_file` or `<data_dir>/heartbeat` in the config) and `CLANKER_HEARTBEAT_MAX_AGE` in seconds (default 120).

For an outside view as well, set `health.ping_url` in the config to a [Healthchecks.io](https://healthchecks.io) (or similar) URL with a period of 5 minutes. Clanker requests it every 5 minutes while connected, so you get an alert when the bot or the whole server is down.

Docker runs the image's own `HEALTHCHECK` with the same settings, but only marks the container unhealthy; it doesn't restart it.

## Logs

Clanker writes one JSON object per line to stdout: `time`, `level`, `msg` and fields such as user, community and channel IDs, token counts and costs. Message text is never logged unless `log.level = "debug"`, which also logs model output and says so with a warning at startup. Don't leave debug on.

If Clanker can't start (config problems) or crashes (for example, an older version refusing an upgraded ledger), it prints a plain-text message to stderr instead; journalctl shows it in the same log.

Follow the log:

```sh
journalctl --user -u clanker -f -o cat
```

`podman logs -f clanker` shows the same lines. To pick out warnings and errors with [jq](https://jqlang.org) (plain-text lines, such as startup errors and crashes, are shown as errors):

```sh
journalctl --user -u clanker -o cat --since today | jq -cR '(fromjson? // {level: "error", msg: .}) | select(.level == "warn" or .level == "error")'
```

## Updating

1. Read the release notes of the new version, and compare `clanker.example.toml` with your config for new or changed keys.
2. Verify the new digest with `cosign verify` and pull it, as in step 2.
3. Put the new digest and version in the unit (fill in both values):

   ```sh
   sed -i 's|^Image=.*|Image=ghcr.io/linus-sexy-tips/clanker@sha256:<new digest>|; s|^# Clanker .*|# Clanker <new version>. Update by hand: see "Updating" in docs/deploy.md.|' ~/.config/containers/systemd/clanker.container
   ```

4. Reload and restart:

   ```sh
   systemctl --user daemon-reload && systemctl --user restart clanker
   ```

5. Check the log as in step 6. To roll back, put the old digest back and repeat step 4. A new version upgrades the ledger automatically when it starts, and an older version refuses to open an upgraded ledger, so take a [backup](#backups) before updating if you may want to roll back.

After editing only the config, a restart is enough:

```sh
systemctl --user restart clanker
```

Old images stay on disk until you remove them. This deletes images no container uses:

```sh
podman image prune -a
```

To rotate a secret, stop the service, replace the secret and start it again:

```sh
systemctl --user stop clanker && podman secret rm anthropic_api_key
```

```sh
read -rsp 'Anthropic API key: ' s && echo && printf '%s' "$s" | podman secret create anthropic_api_key - && unset s
```

```sh
systemctl --user start clanker
```

## Backups

Back up two things: `~/clanker/config` (plain files, no secrets) and the `clanker-data` volume, which holds the spending ledger. The ledger only matters for the caps and your own records; if it's lost, spending counts start again from zero. The secrets aren't in either; keep them in your password manager.

The simplest consistent backup stops the bot for a few seconds:

```sh
mkdir -p ~/backups && systemctl --user stop clanker && podman volume export clanker-data --output ~/backups/clanker-data.tar; systemctl --user start clanker
```

To back up without stopping, let SQLite write a consistent copy inside the volume, then copy it out:

```sh
podman exec clanker /nodejs/bin/node -e "const fs = require('node:fs'); const { DatabaseSync } = require('node:sqlite'); fs.rmSync('/data/backup.db', { force: true }); const db = new DatabaseSync('/data/clanker.db'); db.exec(\"VACUUM INTO '/data/backup.db'\"); db.close();"
```

```sh
podman cp clanker:/data/backup.db ~/backups/clanker-$(date +%F).db
```

To restore a volume export, stop the service, delete the ledger's write-ahead log files if any are left (SQLite would apply them to the restored ledger), import the export over the volume and start again:

```sh
systemctl --user stop clanker && mp=$(podman volume inspect clanker-data --format '{{.Mountpoint}}') && podman unshare rm -f "$mp/clanker.db-wal" "$mp/clanker.db-shm" && podman volume import clanker-data ~/backups/clanker-data.tar && systemctl --user start clanker
```

## Removing it

Stop the service and remove the unit:

```sh
systemctl --user stop clanker && rm ~/.config/containers/systemd/clanker.container && systemctl --user daemon-reload
```

Then, as admin, remove the user. Its home folder holds the config, the data volume, the secrets and the images, so this deletes all of them and can't be undone:

```sh
sudo loginctl disable-linger clanker && sudo userdel --remove clanker
```

Also remove the bot from your community, delete the application in Fluxer (User settings > Applications), and delete the API key in the Claude Console.
