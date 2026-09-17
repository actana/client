import { describe, expect, it } from "vitest";
import { peerCertIdentityFromSocket } from "../identity.js";

describe("peerCertIdentityFromSocket", () => {
  it("returns null when the socket did not authorize the certificate", () => {
    const identity = peerCertIdentityFromSocket({
      authorized: false,
      getPeerCertificate: () => ({
        serialNumber: "DEADBEEF",
        fingerprint256: "AA:BB:CC:DD",
      }),
    });
    expect(identity).toBeNull();
  });

  it("returns null when authorized is not strictly true", () => {
    expect(
      peerCertIdentityFromSocket({
        authorized: undefined,
        getPeerCertificate: () => ({ serialNumber: "DEADBEEF" }),
      }),
    ).toBeNull();
  });

  it("returns null when no certificate is presented", () => {
    expect(
      peerCertIdentityFromSocket({
        authorized: true,
        getPeerCertificate: () => ({}),
      }),
    ).toBeNull();
  });

  it("returns null when getPeerCertificate is absent", () => {
    expect(peerCertIdentityFromSocket({ authorized: true })).toBeNull();
  });

  it("returns null when getPeerCertificate throws", () => {
    expect(
      peerCertIdentityFromSocket({
        authorized: true,
        getPeerCertificate: () => {
          throw new Error("not a TLS socket");
        },
      }),
    ).toBeNull();
  });

  it("returns null when the certificate has no serial", () => {
    expect(
      peerCertIdentityFromSocket({
        authorized: true,
        getPeerCertificate: () => ({ fingerprint256: "AA:BB:CC:DD" }),
      }),
    ).toBeNull();
  });

  it("reads serial and fingerprint from a verified certificate", () => {
    expect(
      peerCertIdentityFromSocket({
        authorized: true,
        getPeerCertificate: () => ({
          serialNumber: "0a1b2c",
          fingerprint256: "AA:BB:CC:DD",
        }),
      }),
    ).toEqual({ serial: "0a1b2c", fingerprint: "AA:BB:CC:DD" });
  });

  it("returns null fingerprint when only serial is present", () => {
    expect(
      peerCertIdentityFromSocket({
        authorized: true,
        getPeerCertificate: () => ({ serialNumber: "0a1b2c" }),
      }),
    ).toEqual({ serial: "0a1b2c", fingerprint: null });
  });
});
