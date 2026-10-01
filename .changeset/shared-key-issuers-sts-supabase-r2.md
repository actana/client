---
"@actana/sdk": minor
---

Add Generic STS, Cloudflare R2 and Supabase Shared-folder key issuers on `@actana/sdk/shared-key`. Each issues a Core a 1-hour key limited to `<prefix>/<core-id>/` (inline AssumeRole session policy, R2 `prefixes`, or a per-Core Supabase Auth user + storage restriction); master material stays on the controller. Wire-level isolation tests with recording fakes; no new dependency.
