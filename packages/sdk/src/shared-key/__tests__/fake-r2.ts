/**
 * Recording fake of Cloudflare's R2 temporary-credentials API.
 */
export interface R2RequestRecord {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeR2Options {
  result?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string };
  error?: { status: number; code: number; message: string };
  networkError?: Error;
}

export function createFakeR2(options: FakeR2Options = {}): {
  fetch: typeof fetch;
  requests: R2RequestRecord[];
} {
  const requests: R2RequestRecord[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    if (options.networkError) throw options.networkError;
    const raw = String(init?.body ?? "");
    let body: unknown = raw;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      /* keep raw */
    }
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    requests.push({ url: String(url), method: init?.method ?? "GET", headers, body });
    if (options.error) {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: options.error.code, message: options.error.message }],
          messages: [],
          result: null,
        }),
        { status: options.error.status, headers: { "content-type": "application/json" } },
      );
    }
    const result = options.result ?? {
      accessKeyId: "AKIAR2TEMP",
      secretAccessKey: "r2-temp-secret",
      sessionToken: "r2-temp-session",
    };
    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, requests };
}
