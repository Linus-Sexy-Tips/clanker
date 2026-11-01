# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Clanker container image.
#
#   podman build -t clanker -f Containerfile .
#
# Runtime contract:
#   /config  read-only: clanker.toml (path set by CLANKER_CONFIG, default /config/clanker.toml)
#   /data    read-write: the spending ledger (clanker.db) and the heartbeat file
#   Secrets: FLUXER_BOT_TOKEN_FILE and ANTHROPIC_API_KEY_FILE (or the plain variables)
#   No ports. Runs as UID/GID 65532 and works with a read-only root filesystem.
#
# Podman ignores HEALTHCHECK in OCI-format images (which is what the release builds),
# so Quadlet users set HealthCmd= in the unit instead. See docs/deploy.md.

# ---------------------------------------------------------------- build
# Runs on the build machine's own architecture. The output is plain JavaScript with no
# native modules, so the arm64 image needs no emulation.
FROM --platform=$BUILDPLATFORM docker.io/library/node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build

WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Compile, then replace node_modules with production dependencies only (npm ci starts clean).
# /out/data becomes the image's /data, owned by the runtime user so new volumes inherit it.
RUN npm run build \
	&& npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
	&& mkdir -p /out/data

# ---------------------------------------------------------------- runtime
# Distroless Node.js: no shell, no package manager. ENTRYPOINT is /nodejs/bin/node.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:9b945e92c1b5463a4b75f11e8417515e4bea7355f6adfd79ec220fbbe905dda8

LABEL org.opencontainers.image.title="Clanker" \
	org.opencontainers.image.description="Self-hosted Fluxer bot that answers approved users with Claude" \
	org.opencontainers.image.source="https://github.com/Linus-Sexy-Tips/clanker" \
	org.opencontainers.image.url="https://github.com/Linus-Sexy-Tips/clanker" \
	org.opencontainers.image.documentation="https://github.com/Linus-Sexy-Tips/clanker#readme" \
	org.opencontainers.image.licenses="AGPL-3.0-or-later"

WORKDIR /app
ENV NODE_ENV=production \
	CLANKER_CONFIG=/config/clanker.toml

# Application files stay owned by root, so the bot can't modify its own code.
# package.json is needed at runtime: "type": "module" makes dist/*.js ES modules.
COPY LICENSE ./LICENSE
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build --chown=65532:65532 /out/data /data

USER 65532:65532

# Healthy while the gateway heartbeat file is younger than CLANKER_HEARTBEAT_MAX_AGE (120 s).
# The bot touches it about every 41 s while connected. Exec form: there is no shell.
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
	CMD ["/nodejs/bin/node", "/app/dist/healthcheck.js"]

CMD ["/app/dist/index.js"]
