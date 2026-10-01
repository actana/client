// `client.files` addresses the Core's home folder (actana/client#10 part 4,
// control #557): `/v1/files`, a path relative to `~`, and nothing that names a
// Project. Run against the Core's own route handler on a real socket, as every
// other Files suite is (`files-rig.ts`).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CoreClient } from "../client";
import { CoreFilesConflictError, CoreFilesRequestError } from "../files-http";
import { homePathRefusal } from "../files";
import { cleanupRoots, connectedClient, startFilesRig, type FilesRig } from "../../__tests__/files-rig";

let rig: FilesRig | null = null;
let client: CoreClient | null = null;
let closeRig: (() => void) | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  closeRig?.();
  closeRig = null;
  await rig?.close();
  rig = null;
});

afterAll(() => cleanupRoots());

async function open(seed: Parameters<typeof startFilesRig>[0] = {}): Promise<CoreClient> {
  rig = await startFilesRig(seed);
  const connected = await connectedClient(rig);
  client = connected.client;
  closeRig = () => connected.coreRig.close();
  return connected.client;
}

const requested = (): string[] =>
  rig!.requests.map((r) => `${r.method} ${new URL(r.url, "http://x").pathname}`);

describe("the home routes", () => {
  it("reads, lists and deletes at /v1/files, with no Project and no id in any URL", async () => {
    const core = await open({ seed: { "notes.txt": "hello", "src/a.txt": "a" } });

    await core.files.download({ path: "notes.txt" }).then((file) => file.stream.cancel());
    for await (const _entry of core.files.list()) void _entry;
    await core.files.remove("notes.txt");

    expect(requested()).toEqual(["GET /v1/files", "GET /v1/files/list", "DELETE /v1/files"]);
    expect(fs.existsSync(path.join(rig!.root, "notes.txt"))).toBe(false);
    expect(rig!.requests.map((r) => r.url).join("\n")).not.toMatch(/project/i);
  });

  it("writes at /v1/files too", async () => {
    const core = await open();

    for await (const _line of core.files.upload({ path: "new/dir/f.txt", body: bytes("x") })) void _line;

    expect(requested()).toEqual(["PUT /v1/files"]);
    expect(fs.readFileSync(path.join(rig!.root, "new/dir/f.txt"), "utf8")).toBe("x");
  });
});

describe("remove", () => {
  it("deletes a file, and a folder only when the path ends in a slash", async () => {
    const core = await open({ seed: { "a.txt": "a", "dir/b.txt": "b" } });

    await expect(core.files.remove("dir")).rejects.toMatchObject({ name: "CoreFilesRequestError", status: 400 });
    expect(fs.existsSync(path.join(rig!.root, "dir/b.txt"))).toBe(true);

    await core.files.remove("dir/");
    await core.files.remove("a.txt");
    expect(fs.readdirSync(rig!.root)).toEqual([]);
  });

  it("answers a missing path with not-found", async () => {
    const core = await open();

    await expect(core.files.remove("gone.txt")).rejects.toMatchObject({ status: 404, code: "not-found" });
  });

  it("refuses to delete the home, on the Core's word", async () => {
    const core = await open({ seed: { "a.txt": "a" } });

    await expect(core.files.remove("")).rejects.toBeInstanceOf(CoreFilesRequestError);
    expect(fs.existsSync(path.join(rig!.root, "a.txt"))).toBe(true);
  });

  it("is refused at once while a write holds the lease, and is not retried", async () => {
    const core = await open({ seed: { "a.txt": "a" } });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = (async function* () {
      yield new TextEncoder().encode("start");
      await gate;
    })();
    const writing = (async () => {
      try {
        for await (const _line of core.files.upload({ path: "slow.bin", body: slow })) void _line;
      } catch {
        // The test ends it by releasing the gate; the outcome is not the subject.
      }
    })();
    await vi.waitFor(() => expect(requested()).toContain("PUT /v1/files"));

    await expect(core.files.remove("a.txt")).rejects.toBeInstanceOf(CoreFilesConflictError);
    expect(requested().filter((r) => r === "DELETE /v1/files")).toHaveLength(1);
    release();
    await writing;
  });
});

describe("paths that cannot be right are refused before any request", () => {
  const unsafe: [string, string][] = [
    ["../escape.txt", "dot-dot-segment"],
    ["a/../../b", "dot-dot-segment"],
    ["/etc/passwd", "absolute-path"],
    ["a\\b", "malformed-path"],
    ["a\0b", "malformed-path"],
  ];

  for (const [bad, code] of unsafe) {
    it(`${JSON.stringify(bad)} is ${code} on every method, and nothing is sent`, async () => {
      const core = await open();
      const calls: Promise<unknown>[] = [
        core.files.download({ path: bad }),
        core.files.list({ path: bad }).next(),
        core.files.upload({ path: bad, body: bytes("x") }).next(),
        core.files.remove(bad),
      ];
      for (const call of calls) {
        await expect(call).rejects.toMatchObject({ name: "CoreFilesRequestError", status: 400, code });
      }
      expect(rig!.requests).toEqual([]);
    });
  }

  it("lets a dotted name and the home itself through", () => {
    expect(homePathRefusal("")).toBeNull();
    expect(homePathRefusal("..a/b..c/.hidden")).toBeNull();
    expect(homePathRefusal("a/b/")).toBeNull();
  });
});

function bytes(content: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield new TextEncoder().encode(content);
  })();
}
