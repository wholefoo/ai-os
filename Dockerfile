FROM node:20-alpine

WORKDIR /app

# Install production deps only
COPY package*.json ./
RUN npm ci --production

# Copy app source
COPY server.js ./
COPY dashboard/ ./dashboard/
COPY .claude/ ./.claude/
COPY ecosystem.config.js ./

# Create required directories
RUN mkdir -p .magent/state .magent/vault/raw .magent/vault/wiki .magent/vault/outputs .magent/artifacts logs

# Non-root user
RUN addgroup -S aios && adduser -S aios -G aios
RUN chown -R aios:aios /app
USER aios

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
