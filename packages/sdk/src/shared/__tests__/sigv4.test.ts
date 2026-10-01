// The signer against the worked examples in AWS's S3 SigV4 documentation, so it is checked
// against something other than itself. (SeaweedFS checks it again, for real, in CI.)
import { describe, expect, it } from "vitest";
import { canonicalPath, presignGetUrl, signRequest } from "../sigv4.ts";

const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const endpoint = new URL("https://examplebucket.s3.amazonaws.com");
const nowMs = Date.UTC(2013, 4, 24, 0, 0, 0);
const signatureOf = (authorization: string): string => /Signature=([0-9a-f]{64})$/.exec(authorization)?.[1] ?? "";

describe("SigV4 against AWS's documented examples", () => {
  it("GET Object with a Range header", () => {
    const signed = signRequest({
      method: "GET",
      endpoint,
      path: "/test.txt",
      headers: { Range: "bytes=0-9" },
      credentials,
      region: "us-east-1",
      nowMs,
    });
    expect(signed.headers.authorization).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date");
    expect(signatureOf(signed.headers.authorization as string)).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("PUT Object with a body, an encoded key and an extra signed header", () => {
    const signed = signRequest({
      method: "PUT",
      endpoint,
      path: canonicalPath(["test$file.text"]),
      headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      body: "Welcome to Amazon S3.",
      credentials,
      region: "us-east-1",
      nowMs,
    });
    expect(signed.url).toBe("https://examplebucket.s3.amazonaws.com/test%24file.text");
    expect(signatureOf(signed.headers.authorization as string)).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("a presigned GET URL", () => {
    const url = presignGetUrl({ endpoint, path: "/test.txt", credentials, region: "us-east-1", nowMs, expiresInSeconds: 86400 });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("carries the session token as a signed header, and in a presigned URL as a query parameter", () => {
    const withToken = { ...credentials, sessionToken: "tok/en+1" };
    const signed = signRequest({ method: "GET", endpoint, path: "/k", credentials: withToken, region: "us-east-1", nowMs });
    expect(signed.headers["x-amz-security-token"]).toBe("tok/en+1");
    expect(signed.headers.authorization).toContain("x-amz-security-token");
    const url = presignGetUrl({ endpoint, path: "/k", credentials: withToken, region: "us-east-1", nowMs, expiresInSeconds: 60 });
    expect(new URL(url).searchParams.get("X-Amz-Security-Token")).toBe("tok/en+1");
  });
});
