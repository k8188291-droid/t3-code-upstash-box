// T3's pair command advertises a container address. Replace it with the Box's
// public HTTPS origin when presenting the link to the user.
export function parsePairingOutput(output, publicUrl) {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  const token = clean.match(/^Token:\s*(\S+)\s*$/m)?.[1];
  const expires = clean.match(/^Expires:\s*(.+)$/m)?.[1]?.trim();
  if (!token || !expires) {
    throw new Error("無法解析 t3 pair 的輸出；請透過 SSH 執行 t3 pair 查看。");
  }
  const direct = new URL("/pair", publicUrl);
  direct.hash = new URLSearchParams({ token }).toString();
  const hosted = new URL("https://app.t3.codes/pair");
  hosted.searchParams.set("host", new URL(publicUrl).origin);
  hosted.hash = direct.hash;
  return { token, expires, directUrl: direct.href, hostedUrl: hosted.href };
}

export async function printPairing(box, publicUrl) {
  const run = await box.exec.command(
    'node "${XDG_DATA_HOME:-$HOME/.local/share}/t3-background/runtime/node_modules/t3/dist/bin.mjs" pair',
  );
  if (run.status !== "completed" || run.exitCode !== 0) {
    throw new Error(`t3 pair 失敗：${run.stderr || run.result}`);
  }
  const pairing = parsePairingOutput(run.stdout || run.result, publicUrl);
  console.log("\nT3 配對資訊（一次性代碼，僅顯示於終端，不存入 Box JSON）");
  console.log(`配對碼：${pairing.token}`);
  console.log(`到期時間：${pairing.expires}`);
  console.log(`配對網址：${pairing.directUrl}`);
  console.log(`T3 hosted app：${pairing.hostedUrl}`);
}
