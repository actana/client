// The one hole in the mTLS wall, asserted as a rule rather than as a route
// (#282). Carried from actana/control's `core-preauth-gate.test.ts`, with
// Search's exact-path predicate and the open-path set made explicit.
import { describe, expect, it } from "vitest";
import { PAIRING_REDEEM_PATH } from "../../wire.js";
import {
  clientCertGate,
  coreLinkUpgradeGate,
  DEFAULT_OPEN_PATHS,
  openPathPredicate,
  rejectUnauthorizedAtHandshake,
  upgradeGate,
} from "../preauth-gate.js";

const isPairingPath = openPathPredicate([PAIRING_REDEEM_PATH]);
const isOpenPath = openPathPredicate(DEFAULT_OPEN_PATHS);

describe("clientCertGate", () => {
  it("serves anything to a connection that presented a verified certificate", () => {
    expect(clientCertGate({ pathname: "/v1/files", authorized: true })).toBe("serve");
    expect(clientCertGate({ pathname: PAIRING_REDEEM_PATH, authorized: true, isPreAuthPath: isPairingPath })).toBe(
      "serve",
    );
  });

  it("serves the pairing path to a connection that presented none", () => {
    expect(
      clientCertGate({ pathname: PAIRING_REDEEM_PATH, authorized: false, isPreAuthPath: isPairingPath }),
    ).toBe("serve");
  });

  it("refuses every other path to that connection", () => {
    for (const pathname of ["/v1/files", "/v1/files/list", "/healthz", "/"]) {
      expect(clientCertGate({ pathname, authorized: false, isPreAuthPath: isPairingPath })).toBe("refuse");
    }
  });

  it("refuses everything when no pre-auth surface is configured", () => {
    expect(clientCertGate({ pathname: PAIRING_REDEEM_PATH, authorized: false })).toBe("refuse");
  });

  it("is not fooled by a path that merely starts like the pairing prefix", () => {
    expect(
      clientCertGate({ pathname: "/v1/pairing-secrets", authorized: false, isPreAuthPath: isPairingPath }),
    ).toBe("refuse");
  });
});

describe("upgradeGate", () => {
  it("has no pairing exception at all", () => {
    expect(upgradeGate(true)).toBe("serve");
    expect(upgradeGate(false)).toBe("refuse");
  });
});

/** @deprecated alias kept for Control callers during the lift */
describe("coreLinkUpgradeGate", () => {
  it("delegates to upgradeGate", () => {
    expect(coreLinkUpgradeGate(true)).toBe("serve");
    expect(coreLinkUpgradeGate(false)).toBe("refuse");
  });
});

describe("rejectUnauthorizedAtHandshake", () => {
  it("keeps the TLS refusal when no pre-auth surface is mounted", () => {
    expect(rejectUnauthorizedAtHandshake(undefined)).toBe(true);
  });

  it("relaxes it only where a pre-auth surface exists", () => {
    expect(rejectUnauthorizedAtHandshake(isPairingPath)).toBe(false);
  });
});

describe("the pre-auth hole is exactly one route wide", () => {
  it("names the redeem path and nothing else under the pairing prefix", () => {
    expect(isPairingPath(PAIRING_REDEEM_PATH)).toBe(true);
    expect(isPairingPath("/v1/pair/status")).toBe(false);
    expect(isPairingPath("/v1/pair/")).toBe(false);
    expect(isPairingPath("/v1/pair/redeem/extra")).toBe(false);
    expect(isPairingPath("/v1/pairing/redeem")).toBe(false);
  });

  it("refuses prefix and trailing-slash variants of the redeem path", () => {
    for (const pathname of ["/v1/pair/redeem/extra", "/v1/pair/redeem/", "/v1/pair/"]) {
      expect(clientCertGate({ pathname, authorized: false, isPreAuthPath: isPairingPath })).toBe("refuse");
    }
  });

  it("refuses `/v1/pair/status` to a connection that presented no certificate", () => {
    expect(
      clientCertGate({ pathname: "/v1/pair/status", authorized: false, isPreAuthPath: isPairingPath }),
    ).toBe("refuse");
  });
});

describe("openPathPredicate", () => {
  it("defaults to the redeem route only", () => {
    expect(DEFAULT_OPEN_PATHS).toEqual([PAIRING_REDEEM_PATH]);
    expect(isOpenPath(PAIRING_REDEEM_PATH)).toBe(true);
    expect(isOpenPath("/v1/health")).toBe(false);
  });

  it("matches pathnames exactly, not by prefix", () => {
    const open = openPathPredicate(["/v1/pair/redeem", "/v1/health"]);
    expect(open("/v1/pair/redeem")).toBe(true);
    expect(open("/v1/health")).toBe(true);
    expect(open("/v1/pair/redeem/")).toBe(false);
    expect(open("/v1/health/details")).toBe(false);
  });
});

describe("the client-certificate gate, with revocation", () => {
  it("refuses a revoked certificate even though the handshake accepted it", () => {
    expect(clientCertGate({ pathname: "/v1/files", authorized: true, revoked: true })).toBe("refuse");
  });

  it("still serves an unrevoked one", () => {
    expect(clientCertGate({ pathname: "/v1/files", authorized: true, revoked: false })).toBe("serve");
  });

  it("gives revocation no pre-auth exception", () => {
    expect(
      clientCertGate({
        pathname: PAIRING_REDEEM_PATH,
        authorized: true,
        revoked: true,
        isPreAuthPath: isPairingPath,
      }),
    ).toBe("refuse");
  });

  it("checks revocation before authorized", () => {
    expect(
      clientCertGate({
        pathname: PAIRING_REDEEM_PATH,
        authorized: true,
        revoked: true,
        isPreAuthPath: isPairingPath,
      }),
    ).toBe("refuse");
    expect(
      clientCertGate({
        pathname: PAIRING_REDEEM_PATH,
        authorized: false,
        revoked: true,
        isPreAuthPath: isPairingPath,
      }),
    ).toBe("refuse");
  });

  it("is unchanged for every server that has revoked nothing", () => {
    expect(clientCertGate({ pathname: "/v1/files", authorized: true })).toBe("serve");
    expect(clientCertGate({ pathname: "/v1/files", authorized: false })).toBe("refuse");
  });
});

describe("the upgrade gate, with revocation", () => {
  it("refuses a revoked certificate", () => {
    expect(upgradeGate(true, true)).toBe("refuse");
  });

  it("is unchanged otherwise", () => {
    expect(upgradeGate(true)).toBe("serve");
    expect(upgradeGate(false)).toBe("refuse");
  });
});
