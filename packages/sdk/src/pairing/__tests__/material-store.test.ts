import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { X509Certificate, createPublicKey } from "node:crypto";
import {
  persistMaterial,
  loadMaterial,
  materialFilePath,
  mintFreshMaterial,
  readMaterialFile,
  reissueServerCert,
  checkServerCertHost,
  type PersistedMaterial,
} from "../material-store.ts";
import type { CertNaming } from "../cert-material.ts";

const TEST_NAMES: CertNaming = {
  caCommonName: "test-pairing-ca",
  clientCommonName: "test-pairing-client",
  organizationName: "Test",
};

const sample: PersistedMaterial = {
  caCert: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
  caKey: "-----BEGIN PRIVATE KEY-----\nCAKEY\n-----END PRIVATE KEY-----",
  serverCert: "-----BEGIN CERTIFICATE-----\nSERVER\n-----END CERTIFICATE-----",
  serverKey: "-----BEGIN PRIVATE KEY-----\nSERVERKEY\n-----END PRIVATE KEY-----",
  clientCert: "-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----",
  clientKey: "-----BEGIN PRIVATE KEY-----\nCLIENTKEY\n-----END PRIVATE KEY-----",
  bearerSecret: "deadbeef".repeat(8),
  coreId: "core_abcdef0123456789",
  coreUuid: "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b",
  serverHosts: ["10.0.0.5"],
};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-material-test-"));
}

describe("material store", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("persistMaterial / loadMaterial", () => {
    it("round-trips material to disk", () => {
      persistMaterial(dir, sample);
      const loaded = loadMaterial(dir);
      expect(loaded).toEqual(sample);
    });

    it("writes to material.json inside the state dir", () => {
      persistMaterial(dir, sample);
      expect(fs.existsSync(materialFilePath(dir))).toBe(true);
    });

    it("returns null when no material file exists", () => {
      expect(loadMaterial(dir)).toBeNull();
    });

    it("returns null for a corrupt JSON file", () => {
      fs.writeFileSync(materialFilePath(dir), "{not json");
      expect(loadMaterial(dir)).toBeNull();
    });

    it("returns null when required fields are missing", () => {
      const partial = { caCert: "x", caKey: "y" } as unknown as PersistedMaterial;
      fs.writeFileSync(materialFilePath(dir), JSON.stringify(partial));
      expect(loadMaterial(dir)).toBeNull();
    });

    it("returns null when fields have wrong types", () => {
      const bad = { ...sample, caCert: 123 } as unknown as PersistedMaterial;
      fs.writeFileSync(materialFilePath(dir), JSON.stringify(bad));
      expect(loadMaterial(dir)).toBeNull();
    });

    it("overwrites existing material on re-persist (reissue)", () => {
      persistMaterial(dir, sample);
      const reissued: PersistedMaterial = {
        ...sample,
        coreId: "core_new123",
        bearerSecret: "aabbccdd".repeat(8),
      };
      persistMaterial(dir, reissued);
      expect(loadMaterial(dir)).toEqual(reissued);
    });

    it("creates the state dir if it does not exist", () => {
      const nested = path.join(dir, "nested", "state");
      persistMaterial(nested, sample);
      expect(loadMaterial(nested)).toEqual(sample);
    });

    it("loads material written before the SAN record existed as an unknown host", () => {
      const { serverHosts, ...legacy } = sample;
      fs.writeFileSync(materialFilePath(dir), JSON.stringify(legacy));

      const loaded = loadMaterial(dir);
      expect(loaded).toEqual({ ...legacy, serverHosts: [] });
      expect(checkServerCertHost(loaded!, serverHosts)).toBe("unrecorded");
    });

    it("reads the pre-#347 single serverHost as a list of one", () => {
      const { serverHosts: _listed, ...legacy } = sample;
      fs.writeFileSync(
        materialFilePath(dir),
        JSON.stringify({ ...legacy, serverHost: "10.0.0.5" }),
      );

      const loaded = loadMaterial(dir);
      expect(loaded!.serverHosts).toEqual(["10.0.0.5"]);
      expect(checkServerCertHost(loaded!, ["10.0.0.5"])).toBe("covered");
    });

    it("restricts file permissions to owner-only (0o600)", () => {
      persistMaterial(dir, sample);
      const stat = fs.statSync(materialFilePath(dir));
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });
  });

  describe("reissueServerCert", () => {
    it("keeps every credential a client pinned and replaces only the server cert", async () => {
      const minted = await mintFreshMaterial(["10.0.0.5"], { names: TEST_NAMES });

      const moved = await reissueServerCert(minted, ["core.example.test"]);

      expect(moved.coreId).toBe(minted.coreId);
      expect(moved.bearerSecret).toBe(minted.bearerSecret);
      expect(moved.caCert).toBe(minted.caCert);
      expect(moved.caKey).toBe(minted.caKey);
      expect(moved.clientCert).toBe(minted.clientCert);
      expect(moved.clientKey).toBe(minted.clientKey);
      expect(moved.serverCert).not.toBe(minted.serverCert);
      expect(moved.serverKey).not.toBe(minted.serverKey);
    });

    it("signs the new cert with the CA the client already pinned", async () => {
      const minted = await mintFreshMaterial(["10.0.0.5"], { names: TEST_NAMES });

      const moved = await reissueServerCert(minted, ["core.example.test"]);

      const server = new X509Certificate(moved.serverCert);
      expect(server.verify(createPublicKey(minted.caCert))).toBe(true);
      expect(server.subjectAltName).toContain("core.example.test");
      expect(server.subjectAltName).not.toContain("10.0.0.5");
    });

    it("records the host it signed for, so the next boot knows it is covered", async () => {
      const minted = await mintFreshMaterial(["10.0.0.5"], { names: TEST_NAMES });
      expect(checkServerCertHost(minted, ["10.0.0.5"])).toBe("covered");
      expect(checkServerCertHost(minted, ["core.example.test"])).toBe("moved");

      const moved = await reissueServerCert(minted, ["core.example.test"]);

      expect(moved.serverHosts).toEqual(["core.example.test"]);
      expect(checkServerCertHost(moved, ["core.example.test"])).toBe("covered");
    });
  });

  describe("checkServerCertHost", () => {
    const unrecorded: PersistedMaterial = { ...sample, serverHosts: [] };

    it("separates a host that moved from one nothing on disk records", () => {
      expect(checkServerCertHost(unrecorded, ["10.0.0.5"])).toBe("unrecorded");
      expect(checkServerCertHost(sample, ["10.0.0.9"])).toBe("moved");
    });

    it("takes the caller's fallback for material that predates the record", () => {
      expect(checkServerCertHost(unrecorded, ["10.0.0.5"], ["10.0.0.5"])).toBe("covered");
      expect(checkServerCertHost(unrecorded, ["10.0.0.9"], ["10.0.0.5"])).toBe("moved");
    });

    it("prefers the recorded host over the fallback", () => {
      expect(checkServerCertHost(sample, ["10.0.0.5"], ["stale.example"])).toBe("covered");
    });
  });

  describe("the stable core UUID", () => {
    it("mints one at install", async () => {
      const minted = await mintFreshMaterial(["10.0.0.5"], { names: TEST_NAMES });
      expect(minted.coreUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("gives two installs two different UUIDs", async () => {
      const a = await mintFreshMaterial(["10.0.0.5"], { names: TEST_NAMES });
      const b = await mintFreshMaterial(["10.0.0.5"], { names: TEST_NAMES });
      expect(a.coreUuid).not.toBe(b.coreUuid);
    });

    it("survives reissueServerCert unchanged", async () => {
      const minted = await mintFreshMaterial(["10.0.0.5"], { names: TEST_NAMES });
      const reissued = await reissueServerCert(minted, ["10.0.0.9"]);
      expect(reissued.coreUuid).toBe(minted.coreUuid);
      expect(reissued.serverCert).not.toBe(minted.serverCert);
    });

    it("mints one on load for material written before the field existed", () => {
      const file = materialFilePath(dir);
      const { coreUuid: _dropped, ...legacy } = sample;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(legacy, null, 2));

      const read = readMaterialFile(file);

      expect(read?.mintedCoreUuid).toBe(true);
      expect(read?.material.coreUuid).not.toBe("");
      expect(read?.material.coreId).toBe(sample.coreId);
      expect(read?.material.caKey).toBe(sample.caKey);
    });

    it("reports a stored UUID as stored, and returns it verbatim", () => {
      persistMaterial(dir, sample);
      const read = readMaterialFile(materialFilePath(dir));
      expect(read?.mintedCoreUuid).toBe(false);
      expect(read?.material.coreUuid).toBe(sample.coreUuid);
    });

    it("round-trips through persist and load", () => {
      persistMaterial(dir, sample);
      expect(loadMaterial(dir)?.coreUuid).toBe(sample.coreUuid);
    });
  });
});
