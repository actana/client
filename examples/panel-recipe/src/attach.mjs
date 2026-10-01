// Step 2 of the recipe: attach a Core's Shared folder with a key issuer.
//
// The controller (this script, here; the Panel, in production) holds the MASTER key. It never sends
// it anywhere. For each Core it asks an issuer for a 1-hour S3 key limited to `<prefix>/<core-id>/`,
// hands that key to the Core with a `sharedAttach` frame, and pushes a fresh one with
// `sharedCredentials` before the old one runs out (15 minutes early, at most half the key's life).
// The controller reads the same folder directly in S3 with the same issuer, so it sees a Core's
// files while that Core is paused or offline.
//
// Public SDK only: `@actana/sdk/shared-key` (the issuer and the refresh provider), `@actana/sdk/shared`
// (the S3 mode of CoreShared) and `CoreClient.request` for the three Shared-folder frames.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  createSeaweedfsKeyIssuer,
  createSharedKeyProvider,
  publicJwks,
  SHARED_KEY_REFRESH_MARGIN_SECONDS,
} from "@actana/sdk/shared-key";
import { createS3CoreShared } from "@actana/sdk/shared";
import { RefusedError, UsageError, messageOf } from "./errors.mjs";
import { realClock } from "./clock.mjs";

/** The SeaweedFS issuer from a settings object (see `config.mjs`). The signing key is read here and goes nowhere else. */
export function createIssuer(seaweedfs) {
  let signingKey;
  try {
    signingKey = readFileSync(seaweedfs.signingKeyFile, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read the signing key file ${seaweedfs.signingKeyFile}: ${messageOf(err)}`);
  }
  return createSeaweedfsKeyIssuer({
    endpoint: seaweedfs.endpoint,
    issuer: seaweedfs.oidcIssuer,
    audience: seaweedfs.oidcAudience,
    signingKey,
    keyId: seaweedfs.keyId,
  });
}

/**
 * Serve the controller's public key as a JWKS document, which is how SeaweedFS checks the tokens the
 * issuer signs. A real controller serves it from its own HTTPS origin; this is the smallest thing that
 * lets the recipe run on one machine. Resolves with the server; call `close()` when done.
 */
export async function serveJwks({ signingKeyFile, keyId, port, host = "127.0.0.1" }) {
  const document = JSON.stringify(publicJwks(readFileSync(signingKeyFile, "utf8"), keyId));
  const server = createServer((req, res) => {
    const found = req.url === "/jwks.json";
    res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
    res.end(found ? document : "{}");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The Core's own folder in the bucket: `<prefix>/<core-id>/`. */
export function corePrefix(prefix, coreId) {
  return `${prefix.replace(/\/+$/, "")}/${coreId}/`;
}

/**
 * The controller's own view of a Core's Shared folder: the direct-S3 mode of `CoreShared`, signed
 * with a key the issuer hands out and refreshes. It sends the Core nothing, so it is also how a later
 * run (step 3, step 4) reads a folder that was attached earlier.
 */
export function openControllerShared({ issuer, coreId, bucket, prefix, endpoint, region = "us-east-1", clock = realClock, fetch: fetchImpl }) {
  const folder = corePrefix(prefix, coreId);
  const provider = createSharedKeyProvider({ issuer, coreId, now: clock.now });
  const shared = createS3CoreShared({
    endpoint,
    bucket,
    prefix: folder.replace(/\/$/, ""),
    region,
    credentials: provider,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return { shared, provider, folder };
}

function describeStatus(status) {
  return status.state === "error" ? `${status.code}: ${status.message}` : status.state;
}

async function sharedRequest(client, frame) {
  const answer = await client.request(frame);
  if (answer.type === "error") throw new RefusedError(`the Core refused ${frame.type}: ${answer.message}`);
  if (answer.type !== "sharedStatus") throw new RefusedError(`the Core answered ${frame.type} with ${answer.type}`);
  return answer.status;
}

/**
 * Attach the Core's Shared folder.
 *
 * 1. refuse a Core that does not announce the `shared` capability (it would not answer the frames);
 * 2. issue a key for the Core's id and send `sharedAttach` with it;
 * 3. return the controller's own direct-S3 `CoreShared` for the same folder, and `keepFresh()` to push
 *    refreshed keys until `stop()`.
 *
 * `info` is what `client.connect()` resolved with. Nothing here logs a key.
 */
export async function attachShared({
  client,
  info,
  issuer,
  bucket,
  prefix,
  /** The S3 endpoint as the CONTROLLER reaches it. */
  endpoint,
  /** The S3 endpoint as the CORE reaches it, when that differs (a different network, a gateway). */
  coreEndpoint = endpoint,
  region = "us-east-1",
  clock = realClock,
  log = () => undefined,
  fetch: fetchImpl,
}) {
  if (info.shared === null) {
    throw new RefusedError("this Core does not announce the shared capability, so it cannot mount a Shared folder");
  }
  if (!info.coreId) throw new RefusedError("the Core did not say its id (no bearer was presented?)");
  const coreId = info.coreId;
  const { shared, provider, folder } = openControllerShared({
    issuer, coreId, bucket, prefix, endpoint, region, clock, fetch: fetchImpl,
  });

  const key = await provider.get();
  const status = await sharedRequest(client, {
    type: "sharedAttach",
    reqId: "",
    endpoint: coreEndpoint,
    bucket,
    prefix: folder,
    region,
    credentials: {
      accessKeyId: key.accessKeyId,
      secretAccessKey: key.secretAccessKey,
      sessionToken: key.sessionToken,
    },
    expiresAt: key.expiresAt.toISOString(),
  });
  if (status.state !== "attached") {
    throw new RefusedError(`the Core did not attach the Shared folder (${describeStatus(status)})`);
  }
  log(`attached ${bucket}/${folder} on Core ${coreId}; key expires ${key.expiresAt.toISOString()}`);

  let pushedKeyId = key.accessKeyId;
  /** Send the Core a fresh key if the provider has issued one since the last push. */
  async function pushIfRenewed() {
    const current = await provider.get();
    if (current.accessKeyId === pushedKeyId) return false;
    const refreshed = await sharedRequest(client, {
      type: "sharedCredentials",
      reqId: "",
      credentials: {
        accessKeyId: current.accessKeyId,
        secretAccessKey: current.secretAccessKey,
        sessionToken: current.sessionToken,
      },
      expiresAt: current.expiresAt.toISOString(),
    });
    if (refreshed.state !== "attached") {
      throw new RefusedError(`the Core did not take the refreshed key (${describeStatus(refreshed)})`);
    }
    pushedKeyId = current.accessKeyId;
    log(`refreshed the Core's key; it expires ${current.expiresAt.toISOString()}`);
    return true;
  }

  let timer = null;
  let stopped = false;
  function keepFresh({ onError = (err) => log(`could not refresh the key: ${messageOf(err)}`) } = {}) {
    const schedule = async () => {
      if (stopped) return;
      const current = await provider.get().catch(() => null);
      // The provider replaces a key from this instant on; one second later is certainly past it.
      const due = current ? current.expiresAt.getTime() - SHARED_KEY_REFRESH_MARGIN_SECONDS * 1000 + 1_000 : clock.now();
      const wait = Math.max(1_000, due - clock.now());
      timer = setTimeout(async () => {
        try {
          await pushIfRenewed();
        } catch (err) {
          onError(err);
        }
        void schedule();
      }, wait);
      timer.unref?.();
    };
    void schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  return {
    coreId,
    prefix: folder,
    shared,
    provider,
    status,
    pushIfRenewed,
    keepFresh,
    /** Tell the Core to unmount; its local copy is kept (the only thing the protocol can ask for). */
    async detach() {
      const detached = await sharedRequest(client, { type: "sharedDetach", reqId: "", keepLocalCopy: true });
      if (detached.state !== "detached") throw new RefusedError(`the Core did not detach (${describeStatus(detached)})`);
    },
  };
}
