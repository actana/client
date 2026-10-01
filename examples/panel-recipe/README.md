# Panel recipe: a runnable reference example

What the Panel does with a Core, using only the public `@actana/sdk` packages, as a small Node script. The walk-through, with the reasoning for each step, is [docs/panel-recipe.md](../../docs/panel-recipe.md).

```
recipe.mjs            the command line: pair | attach | session | task | all
src/pair.mjs          step 1   pair a Core
src/attach.mjs        step 2   attach its Shared folder with a key issuer
src/session.mjs       step 3   start a Session and watch its report
src/task.mjs          step 4   dispatch a Task and turn its result files into status
src/report-contract.mjs   client PR 41's report paths and prompt block (copied; pinned by a test)
__tests__/            the tests, a fake Core and an in-memory Shared folder
```

## Run it

From the repository root, after `pnpm install` (Node 24):

```sh
node examples/panel-recipe/recipe.mjs --help
node examples/panel-recipe/recipe.mjs pair       # step 1
node examples/panel-recipe/recipe.mjs attach     # step 2
node examples/panel-recipe/recipe.mjs session "summarise this repo"   # step 3
node examples/panel-recipe/recipe.mjs task --task-id T-42 --task-title "Fix the flaky test"   # step 4
node examples/panel-recipe/recipe.mjs all "summarise this repo" --task-id T-42 --task-title "Fix the flaky test"
```

Progress goes to stderr; each step prints one JSON line on stdout. A failure prints `recipe: <Name>: <reason>` on stderr and exits non-zero:

| Exit | Meaning |
| --- | --- |
| 0 | done |
| 1 | any other failure |
| 2 | a missing or malformed setting (the message names the variable, never a value) |
| 3 | no report within `ACTANA_TIMEOUT_MS` |
| 4 | refused: pairing, the Core's `sharedStatus`, the key issuer, or the store |
| 5 | the harness exited and left no report |

## Settings

Every endpoint, credential and path is an argument or an environment variable (the argument wins). Nothing is hard-coded and nothing is read from this repository.

| Variable | Argument | Used by | What it is |
| --- | --- | --- | --- |
| `ACTANA_CORE_ADDRESS` | `--address` | pair | the Core, `host:port` |
| `ACTANA_PAIRING_CODE` | `--code` | pair | `<session>:<code>` from `actana pair new` on the Core |
| `ACTANA_CA_FINGERPRINT` | `--fingerprint` | pair | the Core's CA fingerprint, read out by the operator |
| `ACTANA_BLOB_OUT` | `--out` | pair | where to write the registration blob (mode 0600) |
| `ACTANA_CORE_BLOB` | `--blob` | attach, session, task | the registration blob, or a path to the file holding it |
| `SEAWEEDFS_ENDPOINT` | `--s3-endpoint` | attach, session, task | the S3 gateway the controller reaches (also serves STS) |
| `SEAWEEDFS_CORE_ENDPOINT` | `--core-s3-endpoint` | attach | the same gateway as the Core reaches it (default: `SEAWEEDFS_ENDPOINT`) |
| `SEAWEEDFS_OIDC_ISSUER` | `--oidc-issuer` | attach, session, task | must equal SeaweedFS's configured OIDC issuer |
| `SEAWEEDFS_OIDC_AUDIENCE` | `--oidc-audience` | attach, session, task | must equal SeaweedFS's configured audience |
| `SEAWEEDFS_SIGNING_KEY_FILE` | `--signing-key-file` | attach, session, task | the controller's RSA private key (PEM): the master key |
| `SEAWEEDFS_KEY_ID` | `--key-id` | attach, session, task | the `kid` its public key has in the JWKS |
| `SEAWEEDFS_BUCKET` | `--bucket` | attach, session, task | the bucket the Shared folders live in |
| `SEAWEEDFS_PREFIX` | `--prefix` | attach, session, task | the folder of Cores; a Core gets `<prefix>/<core-id>/` |
| `SEAWEEDFS_REGION` | `--region` | attach | the region sent to the Core (default `us-east-1`) |
| `SEAWEEDFS_JWKS_PORT` | `--jwks-port` | attach, session, task | serve the controller's JWKS on `127.0.0.1:<port>` while running (optional) |
| `ACTANA_HARNESS` | `--harness` | session, task | the harness to run (default `claude-code`) |
| `ACTANA_SKIP_PERMISSIONS` | `--skip-permissions` | session, task | `1` starts the harness with permission prompts off |
| `ACTANA_TIMEOUT_MS` | `--timeout-ms` | session, task | how long to wait for the report (default 300000 for a Session, 3600000 for a Task) |
| `ACTANA_POLL_MS` | `--poll-ms` | session, task | how often to look at the Shared folder (default 2000) |
| `ACTANA_EXIT_GRACE_MS` | `--exit-grace-ms` | session, task | how long to keep looking after the harness exits (default 30000) |

Keep the blob and the signing key out of the repository. The script never prints either, nor a key it issues.

## Test it

```sh
CI=1 NODE_OPTIONS=--max-old-space-size=2048 pnpm exec vitest run examples/panel-recipe/__tests__/recipe.test.mjs --maxWorkers=1
```

One file at a time; the others are `session`, `task`, `attach`, `report-contract` and `seaweedfs` under `__tests__/`. Everything that needs a Core runs against `__tests__/fake-core.mjs`, a hand-written core-link peer, so the tests say nothing about a real Core. `seaweedfs.test.mjs` runs the S3-backed steps against a real SeaweedFS and is skipped unless `SEAWEEDFS_ENDPOINT` is set (CI job `shared-key-seaweedfs` sets it and fails the job if the file is skipped).
