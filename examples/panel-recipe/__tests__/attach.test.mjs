// Step 2 against the fake Core: issue a key, send it to the Core, keep it fresh. The issuer here is
// a test double of the SDK's `SharedKeyIssuer` interface; the real SeaweedFS issuer is exercised
// against a real SeaweedFS in `seaweedfs.test.mjs` (CI job `shared-key-seaweedfs`).
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient } from "@actana/sdk/core";
import { startFakeCore } from "./fake-core.mjs";
import { attachShared, corePrefix } from "../src/attach.mjs";
import { RefusedError } from "../src/errors.mjs";

const clients = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

async function connect(core) {
  const client = new CoreClient({ url: "wss://fake-core.invalid", bearer: core.bearer, createSocket: core.createSocket });
  clients.push(client);
  return { client, info: await client.connect() };
}

/** Issues numbered keys that live one hour from the fake clock. */
function fakeIssuer(clock) {
  const issued = [];
  return {
    issued,
    async issue(coreId) {
      const n = issued.length + 1;
      issued.push(coreId);
      return {
        accessKeyId: `AKIA-${coreId}-${n}`,
        secretAccessKey: `SECRET-${n}-NEVER-PRINT`,
        sessionToken: `TOKEN-${n}-NEVER-PRINT`,
        expiresAt: new Date(clock.t + 3_600_000),
      };
    },
  };
}

const target = { bucket: "actana-shared", prefix: "cores", endpoint: "http://s3.invalid:8333" };

describe("step 2: attach the Shared folder with a key issuer", () => {
  it("issues a key for the Core's id and sends it in sharedAttach, limited to the Core's own folder", async () => {
    const clock = { t: Date.parse("2026-10-01T12:00:00Z") };
    const core = startFakeCore({ coreId: "core-a" });
    const { client, info } = await connect(core);
    const issuer = fakeIssuer(clock);

    const attached = await attachShared({ client, info, issuer, ...target, clock: { now: () => clock.t, sleep: async () => {} } });

    expect(issuer.issued).toEqual(["core-a"]);
    const [frame] = core.framesOfType("sharedAttach");
    expect(frame).toMatchObject({
      endpoint: "http://s3.invalid:8333",
      bucket: "actana-shared",
      prefix: "cores/core-a/",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA-core-a-1", secretAccessKey: "SECRET-1-NEVER-PRINT", sessionToken: "TOKEN-1-NEVER-PRINT" },
      expiresAt: "2026-10-01T13:00:00.000Z",
    });
    expect(attached.status).toEqual({ state: "attached", expiresAt: "2026-10-01T13:00:00.000Z" });
    expect(attached.prefix).toBe("cores/core-a/");
    expect(core.state.attached).toMatchObject({ prefix: "cores/core-a/", bucket: "actana-shared" });
  });

  it("builds the controller's own S3 view on the same folder, signed with the same key", async () => {
    const clock = { t: Date.parse("2026-10-01T12:00:00Z") };
    const core = startFakeCore({ coreId: "core-a" });
    const { client, info } = await connect(core);
    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>", { status: 200 });
    };
    const { shared } = await attachShared({
      client, info, issuer: fakeIssuer(clock), ...target, clock: { now: () => clock.t, sleep: async () => {} }, fetch,
    });
    await shared.list("tasks/");
    expect(seen[0].url).toContain("/actana-shared");
    expect(decodeURIComponent(seen[0].url)).toContain("cores/core-a/tasks/");
    expect(seen[0].auth).toContain("AKIA-core-a-1");
  });

  it("refuses a Core that does not announce the shared capability, before issuing any key", async () => {
    const core = startFakeCore({ shared: null });
    const { client, info } = await connect(core);
    const issuer = fakeIssuer({ t: 0 });
    await expect(attachShared({ client, info, issuer, ...target })).rejects.toThrow(/shared capability/);
    expect(issuer.issued).toEqual([]);
    expect(core.framesOfType("sharedAttach")).toEqual([]);
  });

  it("surfaces the Core's refusal with its code, and never the key", async () => {
    const core = startFakeCore({
      attach: () => ({ state: "error", code: "mount-failed", message: "the bucket is not reachable" }),
    });
    const { client, info } = await connect(core);
    const err = await attachShared({ client, info, issuer: fakeIssuer({ t: Date.now() }), ...target }).catch((e) => e);
    expect(err).toBeInstanceOf(RefusedError);
    expect(err.exitCode).toBe(4);
    expect(err.message).toContain("mount-failed: the bucket is not reachable");
    expect(err.message).not.toMatch(/SECRET|TOKEN|AKIA/);
  });

  it("pushes a refreshed key with sharedCredentials only once the old one is within 15 minutes of expiring", async () => {
    const clock = { t: Date.parse("2026-10-01T12:00:00Z") };
    const core = startFakeCore({ coreId: "core-a" });
    const { client, info } = await connect(core);
    const issuer = fakeIssuer(clock);
    const attached = await attachShared({ client, info, issuer, ...target, clock: { now: () => clock.t, sleep: async () => {} } });

    clock.t += 44 * 60_000; // 44 minutes in: 16 minutes left, not yet
    expect(await attached.pushIfRenewed()).toBe(false);
    expect(core.framesOfType("sharedCredentials")).toEqual([]);

    clock.t += 2 * 60_000; // 46 minutes in: 14 minutes left, refresh
    expect(await attached.pushIfRenewed()).toBe(true);
    const [push] = core.framesOfType("sharedCredentials");
    expect(push.credentials.accessKeyId).toBe("AKIA-core-a-2");
    expect(push.expiresAt).toBe(new Date(clock.t + 3_600_000).toISOString());
    expect(core.state.credentials.accessKeyId).toBe("AKIA-core-a-2");
    expect(issuer.issued).toHaveLength(2);
  });

  it("detaches, keeping the Core's local copy", async () => {
    const core = startFakeCore();
    const { client, info } = await connect(core);
    const attached = await attachShared({ client, info, issuer: fakeIssuer({ t: Date.now() }), ...target });
    await attached.detach();
    expect(core.framesOfType("sharedDetach")[0]).toMatchObject({ keepLocalCopy: true });
    expect(core.state.attached).toBeNull();
  });
});

describe("corePrefix", () => {
  it("is <prefix>/<core-id>/ whatever slashes the prefix carries", () => {
    expect(corePrefix("cores", "core-a")).toBe("cores/core-a/");
    expect(corePrefix("cores/", "core-a")).toBe("cores/core-a/");
  });
});
