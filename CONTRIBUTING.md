# Contributing to actana/client

Thank you for helping keep the shared client layer aligned with Control while
pairing still lifts from [actana/control](https://github.com/actana/control).

## Weekly port rule (phases 2–4)

Until phase 4 retires the lift (see modular-split plan task T-406), **Control
stays the source of truth for pairing**. The rule is simple:

- Any pairing-related change that lands on Control's `main` must be **ported
  into this repository within the same calendar week**.
- After porting, update `origins-manifest.json` with the new Control commit and
  content hashes for every affected lifted file.
- Do not edit lifted files here without either matching Control or recording the
  intentional divergence in the manifest.

A scheduled workflow (`.github/workflows/drift-check.yml`) compares Control
`main` against the hashes recorded in `origins-manifest.json`. When they
differ, it opens an issue here listing the drifted Control paths and their
client destinations. That job **reads Control only** — it never writes to it.

To run the check locally:

```bash
node scripts/check-control-drift.mjs
```

Use `--control-root /path/to/control/checkout` when you already have Control
cloned, or `--dry-run-issue` to preview the GitHub issue body without filing
one.

## Development

- Node **24** (see `engines` in `package.json`).
- `pnpm install`, then `pnpm typecheck`, `pnpm lint`, and `pnpm test`.
