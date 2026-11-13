# Build stage
FROM node:22.23.5-alpine AS builder
WORKDIR /app

# Copy package.json and package-lock.json to leverage layer caching. `npm ci` installs exactly what the lock file
# names, and fails when package.json and the lock disagree, instead of changing the lock inside the build
COPY package.json package-lock.json ./
RUN npm ci

# Copy all source files and build
COPY . .
RUN npm run build

# The runtime only needs production dependencies; drop build/test tooling before the copy
RUN npm prune --omit=dev

# Production stage
FROM node:22.23.5-alpine AS production
WORKDIR /app

# Add curl for healthcheck; the system Brotli it links must carry the CVE-2026-111497 fix, so the build fails
# rather than ship an older brotli-libs. su-exec: the entrypoint runs the server as nodeuser through it.
# nodeuser is uid 1001 in a group of its own, gid 1001 (`adduser -S` alone makes no group named nodeuser).
RUN apk add --no-cache --upgrade curl 'brotli-libs>=1.2.1' su-exec && \
    addgroup -S -g 1001 nodeuser && \
    adduser -S -u 1001 -G nodeuser nodeuser

# The entrypoint (scripts/coo-entrypoint.sh says what it does). Its mode is set by RUN, not by COPY --chmod, which
# needs BuildKit
COPY scripts/coo-entrypoint.sh /usr/local/bin/coo-entrypoint.sh
RUN chmod 755 /usr/local/bin/coo-entrypoint.sh

# Copy only necessary files from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/src ./src
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/scripts ./scripts

# Set build argument and environment variable
ARG COMMIT_HASH=local
ENV COMMIT_HASH=${COMMIT_HASH:-local} \
    NODE_ENV=production

# Expose the port
EXPOSE 3000

# Healthcheck on the port the server listens on. Shell form: the shell reads PORT when the check runs, inside the
# container (the builder does not substitute variables in HEALTHCHECK)
HEALTHCHECK --interval=2s --timeout=10s --start-period=5s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/health" || exit 1

# Start the application. No USER: the container starts as root, so that the entrypoint can give the world folder
# (a volume written by root, or a file root left in it) to nodeuser first; it then runs the command as nodeuser
# (uid 1001, gid 1001) with su-exec, which replaces the entrypoint: the server is the container's PID 1.
# Nothing the image holds is given to nodeuser: of /app, it gets the world folder only.
ENTRYPOINT ["/usr/local/bin/coo-entrypoint.sh"]
CMD ["node", "build/index.js"]
