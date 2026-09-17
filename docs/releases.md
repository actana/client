# Releases (T-220, T-222)

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

## 0.5.0 client cut (T-222)

Both packages are already **`0.5.0`** in `package.json` (jump from Control's `0.4.5`). Changelog entries live in `packages/*/CHANGELOG.md`. **Do not run `pnpm changeset version`** for this cut — it would bump past `0.5.0`.

Live npm still serves **`0.4.5`** until a human publishes from `actana/client` (see `docs/ops-publish-freeze.md`).

### Pack and smoke locally

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
CI=true node scripts/pack-0.5.0.mjs
CI=true node scripts/smoke-pack-0.5.0.mjs
```

`pack-0.5.0.mjs` builds both packages and writes gitignored tarballs under `.pack/`:

- `.pack/actana-sdk-0.5.0.tgz`
- `.pack/actana-cli-0.5.0.tgz`

Dry-run publish (no npm auth):

```bash
npm publish --dry-run .pack/actana-sdk-0.5.0.tgz
npm publish --dry-run .pack/actana-cli-0.5.0.tgz
```

### Phase 3 consumption (no registry)

Until `@actana/sdk@0.5.0` and `@actana/cli@0.5.0` are on npm, Search (phase 3) can install both tarballs together (CLI depends on `@actana/sdk@0.5.0`, which is not on the registry yet):

```bash
node scripts/pack-0.5.0.mjs
cd /path/to/search-repo
npm install /path/to/actana-client/.pack/actana-sdk-0.5.0.tgz /path/to/actana-client/.pack/actana-cli-0.5.0.tgz
```

Or pin `file:` paths in `package.json`:

```json
{
  "dependencies": {
    "@actana/sdk": "file:../actana-client/.pack/actana-sdk-0.5.0.tgz",
    "@actana/cli": "file:../actana-client/.pack/actana-cli-0.5.0.tgz"
  }
}
```

When using `file:` entries, install **both** tarballs in one command so npm resolves `@actana/sdk@0.5.0` locally instead of hitting the registry.

Regenerate tarballs after client changes:

```bash
node scripts/pack-0.5.0.mjs
```

## npm publish

- **Workflow:** `.github/workflows/release.yml` — `changeset publish` ships only packages whose version changed in the Version PR.
- **Provenance:** `publishConfig.provenance: true` on both packages; the workflow grants `id-token: write` for OIDC attestations.
- **Publish rights:** Scoped to **`actana/client`** only. Store `NPM_TOKEN` on this repository — an npm automation token with Read and Write on `@actana/*`, trusted to `github.com/actana/client`. Do not reuse Control's token; freeze Control's publish path before cutting `0.5.0` (see `docs/ops-publish-freeze.md`).

```bash
gh secret set NPM_TOKEN --repo actana/client
```
