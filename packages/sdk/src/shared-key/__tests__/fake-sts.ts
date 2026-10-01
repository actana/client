/**
 * Recording fake of a Generic STS AssumeRole endpoint. Captures the signed
 * form body (Action, Policy, …) for wire-level isolation assertions.
 */
export interface StsRequestRecord {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: URLSearchParams;
  body: string;
}

export interface FakeStsOptions {
  /** Override the XML credentials returned on success. */
  credentials?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    expiration?: string;
  };
  /** Force an error response. */
  error?: { status: number; code: string; message: string };
  /** Throw instead of responding (network failure). */
  networkError?: Error;
}

export function createFakeSts(options: FakeStsOptions = {}): {
  fetch: typeof fetch;
  requests: StsRequestRecord[];
} {
  const requests: StsRequestRecord[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    if (options.networkError) throw options.networkError;
    const body = String(init?.body ?? "");
    const form = new URLSearchParams(body);
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    requests.push({ url: String(url), method: init?.method ?? "GET", headers, form, body });
    if (options.error) {
      const { status, code, message } = options.error;
      return new Response(
        `<ErrorResponse><Error><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`,
        { status },
      );
    }
    const c = options.credentials ?? {};
    const expiration = c.expiration ?? new Date(Date.UTC(2026, 9, 1, 13, 0, 0)).toISOString();
    const xml =
      `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials>` +
      `<AccessKeyId>${c.accessKeyId ?? "ASIASTS"}</AccessKeyId>` +
      `<SecretAccessKey>${c.secretAccessKey ?? "sts-secret"}</SecretAccessKey>` +
      `<SessionToken>${c.sessionToken ?? "sts-session"}</SessionToken>` +
      `<Expiration>${expiration}</Expiration>` +
      `</Credentials></AssumeRoleResult></AssumeRoleResponse>`;
    return new Response(xml, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, requests };
}
