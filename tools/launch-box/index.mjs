import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Box } from "@upstash/box";
import { printPairing } from "./pairing.mjs";

const setupArgument = process.argv[2];
const port = Number(process.argv[3] ?? 3000);
const name = process.argv[4] ?? `setup-box-${Date.now()}`;

if (!process.env.UPSTASH_BOX_API_KEY) {
  console.error("缺少 UPSTASH_BOX_API_KEY，請先設定在 .env");
  process.exit(1);
}

if (!setupArgument) {
  console.error("用法：npm run launch-box -- <setup-script> [port] [box-name]");
  console.error("範例：npm run launch-box -- ./tools/launch-box/setup/setup.t3.sh 3773");
  process.exit(1);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("port 必須是 1 到 65535 的整數");
  process.exit(1);
}

const setupPath = resolve(setupArgument);
await access(setupPath);

let box;

try {
  console.log(`正在建立 Box：${name}`);
  box = await Box.create({
    name,
    runtime: "node",
    size: "small",
    env: process.env.OPENAI_API_KEY
      ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY }
      : undefined,
  });

  const recordsDirectory = new URL("./.boxes/", import.meta.url);
  await mkdir(recordsDirectory, { recursive: true });
  const recordFile = new URL(`${box.id}.json`, recordsDirectory);
  await writeFile(
    recordFile,
    `${JSON.stringify({ id: box.id, name, port, setupPath }, null, 2)}\n`,
    { mode: 0o600 },
  );

  console.log(`Box 已建立：${box.id}`);
  console.log(`正在上傳並執行：${setupPath}`);
  const uploads = [
    { path: setupPath, destination: "/workspace/home/setup.sh" },
  ];
  const t3BackgroundPath = resolve(dirname(setupPath), "t3-background.sh");
  try {
    await access(t3BackgroundPath);
    uploads.push({
      path: t3BackgroundPath,
      destination: "/workspace/home/t3-background.sh",
    });
  } catch {
    // Most setup scripts do not need the optional T3 companion script.
  }
  await box.files.upload(uploads);

  const setup = await box.exec.command(
    `chmod +x /workspace/home/setup.sh && PORT=${port} bash /workspace/home/setup.sh`,
  );
  if (setup.status !== "completed" || setup.exitCode !== 0) {
    throw new Error(`setup script 執行失敗：${setup.stderr || setup.result}`);
  }

  console.log(`正在開啟 port ${port} 的 Public URL...`);
  const publicURL = await box.getPublicURL(port);

  await writeFile(
    recordFile,
    `${JSON.stringify(
      {
        id: box.id,
        name,
        port,
        setupPath,
        publicUrl: publicURL.url,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  console.log("\nBox 準備完成");
  console.log(`Box ID：${box.id}`);
  console.log(`Public URL：${publicURL.url}`);
  console.log(`SSH：ssh ${box.id}@us-east-1.box.upstash.com`);
  console.log(`紀錄：tools/launch-box/.boxes/${box.id}.json`);

  if (setupPath === fileURLToPath(new URL("./setup/setup.t3.sh", import.meta.url))) {
    console.log("正在執行 t3 pair...");
    console.log(`重新取得配對碼：npm run t3:pair -- ${box.id}`);
    await printPairing(box, publicURL.url);
  }
} catch (error) {
  if (box?.id) {
    console.error(`建立流程未完成；Box ${box.id} 已保留，方便登入除錯。`);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
