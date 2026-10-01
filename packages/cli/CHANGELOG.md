# @actana/cli

## 0.5.0

### Minor Changes

First release from [`actana/client`](https://github.com/actana/client) at **0.5.0**, continuing from Control's `@actana/cli@0.4.5`.

- Packable `dist/` build with `prepack`, `publishConfig.exports`, and `bin/actana.mjs` wired to compiled entry.
- `runClient` dispatcher with general help and version; Core nouns (`core`, `project`, `harness`, `events`, `session`) and Search nouns (`search`).
- Product-keyed credential registry under `~/.config/actana` with one-release migration from `~/.actana-search/cli.json` (T-216).
