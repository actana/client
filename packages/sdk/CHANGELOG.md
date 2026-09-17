# @actana/sdk

## 0.5.0

### Minor Changes

First release from [`actana/client`](https://github.com/actana/client) at **0.5.0**, continuing from Control's `@actana/sdk@0.4.5`.

- Six explicit export subpaths (`./pairing`, `./core`, `./search`, pairing server and stores) — no root barrel and no `./*` catch-all.
- Published tarball ships compiled `dist/` JavaScript and type declarations (`publishConfig.exports`).
- Pairing library, core-link client, and Search contracts extracted from Control for shared use by CLI and Search phase 3.
