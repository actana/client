# @actana/cli

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
