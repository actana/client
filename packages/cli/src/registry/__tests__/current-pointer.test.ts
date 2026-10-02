// The Core pointer: `current.json` preferred, `current.txt` read too (client issue 11).
//
// Control's CLI writes only `current.txt` until actana/control issue 580 makes it write both, and
// the client reads `current.json` first. These pin the agreed order, from the machine states that
// actually occur: Control alone, the client alone, both agreeing, both disagreeing, and a JSON that
// has gone stale or unreadable.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearCurrentCore,
  readCurrentCore,
  registryPaths,
  removeCoreBlob,
  writeCoreBlob,
  writeCurrentCore,
} from "../credentials.ts";

const BLOB = Buffer.from(
  JSON.stringify({
    endpoint: "wss://core.test:9444",
    label: "core",
    caCert: "-----BEGIN CERTIFICATE-----CA-----END CERTIFICATE-----",
    clientCert: "-----BEGIN CERTIFICATE-----CERT-----END CERTIFICATE-----",
    clientKey: "-----BEGIN PRIVATE KEY-----KEY-----END PRIVATE KEY-----",
    bearer: "bearer.signature",
  }),
).toString("base64");

const roots: string[] = [];
function machine() {
  const home = mkdtempSync(path.join(tmpdir(), "actana-pointer-"));
  roots.push(home);
  const paths = registryPaths({ XDG_CONFIG_HOME: home }, home);
  for (const name of ["alpha", "beta"]) writeCoreBlob(paths, name, BLOB);
  return paths;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("the Core pointer, as written by Control and by the client", () => {
  it("reads a Core that only Control selected: current.txt and no current.json", () => {
    const paths = machine();
    writeFileSync(paths.currentPointer, "beta\n");
    expect(existsSync(paths.currentJson)).toBe(false);
    expect(readCurrentCore(paths)).toBe("beta");
  });

  it("prefers current.json when the two disagree", () => {
    const paths = machine();
    writeFileSync(paths.currentJson, JSON.stringify({ core: "alpha", search: null }));
    writeFileSync(paths.currentPointer, "beta\n");
    expect(readCurrentCore(paths)).toBe("alpha");
  });

  it("falls back to current.txt when current.json names a Core that was removed", () => {
    const paths = machine();
    writeFileSync(paths.currentJson, JSON.stringify({ core: "alpha", search: null }));
    writeFileSync(paths.currentPointer, "beta\n");
    removeCoreBlob(paths, "alpha");
    expect(readCurrentCore(paths)).toBe("beta");
  });

  it("falls back to current.txt when current.json is malformed or has no Core", () => {
    const paths = machine();
    writeFileSync(paths.currentPointer, "beta\n");
    writeFileSync(paths.currentJson, "{ not json");
    expect(readCurrentCore(paths)).toBe("beta");
    writeFileSync(paths.currentJson, JSON.stringify({ core: null, search: "docs" }));
    expect(readCurrentCore(paths)).toBe("beta");
  });

  it("answers nothing selected when neither file names a Core that exists", () => {
    const paths = machine();
    writeFileSync(paths.currentJson, JSON.stringify({ core: "gone", search: null }));
    writeFileSync(paths.currentPointer, "also-gone\n");
    expect(readCurrentCore(paths)).toBeNull();
  });

  it("writes both files when the client selects a Core, so Control reads it too", () => {
    const paths = machine();
    writeCurrentCore(paths, "alpha");
    expect(JSON.parse(readFileSync(paths.currentJson, "utf8"))).toMatchObject({ core: "alpha" });
    expect(readFileSync(paths.currentPointer, "utf8").trim()).toBe("alpha");
    expect(readCurrentCore(paths)).toBe("alpha");
  });

  it("clears both, so a cleared selection is not resurrected from the text file", () => {
    const paths = machine();
    writeCurrentCore(paths, "alpha");
    clearCurrentCore(paths);
    expect(existsSync(paths.currentPointer)).toBe(false);
    expect(readCurrentCore(paths)).toBeNull();
  });

  it("adopts the text pointer into current.json when the JSON's Core is gone, on first read", () => {
    const paths = machine();
    writeFileSync(paths.currentJson, JSON.stringify({ core: "gone", search: null }));
    writeFileSync(paths.currentPointer, "beta\n");
    expect(readCurrentCore(paths)).toBe("beta");
    expect(JSON.parse(readFileSync(paths.currentJson, "utf8")).core).toBe("beta");
  });
});
