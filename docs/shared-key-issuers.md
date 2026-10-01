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
| Supabase | `createSupabaseKeyIssuer` | Service-role key + JWT secret | One Auth user per Core; JWT is `sessionToken`; S3 key = project ref + anon key; RLS on `storage.objects` must read `allowed_prefix` (see below) |

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
import { createSupabaseKeyIssuer, supabaseCoreStorageRlsSql } from "@actana/sdk/shared-key";

const issuer = createSupabaseKeyIssuer({
  url: process.env.SUPABASE_URL!,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  jwtSecret: process.env.SUPABASE_JWT_SECRET!,
  anonKey: process.env.SUPABASE_ANON_KEY!,
  // projectRef defaults to the first label of the URL hostname
  bucket: "actana-shared",
  prefix: "cores",
});
```

Ensures an Auth user `core-<id>@actana.shared` whose `app_metadata.allowed_prefix`
(and `storage_policy`) is `cores/<id>/`, then mints an HS256 JWT. The returned
`SharedKey` matches [Supabase S3 session-token authentication](https://supabase.com/docs/guides/storage/s3/authentication):
`accessKeyId` = project ref, `secretAccessKey` = anon key (both public),
`sessionToken` = that JWT.

**The issuer restricts nothing by itself.** Without an RLS policy on
`storage.objects` that compares the object name to
`auth.jwt() -> 'app_metadata' ->> 'allowed_prefix'`, the JWT is an ordinary
`authenticated` token limited only by whatever the project already grants that
role. Apply the SQL from `supabaseCoreStorageRlsSql(bucket)` once per project
(also exported from `@actana/sdk/shared-key`):

```sql
-- Actana Shared-folder: one Core per Auth user.
-- The issuer sets auth.jwt() -> 'app_metadata' ->> 'allowed_prefix' to
-- '<prefix>/<core-id>/'. Without these policies the issued JWT is not limited.
-- Run once per project (adjust the bucket name).
-- Use starts_with (not LIKE): Core ids may contain '_', which LIKE treats as a wildcard.

CREATE POLICY actana_core_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'actana-shared'
    AND starts_with(name, auth.jwt() -> 'app_metadata' ->> 'allowed_prefix')
  );

CREATE POLICY actana_core_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'actana-shared'
    AND starts_with(name, auth.jwt() -> 'app_metadata' ->> 'allowed_prefix')
  );

CREATE POLICY actana_core_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'actana-shared'
    AND starts_with(name, auth.jwt() -> 'app_metadata' ->> 'allowed_prefix')
  )
  WITH CHECK (
    bucket_id = 'actana-shared'
    AND starts_with(name, auth.jwt() -> 'app_metadata' ->> 'allowed_prefix')
  );

CREATE POLICY actana_core_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'actana-shared'
    AND starts_with(name, auth.jwt() -> 'app_metadata' ->> 'allowed_prefix')
  );
```

(Same text as `supabaseCoreStorageRlsSql("actana-shared")`.) These policies add to
whatever the project already has: a broader existing policy for `authenticated`
on the bucket still applies (Postgres RLS is OR-ed across permissive policies).

## Isolation tests

- **SeaweedFS:** live SeaweedFS in CI (`shared-key-seaweedfs` job).
- **STS, R2, Supabase:** no real backend in CI. Their isolation tests assert the
  **exact policy or prefix on the wire** against a recording fake of the
  provider API, plus a negative check that a policy for Core A never names
  Core B or the bucket root. These are wire-level isolation tests, not
  live-provider tests.
