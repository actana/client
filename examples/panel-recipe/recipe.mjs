#!/usr/bin/env node
// What the Panel does with a Core, using only the public SDK (`@actana/sdk/*`), in four steps:
//
//   1. pair a Core                                        pair
//   2. attach its Shared folder with a key issuer         attach
//   3. start a Session and watch its report               session "<prompt>"
//   4. dispatch a Task and turn its result files into status   task
//
// Progress goes to stderr, one JSON result per step to stdout, and a failure ends the script with a
// message on stderr and a non-zero exit code (see `src/errors.mjs`). Settings come from arguments or
// environment variables only; run it with --help. The walk-through is README.md.
import { pathToFileURL } from "node:url";
import { CoreClient } from "@actana/sdk/core";
import { PairingError } from "@actana/sdk/pairing";
import { CoreSharedError } from "@actana/sdk/shared";
import { SharedKeyIssueError } from "@actana/sdk/shared-key";
import { attachShared, createIssuer, openControllerShared, serveJwks } from "./src/attach.mjs";
import { realClock } from "./src/clock.mjs";
import { readConfig, usage } from "./src/config.mjs";
import { EXIT, RecipeError, UsageError, messageOf } from "./src/errors.mjs";
import { loadBlob, pairCore, saveBlob } from "./src/pair.mjs";
import { startSessionAndWatch } from "./src/session.mjs";
import { dispatchTask } from "./src/task.mjs";

const DEFAULT_SESSION_PROMPT = "Reply with exactly: hello from the recipe";

/** The exit code for any failure. A refusal by the Core, the key issuer or the store is a 4. */
export function exitCodeFor(err) {
  if (err instanceof RecipeError) return err.exitCode;
  if (err instanceof PairingError || err instanceof SharedKeyIssueError) return EXIT.refused;
  if (err instanceof CoreSharedError && ["forbidden", "expired"].includes(err.code)) return EXIT.refused;
  return EXIT.failed;
}

/**
 * Run the recipe. Resolves with the exit code and never throws.
 * `deps` are seams for tests: `createSocket` (a fake Core), `pair`, `issuer`, `shared` (replaces the
 * controller's S3 view), `fetch` (the S3 mode's transport), `clock`.
 */
export async function main(argv, env, io = { stdout: process.stdout, stderr: process.stderr }, deps = {}) {
  const clock = deps.clock ?? realClock;
  const out = (value) => io.stdout.write(`${JSON.stringify(value)}\n`);
  const log = (line) => io.stderr.write(`recipe: ${line}\n`);
  const cleanups = [];
  try {
    const config = readConfig(argv, env);
    if (config.help) {
      io.stdout.write(`${usage()}\n`);
      return EXIT.ok;
    }
    const steps = config.command === "all" ? ["pair", "attach", "session", "task"] : [config.command];

    // Step 1.
    let blobSource = config.blobSource;
    if (steps.includes("pair") && (config.command === "pair" || blobSource === undefined)) {
      const pairing = config.pairing();
      const blob = await pairCore({ ...pairing, ...(deps.pair ? { pair: deps.pair } : {}) });
      saveBlob(blob, pairing.out);
      log(`paired with ${blob.endpoint}; registration blob written to ${pairing.out} (keep it secret)`);
      out({ step: "pair", endpoint: blob.endpoint, blobFile: pairing.out });
      blobSource = pairing.out;
    }
    if (config.command === "pair") return EXIT.ok;

    // Everything after pairing talks to the Core.
    const blob = loadBlob(blobSource ?? config.blob());
    const client = CoreClient.fromRegistrationBlob(blob, {
      connectTimeoutMs: 15_000,
      ...(deps.createSocket ? { createSocket: deps.createSocket } : {}),
    });
    cleanups.push(() => client.close());
    const info = await client.connect();
    log(`connected to ${info.coreId} (core-link ${info.protocolVersion})`);

    const s3 = config.seaweedfs();
    const issuer = deps.issuer ?? createIssuer(s3);
    if (s3.jwksPort !== undefined) {
      const jwks = await serveJwks({ signingKeyFile: s3.signingKeyFile, keyId: s3.keyId, port: s3.jwksPort });
      cleanups.push(() => jwks.close());
      log(`serving the JWKS on 127.0.0.1:${s3.jwksPort}`);
    }
    const target = {
      issuer,
      bucket: s3.bucket,
      prefix: s3.prefix,
      endpoint: s3.endpoint,
      ...(s3.region ? { region: s3.region } : {}),
      clock,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    };

    // Step 2. A later command reads the folder an earlier `attach` mounted, so it does not attach again.
    let shared;
    if (steps.includes("attach")) {
      const attached = await attachShared({ client, info, coreEndpoint: s3.coreEndpoint ?? s3.endpoint, log, ...target });
      shared = deps.shared ?? attached.shared;
      out({ step: "attach", coreId: attached.coreId, prefix: attached.prefix, bucket: s3.bucket, state: attached.status.state, expiresAt: attached.status.expiresAt });
      if (config.keepFresh) {
        cleanups.push(attached.keepFresh());
        log("keeping the Core's key fresh; press Ctrl-C to stop");
        await new Promise((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
      }
    } else if (config.command !== "pair") {
      shared = deps.shared ?? openControllerShared({ coreId: info.coreId, ...target }).shared;
    }
    if (config.command === "attach") return EXIT.ok;

    const wait = { ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }), ...(config.pollMs === undefined ? {} : { pollMs: config.pollMs }),
      ...(config.exitGraceMs === undefined ? {} : { exitGraceMs: config.exitGraceMs }) };
    const run = { client, shared, harness: config.harness, dangerouslySkipPermissions: config.dangerouslySkipPermissions, clock, log, ...wait };

    // Step 3.
    if (steps.includes("session")) {
      const result = await startSessionAndWatch({ ...run, prompt: config.prompt ?? DEFAULT_SESSION_PROMPT });
      out({ step: "session", ...result });
    }

    // Step 4.
    if (steps.includes("task")) {
      const { id, title, description, attempt } = config.task;
      if (!id || !title) throw new UsageError("the task step needs --task-id and --task-title (and, usually, --task-description)");
      const result = await dispatchTask({ ...run, task: { id, title, description: description ?? "" }, attempt });
      out({ step: "task", ...result });
    }
    return EXIT.ok;
  } catch (err) {
    log(`${err instanceof Error ? err.name : "Error"}: ${messageOf(err)}`);
    return exitCodeFor(err);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // Closing is best effort; the result is already decided.
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
