# Releases (T-220)

`@actana/sdk` and `@actana/cli` version and publish independently via [Changesets](https://github.com/changesets/changesets).

## Day to day

1. Change code under `packages/`.
2. Add a changeset: `pnpm changeset` (or author a file under `.changeset/`).
3. Open a PR — CI runs the full workspace (`ci.yml`) and `changeset-required.yml` checks for a changeset when `packages/` changed.
4. Merge to `main` — `release.yml` opens or updates a **Version packages** PR, then publishes when that PR merges.

A CLI-only changeset bumps only `@actana/cli`. `@actana/sdk` is unchanged until it has its own changeset.

```bash
# Local dry-run of independent CLI versioning (no npm publish):
node scripts/assert-cli-only-changeset.mjs
```

## npm publish

- **Workflow:** `.github/workflows/release.yml` — `changeset publish` ships only packages whose version changed in the Version PR.
- **Provenance:** `publishConfig.provenance: true` on both packages; the workflow grants `id-token: write` for OIDC attestations.
- **Publish rights:** Scoped to **`actana/client`** only. Store `NPM_TOKEN` on this repository — an npm automation token with Read and Write on `@actana/*`, trusted to `github.com/actana/client`. Do not reuse Control's token; freeze Control's publish path before cutting `0.5.0` (see `docs/ops-publish-freeze.md`).

```bash
gh secret set NPM_TOKEN --repo actana/client
```
