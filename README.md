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

## Using the SDK like the Panel does

[docs/panel-recipe.md](./docs/panel-recipe.md) shows how to do what the Panel does with a Core using only the public SDK (pair a Core, attach its Shared folder with a key issuer, start a Session and watch its report, dispatch a Task and turn its result files into status), with a runnable script in [`examples/panel-recipe`](./examples/panel-recipe). The SDK's other docs: [`actana files`](./docs/cli-files.md), [shared-key issuers](./docs/shared-key-issuers.md), [the report contract](./docs/report-contract.md).

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
