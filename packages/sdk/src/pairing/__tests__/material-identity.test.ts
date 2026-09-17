import { describe, it, expect, beforeAll } from "vitest";
import selfsigned from "selfsigned";
import {
  checkMaterialIdentity,
  mintFreshMaterial,
  CONTROL_CA_COMMON_NAME,
  CONTROL_LEGACY_CA_COMMON_NAME,
  type PersistedMaterial,
} from "../material-store.ts";
import { issueServerCert } from "../cert-material.ts";

const CONTROL_NAMES = {
  caCommonName: CONTROL_CA_COMMON_NAME,
  clientCommonName: "mission-control-panel",
  organizationName: "Mission Control",
};

const CONTROL_IDENTITY_CHECK = {
  expectedCaCommonName: CONTROL_CA_COMMON_NAME,
  legacyCaCommonNames: [CONTROL_LEGACY_CA_COMMON_NAME],
  remedyHint:
    "Run `actana setup`, which mints this Core a fresh identity when the one on disk cannot " +
    "be served — every paired client then re-pairs with a new `actana pair new` code.",
};

let current: PersistedMaterial;
let other: PersistedMaterial;

beforeAll(async () => {
  current = await mintFreshMaterial(["core.example.test"], { names: CONTROL_NAMES });
  other = await mintFreshMaterial(["core.example.test"], { names: CONTROL_NAMES });
}, 60_000);

async function preRenameMaterial(): Promise<PersistedMaterial> {
  const notBefore = new Date();
  const ca = await selfsigned.generate(
    [
      { name: "commonName", value: CONTROL_LEGACY_CA_COMMON_NAME },
      { name: "organizationName", value: "Mission Control" },
    ],
    {
      algorithm: "sha256",
      notBeforeDate: notBefore,
      notAfterDate: new Date(notBefore.getTime() + 86_400_000),
      extensions: [
        { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    },
  );
  const server = await issueServerCert({
    ca: { cert: ca.cert, key: ca.private },
    hosts: ["core.example.test"],
  });
  return {
    ...current,
    caCert: ca.cert,
    caKey: ca.private,
    serverCert: server.cert,
    serverKey: server.key,
  };
}

describe("material this service can serve", () => {
  it("passes what this product mints", () => {
    expect(checkMaterialIdentity(current, CONTROL_IDENTITY_CHECK)).toBeNull();
    expect(CONTROL_CA_COMMON_NAME).toBe("mission-control-core-ca");
  });
});

describe("material from before the rename", () => {
  it("is reported as foreign, not as unusable — it works, and the rename is not its fault", async () => {
    const legacy = await preRenameMaterial();
    const issue = checkMaterialIdentity(legacy, CONTROL_IDENTITY_CHECK)!;

    expect(issue.severity).toBe("foreign");
    expect(issue.message).toContain(CONTROL_LEGACY_CA_COMMON_NAME);
    expect(issue.message).toMatch(/rename/i);
    expect(issue.message).toMatch(/kept and served/);
  });

  it("is refused once it genuinely cannot serve, and then it is not called old", async () => {
    const legacy = await preRenameMaterial();
    const issue = checkMaterialIdentity(
      { ...legacy, serverKey: current.serverKey },
      CONTROL_IDENTITY_CHECK,
    )!;

    expect(issue.severity).toBe("unusable");
    expect(issue.message).not.toContain(CONTROL_LEGACY_CA_COMMON_NAME);
  });

  it("is otherwise indistinguishable from current material, which is the point", async () => {
    const legacy = await preRenameMaterial();
    expect(Object.keys(legacy).sort()).toEqual(Object.keys(current).sort());
    for (const key of ["caCert", "serverCert", "serverKey"] as const) {
      expect(typeof legacy[key]).toBe("string");
      expect(legacy[key]).toContain("-----BEGIN");
    }
  });
});

describe("material that does not hang together", () => {
  it("refuses a CA that did not sign the leaf beside it, whatever it is called", async () => {
    const stranger = await selfsigned.generate([{ name: "commonName", value: "some-other-ca" }], {
      algorithm: "sha256",
    });
    const issue = checkMaterialIdentity(
      { ...current, caCert: stranger.cert },
      CONTROL_IDENTITY_CHECK,
    )!;
    expect(issue.severity).toBe("unusable");
    expect(issue.message).toMatch(/not issued by the CA beside it/);
  });

  it("refuses a server certificate the CA beside it did not issue", () => {
    const issue = checkMaterialIdentity(
      {
        ...current,
        serverCert: other.serverCert,
        serverKey: other.serverKey,
      },
      CONTROL_IDENTITY_CHECK,
    )!;
    expect(issue.severity).toBe("unusable");
    expect(issue.message).toMatch(/not issued by the CA beside it/);
  });

  it("refuses a certificate and key that are not a pair", () => {
    const issue = checkMaterialIdentity(
      { ...current, serverKey: other.serverKey },
      CONTROL_IDENTITY_CHECK,
    )!;
    expect(issue.severity).toBe("unusable");
    expect(issue.message).toMatch(/are not a pair/);
    expect(issue.message).toMatch(/handshake/);
  });

  it("refuses bytes that are not certificates at all", () => {
    const message = (material: PersistedMaterial) =>
      checkMaterialIdentity(material, CONTROL_IDENTITY_CHECK)?.message ?? "";
    expect(message({ ...current, caCert: "not a certificate" })).toMatch(
      /`caCert` is not a certificate/,
    );
    expect(message({ ...current, serverCert: "-----BEGIN CERTIFICATE-----\nx\n" })).toMatch(
      /`serverCert` is not a certificate/,
    );
    expect(message({ ...current, serverKey: "not a key" })).toMatch(
      /`serverKey` is not a private key/,
    );
  });

  it("says what to run, whatever the reason — and it is a command that works", () => {
    for (const broken of [
      { ...current, caCert: "junk" },
      { ...current, serverCert: "junk" },
      { ...current, serverKey: "junk" },
      { ...current, serverCert: other.serverCert, serverKey: other.serverKey },
    ]) {
      const issue = checkMaterialIdentity(broken, CONTROL_IDENTITY_CHECK)!;
      expect(issue.severity).toBe("unusable");
      expect(issue.message).toContain("actana setup");
    }
  });
});
