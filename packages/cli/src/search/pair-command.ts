// `actana search pair <name> <address> <code>` — enrollment from the client's side.

import { PairingError, parsePairingTicket, type PairingFailure } from "@actana/sdk/pairing";
import { encodeRegistrationBlob, type RegistrationBlob } from "@actana/sdk/pairing";
import type { ParsedArgs } from "../kit/cli-args.ts";
import {
  readCurrentSearch,
  searchBlobPath,
  searchExists,
  searchNameError,
  writeCurrentSearch,
  writeSearchBlob,
  type RegistryPaths,
} from "../registry/credentials.ts";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_PAIR_CERTIFICATE_INVALID,
  EXIT_PAIR_FINGERPRINT_MISMATCH,
  EXIT_PAIR_FINGERPRINT_UNCONFIRMED,
  EXIT_PAIR_HOSTNAME_MISMATCH,
  EXIT_PAIR_MALFORMED_RESPONSE,
  EXIT_PAIR_NO_CA,
  EXIT_PAIR_NOT_PAIRABLE,
  EXIT_PAIR_RATE_LIMITED,
  EXIT_PAIR_REFUSED,
  EXIT_PAIR_REJECTED,
  EXIT_PAIR_SEARCH_ERROR,
  EXIT_PAIR_UNREACHABLE,
  EXIT_USAGE,
} from "../kit/exit-codes.ts";
import type { SearchCliDeps } from "./search-deps.ts";
import { formatSearchPairSuccessLine, grantFromPairStatus } from "./search-pair-results.ts";
import { formatJson } from "../kit/cli-output.ts";

export const SEARCH_PAIR_HELP = `actana search pair <name> <address> <code> — enroll on a Search instance

Usage
  actana search pair <name> <host:port> <code> --session <id> --fingerprint <sha256>

Flags
  --fingerprint <fp>   the CA fingerprint read out beside the code
  --session <id>       the pairing session, when the code does not carry it
  --label <name>       what this machine calls itself on the instance
  --json               machine-readable output (no credential in the payload)
  -h, --help           show this help`;

const PAIRING_EXITS: Record<PairingFailure, number> = {
  "bad-address": EXIT_USAGE,
  "bad-code": EXIT_USAGE,
  "bad-fingerprint": EXIT_USAGE,
  unreachable: EXIT_PAIR_UNREACHABLE,
  "not-pairable": EXIT_PAIR_NOT_PAIRABLE,
  "no-ca-presented": EXIT_PAIR_NO_CA,
  "fingerprint-unconfirmed": EXIT_PAIR_FINGERPRINT_UNCONFIRMED,
  "fingerprint-mismatch": EXIT_PAIR_FINGERPRINT_MISMATCH,
  "hostname-mismatch": EXIT_PAIR_HOSTNAME_MISMATCH,
  "certificate-invalid": EXIT_PAIR_CERTIFICATE_INVALID,
  refused: EXIT_PAIR_REFUSED,
  "rate-limited": EXIT_PAIR_RATE_LIMITED,
  rejected: EXIT_PAIR_REJECTED,
  "core-error": EXIT_PAIR_SEARCH_ERROR,
  "malformed-response": EXIT_PAIR_MALFORMED_RESPONSE,
};

export async function runSearchPair(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  if (flags.help) {
    deps.out(SEARCH_PAIR_HELP);
    return EXIT_OK;
  }

  const [name, address, code, ...extra] = rest;
  if (name === undefined || address === undefined || code === undefined) {
    deps.err("actana search pair: a name, an address and a code are required.");
    deps.err("  actana search pair <name> <host:port> <code> --session <id> --fingerprint <sha256>");
    return EXIT_USAGE;
  }
  if (extra.length > 0) {
    deps.err("actana search pair: too many arguments — expected <name> <address> <code>.");
    return EXIT_USAGE;
  }

  const nameError = searchNameError(name);
  if (nameError) {
    deps.err(`actana search pair: ${nameError}.`);
    return EXIT_USAGE;
  }

  const ticket = readTicket(deps, code, flags.session);
  if (!ticket.ok) return ticket.exit;

  const confirmed = await confirmFingerprint(deps, flags, address);
  if (!confirmed.ok) return confirmed.exit;

  let blob: RegistrationBlob;
  try {
    deps.verbose(`redeeming the code at ${address}`);
    blob = await deps.pairing.pair({
      address,
      code: ticket.code,
      sessionId: ticket.sessionId,
      expectedCaFingerprint: confirmed.fingerprint,
      label: flags.label ?? deps.hostname,
      platform: deps.platform,
    });
  } catch (err) {
    return reportPairing(deps, err);
  }

  const replacing = searchExists(paths, name);
  writeSearchBlob(paths, name, encodeRegistrationBlob({ ...blob, label: "" }));
  deps.verbose(`stored at ${searchBlobPath(paths, name)}, mode 0600`);

  const before = readCurrentSearch(paths);
  if (before === null) writeCurrentSearch(paths, name);

  let grant = { scope: "read", kbCount: null as number | null };
  try {
    const client = deps.clientFor(blob);
    const status = await client.pairStatus();
    grant = grantFromPairStatus(status);
    await client.close().catch(() => {});
  } catch {
    // Grant detail is cosmetic on the success line; pairing already succeeded.
  }

  if (flags.json) {
    deps.out(formatJson({ name, endpoint: blob.endpoint, scope: grant.scope, kbCount: grant.kbCount }));
    return EXIT_OK;
  }

  deps.out(formatSearchPairSuccessLine(name, grant));
  if (replacing) deps.err(`Replaced the credential for "${name}".`);
  if (before === null) deps.err(`\`current\` now points at "${name}".`);
  else if (before !== name) {
    deps.err(`\`current\` is still "${before}" — \`actana search use ${name}\` to switch.`);
  }
  return EXIT_OK;
}

type TicketResult = { ok: true; sessionId: string; code: string } | { ok: false; exit: number };

function readTicket(deps: SearchCliDeps, code: string, session: string | null): TicketResult {
  const separator = code.indexOf(":");
  const carried = separator === -1 ? "" : code.slice(0, separator).trim();
  const explicit = session?.trim() ?? "";

  if (carried === "" && explicit === "") {
    deps.err("actana search pair: a pairing code names the pairing session it belongs to.");
    deps.err("Pass `--session <id>` or the <session>:<code> form.");
    return { ok: false, exit: EXIT_USAGE };
  }
  if (carried !== "" && explicit !== "" && carried !== explicit) {
    deps.err("actana search pair: the code names one pairing session and `--session` names another.");
    return { ok: false, exit: EXIT_USAGE };
  }

  try {
    const ticket = parsePairingTicket(code, session ?? undefined);
    return { ok: true, sessionId: ticket.sessionId, code: ticket.code };
  } catch (err) {
    if (err instanceof PairingError && err.failure === "bad-code") {
      deps.err("actana search pair: that was not accepted as a pairing code.");
      return { ok: false, exit: EXIT_USAGE };
    }
    throw err;
  }
}

type FingerprintResult = { ok: true; fingerprint: string } | { ok: false; exit: number };

async function confirmFingerprint(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  address: string,
): Promise<FingerprintResult> {
  if (flags.fingerprint !== null) {
    deps.verbose("checking the certificate authority against the fingerprint given on the command line");
    return { ok: true, fingerprint: flags.fingerprint };
  }
  if (!deps.interactive) {
    deps.err("actana search pair: no fingerprint was given and there is no terminal to confirm one on.");
    deps.err("Pass --fingerprint with the one `search pair new` printed.");
    return { ok: false, exit: EXIT_PAIR_FINGERPRINT_UNCONFIRMED };
  }

  let identity;
  try {
    deps.verbose(`dialling ${address} to read its certificate chain`);
    identity = await deps.pairing.identify({ address });
  } catch (err) {
    return { ok: false, exit: reportPairing(deps, err) };
  }

  deps.out(`${identity.httpsOrigin} presents a certificate authority with this fingerprint:`);
  deps.out(`  ${identity.fingerprint}`);
  const confirm = deps.confirmFingerprint ?? (async () => false);
  const matches = await confirm("Is that the fingerprint `search pair new` printed on the instance?");
  if (!matches) {
    deps.err("actana search pair: the fingerprint was not confirmed, so the pairing code was not sent.");
    return { ok: false, exit: EXIT_PAIR_FINGERPRINT_MISMATCH };
  }
  return { ok: true, fingerprint: identity.fingerprint };
}

function reportPairing(deps: SearchCliDeps, err: unknown): number {
  if (!(err instanceof PairingError)) {
    deps.err(`actana search pair: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_FAILURE;
  }
  for (const line of err.message.split("\n")) deps.err(`actana search pair: ${line}`);
  if (err.failure === "fingerprint-mismatch") {
    deps.err("");
    deps.err("The code was NOT sent. Either something is answering for that address that is not");
    deps.err("the instance you were told about, or the instance has been re-issued and the");
    deps.err("fingerprint you have is stale. Ask for a fresh one and compare again.");
  }
  if (err.failure === "fingerprint-unconfirmed") {
    deps.err("");
    deps.err("The code was NOT sent. Pass --fingerprint with the one `search pair new` printed.");
  }
  return PAIRING_EXITS[err.failure] ?? EXIT_FAILURE;
}
