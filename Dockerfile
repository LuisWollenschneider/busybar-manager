FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-slim

# Community apps are Python: the manager creates a per-app .venv and pip-installs
# each app's requirements.txt at start, so python3 + venv + pip must be present.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
        python3-pip \
        ca-certificates \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# No runtime npm dependencies (package.json declares none), so copying the
# source is the whole install.
COPY package.json ./
COPY server.js ./
COPY --from=web /web/dist ./web/dist

# PORT wins over config.json's listenPort (see getListenPort in server.js), so
# the port stays fixed no matter what a mounted config.json says — otherwise
# editing listenPort would move the server off the published port and out from
# under the healthcheck. Override it at runtime (-e PORT=…) to move the server.
ENV NODE_ENV=production \
    BUSYBAR_BIND_HOST=0.0.0.0 \
    BUSYBAR_MANAGER_CONFIG=/app/config.json \
    PORT=8321

# The manager spawns community Python apps, so neither it nor they should run
# as root. The base image's `node` account is renamed rather than a second one
# added, to keep uid/gid 1000 — the first non-system uid on a Linux host, so
# bind-mounted ./docker/data and ./docker/apps stay writable by the person who
# checked the repo out instead of turning root-owned.
RUN groupmod -n scheduler node \
    && usermod -l scheduler -d /home/scheduler -m node

# Installed apps live here and are written at runtime; keep them on a volume.
# Everything the server writes stays under /app/apps (staging dirs, per-app
# .venv, pip installs) and the config file, so /app is the only tree that has
# to be owned by the runtime user.
RUN mkdir -p /app/apps && chown -R scheduler:scheduler /app

USER scheduler

# Documentation only (`docker run -P`, image inspection); it does not constrain
# the port, so it stays at the default rather than tracking PORT via a build arg.
EXPOSE 8321

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||8321,path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
