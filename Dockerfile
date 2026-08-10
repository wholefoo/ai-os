FROM node:24-alpine

WORKDIR /app

# Install production deps only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source
#
# AS-04: this list was both broken and incomplete. It copied `deploy/`, which .dockerignore
# excludes — so the COPY had no source and the build failed outright. And it never copied `lib/`
# (80 requires from server.js) or `tools/` (1), so even a build that got past that would have
# produced an image that crashed on the first require.
#
# `deploy/` is HOST-side provisioning — install-vps.sh, push-update.sh, nginx.conf. The container
# has no use for it and is better off without root-level install scripts baked into the image, so
# the fix is to drop the COPY, not to un-ignore the directory.
#
# `commercial/` is deliberately absent: it is a separate private repo, and lib/commercial-stub.js
# provides the graceful Community fallback when it is not mounted.
COPY server.js ./
COPY ecosystem.config.js ./
COPY lib/ ./lib/
COPY tools/ ./tools/
COPY dashboard/ ./dashboard/
COPY .claude/ ./.claude/

# Create required directories
RUN mkdir -p \
  .magent/state \
  .magent/vault/raw \
  .magent/vault/wiki \
  .magent/vault/outputs \
  .magent/artifacts \
  logs

# Non-root user
RUN addgroup -S aios && adduser -S aios -G aios
RUN chown -R aios:aios /app
USER aios

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
