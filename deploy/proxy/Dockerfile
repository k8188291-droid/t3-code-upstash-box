FROM ghcr.io/jpillora/chisel:1.12.0 AS chisel
FROM node:22-bookworm-slim
COPY --from=chisel /ko-app/* /usr/local/bin/chisel
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY *.mjs ./
CMD ["node", "server.mjs"]
