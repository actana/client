/**
 * Page 03 wiring snippets — must compile as written.
 * @see planning/modular-split/03-pairing.html
 */

import { createPairing } from "@actana/sdk/pairing/server";
import { jsonFileStore } from "@actana/sdk/pairing/stores/json-file";
import { postgresStore } from "@actana/sdk/pairing/stores/postgres";
import type { PersistedMaterial } from "../material-store.ts";

type SearchGrant = { scope: string; kbIds: string[] };

/** Typecheck fixture — page 03 snippets, parameterised so imports stay side-effect free. */
export function page03WiringExamples(
  paths: { pairing: string },
  material: PersistedMaterial,
  server: { use(...handlers: unknown[]): void; closeRevoked(): void },
  db: Parameters<typeof postgresStore>[0],
  api: { closeClients(serials?: readonly string[]): void },
): void {
  // Control Core (later round)
  const pairing = createPairing({
    store: jsonFileStore(paths.pairing),
    material,
    endpointScheme: "wss",
    onRevoked: () => server.closeRevoked(),
  });
  server.use(pairing.gate, pairing.redeem);

  // Search service (this round)
  const searchPairing = createPairing<SearchGrant>({
    store: postgresStore(db, { schema: "search" }),
    material,
    endpointScheme: "https",
    openPaths: [{ method: "GET", path: "/v1/health" }],
    onRevoked: (serials) => api.closeClients(serials),
  });
  void searchPairing;
}
