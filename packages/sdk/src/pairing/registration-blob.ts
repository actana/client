// The registration blob, as a paired client reads it.
//
// The SDK takes a blob object, never a file. The shape is declared here, not
// imported from a private shared package. `endpoint`'s scheme says which product
// opens it: `wss://` for Core, `https://` for Search.

/** Which product a registration blob belongs to. */
export type PairingProduct = "core" | "search";

const ENDPOINT_PREFIX: Record<PairingProduct, string> = {
  core: "wss://",
  search: "https://",
};

/** PEM material for an mTLS dial. */
export type TlsMaterial = {
  ca: string;
  cert: string;
  key: string;
};

/**
 * A decoded registration blob. `endpoint` is the product's dial origin;
 * `label` is the machine's own suggestion for an alias and is not used here.
 */
export type RegistrationBlob = {
  endpoint: string;
  label?: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  bearer: string;
};

/** @deprecated Use {@link RegistrationBlob}. */
export type CoreRegistrationBlob = RegistrationBlob;

/** @deprecated Use {@link RegistrationBlob}. */
export type SearchRegistrationBlob = RegistrationBlob;

/** Everything a blob says about how to reach one server, unpacked for dialing. */
export type ProductConnection = {
  /** The endpoint URL (`wss://` for Core, `https://` for Search). */
  url: string;
  /**
   * The `https://` origin of the same server — for Core, derived by swapping the
   * WebSocket scheme. No path, no trailing slash.
   */
  httpsBaseUrl: string;
  /** PEM material for mTLS, or null for a plaintext dial. */
  tls: TlsMaterial | null;
  /** The signed bearer (Core auth frame; carried for shape parity on Search). */
  bearer: string;
};

/** @deprecated Use {@link ProductConnection}. */
export type CoreConnection = ProductConnection;

/** @deprecated Use {@link ProductConnection}. */
export type SearchConnection = Pick<ProductConnection, "httpsBaseUrl" | "tls" | "bearer">;

/** Encode a registration blob into the single base64 line a store holds. */
export function encodeRegistrationBlob(blob: RegistrationBlob): string {
  return Buffer.from(
    JSON.stringify({
      endpoint: blob.endpoint,
      label: blob.label ?? "",
      caCert: blob.caCert,
      clientCert: blob.clientCert,
      clientKey: blob.clientKey,
      bearer: blob.bearer,
    }),
    "utf8",
  ).toString("base64");
}

/**
 * Decode a stored registration blob for `product`, or `null` when malformed or
 * the endpoint scheme does not match the product.
 */
export function decodeRegistrationBlob(raw: string, product: PairingProduct): RegistrationBlob | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const { endpoint, label, caCert, clientCert, clientKey, bearer } = o;
  if (
    typeof endpoint !== "string" ||
    typeof caCert !== "string" ||
    typeof clientCert !== "string" ||
    typeof clientKey !== "string" ||
    typeof bearer !== "string"
  ) {
    return null;
  }
  if (!endpoint.startsWith(ENDPOINT_PREFIX[product])) return null;
  return {
    endpoint,
    label: typeof label === "string" ? label : "",
    caCert,
    clientCert,
    clientKey,
    bearer,
  };
}

/** Unpack a registration blob into a {@link ProductConnection}. */
export function connectionFromBlob(blob: RegistrationBlob, product: PairingProduct): ProductConnection {
  const url = blob.endpoint.trim();
  const secure =
    product === "core" ? url.startsWith("wss://") : url.startsWith("https://");
  return {
    url,
    httpsBaseUrl: httpsBaseUrlFor(url),
    tls: secure ? { ca: blob.caCert, cert: blob.clientCert, key: blob.clientKey } : null,
    bearer: blob.bearer,
  };
}

/** @deprecated Use {@link connectionFromBlob} with `product: "core"`. */
export function coreConnectionFromBlob(blob: RegistrationBlob): ProductConnection {
  return connectionFromBlob(blob, "core");
}

/** Unpack a Search blob. {@link SearchConnection} omits `url` for API parity. */
export function searchConnectionFromBlob(blob: RegistrationBlob): SearchConnection {
  const conn = connectionFromBlob(blob, "search");
  return { httpsBaseUrl: conn.httpsBaseUrl, tls: conn.tls, bearer: conn.bearer };
}

/**
 * `wss://host:port` → `https://host:port`, `ws://…` → `http://…`. An
 * `https://`/`http://` origin is trimmed of trailing slashes. Anything else is
 * returned unchanged.
 */
export function httpsBaseUrlFor(url: string): string {
  if (url.startsWith("wss://")) return `https://${url.slice("wss://".length)}`.replace(/\/+$/, "");
  if (url.startsWith("ws://")) return `http://${url.slice("ws://".length)}`.replace(/\/+$/, "");
  if (url.startsWith("https://") || url.startsWith("http://")) return url.replace(/\/+$/, "");
  return url;
}

/** Expected endpoint prefix for a product (`wss://` or `https://`). */
export function endpointPrefixFor(product: PairingProduct): string {
  return ENDPOINT_PREFIX[product];
}
