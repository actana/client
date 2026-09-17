/**
 * `@actana/sdk/search` — the typed client for a Search instance.
 *
 * Zod contracts are `@actana/sdk/search/contracts` (and one module per family
 * beneath `search/contracts/`). They are not re-exported here.
 */

/** The wire protocol version this SDK speaks. Reported by `GET /capabilities`. */
export const SEARCH_PROTOCOL_VERSION = 1;

export { SearchClient, DEFAULT_REQUEST_TIMEOUT_MS } from "./search/client.ts";
export type {
  AttachBlobInput,
  IngestInput,
  SearchClientOptions,
  SearchRequestBody,
  SearchRequestOptions,
} from "./search/client.ts";
export { SearchApiError } from "./search/errors.ts";
export type { SearchHealth, SearchPairStatus } from "./search/wire.ts";
