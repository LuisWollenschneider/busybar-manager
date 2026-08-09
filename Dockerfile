# The frontend is built from web/src rather than copied from web/dist: the
# checked-out web/dist is a newer upstream build that calls endpoints this
# server.js does not implement (/api/_manager/schedule, /api/input), so serving
# it gives a dashboard whose buttons hit 404s.
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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# No runtime npm dependencies (package.json declares none), so copying the
# source is the whole install.
COPY package.json ./
COPY server.js ./
COPY --from=web /web/dist ./web/dist

ENV NODE_ENV=production \
    BUSYBAR_BIND_HOST=0.0.0.0 \
    BUSYBAR_MANAGER_CONFIG=/app/config.json

# Installed apps live here and are written at runtime; keep them on a volume.
RUN mkdir -p /app/apps

EXPOSE 8321

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||8321,path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
