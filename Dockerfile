# ---- builder stage: compile TypeScript ----
FROM node:20-slim AS builder
WORKDIR /app

# Install all deps including devDependencies for tsc, exactly matching the
# lockfile. `npm ci` is required because `npm install` will resolve newer
# minor versions (e.g. the MCP SDK) that have a different request-handler
# signature than the version this code was written against.
COPY package.json package-lock.json* ./
RUN npm ci --include=dev --no-audit --no-fund \
    && test -x node_modules/.bin/tsc

# Compile
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Drop dev deps for a smaller runtime install
RUN npm prune --omit=dev


# ---- runtime stage: lean image ----
FROM node:20-slim
WORKDIR /app

# Tini for proper PID-1 signal handling
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for the app. UID/GID are pinned so the (optional) EFS access
# point in production can enforce a stable POSIX identity. 10001 picked to
# avoid clashes with default users (1000) and system uids.
RUN groupadd -g 10001 app && useradd -u 10001 -g app -M -N -d /app app

# Copy compiled output, pruned production deps, and the default config file
# (ConfigManager reads ./config/default.json from cwd at startup).
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./
COPY --chown=app:app config ./config

# Defaults baked into the image. Override at task-definition / docker-run level.
ENV NODE_ENV=production
ENV LOG_LEVEL=error
ENV LOG_PRETTY=false
# Bind to all interfaces inside the container so Docker can port-forward.
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=8000
# Wodify hardening: read-only mode on by default. Set to "false" in the
# task definition only when an explicit token with write scope is intended
# and the workflow actually needs write tools.
ENV PRODUCTBOARD_READ_ONLY=true

USER app
EXPOSE 8000

# Basic container-level health check. ECS / Docker Desktop both honor this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js", "serve"]
