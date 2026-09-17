import { describe, expect, it } from "vitest";
import { PAIRING_REDEEM_PATH } from "../../wire.ts";
import {
  isOpenPath,
  openPathPredicateFrom,
  openPathnames,
} from "../preauth-gate.ts";

describe("open path specs", () => {
  const paths = [PAIRING_REDEEM_PATH, { method: "GET", path: "/v1/health" }];

  it("matches pathname-only entries for any method", () => {
    expect(isOpenPath("POST", PAIRING_REDEEM_PATH, paths)).toBe(true);
    expect(isOpenPath("GET", PAIRING_REDEEM_PATH, paths)).toBe(true);
  });

  it("matches method-specific entries exactly", () => {
    expect(isOpenPath("GET", "/v1/health", paths)).toBe(true);
    expect(isOpenPath("POST", "/v1/health", paths)).toBe(false);
  });

  it("refuses prefix variants", () => {
    expect(isOpenPath("GET", "/v1/health/details", paths)).toBe(false);
    expect(isOpenPath("POST", `${PAIRING_REDEEM_PATH}/extra`, paths)).toBe(false);
  });

  it("builds a pathname predicate from mixed entries", () => {
    const predicate = openPathPredicateFrom(paths);
    expect(openPathnames(paths)).toEqual([PAIRING_REDEEM_PATH, "/v1/health"]);
    expect(predicate(PAIRING_REDEEM_PATH)).toBe(true);
    expect(predicate("/v1/health")).toBe(true);
    expect(predicate("/v1/files")).toBe(false);
  });
});
