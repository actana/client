// What only the S3 mode can say: the wire layout, partial failures of the copy-then-delete move, and
// that a refused path never reaches the store. The mode-agnostic behaviour is in contract.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createS3CoreShared } from "../s3.ts";
import { CoreSharedError, CoreSharedPartialError, type CoreShared } from "../types.ts";
import { refusal } from "./contract.ts";
import { startFakeS3, type FakeS3 } from "./fake-s3.ts";

const PREFIX = "cores/core-a/";
const SECRET = "very-secret-access-key";
const TOKEN = "very-secret-session-token";

type Fault = (call: { method: string; key: string; copySource?: string }) => boolean;

let s3: FakeS3;
let faults: Fault[];
let sent: Record<string, string>[];
let clock: number;
let expiresAt: Date;

/** The fetch the S3 mode sees: it fails (HTTP 500) any call a fault matches. */
const faultyFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
  const headers = (init?.headers ?? {}) as Record<string, string>;
  sent.push(headers);
  const call = { method: String(init?.method), key, copySource: headers["x-amz-copy-source"] };
  if (faults.some((fault) => fault(call))) {
    return new Response('<Error><Code>InternalError</Code><Message>boom</Message></Error>', { status: 500 });
  }
  return fetch(input, init);
};

const shared = (): CoreShared =>
  createS3CoreShared({
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    prefix: "cores/core-a",
    credentials: { get: async () => ({ accessKeyId: "AKIA", secretAccessKey: SECRET, sessionToken: TOKEN, expiresAt }) },
    fetch: faultyFetch,
    now: () => clock,
  });

const put = (key: string, body = key): void => {
  s3.objects.set(PREFIX + key, { body: Buffer.from(body), modified: new Date(), etag: "e" });
};
const keys = (): string[] => [...s3.objects.keys()].sort();

beforeEach(async () => {
  s3 = await startFakeS3();
  faults = [];
  sent = [];
  clock = Date.UTC(2026, 9, 1, 12, 0, 0);
  expiresAt = new Date(clock + 3600_000);
});
afterEach(async () => {
  await s3.close();
});

describe("S3 wire layout", () => {
  it("keeps every object under the Core's prefix and writes a folder marker as `<folder>/`", async () => {
    const api = shared();
    await api.put("a/b.txt", "b");
    await api.mkdir("docs/empty");
    await api.upload("up", [{ path: "x/y.txt", body: "y" }, { path: "dir", folder: true }]);
    expect(keys()).toEqual([
      `${PREFIX}a/b.txt`,
      `${PREFIX}docs/empty/`,
      `${PREFIX}up/dir/`,
      `${PREFIX}up/x/y.txt`,
    ]);
    expect(s3.objects.get(`${PREFIX}docs/empty/`)?.body.length).toBe(0);
  });

  it("signs every request and sends the session token", async () => {
    await shared().put("a.txt", "a");
    expect(sent.length).toBeGreaterThan(0);
    for (const headers of sent) {
      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\//);
      expect(headers["x-amz-security-token"]).toBe(TOKEN);
    }
    expect(s3.requests.at(-1)).toBe("PUT cores/core-a/a.txt");
  });
});

describe("a refused path never reaches the store", () => {
  it.each(["../x.txt", "a/../../x.txt", "/etc/passwd", "a//b", "./x"])("%j sends no request", async (path) => {
    const api = shared();
    const calls: Promise<unknown>[] = [
      api.get(path),
      api.put(path, "x"),
      api.list(path),
      api.mkdir(path),
      api.rm(path),
      api.move(path, "ok.txt"),
      api.move("ok.txt", path),
      api.upload("drop", [{ path, body: "x" }]),
      api.upload(path, [{ path: "a.txt", body: "x" }]),
    ];
    for (const call of calls) expect((await refusal(call)).code).toBe("invalid-path");
    expect(s3.requests).toEqual([]);
  });
});

describe("move is copy, then delete: what a failure leaves behind", () => {
  const seed = (): void => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) put(`old/${name}`);
    put("old/", "");
  };

  it("a failed copy is rolled back: the source is whole, the destination is empty, the error is the plain one", async () => {
    seed();
    faults.push((c) => c.method === "PUT" && c.key === `${PREFIX}new/c.txt`);
    const error = await refusal(shared().move("old/", "new/"));
    expect(error).not.toBeInstanceOf(CoreSharedPartialError);
    expect(error.code).toBe("unavailable");
    expect(keys()).toEqual([`${PREFIX}old/`, `${PREFIX}old/a.txt`, `${PREFIX}old/b.txt`, `${PREFIX}old/c.txt`]);
  });

  it("a failed copy whose rollback also fails reports the copies it could not remove", async () => {
    seed();
    faults.push((c) => c.method === "PUT" && c.key === `${PREFIX}new/c.txt`);
    faults.push((c) => c.method === "DELETE" && c.key === `${PREFIX}new/b.txt`);
    const error = (await refusal(shared().move("old/", "new/"))) as CoreSharedPartialError;
    expect(error).toBeInstanceOf(CoreSharedPartialError);
    expect([error.operation, error.stage, error.reason]).toEqual(["move", "copy", "unavailable"]);
    expect(error.leftBehind).toEqual(["new/b.txt"]);
    // The source is untouched; the stray copy is exactly the one reported.
    expect(keys()).toEqual([
      `${PREFIX}new/b.txt`,
      `${PREFIX}old/`,
      `${PREFIX}old/a.txt`,
      `${PREFIX}old/b.txt`,
      `${PREFIX}old/c.txt`,
    ]);
  });

  it("a failed delete leaves the destination complete and lists the source paths still there", async () => {
    seed();
    faults.push((c) => c.method === "DELETE" && c.key === `${PREFIX}old/b.txt`);
    const error = (await refusal(shared().move("old/", "new/"))) as CoreSharedPartialError;
    expect(error).toBeInstanceOf(CoreSharedPartialError);
    expect([error.operation, error.stage, error.reason]).toEqual(["move", "delete", "unavailable"]);
    // a.txt is already gone; b.txt, c.txt and the folder marker are what is left of the source.
    expect(error.leftBehind).toEqual(["old/b.txt", "old/c.txt", "old/"]);
    expect(keys()).toEqual([
      `${PREFIX}new/`,
      `${PREFIX}new/a.txt`,
      `${PREFIX}new/b.txt`,
      `${PREFIX}new/c.txt`,
      `${PREFIX}old/`,
      `${PREFIX}old/b.txt`,
      `${PREFIX}old/c.txt`,
    ]);
  });

  it("a file move that fails to delete leaves both copies, and says so", async () => {
    put("f.txt", "data");
    faults.push((c) => c.method === "DELETE" && c.key === `${PREFIX}f.txt`);
    const error = (await refusal(shared().move("f.txt", "g.txt"))) as CoreSharedPartialError;
    expect([error.stage, error.leftBehind]).toEqual(["delete", ["f.txt"]]);
    expect(keys()).toEqual([`${PREFIX}f.txt`, `${PREFIX}g.txt`]);
  });

  it("a file move whose copy fails changes nothing", async () => {
    put("f.txt", "data");
    faults.push((c) => c.method === "PUT" && c.key === `${PREFIX}g.txt`);
    expect((await refusal(shared().move("f.txt", "g.txt"))).code).toBe("unavailable");
    expect(keys()).toEqual([`${PREFIX}f.txt`]);
  });

  it("an S3 copy that answers 200 with an error body is a failure, not a success", async () => {
    put("f.txt", "data");
    const api = createS3CoreShared({
      endpoint: s3.endpoint,
      bucket: s3.bucket,
      prefix: "cores/core-a",
      credentials: { get: async () => ({ accessKeyId: "A", secretAccessKey: SECRET, sessionToken: TOKEN, expiresAt }) },
      fetch: async (input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (headers["x-amz-copy-source"]) return new Response("<Error><Code>InternalError</Code></Error>", { status: 200 });
        return fetch(input, init);
      },
    });
    expect((await refusal(api.move("f.txt", "g.txt"))).code).toBe("unavailable");
    expect(keys()).toEqual([`${PREFIX}f.txt`]);
  });
});

describe("rm and upload that stop part-way", () => {
  it("rm of a folder lists what it did not delete, and keeps the marker until the end", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) put(`old/${name}`);
    put("old/", "");
    faults.push((c) => c.method === "DELETE" && c.key === `${PREFIX}old/b.txt`);
    const error = (await refusal(shared().rm("old/"))) as CoreSharedPartialError;
    expect([error.operation, error.stage, error.leftBehind]).toEqual(["rm", "delete", ["old/b.txt", "old/c.txt", "old/"]]);
    expect(keys()).toEqual([`${PREFIX}old/`, `${PREFIX}old/b.txt`, `${PREFIX}old/c.txt`]);
  });

  it("upload lists the files it wrote before the failure", async () => {
    faults.push((c) => c.method === "PUT" && c.key === `${PREFIX}up/c.txt`);
    const error = (await refusal(
      shared().upload("up", [
        { path: "a.txt", body: "a" },
        { path: "b.txt", body: "b" },
        { path: "c.txt", body: "c" },
        { path: "d.txt", body: "d" },
      ]),
    )) as CoreSharedPartialError;
    expect([error.operation, error.stage, error.leftBehind]).toEqual(["upload", "write", ["up/a.txt", "up/b.txt"]]);
    expect(keys()).toEqual([`${PREFIX}up/a.txt`, `${PREFIX}up/b.txt`]);
  });

  it("upload whose first write fails is the plain error: nothing was left", async () => {
    faults.push((c) => c.method === "PUT");
    const error = await refusal(shared().upload("up", [{ path: "a.txt", body: "a" }]));
    expect(error).not.toBeInstanceOf(CoreSharedPartialError);
    expect(error.code).toBe("unavailable");
    expect(keys()).toEqual([]);
  });
});

describe("errors say nothing secret", () => {
  it("a store failure maps to a code and its message holds no key, token or URL", async () => {
    faults.push(() => true);
    const error = await refusal(shared().put("a.txt", "a"));
    expect(error).toBeInstanceOf(CoreSharedError);
    expect(error.code).toBe("unavailable");
    for (const text of [error.message, String(error.stack), JSON.stringify(error)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("127.0.0.1");
    }
  });
});

describe("signedUrl and the key's lifetime", () => {
  const params = (url: string): URLSearchParams => new URL(url).searchParams;

  it("signs for the asked time when the key lives longer, and carries the session token", async () => {
    const signed = await shared().signedUrl("a/b.txt", { expiresInSeconds: 600 });
    expect(params(signed.url).get("X-Amz-Expires")).toBe("600");
    expect(params(signed.url).get("X-Amz-Security-Token")).toBe(TOKEN);
    expect(signed.expiresAt.getTime()).toBe(clock + 600_000);
    expect(new URL(signed.url).pathname).toBe(`/${s3.bucket}/${PREFIX}a/b.txt`);
  });

  it("expires with the key when the key ends sooner than asked", async () => {
    expiresAt = new Date(clock + 90_000);
    const signed = await shared().signedUrl("a.txt", { expiresInSeconds: 3600 });
    expect(params(signed.url).get("X-Amz-Expires")).toBe("90");
    expect(signed.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it("never signs past the key even when the clock has a fraction of a second", async () => {
    clock += 400;
    expiresAt = new Date(clock + 30_900);
    const signed = await shared().signedUrl("a.txt", { expiresInSeconds: 3600 });
    expect(signed.expiresAt.getTime()).toBeLessThanOrEqual(expiresAt.getTime());
  });

  it("refuses with expired when the key has run out, and caps the lifetime at S3's seven days", async () => {
    expiresAt = new Date(clock - 1000);
    expect((await refusal(shared().signedUrl("a.txt"))).code).toBe("expired");
    expiresAt = new Date(clock + 30 * 86400_000);
    const signed = await shared().signedUrl("a.txt", { expiresInSeconds: 30 * 86400 });
    expect(params(signed.url).get("X-Amz-Expires")).toBe("604800");
  });

  it("makes no request", async () => {
    await shared().signedUrl("a.txt");
    expect(s3.requests).toEqual([]);
  });
});

describe("the store's refusals", () => {
  const respondWith = (status: number, code: string): typeof fetch => async () =>
    new Response(`<Error><Code>${code}</Code><Message>m</Message></Error>`, { status });
  const api = (fetchImpl: typeof fetch): CoreShared =>
    createS3CoreShared({
      endpoint: s3.endpoint,
      bucket: s3.bucket,
      prefix: "cores/core-a",
      credentials: { get: async () => ({ accessKeyId: "A", secretAccessKey: SECRET, sessionToken: TOKEN, expiresAt }) },
      fetch: fetchImpl,
    });

  it.each([
    [403, "AccessDenied", "forbidden"],
    [400, "ExpiredToken", "expired"],
    [404, "NoSuchKey", "not-found"],
    [503, "SlowDown", "unavailable"],
  ] as const)("HTTP %i %s becomes %s", async (status, code, expected) => {
    expect((await refusal(api(respondWith(status, code)).get("a.txt"))).code).toBe(expected);
  });

  it("an unreachable store is unavailable and the message names no address", async () => {
    const error = await refusal(
      api(async () => {
        throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:9");
      }).get("a.txt"),
    );
    expect(error.code).toBe("unavailable");
    expect(error.message).not.toContain("127.0.0.1");
  });
});

describe("watch cursors are bound to the Shared folder", () => {
  it("another Core's cursor is refused", async () => {
    await shared().put("a.txt", "a");
    const mine = (await shared().watch()).cursor;
    const other = createS3CoreShared({
      endpoint: s3.endpoint,
      bucket: s3.bucket,
      prefix: "cores/core-b",
      credentials: { get: async () => ({ accessKeyId: "A", secretAccessKey: SECRET, sessionToken: TOKEN, expiresAt }) },
    });
    expect((await refusal(other.watch(mine))).code).toBe("invalid-cursor");
  });
});
