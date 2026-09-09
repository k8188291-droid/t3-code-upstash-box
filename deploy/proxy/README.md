# Railway proxy + Upstash Box

T3 0.0.39 的固定入口：客戶端 → Railway HTTPS/WebSocket proxy → Chisel 反向通道 → Box 的 T3。
不需要 Upstash Public URL，也不建立定時 `date` 排程。

- Proxy 維持客戶端 WebSocket，在本機處理 Effect Ping/Pong 與 transport ping。
- 使用者操作（terminal.write、dispatchCommand、recentlyInteracted 等，見 protocol.mjs）才更新閒置時間，且最多每 30 秒執行一次 `date`。
- 最後操作一小時後暫停 Box；訂閱、輪詢與心跳不續命。長時間背景工作也會受此規則暫停。
- 新操作會 resume 原 Box，等待 Chisel 回連，重建上游並恢復訂閱。客戶端連線不變。
- 已送出的指令不自動重送；斷線時回報結果不確定。尚未送出的唯讀查詢有數量限制。
- 訂閱重建可能重播初始快照；這不是完整的事件持久化或 exactly-once 系統。
- Railway proxy 必須關閉自動 sleep 並使用單一 replica。Proxy 自身部署／重啟仍會斷開客戶端，需由 T3 自動重連。
- 初次 HTTP 配對／連線在没有既有 WebSocket 時可喚醒 Box；已連線時的背景 HTTP 不喚醒。

## 部署

先用根目錄 launch-box 安裝一台專用 Box，保留 Box ID。Railway 建立單一 replica service、`/data` volume、HTTPS domain，healthcheck 設 `/healthz`，關閉 Serverless/sleep。

設定 Railway 私密 variables：`UPSTASH_BOX_API_KEY`、`BOX_ID`、`CHISEL_AUTH`（`box:` 加隨機長密碼）、`PROXY_ADMIN_TOKEN`（隨機管理密碼）；另設 `PORT=3000`、`IDLE_MS=3600000`。

從此目錄執行 `railway up --detach`，或從根目錄執行 `railway up deploy/proxy --path-as-root --service <proxy-service-id> --detach`。

本機根目錄建立 chmod 600 的 `.env.proxy.json`（已 gitignore）：

```json
{"boxId":"your-box-id","domain":"https://your-proxy.up.railway.app","chiselAuth":"box:your-secret","adminToken":"your-admin-secret"}
```

根目錄執行：

```sh
node --env-file=.env deploy/proxy/setup-box.mjs
```

此腳本安裝固定版 Chisel 1.12.0（下載需要 GitHub），支援 arm64/amd64；T3 已需由 launch-box 安裝。更換 Chisel 密碼後須停止舊 Chisel client 再重跑。Public URL 不參與 proxy 路由，可以刪除。

使用 T3 CLI `pair` 產生配對碼，將連結的 host 改成 proxy domain，格式 `/pair#token=<pair-token>`。Token 短效且只能用一次，不應提交到版本庫。

## 認證

首次 WebSocket 必須先通過 T3 認證。Box 內 localhost:3774 helper 只透過有密碼的 Chisel 暴露至 proxy loopback:4774；以原本有效簽章的 wsTicket 更新短效票券。簽章金鑰留在 Box，不傳到 Railway。重新連線仍由 T3 檢查原 session 的撤銷、到期及權限。

這個機制與 T3 0.0.39 的內部 RPC/票券格式綁定，升級前必須重新驗證。Proxy 持有 Box API key，屬受信任基礎設施。不要把 Chisel 或 helper loopback port 公開。

## 驗證

```sh
npm test --prefix deploy/proxy
cd deploy/proxy
node --env-file=../../.env smoke.mjs
```

smoke 會使用 `.env.proxy.json` 指定的專用 Box：配對、RPC、暫停、確認心跳不喚醒，再由同一 WebSocket 喚醒並呼叫 RPC。測試會消耗配對 session，且暫停該 Box。
`/__proxy/admin/sleep` 僅接受帶管理 token 的 POST，可立即測試暫停；`/healthz` 不會喚醒 Box。
