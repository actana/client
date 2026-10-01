/**
 * Recording fake of Supabase Auth Admin (machine-user create / list / update).
 * Captures app_metadata storage restrictions for wire-level isolation tests.
 */
export interface SupabaseRequestRecord {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeSupabaseUser {
  id: string;
  email: string;
  app_metadata?: Record<string, unknown>;
}

export interface FakeSupabaseOptions {
  /** Pre-seeded users (create will 422 and fall through to list+update). */
  users?: FakeSupabaseUser[];
  /** Page size for GET /admin/users (default 200). */
  perPage?: number;
  networkError?: Error;
  createError?: { status: number; message: string };
}

export function createFakeSupabase(options: FakeSupabaseOptions = {}): {
  fetch: typeof fetch;
  requests: SupabaseRequestRecord[];
  users: FakeSupabaseUser[];
} {
  const users: FakeSupabaseUser[] = [...(options.users ?? [])];
  const requests: SupabaseRequestRecord[] = [];

  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    if (options.networkError) throw options.networkError;
    const raw = String(init?.body ?? "");
    let body: unknown = raw === "" ? undefined : raw;
    if (raw) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        /* keep raw */
      }
    }
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    const href = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ url: href, method, headers, body });

    if (options.createError && method === "POST" && href.includes("/auth/v1/admin/users") && !/\/users\/[^/?]+$/.test(href)) {
      return new Response(JSON.stringify({ message: options.createError.message }), {
        status: options.createError.status,
        headers: { "content-type": "application/json" },
      });
    }

    // POST create
    if (method === "POST" && /\/auth\/v1\/admin\/users\/?$/.test(new URL(href).pathname)) {
      const payload = body as { email: string; app_metadata?: Record<string, unknown> };
      if (users.some((u) => u.email === payload.email)) {
        return new Response(JSON.stringify({ message: "User already registered" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      }
      const user: FakeSupabaseUser = {
        id: `user-${users.length + 1}`,
        email: payload.email,
        app_metadata: payload.app_metadata,
      };
      users.push(user);
      return new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } });
    }

    // GET list (honours page + per_page so R3 can put a user on page 2)
    if (method === "GET" && href.includes("/auth/v1/admin/users")) {
      const u = new URL(href);
      const page = Math.max(1, Number(u.searchParams.get("page") ?? "1") || 1);
      const perPage = Math.max(1, Number(u.searchParams.get("per_page") ?? String(options.perPage ?? 200)) || 200);
      const start = (page - 1) * perPage;
      const slice = users.slice(start, start + perPage);
      return new Response(JSON.stringify({ users: slice }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // PUT update
    const putMatch = /\/auth\/v1\/admin\/users\/([^/?]+)$/.exec(new URL(href).pathname);
    if (method === "PUT" && putMatch) {
      const id = putMatch[1]!;
      const payload = body as { app_metadata?: Record<string, unknown> };
      const user = users.find((u) => u.id === id);
      if (!user) {
        return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      }
      user.app_metadata = payload.app_metadata;
      return new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as unknown as typeof fetch;

  return { fetch: fetchFn, requests, users };
}
