# Changesets

This workspace versions `@actana/sdk` and `@actana/cli` independently. Add a changeset on any pull request that changes files under `packages/`.

```bash
pnpm changeset
```

A CLI-only changeset bumps only `@actana/cli`; `@actana/sdk` stays on its current version until it has its own changeset.
