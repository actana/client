# Shared-folder key issuers

Controller-side issuers in `@actana/sdk/shared-key` (Node-only). Each holds the
**master key** on the controller and issues a Core a **1-hour** key limited to
`<prefix>/<core-id>/`. Keys are refreshed **15 minutes** early (at most half the
key's life) via `createSharedKeyProvider`.

| Issuer | Factory | Master material | How the Core is limited |
| --- | --- | --- | --- |
| SeaweedFS (default) | `createSeaweedfsKeyIssuer` | RSA signing key | OIDC token `sub` = core id; role policy in control's SeaweedFS IAM |
| Generic STS | `createStsKeyIssuer` | IAM access key + secret | `AssumeRole` + inline session policy for the Core prefix (SigV4, no AWS SDK) |
| Cloudflare R2 | `createR2KeyIssuer` | Cloudflare API token | Temporary credentials with `prefixes: [<prefix>/<core-id>/]` |
| Supabase | `createSupabaseKeyIssuer` | Service-role key + JWT secret | One Auth user per Core; JWT is `sessionToken`; `app_metadata` carries the storage prefix |

The returned `SharedKey` is only `{ accessKeyId, secretAccessKey, sessionToken, expiresAt }`.
Master material never appears in that object or in thrown `SharedKeyIssueError`s.

## Generic STS

```ts
import { createStsKeyIssuer, createSharedKeyProvider } from "@actana/sdk/shared-key";

const issuer = createStsKeyIssuer({
  endpoint: "https://sts.us-east-1.amazonaws.com",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  roleArn: "arn:aws:iam::123456789012:role/ActanaCoreShared",
  bucket: "actana-shared",
  prefix: "cores",
  region: "us-east-1",
});
const provider = createSharedKeyProvider({ issuer, coreId: "workstation-berlin" });
```

Works against AWS STS and S3-compatible STS (Ceph RGW, RustFS, Wasabi) that
implement `AssumeRole` with an inline `Policy`.

## Cloudflare R2

```ts
import { createR2KeyIssuer } from "@actana/sdk/shared-key";

const issuer = createR2KeyIssuer({
  accountId: process.env.CF_ACCOUNT_ID!,
  apiToken: process.env.CF_API_TOKEN!,
  parentAccessKeyId: process.env.R2_PARENT_ACCESS_KEY_ID!,
  bucket: "actana-shared",
  prefix: "cores",
});
```

Calls `POST /accounts/{account_id}/r2/temp-access-credentials` with
`ttlSeconds: 3600` and `prefixes: ["cores/<core-id>/"]`.

## Supabase

```ts
import { createSupabaseKeyIssuer } from "@actana/sdk/shared-key";

const issuer = createSupabaseKeyIssuer({
  url: process.env.SUPABASE_URL!,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  jwtSecret: process.env.SUPABASE_JWT_SECRET!,
  bucket: "actana-shared",
  prefix: "cores",
});
```

Ensures an Auth user `core-<id>@actana.shared` whose `app_metadata.allowed_prefix`
(and `storage_policy`) is `cores/<id>/`, then mints an HS256 JWT (the
`sessionToken`). Storage RLS must allow only that prefix (same idea as the
prototype's `machineUsers`).

## Isolation tests

- **SeaweedFS:** live SeaweedFS in CI (`shared-key-seaweedfs` job).
- **STS, R2, Supabase:** no real backend in CI. Their isolation tests assert the
  **exact policy or prefix on the wire** against a recording fake of the
  provider API, plus a negative check that a policy for Core A never names
  Core B or the bucket root. These are wire-level isolation tests, not
  live-provider tests.
