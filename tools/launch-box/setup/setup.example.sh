#!/bin/sh
set -eu

cd /workspace/home

cat > server.mjs <<'EOF'
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);

createServer((request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({
    ok: true,
    path: request.url,
    time: new Date().toISOString(),
  }));
}).listen(port, "0.0.0.0", () => {
  console.log(`Listening on ${port}`);
});
EOF

nohup node server.mjs > /workspace/home/server.log 2>&1 < /dev/null &

# 等待服務啟動，setup 失敗時會立刻反映在 launch-box。
i=0
while [ "$i" -lt 20 ]; do
  if curl -fsS "http://127.0.0.1:${PORT:-3000}" >/dev/null; then
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

cat /workspace/home/server.log >&2
exit 1
