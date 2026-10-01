# @actana/cli

## 0.6.0-next.1

### Minor Changes

- 134d113: Remove Projects from the core-link protocol and the CLI (actana/client#10 part 3, ADR 0041 D1–D2). Drop `projectsList` / `projectsMutate` and every `project:*` event, drop `projectId` on session rows and spawn, drop `cwd` on harness spawn. `CORE_LINK_PROTOCOL_VERSION` stays at 0.19.0: that minor already covers the Shared-folder frames (client#4 / PR 33); no published SDK carries 0.19.0, so both wire changes share it. Delete the `actana project` command and every project argument; `session start` takes a Core, a harness and a prompt only. `session ls` never dials a project frame. File transfer left the CLI with Projects (no `project cp`); part 4 lands `actana files`. A bare `actana session start web "…"` now treats `web` as the start of the prompt. Hard cut below 1.0, so the bump is minor (not major). The Files HTTPS URL stays for part 4.

### Patch Changes

- Updated dependencies [134d113]
- Updated dependencies [134d113]
- Updated dependencies [134d113]
  - @actana/sdk@0.6.0-next.1

## 0.6.0-next.0

### Minor Changes

- ad92934: Rename Task to Session across the CLI: `session start|resume|logs|send|kill --json` print `sessionId` and no longer carry `taskId`, `actana events` labels a session's events `session=<id>` and filters on the `session:*` kinds, and the CLI calls the renamed SDK (`sessionRowsList`, `archivedSessionRowsList`, `findBySession`). This is a hard cut with no `taskId` alias, so scripts that read `.taskId` from `--json` must read `.sessionId`; the CLI now speaks core-link 0.18.0 and refuses a 0.17 Core at the version gate.

### Patch Changes

- Updated dependencies [ad92934]
- Updated dependencies [ad92934]
- Updated dependencies [ad92934]
- Updated dependencies [ad92934]
  - @actana/sdk@0.6.0-next.0

## 0.5.0

### Minor Changes

First release from [`actana/client`](https://github.com/actana/client) at **0.5.0**, continuing from Control's `@actana/cli@0.4.5`.

- Packable `dist/` build with `prepack`, `publishConfig.exports`, and `bin/actana.mjs` wired to compiled entry.
- `runClient` dispatcher with general help and version; Core nouns (`core`, `project`, `harness`, `events`, `session`) and Search nouns (`search`).
- Product-keyed credential registry under `~/.config/actana` with one-release migration from `~/.actana-search/cli.json` (T-216).
