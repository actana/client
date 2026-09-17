# T-221 — Freeze Control's npm publish

**Task:** [T-221](tasks/T-221.html) · modular-split phase 2, wave 1  
**Status:** **Runbook complete — freeze NOT executed** (no org/npm/GitHub settings were changed in this task)  
**Date drafted:** 2026-09-17

## Goal

Make `actana/control` unable to publish `@actana/sdk` and `@actana/cli` to registry.npmjs.org, so `actana/client` becomes the sole publisher before T-222 (`0.5.0`).

This is an **ops switch** — no edits to the Control tree are required or performed here.

---

## 1. What publishes today (verified by read-only inspection)

### Summary

| Workflow | Job ID | Job display name | Publishes to npm? | Condition / trigger |
|----------|--------|------------------|-------------------|---------------------|
| `.github/workflows/release.yml` | `npm` | **npm publish** | **Yes** — `@actana/sdk`, `@actana/cli` | `workflow_dispatch` with input `tag` (e.g. `v0.4.5`). Also dispatched by `promote.yml` after a promotion. Job runs only after `resolve`, both tarball legs, `installer-e2e`, `panel`, and `core` succeed. |
| `.github/workflows/beta-release.yml` | — | — | **No** | Explicitly does not publish to npm (ADR 0036 D15). CLI is a GitHub Release asset only. |
| `.github/workflows/promote.yml` | — | — | **No** (checks only) | `resolve` step *The credentials release.yml refuses without* requires `NPM_TOKEN` to be **set** (non-empty) before dispatching `release.yml`; it does not call `npm publish`. |
| `.github/workflows/ci.yml` | — | — | **No** | Rehearses packing in tests only. |
| All other workflows | — | — | **No** | No `npm publish` or `NPM_TOKEN` usage found outside `release.yml` / `promote.yml`. |

**Only one job writes to npm:** `release.yml` → job `npm`.

### `release.yml` → job `npm` (detail)

- **Trigger:** `on.workflow_dispatch` with required input `tag` (semver tag like `v0.4.5`). No tag-push trigger.
- **Entry path:** Manual dispatch, or `promote.yml` dispatching `release.yml` at the version tag after promotion.
- **Upstream `needs`:** `resolve`, `tarball`, `tarball-macos`, `installer-e2e`, `panel`, `core`.
- **Downstream:** `github-release` **also** `needs: npm` — if `npm` fails, GitHub Release assets are not attached automatically.
- **Packages published (in order):** `@actana/sdk`, then `@actana/cli` (from `scripts/lib/npm-packages.mjs` → `PUBLISHABLE` and `publishOrder()`).
- **Version:** Same as the git tag (`v0.4.5` → `0.4.5`).
- **Dist-tag:** From `resolve` → `scripts/release-tags.mjs` (`npm_tag`, typically `latest` or `next` per ADR 0023 D28).
- **Auth:** `secrets.NPM_TOKEN` → `NODE_AUTH_TOKEN` (via `actions/setup-node` + `registry-url: https://registry.npmjs.org`).
- **Early gate:** `resolve` step *Require an npm token* fails the **entire workflow** if `NPM_TOKEN` is unset or empty (before tarballs or images build).
- **Provenance (OIDC):**
  - Job `permissions.id-token: write`
  - `npm publish "$tarball" --provenance --access public --tag "$NPM_TAG"`
  - Post-publish step *Every published package is attested* reads `dist.attestations.provenance.predicateType` from the registry.
- **Re-run behaviour:** If a version already exists on npm, publish is skipped (notice) and attestation is still verified.

### `beta-release.yml` (does not publish)

- Packs `@actana/cli` with `scripts/rehearse-npm-publish.mjs --beta` and attaches `actana-cli-x.y.z-beta.tgz` to the prerelease GitHub Release.
- **No** `NPM_TOKEN`, **no** `npm publish`, **no** `id-token: write` for provenance.
- Documented in workflow header and ADR 0036 D15/D16.

### Secrets and variables involved

| Name | Kind | Repo | Used for npm publish? |
|------|------|------|------------------------|
| `NPM_TOKEN` | Secret | `actana/control` | Yes — `release.yml` `npm` job |
| `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` | Secrets | `actana/control` | No (images only) |
| `APP_ID` / `APP_PRIVATE_KEY` | Secrets | `actana/control` | No (promotion / beta tags) |
| `DOCKERHUB_NAMESPACE` | Variable | `actana/control` | No |

Documented in `actana-control/docs/REPO_SETUP.md` §2 (`NPM_TOKEN — the second registry`).

---

## 2. npm scope ownership (discovered 2026-09-17)

Commands run from this environment (not logged in to npm; `npm whoami` → `ENEEDAUTH`):

```text
$ npm owner ls @actana/sdk
actana <info+actana@qcentic.com>

$ npm owner ls @actana/cli
actana <info+actana@qcentic.com>

$ npm access list packages @actana
@actana/cli: read-write
@actana/sdk: read-write

$ npm access list collaborators @actana/sdk
actana: read-write

$ npm access list collaborators @actana/cli
actana: read-write
```

**Current registry versions (public):** `@actana/sdk@0.4.5`, `@actana/cli@0.4.5`.

**Who can execute the freeze:** A person with **Owner** on the `@actana` npm scope (the `actana` npm user / `info+actana@qcentic.com` account) to revoke automation tokens, plus **admin** on `actana/control` to manage GitHub secrets/variables.

---

## 3. Freeze runbook (for a human with org rights)

### Status legend

- **Runbook complete** — this document.
- **Freeze executed** — only after someone runs the steps below and verifies Control cannot publish.

### Recommended approach: revoke at npm (keeps Core release path mostly working)

**Why not delete `NPM_TOKEN` from GitHub?**  
`release.yml` `resolve` and `promote.yml` both require `NPM_TOKEN` to be **non-empty**. Removing the secret blocks promotions and releases at `resolve` — **before** tarballs or Docker images build.

**Why revoke at npm instead?**  
The GitHub secret stays set (satisfies pre-checks). Tarballs and Panel/Core images still build and push. Only the `npm` job fails at `npm publish` (401/403).

**Trade-off (current workflow, no Control edit):**  
`github-release` `needs: npm`. If `npm` fails, **GitHub Release assets are not attached automatically** even though tarballs exist as artifacts and images are on Docker Hub. See §3.4 for recovery.

#### Step A — Revoke Control's npm automation token (primary freeze)

1. Sign in to [npmjs.com](https://www.npmjs.com/) as a user with **Owner** on `@actana` (`actana` / `info+actana@qcentic.com`).
2. Open **Access Tokens** and find the automation/granular token used for CI (the one whose value is stored as `NPM_TOKEN` on `actana/control`). If unsure, check token creation notes or rotate: create a **new** read-only or scoped token for any remaining read needs, and **revoke** the publish token.
3. **Revoke** (or delete) the publish-capable token. Do **not** remove `NPM_TOKEN` from GitHub yet unless you intend to block all releases (see Step B).

**Verify freeze:**

```bash
# Should fail with 401/403 (token revoked or read-only)
NPM_TOKEN='<value from gh secret, if you can read it>' \
  npm publish --dry-run /dev/null 2>&1 || true

# Or trigger a harmless check: from a machine with the old token, npm whoami && npm publish should fail.
```

Optional GitHub-side confirmation (does not prove npm rejects publish):

```bash
gh secret list --repo actana/control | grep NPM_TOKEN
# NPM_TOKEN should still appear if you followed the recommended path
```

**Prove Control cannot write to npm:** Dispatch `release.yml` on a test tag **only if** you accept a partial release (images out, npm red, GitHub Release blocked) — or wait for the next real promotion and confirm `npm` job fails with auth error and no new version appears on:

```bash
npm view @actana/sdk version
npm view @actana/cli version
```

#### Step B — Delete or empty `NPM_TOKEN` on GitHub (hard stop — blocks entire release)

Use only if you want **no** `release.yml` or `promote.yml` run to proceed at all:

```bash
gh secret delete NPM_TOKEN --repo actana/control
```

**Effect:** `release.yml` `resolve` → *Require an npm token* fails immediately. **No** tarballs, **no** images, **no** npm, **no** GitHub Release.  
`promote.yml` → *The credentials release.yml refuses without* fails before dispatching `release.yml`.

**Not recommended** while Control must still ship Core tarballs and container images.

#### Step C — Optional hardening: repository variable gate (requires a future Control PR)

The current workflows have **no** `vars.*` gate on the `npm` job. To skip npm while letting `github-release` proceed **without** revoking tokens, a follow-up Control change would add something like:

```yaml
# Illustrative only — NOT in the repo today
if: vars.PUBLISH_NPM_FROM_CONTROL != 'false'
```

on job `npm`, and set:

```bash
gh variable set PUBLISH_NPM_FROM_CONTROL --repo actana/control --body "false"
```

That is **out of scope for T-221** (Control is read-only here) but is the clean long-term switch if Control must keep cutting Core releases after client owns npm.

### 3.4 Keeping Core tarball and container releases intact

With **Step A (recommended)**:

| Artifact | Still published? | Notes |
|----------|------------------|-------|
| Core tarballs (linux-x64, linux-arm64, mac-arm64) | **Yes** | Built in `tarball` / `tarball-macos` before `npm` |
| Panel / Core Docker images | **Yes** | `panel` / `core` jobs complete before `npm` |
| `@actana/sdk` / `@actana/cli` on npm | **No** | `npm publish` fails (token revoked) |
| GitHub Release (tarballs + SHA256SUMS) | **No** (automatic) | `github-release` waits on `npm` |

**Manual GitHub Release recovery** (if images and tarballs are out but `npm` failed):

1. Download the three `core-tarball-*` artifacts from the failed/succeeded run.
2. Compose checksums: `node scripts/compose-core-shasums.mjs --dir <dir> --expect 3` (from the release tag checkout).
3. Attach assets:

```bash
gh release create vX.Y.Z <tarballs> SHA256SUMS \
  --repo actana/control \
  --title vX.Y.Z \
  --latest=true   # or false per release policy
```

Or re-dispatch `release.yml` after client owns npm and Control's npm job is gated/skipped.

**Beta cuts:** Unaffected — `beta-release.yml` never publishes to npm.

### 3.5 Hand off publish rights to `actana/client` (after freeze, for T-222)

1. Create a **new** npm automation token (Read and Write on `@actana/*`) for `actana/client` CI.
2. Store it on the client repo:

```bash
gh secret set NPM_TOKEN --repo actana/client
```

3. Ensure the client release workflow uses `id-token: write` and `npm publish --provenance` (mirror Control's `npm` job pattern).
4. Do **not** restore Control's old publish token.

---

## 4. Verification checklist

| Check | Runbook only | After freeze executed |
|-------|--------------|------------------------|
| Documented publish path | ✅ | — |
| `npm owner ls` recorded | ✅ (`actana`) | — |
| Control automation token cannot publish | — | Revoke token; confirm 401/403 on publish |
| No new versions from Control | — | `npm view @actana/sdk version` unchanged after a Control release attempt |
| Core images still push | — | Docker Hub tags update on release |
| `promote.yml` still dispatches (if token left in GitHub) | — | Promotion reaches `release.yml` |
| Client repo ready to publish `0.5.0` | — | T-222 (separate task) |

---

## 5. What this task did and did not do

**Done (implementer, read-only):**

- Inspected `release.yml`, `beta-release.yml`, `promote.yml`, and repo-wide npm publish references.
- Recorded job IDs, conditions, packages, OIDC/provenance, and secret names.
- Queried public npm metadata (`owner`, `access`, current versions).
- Wrote this runbook at `planning/modular-split/ops-publish-freeze.md`.

**Not done (requires human with org rights):**

- Revoke or rotate npm automation tokens.
- Change `actana/control` GitHub secrets or variables.
- Prove "a Control release can no longer write to npm" in production.
- Copy to `actana-client/docs/ops-publish-freeze.md` — **`actana/client` workspace does not exist yet** on this machine.

**Explicit:** **Freeze executed = false.** Execute §3 before T-222.

---

## References

- `actana-control/.github/workflows/release.yml` — job `npm` (lines ~748–954)
- `actana-control/.github/workflows/beta-release.yml` — no npm publish
- `actana-control/.github/workflows/promote.yml` — `NPM_TOKEN` presence check (~628–641)
- `actana-control/docs/REPO_SETUP.md` — §2 `NPM_TOKEN`
- `actana-control/scripts/lib/npm-packages.mjs` — `PUBLISHABLE = ["@actana/sdk", "@actana/cli"]`
- `planning/modular-split/tasks/T-221.html`, `T-222.html`
