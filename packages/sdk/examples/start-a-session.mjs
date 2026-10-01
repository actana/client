// A plain Node script that starts a Session on a Core, sends it a prompt, and
// reads the result. No terminal is involved anywhere (#129 D11, issue 155).
//
// Run it:
//
//     ACTANA_CORE_BLOB=~/.config/actana/registration-blob.txt \
//     ACTANA_HARNESS=claude-code \
//       node packages/sdk/examples/start-a-session.mjs "summarise this repo"
//
// Every Session starts in the Core's workspace (`~`); there is no Project and
// no cwd (ADR 0041 D1–D2, actana/client#10 part 3).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CoreClient, CoreSession } from "@actana/sdk/core";

/** The registration blob: the base64 paste itself, or a path to the file holding it. */
function loadBlob() {
  const raw = process.env.ACTANA_CORE_BLOB?.trim();
  if (!raw) throw new Error("set ACTANA_CORE_BLOB to a registration blob or a path to one");
  const source =
    raw.startsWith("~") || raw.startsWith("/")
      ? readFileSync(raw.replace(/^~/, homedir()), "utf8")
      : raw;
  return JSON.parse(Buffer.from(source.trim(), "base64").toString("utf8"));
}

const prompt = process.argv[2] ?? "Reply with exactly: hello from the SDK";

const client = CoreClient.fromRegistrationBlob(loadBlob(), { connectTimeoutMs: 15_000 });
const info = await client.connect();
console.log(`connected to ${info.coreId} (core-link ${info.protocolVersion})`);

const session = await CoreSession.start(client, {
  harness: process.env.ACTANA_HARNESS ?? "claude-code",
  title: "SDK example session",
  prompt,
  dangerouslySkipPermissions: process.env.ACTANA_SKIP_PERMISSIONS === "1",
});
console.log(`session ${session.sessionId} running on pty ${session.ptyId}`);

session.onStatus((status) => console.log(`  status → ${status}`));

const idle = await session.waitForIdle({ timeoutMs: Number(process.env.ACTANA_TIMEOUT_MS ?? 300_000) });
console.log(`settled: ${idle.status}${idle.exited ? ` (process exited ${idle.exitCode})` : ""}`);

console.log("─".repeat(60));
console.log(session.screen());
console.log("─".repeat(60));

await session.kill();
client.close();
