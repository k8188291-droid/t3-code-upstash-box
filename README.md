# 在 Upstash Box 啟動 T3 Code

本專案會建立雲端 Box、安裝 T3 Code、確認 Codex CLI 可用，在背景啟動
3773 服務，建立 HTTPS Public URL，最後執行 `t3 pair` 顯示配對碼與連結。
每次啟動都會建立新的 Box。

## 1. 安裝本機依賴

準備支援 `--env-file` 的 Node.js（20.6 以上）與 npm。
在本專案根目錄執行：

```sh
npm install
```

## 2. 設定 Upstash API Key

到 [Upstash Console](https://console.upstash.com/) 取得 **Box API Key**，
在專案根目錄建立 `.env`：

```dotenv
UPSTASH_BOX_API_KEY=box_你的金鑰
```

`.env` 已被忽略提交。此金鑰用於管理 Box 及 SSH 登入，不等於 Codex 登入憑證。
若需要把自己的 OpenAI API Key 注入新 Box，可以加入 `OPENAI_API_KEY`；
修改本機 `.env` 不會更新已建立的 Box。

## 3. 啟動 T3 Code Box

```sh
npm run launch-box -- ./tools/launch-box/setup/setup.t3.sh 3773
```

也可在最後指定名稱：

```sh
npm run launch-box -- ./tools/launch-box/setup/setup.t3.sh 3773 my-t3-box
```

腳本依序完成：

1. 建立 Node.js runtime、small 規格的 Box。
2. 上傳 setup 與 `t3-background.sh`。
3. 使用預裝的 Codex CLI；找不到時才安裝至使用者目錄。
4. 安裝 `t3@0.0.39`，背景監聽 `0.0.0.0:3773`，檢查服務就緒。
5. 建立每 30 分鐘執行 `date` 的排程，寫入 `/workspace/home/keepalive.log`。
6. 建立 3773 的 Public URL，不加 Basic Auth。
7. 執行 **`t3 pair`**，輸出一次性配對碼、到期時間及使用 Public URL 的配對連結。

保留終端顯示的 Box ID。連線資訊保存在
`tools/launch-box/.boxes/<box-id>.json`，包含 Public URL 與排程 ID。
配對碼只顯示於終端，不寫入此 JSON。

## 4. 配對裝置

開啟啟動器輸出的「配對網址」，或在 T3 客戶端輸入 **Public URL 與配對碼**。
也可以使用輸出的 `T3 hosted app` 連結。

目前版本的 `t3 pair` 預設有效期為 **5 分鐘**。配對後使用裝置 session 存取，
無需 Basic Auth 帳密。配對碼是一次性的，請勿公開分享。

T3 CLI 原始連結可能使用容器內部 IP；啟動器會換成 Box 的公開 HTTPS URL。
參考 [T3 Code 官方 Remote Access 文件](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)。

## 5. 過期或需要新增裝置：重新取得配對碼

在本機專案根目錄執行，將 `<box-id>` 換成剛才的 ID：

```sh
npm run t3:pair -- <box-id>
```

這會讀取本機 Box 紀錄，在現有 Box 執行 `t3 pair`，不會建立另一台。
T3 服務需要處於運行狀態。

## 6. 透過 SSH 操作與檢查

使用啟動器輸出的 SSH 指令：

```sh
ssh <box-id>@us-east-1.box.upstash.com
```

密碼是 `.env` 中的 `UPSTASH_BOX_API_KEY`。登入後可執行：

```sh
bash /workspace/home/t3-background.sh status
bash /workspace/home/t3-background.sh logs
bash /workspace/home/t3-background.sh restart
codex
```

`logs` 會持續顯示日誌，按 Ctrl+C 離開。Codex 首次使用仍需完成自己的驗證；
T3 裝置配對與 Codex 登入是兩個步驟。

## 7. 停用測試環境

在 Upstash Console 中找到對應 Box ID。不再使用時可以刪除；刪除會永久移除
Box 內的檔案與狀態。若只要暫停，先暫停它的 30 分鐘排程，再暫停 Box。

`date` 排程會產生活動，但不保證服務永不暫停，也不等同於 `keepAlive: true`。

## 啟動失敗時

setup 或配對失敗會保留已建立的 Box，並顯示 ID。先 SSH 檢查日誌，
不要直接重跑啟動指令，因為那會建立另一台 Box。
若只是配對失敗且 JSON 已有 Public URL，可用 `npm run t3:pair -- <box-id>` 重試。
