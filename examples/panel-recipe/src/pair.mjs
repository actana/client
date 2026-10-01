// Step 1 of the recipe: pair a Core.
//
// Pairing is how a controller becomes a client of a Core. The operator opens a pairing session on the
// Core and reads out a one-time code and the Core's CA fingerprint. `pairWithCore` checks that
// fingerprint BEFORE the code leaves this machine (a wrong or missing fingerprint sends nothing), then
// redeems the code for a client certificate and a signed bearer. What comes back is a registration
// blob: the Core's endpoint plus the mTLS material and the bearer. It is a credential; treat it like a
// private key. Nothing in this recipe prints it.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { decodeRegistrationBlob, encodeRegistrationBlob, pairWithCore } from "@actana/sdk/pairing";
import { UsageError, messageOf } from "./errors.mjs";

/** Pair with a Core and return the registration blob. `pair` is a seam for tests. */
export async function pairCore({ address, code, fingerprint, label = "panel-recipe", timeoutMs, pair = pairWithCore }) {
  return pair({
    address,
    code,
    expectedCaFingerprint: fingerprint,
    label,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** Write the blob to `file`, readable by its owner only. */
export function saveBlob(blob, file) {
  writeFileSync(file, `${encodeRegistrationBlob(blob)}\n`, { mode: 0o600 });
  // `mode` only applies to a file that is created; tighten one that already existed.
  chmodSync(file, 0o600);
}

/** The registration blob: the base64 paste itself, or a path to the file holding it. */
export function loadBlob(source) {
  const looksLikePath = source.startsWith("~") || source.startsWith("/") || source.startsWith(".");
  let raw = source;
  if (looksLikePath) {
    try {
      raw = readFileSync(source.replace(/^~/, homedir()), "utf8");
    } catch (err) {
      throw new UsageError(`cannot read the registration blob file ${source}: ${messageOf(err)}`);
    }
  }
  // Never echo `raw`: whatever it is, it may be a credential.
  const blob = decodeRegistrationBlob(raw.trim(), "core");
  if (blob === null) throw new UsageError("ACTANA_CORE_BLOB is not a Core registration blob (a base64 blob, or a path to a file holding one)");
  return blob;
}
