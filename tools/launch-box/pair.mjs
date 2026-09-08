import { readFile } from "node:fs/promises";
import { Box } from "@upstash/box";
import { printPairing } from "./pairing.mjs";

const id = process.argv[2];
try {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("用法：npm run t3:pair -- <box-id>");
  }
  const record = JSON.parse(await readFile(new URL(`./.boxes/${id}.json`, import.meta.url), "utf8"));
  if (record.id !== id || !record.publicUrl) {
    throw new Error("Box 紀錄缺少對應的 Public URL，請先完成啟動流程。");
  }
  const box = await Box.get(id);
  await printPairing(box, record.publicUrl);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
