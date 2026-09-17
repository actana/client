// Material store — persists cert material + bearer secret to disk so a
// service can reload the same CA + certs across reboots.

import * as fs from "node:fs";
import * as path from "node:path";
import { createPrivateKey, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { generateCertMaterial, issueServerCert, type CertNaming } from "./cert-material.ts";

export type PersistedMaterial = {
  caCert: string;
  caKey: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
  bearerSecret: string;
  coreId: string;
  coreUuid: string;
  serverHosts: string[];
};

export const MATERIAL_FILENAME = "material.json";

export function materialFilePath(stateDir: string): string {
  return path.join(stateDir, MATERIAL_FILENAME);
}

function restrictPermissions(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort */
  }
}

export type MintFreshMaterialOptions = {
  names: CertNaming;
};

export async function mintFreshMaterial(
  publicHosts: readonly string[],
  opts: MintFreshMaterialOptions,
): Promise<PersistedMaterial> {
  const generated = await generateCertMaterial({ hosts: publicHosts, names: opts.names });
  return {
    caCert: generated.ca.cert,
    caKey: generated.ca.key,
    serverCert: generated.server.cert,
    serverKey: generated.server.key,
    clientCert: generated.client.cert,
    clientKey: generated.client.key,
    bearerSecret: randomBytes(32).toString("hex"),
    coreId: `core_${randomBytes(8).toString("hex")}`,
    coreUuid: randomUUID(),
    serverHosts: [...publicHosts],
  };
}

function samePublicHosts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((host, index) => host === b[index]);
}

export function checkServerCertHost(
  material: PersistedMaterial,
  hosts: readonly string[],
  fallbackHosts?: readonly string[],
): "covered" | "moved" | "unrecorded" {
  const signedFor = material.serverHosts.length > 0 ? material.serverHosts : (fallbackHosts ?? []);
  if (signedFor.length === 0) return "unrecorded";
  return samePublicHosts(signedFor, hosts) ? "covered" : "moved";
}

export async function reissueServerCert(
  material: PersistedMaterial,
  publicHosts: readonly string[],
): Promise<PersistedMaterial> {
  const server = await issueServerCert({
    ca: { cert: material.caCert, key: material.caKey },
    hosts: publicHosts,
  });
  return {
    ...material,
    serverCert: server.cert,
    serverKey: server.key,
    serverHosts: [...publicHosts],
  };
}

export function persistMaterial(stateDir: string, material: PersistedMaterial): void {
  persistMaterialToFile(materialFilePath(stateDir), material);
}

export function persistMaterialToFile(filePath: string, material: PersistedMaterial): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(material, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  restrictPermissions(filePath);
}

export function loadMaterial(stateDir: string): PersistedMaterial | null {
  return loadMaterialFromFile(materialFilePath(stateDir));
}

export function loadMaterialFromFile(filePath: string): PersistedMaterial | null {
  return readMaterialFile(filePath)?.material ?? null;
}

export type MaterialFileRead = {
  material: PersistedMaterial;
  mintedCoreUuid: boolean;
};

export function readMaterialFile(filePath: string): MaterialFileRead | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.caCert !== "string" ||
    typeof o.caKey !== "string" ||
    typeof o.serverCert !== "string" ||
    typeof o.serverKey !== "string" ||
    typeof o.clientCert !== "string" ||
    typeof o.clientKey !== "string" ||
    typeof o.bearerSecret !== "string" ||
    typeof o.coreId !== "string"
  ) {
    return null;
  }
  const storedUuid = typeof o.coreUuid === "string" ? o.coreUuid : "";
  const mintedCoreUuid = storedUuid === "";
  return {
    material: {
      caCert: o.caCert,
      caKey: o.caKey,
      serverCert: o.serverCert,
      serverKey: o.serverKey,
      clientCert: o.clientCert,
      clientKey: o.clientKey,
      bearerSecret: o.bearerSecret,
      coreId: o.coreId,
      coreUuid: mintedCoreUuid ? randomUUID() : storedUuid,
      serverHosts: readServerHosts(o),
    },
    mintedCoreUuid,
  };
}

export type MaterialIdentityIssue = {
  severity: "unusable" | "foreign";
  message: string;
};

/** Control-era CA names — pass via {@link MaterialIdentityCheckOptions} when checking provenance. */
export const CONTROL_CA_COMMON_NAME = "mission-control-core-ca";
export const CONTROL_LEGACY_CA_COMMON_NAME = "mission-control-harness-ca";

export type MaterialIdentityCheckOptions = {
  /** The CA common name this product mints. Enables provenance checks when set. */
  expectedCaCommonName: string;
  /** Legacy CA names reported as foreign but still served. */
  legacyCaCommonNames?: readonly string[];
  /** Appended to unusable messages (e.g. the operator command to re-mint). */
  remedyHint?: string;
};

function commonNameOf(distinguishedName: string): string {
  return /^CN=(.*)$/m.exec(distinguishedName)?.[1]?.trim() ?? "";
}

export function checkMaterialIdentity(
  material: PersistedMaterial,
  options?: MaterialIdentityCheckOptions,
): MaterialIdentityIssue | null {
  const remedy =
    options?.remedyHint ??
    "Re-mint material when the identity on disk cannot be served — every paired client then re-pairs.";

  const unusable = (message: string): MaterialIdentityIssue => ({
    severity: "unusable",
    message: `${message} ${remedy}`,
  });

  let ca: X509Certificate;
  try {
    ca = new X509Certificate(material.caCert);
  } catch {
    return unusable("`caCert` is not a certificate this service can parse.");
  }

  let server: X509Certificate;
  try {
    server = new X509Certificate(material.serverCert);
  } catch {
    return unusable("`serverCert` is not a certificate this service can parse.");
  }

  let issuedByThisCa: boolean;
  try {
    issuedByThisCa = server.verify(ca.publicKey);
  } catch {
    issuedByThisCa = false;
  }
  if (!issuedByThisCa) {
    return unusable(
      "The server certificate in this material was not issued by the CA beside it, so no " +
        "client that pins the CA can validate it.",
    );
  }

  try {
    if (!server.checkPrivateKey(createPrivateKey(material.serverKey))) {
      return unusable(
        "The server certificate and `serverKey` in this material are not a pair. TLS would " +
          "fail at the handshake with nothing said about why.",
      );
    }
  } catch {
    return unusable("`serverKey` is not a private key this service can parse.");
  }

  if (!options?.expectedCaCommonName) return null;

  const issuer = commonNameOf(ca.subject);
  if (issuer === options.expectedCaCommonName) return null;

  const legacy = options.legacyCaCommonNames ?? [];
  const provenance =
    legacy.includes(issuer)
      ? `was minted by \`${issuer}\`, an install from before a product rename`
      : `was minted by \`${issuer || "(no common name)"}\`, which this product has not minted`;
  return {
    severity: "foreign",
    message:
      `This identity ${provenance}. It is kept and served as it is: the ` +
      "certificates hang together, and a client that pinned that CA still validates. " +
      "Re-mint material if you want to replace it — every paired client re-pairs when you do.",
  };
}

function readServerHosts(o: Record<string, unknown>): string[] {
  if (Array.isArray(o.serverHosts)) {
    return o.serverHosts
      .filter((host): host is string => typeof host === "string")
      .map((host) => host.trim())
      .filter((host) => host.length > 0);
  }
  const legacy = typeof o.serverHost === "string" ? o.serverHost.trim() : "";
  return legacy.length > 0 ? [legacy] : [];
}
