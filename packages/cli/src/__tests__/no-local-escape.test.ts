// The boundaries that make this a CLI, and the one it is allowed to cross.
//
// Three bans live here. Two are unchanged; one is narrowed by #288 C1 and one
// is rewritten by #288 D5, and neither of those two is deleted — the argument
// each of them was written to hold is still true, of a smaller set of files.
//
// ─── 1. The client cannot shell out (#129 D9, narrowed by #288 C1) ───────────
//
// The ticket's wording is the argument in full — *the CLI accepts a
// file or stdin. Never `docker exec` — a CLI that shells into a container to
// fetch its own credentials is not a CLI.* A client that gets its credential by
// running a command on the Core's host only works when the Core is on this
// machine, which is the case that matters least; it makes a container runtime a
// dependency of a program whose whole purpose is to not need one; and it turns
// "paste this once" into a standing privilege.
//
// Nothing in the source says `docker`, which is why this test does not grep for
// it: a string is renameable and the *capability* is not. What it asserts is
// that no shipped **client** module imports a way to start a process at all.
// That covers the container shell-out, and it covers the four other shapes the
// same temptation takes — scp'ing a blob off a host, running `ssh core 'actana
// token'` internally, calling a package manager, shelling out to `curl`.
//
// **Why "client" and not "shipped", since #288.** This package now ships the
// machine half of `actana` as well: `setup`, `status`, `update`, `start`,
// `stop`, `logs`, `uninstall` and `daemon` install and operate the Core on the
// box the command is running on. Driving `systemctl`, `launchctl`, `loginctl`
// and a vendor's Harness installer is not the temptation this ban names — it is
// the only way to do that job, and it was always done this way; the modules
// that do it simply used to live in `packages/core`. So the ban keeps sweeping
// the client modules, where the temptation actually lives, and stops covering
// the machine modules, which are enumerated with a reason each in
// `module-halves.ts`.
//
// **What would make a breach a breach again**: a *client* noun reaching for a
// subprocess to get at a Core — `core pair` running `docker exec`, `core status`
// running `ssh`, `project cp` running `scp`. That is what the sweep below still
// fails on, and it is why `actana-cli.ts` and `actana-cli-entry.ts` are
// deliberately left in the swept set even though both halves dispatch through
// them: an exemption there would be a door from the machine half straight onto
// the client's path.
//
// **The sweep stops at this package's boundary, and since #288 that boundary
// has a door in it.** These tests read import specifiers in `packages/cli/src`
// and nothing else, so a subprocess reached *through* a package this one may
// now import is invisible to them. There is one such route today and it is
// legitimate: `actana-cli-entry.ts` imports
// `@actana/shared/harness-availability-store`, which runs the Core's own PATH
// probe and reaches `spawnSync` through `shell-env.ts` and
// `harness-cli-version.ts`. `status` and `setup` need that probe to be the
// Core's rather than a second, subtly different one (CONTEXT.md: "CLI
// availability is Core-published state"). Before #288 `packages/cli` could not
// import `@actana/shared` at all, so the route is new — and a *client* noun
// that grew one would be a breach this file cannot see. If that ever needs
// enforcing, the sweep has to follow `@actana/shared` specifiers into
// `packages/shared/src` rather than stopping at the name.
//
// The one client verb that will legitimately want a subprocess is `core shell`
// (#162), and it is the exception that proves the rule: it hands the operator a
// terminal on the *Core*, over the core link, rather than running anything
// locally on their behalf.
//
// ─── 2. No daemon (#129 D8) — unchanged, and the proof the move was done ─────
//
// ─── 3. The private package, inlined (#288 D5) — rewritten, not deleted ──────
//
// ─── And what the dependency pin now also holds up (#320, ADR 0036 D16) ──────
//
// The last `describe` in this file pins `dependencies` to four names, and that
// pin acquired a second job with #320. The beta install path packs this CLI as
// a Release asset and installs it with `npm i -g <asset-url>`, publishing
// nothing to registry.npmjs.org — because a beta version string is `x.y.z-beta`
// with no counter (ADR 0036 C1) and npm burns a version on first publish, so
// the second cut of a beta could not publish at all (D15). That asset's packed
// manifest **drops `@actana/sdk`**, on the grounds that esbuild inlines it, and
// `scripts/rehearse-npm-publish.mjs` makes the edit in the workflow's checkout
// and never commits it.
//
// So this file's list stays exactly four names — the *release* manifest needs
// the SDK, and **this file is what says so**. `scripts/lib/npm-packages.mjs`
// refuses a release CLI pinned to the *wrong* SDK version, but its check
// iterates the packed dependencies and therefore has nothing to say about a
// release manifest that dropped the SDK entirely; the pin below, on the working
// tree the release packs from, is the only thing that refuses that. One
// assertion is added rather than any being relaxed: the invariant that makes
// dropping it on the beta path safe. The whole argument for the drop is that the code
// is in the bundle, which is true only while `@actana/sdk` is absent from
// `build.mjs`'s `external` array. That absence was already asserted here for
// #288 D5's reasons; it now also decides whether a stranger's `npm i -g` of a
// beta asset resolves a version that does not exist.
//
// See the three `describe` blocks below; each carries its own argument.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MACHINE_MODULES,
  SRC,
  clientSources,
  importSpecifiers,
  machineSources,
  shippedSources,
  withoutComments,
} from "./module-halves.ts";

/** Modules that can start a process, under either specifier spelling. */
const PROCESS_STARTERS = ["child_process", "node:child_process", "node:worker_threads", "worker_threads"];

describe("the client half cannot shell out (#129 D9, narrowed by #288 C1)", () => {
  it("has sources to sweep", () => {
    // A sweep over an empty list passes and proves nothing. This is the guard
    // on the guard — and since the sweep is now a *subset* of the shipped
    // modules, it is also what catches a `MACHINE_MODULES` table that grew
    // until there was nothing left to check.
    expect(shippedSources().length).toBeGreaterThan(5);
    expect(clientSources().length).toBeGreaterThan(shippedSources().length / 2);
  });

  it("keeps the exemption honest: every machine module is real and named with a reason", () => {
    // Two ways an exemption list stops meaning anything, both closed here. A
    // row for a deleted file is a hole left open for whatever takes that name
    // next; a row with no reason is a name somebody added to make a test pass.
    const shipped = new Set(shippedSources().map((file) => path.relative(SRC, file)));
    for (const [name, why] of Object.entries(MACHINE_MODULES)) {
      expect(shipped.has(name), `${name} is exempt but is not a shipped module`).toBe(true);
      expect(why.length, `${name} is exempt with no reason given`).toBeGreaterThan(20);
    }
    // The dispatch and the entry are the spine both halves come through. An
    // exemption on either would be an exemption on everything.
    expect(MACHINE_MODULES["run-client.ts"]).toBeUndefined();
    expect(MACHINE_MODULES["entry.ts"]).toBeUndefined();
  });

  it("imports nothing that can start a process", () => {
    for (const file of clientSources()) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        expect(
          PROCESS_STARTERS,
          `${path.relative(SRC, file)} imports ${specifier} — a client that shells out to fetch its own credentials is not a CLI (#129 D9)`,
        ).not.toContain(specifier);
      }
    }
  });

  it("does not reach for the process-starting globals either", () => {
    // `process.binding`, and a dynamic `require("child_" + "process")`, are the
    // two ways around an import sweep that do not need a new import.
    for (const file of clientSources()) {
      const source = withoutComments(readFileSync(file, "utf8"));
      expect(source, `${path.relative(SRC, file)} calls process.binding`).not.toMatch(
        /process\s*\.\s*binding/,
      );
      expect(source, `${path.relative(SRC, file)} builds a require specifier`).not.toMatch(
        /require\s*\(\s*[^)"']*\+/,
      );
    }
  });

  it("keeps the machine half's subprocess in one module", () => {
    // The narrowing is only defensible while the exemption is narrow *in
    // practice* as well as on paper. One module in the machine half starts a
    // process — `actana-system.ts`, the port every operator verb runs
    // `systemctl` and `launchctl` through — and every other machine module
    // takes that port as an argument rather than reaching for one of its own.
    // A second name here means the port has stopped being a seam.
    const reaching = machineSources()
      .filter((file) =>
        importSpecifiers(readFileSync(file, "utf8")).some((s) => PROCESS_STARTERS.includes(s)),
      )
      .map((file) => path.relative(SRC, file));
    expect(reaching).toEqual([]);
  });
});

describe("the published CLI carries no daemon (#129 D8)", () => {
  it("carries no daemon: nothing here imports the Core package", () => {
    // `actana daemon` stays in `packages/core`. An import of it would put a Node
    // daemon, `better-sqlite3` and `node-pty` in the dependency graph of a
    // package whose entire job is to need none of them.
    //
    // Unchanged by #288, and passing it is the proof that ticket's move was
    // done right: the machine-side modules came here whole, so nothing is left
    // behind in `packages/core` for a module here to reach back for. A partial
    // move shows up as a `@actana/core` import in CI rather than in a
    // stranger's `npm install`. The `daemon` verb reaches the Core by *path* —
    // `<install root>/app/core-entry.cjs`, through `createRequire` — which
    // resolves nothing at build time and so puts nothing in this graph
    // (#288 D4).
    for (const file of shippedSources()) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        expect(
          specifier.startsWith("@actana/core"),
          `${path.relative(SRC, file)} imports ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it("does not resolve the daemon by name anywhere either", () => {
    // The import sweep above cannot see a `require("@actana/core/...")` built
    // at runtime, and the `daemon` verb is the one place in this package that
    // requires anything at all. What it requires is an absolute path it
    // computed from the install root, never a package specifier.
    for (const file of shippedSources()) {
      const source = withoutComments(readFileSync(file, "utf8"));
      expect(source, `${path.relative(SRC, file)} names @actana/core in code`).not.toMatch(
        /["'`]@actana\/core/,
      );
    }
  });
});

describe("the client CLI does not depend on Control's private packages", () => {
  it("imports nothing from @actana/shared", () => {
    for (const file of shippedSources()) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        expect(
          specifier.startsWith("@actana/shared"),
          `${path.relative(SRC, file)} imports ${specifier}`,
        ).toBe(false);
      }
    }
  });
});

describe("the dependency list stays short (#129 D8)", () => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(SRC, "..", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };

  it("declares only the SDK as a runtime dependency", () => {
    // The list is short because a CLI must not grow a server dependency, a
    // database driver or a native addon, and a new name here is the first sign
    // that one has arrived. That purpose is unchanged; the list is one longer.
    //
    // `ws` and `undici` are on it and neither is really this package's own:
    // they are the SDK's runtime dependencies, and they are declared *here* as
    // well because `build.mjs` marks them external — the bundle imports them by
    // name at runtime, so this package's own `node_modules` is where they have
    // to resolve from. Bundling either is not the alternative: undici reaches
    // for `require("node:assert")` down a path esbuild cannot see, so an
    // inlined copy throws `Dynamic require ... is not supported` the first time
    // `actana` runs.
    //
    // **`selfsigned` is new, and it is admitted deliberately (#288 C2).** The
    // CLI can now run `setup`, and `setup` mints this Core's certificate
    // material — a CA, a server cert and the Panel's client cert — which
    // reaches `selfsigned` through `@actana/shared/core-cert-material`. It is
    // none of the three things this list exists to keep out: it is a pure-JS
    // X.509 builder over Node's own WebCrypto, with no server, no database and
    // no native addon under it. It is external rather than inlined for the same
    // reason `ws` and `undici` are — the Core's own bundle has always treated
    // it that way, and the tarball already ships it in `app/node_modules`, so
    // inlining it here would put a second copy of a crypto library in a tree
    // that has one.
    //
    // **`better-sqlite3` and `node-pty` must still never appear.** They are the
    // daemon's, they are native, and a published client that installed either
    // would be a client that needs a compiler.
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@actana/sdk"]);
    expect(Object.keys(manifest.dependencies)).not.toContain("better-sqlite3");
    expect(Object.keys(manifest.dependencies)).not.toContain("node-pty");
  });

  it("keeps the SDK in the manifest", () => {
    expect(Object.keys(manifest.dependencies)).toContain("@actana/sdk");
  });
});

describe("the command is `actana` (#129 D8)", () => {
  it("is the bin name the package installs, whatever the package is called", () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(SRC, "..", "package.json"), "utf8"),
    ) as { name: string; bin: Record<string, string>; description: string };

    // #288 D6: the name stays. A rename costs every existing install and buys a
    // manifest field we can rewrite — so the field is what was rewritten.
    expect(manifest.name).toBe("@actana/cli");
    // And the description no longer calls this "the `actana` command's client
    // half", because that stopped being true the day #288 landed. There is one
    // half.
    expect(manifest.description.toLowerCase()).toContain("cli");
    // One binary name. Not `actana-cli`, not `ac`, and not a second command to
    // remember: `npm i -g @actana/cli` puts `actana` on the PATH the same way
    // `npm i -g npm` puts `npm` there.
    expect(Object.keys(manifest.bin)).toEqual(["actana"]);
    expect(manifest.bin.actana).toBe("bin/actana.mjs");
  });
});
