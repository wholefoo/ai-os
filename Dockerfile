FROM node:20-alpine

WORKDIR /app

# Install production deps only
COPY package*.json ./
RUN npm ci --production

# Copy app source
COPY server.js ./
COPY ecosystem.config.js ./
COPY dashboard/ ./dashboard/
COPY .claude/ ./.claude/
COPY deploy/ ./deploy/

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
