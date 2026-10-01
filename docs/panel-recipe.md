# Doing what the Panel does, with the public SDK

The Panel may use only the public SDK, so anyone else (a Studio, a script, a bot) can do the same. This page is the recipe, in four steps, and `examples/panel-recipe/` is a runnable script that does each one. Every call below is an export of `@actana/sdk/*`; nothing is imported from the CLI, the Panel or a private path.

| Step | What the Panel does | SDK calls the recipe uses | Script command |
| --- | --- | --- | --- |
| 1. Pair a Core | pairs a Core, keeps its registration blob | `pairWithCore`, `encodeRegistrationBlob`, `decodeRegistrationBlob` (`@actana/sdk/pairing`) | `recipe.mjs pair` |
| 2. Attach its Shared folder with a key issuer | issues each Core a 1-hour key for its own folder and pushes it, then reads the folder in S3 | `createSeaweedfsKeyIssuer`, `createSharedKeyProvider`, `publicJwks` (`/shared-key`); `createS3CoreShared` (`/shared`); `CoreClient.request` with the `sharedAttach`, `sharedCredentials`, `sharedDetach` frames (`/core`) | `recipe.mjs attach` |
| 3. Start a Session and watch its report | starts a Session, learns it finished from its report file | `CoreClient`, `CoreSession.start` (`/core`); `CoreShared.watch`, `.get` (`/shared`) | `recipe.mjs session "<prompt>"` |
| 4. Dispatch a Task and turn its result files into status | starts a Session for the Task, turns `success.md`, `fail.md`, `partial-<n>.md` into a comment and a status | the same, plus `CoreShared.list`, `.move`, `.put` | `recipe.mjs task --task-id … --task-title …` |

`recipe.mjs all` runs 1 to 4 in order (step 1 only when no registration blob is set).

## Before you start

- **A Core** you can pair with. For step 2 it must also answer `sharedAttach`, `sharedCredentials` and `sharedDetach`, which **no real Core does yet** (see the box below). The script refuses a Core that does not announce the `shared` capability on `ready`; announcing it is not the same as answering the frames.

> **Status of the Core side (read this first).** No real Core answers `sharedAttach`, `sharedCredentials` or `sharedDetach` today. The Core side of step 2 is actana/control#562, which is open and not built. A real Core on control `feat/0.5.0` announces `shared` on `ready` as `{ version: 1, backend: "local" }` (control #561) and has no handler for the three frames: it answers them with an `error` frame. Against it, the capability gate in step 2 passes, `sharedAttach` is refused (exit 4), and steps 3 and 4, which read the folder in S3, would wait out their timeouts because nothing syncs a Core's files there. Steps 2 to 4 therefore cannot complete against a real Core until #562 lands. Step 1 (pairing) does not depend on it.
- **An S3 store with a per-Core policy.** The recipe uses SeaweedFS, the SDK's default, set up as in actana/control `deploy/seaweedfs`: STS enabled, an OIDC provider that trusts your controller's JWKS, and a role limiting a Core to `<prefix>/<core-id>/`. The other issuers (`createStsKeyIssuer`, `createR2KeyIssuer`, `createSupabaseKeyIssuer`, see [shared-key-issuers.md](./shared-key-issuers.md)) drop into the same place in `src/attach.mjs`.
- **The controller's signing key**, an RSA private key in PEM. It is the master key: the issuer signs a short token with it, SeaweedFS swaps the token for a Core's key, and it is never sent to a Core.
- Node 24, and `pnpm install` in this repository.

Every endpoint, credential and path is an argument or an environment variable; nothing is read from the repository. `node examples/panel-recipe/recipe.mjs --help` lists them all, and [the example's README](../examples/panel-recipe/README.md) has the table.

## Step 1: pair a Core

On the Core, an operator runs `actana pair new` and reads out three things: a pairing code, the Core's CA fingerprint, and the session the code belongs to.

```sh
ACTANA_CORE_ADDRESS=core.example.net:8765 \
ACTANA_PAIRING_CODE=<session>:<code> \
ACTANA_CA_FINGERPRINT=<sha256 fingerprint> \
ACTANA_BLOB_OUT=./core.blob \
  node examples/panel-recipe/recipe.mjs pair
```

`pairWithCore` checks the fingerprint **before** the code leaves the machine. A missing or wrong fingerprint is refused (`fingerprint-unconfirmed`, `fingerprint-mismatch`) and nothing is sent. The result is a registration blob (the Core's endpoint plus the mTLS material and a signed bearer). The script writes it to a file readable by its owner only (mode 0600) and never prints it. Treat it like a private key.

## Step 2: attach the Shared folder with a key issuer

```sh
ACTANA_CORE_BLOB=./core.blob \
SEAWEEDFS_ENDPOINT=http://s3.example.net:8333 \
SEAWEEDFS_OIDC_ISSUER=https://controller.example.net \
SEAWEEDFS_OIDC_AUDIENCE=actana-shared \
SEAWEEDFS_SIGNING_KEY_FILE=./controller-signing.pem \
SEAWEEDFS_KEY_ID=controller-key \
SEAWEEDFS_BUCKET=actana-shared \
SEAWEEDFS_PREFIX=cores \
  node examples/panel-recipe/recipe.mjs attach
```

1. `client.connect()` returns the Core's id and whether it announces `shared`.
2. `createSharedKeyProvider({ issuer, coreId })` issues a key for that id: `{ accessKeyId, secretAccessKey, sessionToken, expiresAt }`, valid for one hour and limited to `<prefix>/<core-id>/`.
3. `client.request({ type: "sharedAttach", … })` sends the Core the endpoint, bucket, prefix (`cores/<core-id>/`), region and that key. The Core answers one `sharedStatus`: `attached`, or `error` with a code (`mount-failed`, `already-attached`, …). The script turns an error into exit code 4 with the code in the message, never the key.
4. `createS3CoreShared({ credentials: provider, … })` is the controller's own view of the same folder, in S3. It works while the Core is paused or offline.
5. **Refresh.** `--keep-fresh` stays running and, 15 minutes before the key expires, takes a new one from the provider and sends it with `sharedCredentials`. `sharedDetach` (`keepLocalCopy: true`) unmounts.

The SeaweedFS gateway must be able to fetch the controller's JWKS (`publicJwks(signingKey, keyId)` served at `<OIDC issuer>/jwks.json`). A real controller serves it from its own origin; for a one-machine run, `SEAWEEDFS_JWKS_PORT=<port>` makes the script serve it on `127.0.0.1` for as long as it runs.

## Step 3: start a Session and watch its report

```sh
… node examples/panel-recipe/recipe.mjs session "summarise this repo"
```

`CoreSession.start` creates the Session and types the prompt in. **The Core appends the standard block to a starting prompt itself** (control PR 621), naming this Session's own report file, so the recipe sends the bare prompt. The harness writes `~/shared/sessions/<session-id>/report-1.md`, and the Core's Shared folder syncs to S3 within seconds.

The wait is the report contract's (client PR 41, [report-contract.md](./report-contract.md)): take a Shared cursor **before** the Session starts, look at the file, and if it is not finished `watch(cursor)` until that path changes, then look again. Nothing reads the screen, nothing runs a command on the Core, and a report that landed before the first look still settles it. A report is finished when its last non-blank line is exactly `ACT-REPORT-END`. The script prints one JSON line: `{"step":"session","sessionId":…,"reportPath":…,"report":…}`.

If the harness exits and no finished report appears within `ACTANA_EXIT_GRACE_MS` (default 30 s: the folder reaches S3 a few seconds after the Core writes it), the script exits 5. If nothing arrives within `ACTANA_TIMEOUT_MS`, it exits 3.

## Step 4: dispatch a Task and turn its result files into status

```sh
… node examples/panel-recipe/recipe.mjs task --task-id T-42 --task-title "Fix the flaky test" \
    --task-description "It fails one run in ten."
```

This is the Panel's dispatcher and result watcher (control PR 629), minus the database:

1. Note the **dispatch time**. Only a result file newer than it counts.
2. On a re-run (`--attempt 2`), rename the older results to `attempt-<n>-<name>` (`CoreShared.move`), so this attempt starts with none.
3. Start a Session whose prompt is the Task, its comments and the result instructions: write `~/shared/tasks/<id>/success.md`, `fail.md` or `partial-<n>.md`, last line `ACT-REPORT-END`. The prompt carries **no** standard block: the Core adds its own, and leaves a prompt that already has one alone.
4. Watch `tasks/<id>/`. A finished file becomes one comment (the report without its end marker, filed under `attempt-<n>-<name>`) and one status: `success.md` → `done`, `fail.md` → `failed`, `partial-<n>.md` → `partial`. A file still being written is read again when it changes.
5. An agent that exits with no result, or a Task that runs out of time, gets a `fail.md` written by the dispatcher, and fails through the same path.

The script prints `{"step":"task","taskId":…,"status":…,"resultFile":…,"sourceFile":…,"comment":…}`. Where the Panel stores the status and the comment in its database, you store them wherever your product keeps Tasks.

## What the SDK does not export (yet)

The recipe uses only exports. Two things the Panel and the CLI share are **not** exported, so the example carries copies, pinned by a test:

- **The report contract's paths and block text** (`session-report.ts` in `@actana/cli`: `sessionReportPath`, `taskResultPath`, `classifyTaskEntry`, `reportIsComplete`, `buildPromptBlock`, …). They are copied into `examples/panel-recipe/src/report-contract.mjs`, as the Panel did into its `shared/task-report.ts`. `report-contract.test.mjs` pins every string and reads the CLI's source as text to catch a drift.
- **A `SharedChangedEventSource` over a `CoreClient`** (the through-the-Core `watch`, `sharedChangedEvents` in the CLI). The recipe does not need it, because it reads the folder in S3; a controller with no S3 would.

There is also no single call for "attach": the recipe sends the three frames with `CoreClient.request`. Moving any of these into the SDK is an API change and is out of scope for this recipe.

## What was run against what

See the pull request that added this page for the run, step by step. In short: the SeaweedFS-backed parts run in CI against the pinned SeaweedFS (`shared-key-seaweedfs`); everything that needs a Core runs against a fake Core in a test (`examples/panel-recipe/__tests__/fake-core.mjs`). No test here runs a real Core.

**Nothing here can yet be run end to end against a real Core.** The fake Core announces `{ version: 1 }` and answers `sharedAttach` with `attached`, which follows the SDK's frame definitions and is ahead of any real Core: the real Core's side is actana/control#562, not built, and it announces `{ version: 1, backend: "local" }` and refuses the frames. The issue's Done when (the example runs end to end against a real Core and SeaweedFS) is waiting on #562, not only on someone having a Core at hand.
