import { describe, it, expect } from "vitest";
import {
  encodeRegistrationBlob,
  decodeRegistrationBlob,
  type RegistrationBlob,
  type PairingProduct,
} from "../registration-blob.ts";

const PRODUCTS: { product: PairingProduct; scheme: string; wrongScheme: string }[] = [
  { product: "core", scheme: "wss://", wrongScheme: "https://" },
  { product: "search", scheme: "https://", wrongScheme: "wss://" },
];

describe.each(PRODUCTS)("registration blob ($product)", ({ product, scheme, wrongScheme }) => {
  const sample: RegistrationBlob = {
    endpoint: `${scheme}10.0.0.5:443`,
    label: "prod-vm-1",
    caCert: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
    clientCert: "-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----",
    clientKey: "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----",
    bearer: "eyJjb3JlSW.abc123",
  };

  describe("encodeRegistrationBlob / decodeRegistrationBlob", () => {
    it("round-trips a full blob", () => {
      const encoded = encodeRegistrationBlob(sample);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+=*$/);
      expect(decodeRegistrationBlob(encoded, product)).toEqual(sample);
    });

    it("encodes as base64 (not raw JSON)", () => {
      const encoded = encodeRegistrationBlob(sample);
      expect(() => JSON.parse(encoded)).toThrow();
    });

    it("decodes a blob with optional label omitted", () => {
      const minimal: RegistrationBlob = {
        endpoint: `${scheme}host:443`,
        caCert: "ca",
        clientCert: "client",
        clientKey: "key",
        bearer: "b",
      };
      const encoded = encodeRegistrationBlob(minimal);
      const decoded = decodeRegistrationBlob(encoded, product);
      expect(decoded).toEqual({ ...minimal, label: "" });
    });

    it("returns null for a malformed base64 string", () => {
      expect(decodeRegistrationBlob("!!!not base64!!!", product)).toBeNull();
    });

    it("returns null for a payload missing required fields", () => {
      const partial = Buffer.from(
        JSON.stringify({ endpoint: `${scheme}h`, label: "x" }),
      ).toString("base64");
      expect(decodeRegistrationBlob(partial, product)).toBeNull();
    });

    it("returns null for a payload with wrong-typed fields", () => {
      const bad = Buffer.from(
        JSON.stringify({
          endpoint: 123,
          label: "x",
          caCert: "ca",
          clientCert: "c",
          clientKey: "k",
          bearer: "b",
        }),
      ).toString("base64");
      expect(decodeRegistrationBlob(bad, product)).toBeNull();
    });

    it(`rejects a blob whose endpoint is not ${scheme} (transport security required)`, () => {
      const bad = encodeRegistrationBlob({ ...sample, endpoint: `${wrongScheme}10.0.0.5:443` });
      expect(decodeRegistrationBlob(bad, product)).toBeNull();
    });

    it("whitespace-trims and ignores surrounding whitespace in the file", () => {
      const encoded = encodeRegistrationBlob(sample);
      expect(decodeRegistrationBlob(`  ${encoded}\n`, product)).toEqual(sample);
    });
  });
});

describe("registration blob scheme enforcement", () => {
  const coreBlob: RegistrationBlob = {
    endpoint: "wss://10.0.0.5:443",
    caCert: "ca",
    clientCert: "client",
    clientKey: "key",
    bearer: "b",
  };

  it("refuses a core blob when decoded for Search", () => {
    const encoded = encodeRegistrationBlob(coreBlob);
    expect(decodeRegistrationBlob(encoded, "core")).toEqual({ ...coreBlob, label: "" });
    expect(decodeRegistrationBlob(encoded, "search")).toBeNull();
  });

  it("refuses a search blob when decoded for Core", () => {
    const searchBlob: RegistrationBlob = {
      endpoint: "https://search.example:7443",
      caCert: "ca",
      clientCert: "client",
      clientKey: "key",
      bearer: "b",
    };
    const encoded = encodeRegistrationBlob(searchBlob);
    expect(decodeRegistrationBlob(encoded, "search")).toEqual({ ...searchBlob, label: "" });
    expect(decodeRegistrationBlob(encoded, "core")).toBeNull();
  });
});
