# Pier Relay container. Build from the repository root:
#   docker build -f apps/relay/Dockerfile -t pier-relay .
FROM oven/bun:1.4.2-alpine AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --filter @pier/relay \
	&& bun build apps/relay/src/main.ts --target node --outfile /out/pier-relay.mjs \
		--external bufferutil --external utf-8-validate

FROM node:24-alpine
WORKDIR /app
COPY --from=build /out/pier-relay.mjs /app/pier-relay.mjs
# Accounts, their access tokens and settings changed in the web admin panel. Mount a volume here.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
ENV NODE_ENV=production PIER_RELAY_DATA_DIR=/data
USER node
# WebSocket and admin panel (put a TLS reverse proxy in front) and the STUN server.
EXPOSE 7480/tcp 3478/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
	CMD wget -qO- http://127.0.0.1:${PIER_RELAY_PORT:-7480}/health >/dev/null || exit 1
ENTRYPOINT ["node", "/app/pier-relay.mjs"]
