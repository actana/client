// What a host needs from the package root to bind a port and to test it (client issue 11 follow-up).
//
// Control's built-in CLI binds the ports and keeps tests that throw this package's errors at its verbs
// and compare what `harness skills` installs with this package's payload. The published code tells
// errors apart with `instanceof`, which is class identity: a host that cannot import the class cannot
// throw it, and the verb behaves as if an unknown error had come back. Everything here is imported from
// `../index.ts`, which is what `"."` maps to, as a host would.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as root from "../index.ts";
import {
  CoreFilesRequestError,
  CoreFilesUnavailableError,
  CoreLinkRequestError,
  CoreSessionAttachError,
  CoreSessionLinkLostError,
  CoreSessionTurnTimeoutError,
  SESSION_LOCKED_ERROR_CODE,
} from "@actana/sdk/core";
import { CorePairingError, PairingError } from "@actana/sdk/pairing";
import { CoreSharedError, CoreSharedPartialError } from "@actana/sdk/shared";
import { SearchApiError } from "@actana/sdk/search";
import { SessionWriteRefused } from "../core/session-attach-channel.ts";
import { SessionGatewayError, KNOWN_HARNESSES } from "../core/session-gateway.ts";
import { SharedUnavailableError } from "../core/shared-gateway.ts";
import { ReportWaitTimeoutError } from "../core/session-report-wait.ts";
import * as exitCodes from "../kit/exit-codes.ts";
import { CORE_BLOB_ENV } from "../core/core-resolution.ts";
import {
  ORCHESTRATION_SKILL_FILES,
  ORCHESTRATION_SKILL_MARKER,
  ORCHESTRATION_SKILL_NAMES,
} from "../core/orchestration-skill-payload.ts";
import { makeCliFixture, type CliFixture } from "./cli-harness.ts";

let fixture: CliFixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

describe("the classes the verbs tell apart with instanceof", () => {
  // The same class, not an equal one: `===` is what `instanceof` needs.
  const classes: Array<[string, unknown]> = [
    ["SessionWriteRefused", SessionWriteRefused],
    ["SessionGatewayError", SessionGatewayError],
    ["SharedUnavailableError", SharedUnavailableError],
    ["ReportWaitTimeoutError", ReportWaitTimeoutError],
    ["PairingError", PairingError],
    ["CorePairingError", CorePairingError],
    ["CoreLinkRequestError", CoreLinkRequestError],
    ["CoreSessionAttachError", CoreSessionAttachError],
    ["CoreSessionLinkLostError", CoreSessionLinkLostError],
    ["CoreSessionTurnTimeoutError", CoreSessionTurnTimeoutError],
    ["CoreFilesRequestError", CoreFilesRequestError],
    ["CoreFilesUnavailableError", CoreFilesUnavailableError],
    ["CoreSharedError", CoreSharedError],
    ["CoreSharedPartialError", CoreSharedPartialError],
    ["SearchApiError", SearchApiError],
  ];

  it.each(classes)("exports %s from the root, as the very class the package uses", (name, cls) => {
    expect((root as Record<string, unknown>)[name]).toBe(cls);
  });

  it("lets a host throw the exported SessionWriteRefused and be recognised by it", () => {
    const thrown = new root.SessionWriteRefused("this attachment does not hold this Session's write lock");
    expect(thrown).toBeInstanceOf(SessionWriteRefused);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.name).toBe("SessionWriteRefused");
  });

  it("exports every class the package's own code tests with instanceof (a drift guard)", () => {
    // Read off the source rather than off a list, so the next `instanceof SomethingNew` fails here
    // until the class is exported, instead of in a host's test.
    const SRC = path.resolve(import.meta.dirname, "..");
    const used = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          for (const m of fs.readFileSync(full, "utf8").matchAll(/instanceof (\w+)/g)) used.add(m[1]!);
        }
      }
    };
    walk(SRC);
    used.delete("Error");
    expect(used.size, "the sweep found no instanceof at all, so it is reading nothing").toBeGreaterThan(8);
    const exported = new Set(Object.keys(root));
    expect([...used].filter((name) => !exported.has(name))).toEqual([]);
  });
});

describe("the constants a host binds or tests against", () => {
  it("exports every exit code, by value", () => {
    for (const [name, value] of Object.entries(exitCodes)) {
      expect((root as Record<string, unknown>)[name], name).toBe(value);
    }
    expect(root.EXIT_OK).toBe(0);
    expect(root.EXIT_LINK_LOST).toBe(125);
  });

  it("exports the harness list, the blob variable and the lock error code", () => {
    expect(root.KNOWN_HARNESSES).toBe(KNOWN_HARNESSES);
    expect(root.CORE_BLOB_ENV).toBe(CORE_BLOB_ENV);
    expect(root.SESSION_LOCKED_ERROR_CODE).toBe(SESSION_LOCKED_ERROR_CODE);
  });

  it("exports a terminal a host's tests can hand to a verb", () => {
    const lines: string[] = [];
    const terminal = root.nonInteractiveTerminal((data) => lines.push(data));
    expect(terminal.isTty).toBe(false);
    terminal.write("hello");
    expect(lines).toEqual(["hello"]);
  });
});

describe("the skill payload, from the root", () => {
  it("exports the payload constants, so a host can compare what `harness skills` installs", () => {
    expect(root.ORCHESTRATION_SKILL_FILES).toBe(ORCHESTRATION_SKILL_FILES);
    expect(root.ORCHESTRATION_SKILL_NAMES).toBe(ORCHESTRATION_SKILL_NAMES);
    expect(root.ORCHESTRATION_SKILL_MARKER).toBe(ORCHESTRATION_SKILL_MARKER);
  });

  it("installs, byte for byte, the files the root constant holds", async () => {
    fixture = makeCliFixture();
    fs.mkdirSync(path.join(fixture.home, ".claude"), { recursive: true });
    const run = await fixture.run(["harness", "skills"]);
    expect(run.code, run.err.join("\n")).toBe(root.EXIT_OK);
    for (const skill of root.ORCHESTRATION_SKILL_NAMES) {
      for (const [file, bytes] of Object.entries(root.ORCHESTRATION_SKILL_FILES[skill] ?? {})) {
        const installed = fs.readFileSync(path.join(fixture.home, ".claude", "skills", skill, file), "utf8");
        expect(installed, `${skill}/${file}`).toBe(bytes);
      }
    }
  });

  it("teaches `actana files` and `actana shared`, so an agent knows both nouns exist", () => {
    const text = Object.values(root.ORCHESTRATION_SKILL_FILES["actana-sessions"] ?? {}).join("\n");
    expect(text).toMatch(/actana files ls/);
    expect(text).toMatch(/actana files get/);
    expect(text).toMatch(/actana files put/);
    expect(text).toMatch(/actana files rm/);
    expect(text).toMatch(/actana shared get/);
  });
});
