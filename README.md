# actana/client

Shared client layer for Actana products: **`@actana/sdk`** (core-link, pairing, product entry points) and **`@actana/cli`** (the `actana` command).

This repository is scaffolded from [actana/control](https://github.com/actana/control) per the modular-split plan. Pairing and CLI modules lift in later tasks (T-202+). The canonical origin baseline lives in [`origins-manifest.json`](./origins-manifest.json).

## Requirements

- Node **24.x**
- pnpm **11.1.2** (see `packageManager` in `package.json`)

## Workspace

| Package | Name | Description |
|---------|------|-------------|
| `packages/sdk` | `@actana/sdk` | SDK — pairing, core-link, product subpaths |
| `packages/cli` | `@actana/cli` | CLI — `actana` binary; depends only on `@actana/sdk` among `@actana/*` |

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
```

## Releases

Packages version independently with [Changesets](https://github.com/changesets/changesets). Any PR that touches `packages/` needs a changeset (`pnpm changeset`). Merges to `main` drive `.github/workflows/release.yml`, which opens a version PR and publishes only packages whose version changed, with npm provenance.

Publish rights belong to **`actana/client`** only — see [docs/releases.md](./docs/releases.md).

## License

MIT — see [LICENSE](./LICENSE).
