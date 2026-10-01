import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertValidCoreId,
  createSeaweedfsKeyIssuer,
  publicJwks,
  SharedKeyIssueError,
  type SeaweedfsKeyIssuerOptions,
} from "../index.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const MASTER_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
// The body of the PEM, i.e. the master key material a leak would reproduce.
const MASTER_BODY = MASTER_PEM.split("\n").filter((l) => l && !l.startsWith("-----"))[2]!;

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

function stsOk(expiration = new Date(NOW + 3600_000).toISOString()) {
  return `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>AKIATEST</AccessKeyId><SecretAccessKey>sekret</SecretAccessKey><SessionToken>stoken</SessionToken><Expiration>${expiration}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;
}

function setup(respond: (form: URLSearchParams) => Response | Promise<Response>, extra: Partial<SeaweedfsKeyIssuerOptions> = {}) {
  const requests: { url: string; method?: string; form: URLSearchParams }[] = [];
  const fetchFn = (async (url: URL, init: RequestInit) => {
    const form = new URLSearchParams(String(init.body));
    requests.push({ url: String(url), method: init.method, form });
    return respond(form);
  }) as unknown as typeof fetch;
  const issuer = createSeaweedfsKeyIssuer({
    endpoint: "http://seaweedfs:8333/some/path",
    issuer: "https://panel.example",
    audience: "actana-shared",
    signingKey: MASTER_PEM,
    keyId: "k1",
    fetch: fetchFn,
    now: () => NOW,
    ...extra,
  });
  return { issuer, requests };
}

describe("createSeaweedfsKeyIssuer", () => {
  it("exchanges a signed per-Core token for a 1-hour key at the STS root", async () => {
    const { issuer, requests } = setup(() => new Response(stsOk(), { status: 200 }));
    const key = await issuer.issue("core-a");

    expect(key).toEqual({
      accessKeyId: "AKIATEST",
      secretAccessKey: "sekret",
      sessionToken: "stoken",
      expiresAt: new Date(NOW + 3600_000),
    });
    expect(requests).toHaveLength(1);
    const { url, method, form } = requests[0]!;
    expect(url).toBe("http://seaweedfs:8333/");
    expect(method).toBe("POST");
    expect(form.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(form.get("RoleArn")).toBe("arn:aws:iam::role/ActanaCoreShared");
    expect(form.get("DurationSeconds")).toBe("3600");
  });

  it("signs an RS256 token whose sub is the Core id, verifiable with the published JWKS", async () => {
    const { issuer, requests } = setup(() => new Response(stsOk(), { status: 200 }));
    await issuer.issue("core-a");
    const token = requests[0]!.form.get("WebIdentityToken")!;
    const [h, c, s] = token.split(".") as [string, string, string];
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());

    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "k1" });
    expect(claims).toMatchObject({ iss: "https://panel.example", aud: "actana-shared", sub: "core-a" });
    expect(claims.exp - claims.iat).toBe(300);

    const jwks = publicJwks(MASTER_PEM, "k1");
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", kid: "k1", alg: "RS256" });
    const pub = createPublicKey({ key: jwks.keys[0] as never, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), pub, Buffer.from(s, "base64url"))).toBe(true);
    expect(pub.export({ type: "spki", format: "pem" })).toEqual(publicKey.export({ type: "spki", format: "pem" }));
  });

  it("returns only the key, secret, session token and expiry: no master material", async () => {
    const { issuer } = setup(() => new Response(stsOk(), { status: 200 }));
    const key = await issuer.issue("core-a");
    expect(Object.keys(key).sort()).toEqual(["accessKeyId", "expiresAt", "secretAccessKey", "sessionToken"]);
    const dump = JSON.stringify(key) + String(Object.values(key));
    expect(dump).not.toContain(MASTER_BODY);
    expect(dump).not.toContain("PRIVATE KEY");
    expect(Object.isFrozen(key)).toBe(true);
  });

  it("leaks no master material or token in an error from STS", async () => {
    let sent = "";
    const { issuer } = setup((form) => {
      sent = form.get("WebIdentityToken")!;
      // A hostile or buggy server echoing the token back in its message.
      return new Response(
        `<ErrorResponse><Error><Code>AccessDenied</Code><Message>${sent} is bad</Message></Error></ErrorResponse>`,
        { status: 403 },
      );
    });
    const error = await issuer.issue("core-a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SharedKeyIssueError);
    const text = `${(error as Error).message}\n${(error as Error).stack}\n${JSON.stringify(error)}`;
    expect(text).toContain("AccessDenied");
    expect((error as SharedKeyIssueError).status).toBe(403);
    expect(sent).not.toBe("");
    // Not the token, nor any part of it (the message is cut at 200 chars, so check both ends).
    expect(text).not.toContain(sent.slice(0, 60));
    expect(text).not.toContain(sent.slice(-60));
    expect(text).toContain("[token]");
    expect(text).not.toContain(MASTER_BODY);
    expect(text).not.toContain("PRIVATE KEY");
  });

  it("leaks no master material when the network fails", async () => {
    const { issuer } = setup(() => {
      throw new Error(`connect refused with ${MASTER_PEM}`);
    });
    const error = (await issuer.issue("core-a").catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(SharedKeyIssueError);
    expect(`${error.message}${error.stack}`).not.toContain(MASTER_BODY);
  });

  it("leaks nothing when the signing key is invalid", () => {
    const attempt = () =>
      createSeaweedfsKeyIssuer({
        endpoint: "http://x:8333",
        issuer: "i",
        audience: "a",
        signingKey: `-----BEGIN PRIVATE KEY-----\n${MASTER_BODY}\n-----END PRIVATE KEY-----`,
        keyId: "k",
      });
    expect(attempt).toThrow(SharedKeyIssueError);
    try {
      attempt();
    } catch (error) {
      expect(`${(error as Error).message}${(error as Error).stack}`).not.toContain(MASTER_BODY);
    }
  });

  it("rejects a non-RSA key", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    expect(() =>
      createSeaweedfsKeyIssuer({ endpoint: "http://x:8333", issuer: "i", audience: "a", signingKey: ec, keyId: "k" }),
    ).toThrow(/RSA/);
  });

  it("rejects an incomplete STS answer", async () => {
    const { issuer } = setup(() => new Response("<AssumeRoleWithWebIdentityResponse/>", { status: 200 }));
    await expect(issuer.issue("core-a")).rejects.toThrow(/incomplete/);
  });

  it("uses the expiry STS returns, not an assumed hour", async () => {
    const { issuer } = setup(() => new Response(stsOk(new Date(NOW + 1800_000).toISOString()), { status: 200 }));
    expect((await issuer.issue("core-a")).expiresAt).toEqual(new Date(NOW + 1800_000));
  });

  it.each(["", "Core-A", "core/a", "core*", "..", "a..b", "core a", "-core", "core.a", "a".repeat(64)])(
    "refuses the Core id %j before anything is sent",
    async (id) => {
      const { issuer, requests } = setup(() => new Response(stsOk(), { status: 200 }));
      await expect(issuer.issue(id)).rejects.toThrow(/invalid core id/);
      expect(requests).toHaveLength(0);
      expect(() => assertValidCoreId(id)).toThrow(SharedKeyIssueError);
    },
  );
});
