FROM node:22-bookworm-slim

ARG T3_VERSION=0.0.39
ARG CODEX_VERSION=0.153.4
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client python3 make g++ ripgrep \
    procps iproute2 util-linux gosu tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-audit --no-fund "t3@${T3_VERSION}" "@openai/codex@${CODEX_VERSION}"

ENV NODE_ENV=production \
    T3CODE_HOME=/home/node/.t3 \
    PORT=3773
COPY --chmod=755 start.sh /usr/local/bin/start-t3
WORKDIR /home/node
EXPOSE 3773
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-t3"]
