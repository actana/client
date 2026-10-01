// The Shared-folder frames (client#4): codec round-trip, rejection, the `shared`
// capability, the protocol bump, and — the part that matters most — that no key
// ever comes back out of an error or a formatter.

import { describe, it, expect } from "vitest";
import {
  CORE_LINK_PROTOCOL_VERSION,
  CORE_LINK_REDACTED,
  CoreLinkSharedFrameError,
  coreLinkProtocolCompatible,
  describeCoreLinkSharedFrame,
  parseCoreLinkRequestFrame,
  parseCoreLinkSharedRequest,
  parseCoreLinkSharedStatus,
  readSharedCapability,
  redactCoreLinkSharedFrame,
  serializeCoreLinkFrame,
  type CoreLinkRequestFrame,
  type CoreLinkServerFrame,
} from "../link-frames";

const SECRETS = {
  accessKeyId: "AKIA-SECRET-ID-7f3a",
  secretAccessKey: "SECRET-ACCESS-KEY-9c1d",
  sessionToken: "SESSION-TOKEN-b82e",
};
const EXPIRES = "2026-10-01T13:00:00.000Z";

const attach = (): CoreLinkRequestFrame => ({
  type: "sharedAttach",
  reqId: "r1",
  endpoint: "https://s3.example.com",
  bucket: "actana-shared",
  prefix: "shared/core-a/",
  region: "us-east-1",
  credentials: { ...SECRETS },
  expiresAt: EXPIRES,
});
const refresh = (): CoreLinkRequestFrame => ({
  type: "sharedCredentials",
  reqId: "r2",
  credentials: { ...SECRETS },
  expiresAt: EXPIRES,
});
const detach = (): CoreLinkRequestFrame => ({ type: "sharedDetach", reqId: "r3", keepLocalCopy: true });

const leaks = (text: string) => Object.values(SECRETS).filter((s) => text.includes(s));

describe("Shared-folder request frames round-trip", () => {
  it.each([
    ["sharedAttach", attach],
    ["sharedCredentials", refresh],
    ["sharedDetach", detach],
  ])("%s parses back to what was sent", (_name, make) => {
    const frame = make();
    expect(parseCoreLinkRequestFrame(JSON.stringify(frame))).toEqual(frame);
    expect(parseCoreLinkSharedRequest(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
  });

  it("a sharedStatus reply round-trips for every state", () => {
    const replies: CoreLinkServerFrame[] = [
      { type: "sharedStatus", reqId: "r1", status: { state: "attached", expiresAt: EXPIRES } },
      { type: "sharedStatus", reqId: "r3", status: { state: "detached", keptLocalCopy: true } },
      { type: "sharedStatus", reqId: "r2", status: { state: "error", code: "not-attached", message: "no mount" } },
    ];
    for (const reply of replies) {
      expect(parseCoreLinkSharedStatus(JSON.parse(serializeCoreLinkFrame(reply)))).toEqual(reply);
    }
  });
});

describe("Shared-folder request frames are rejected when malformed", () => {
  const bad: Array<[string, unknown]> = [
    ["attach without an endpoint", { ...attach(), endpoint: undefined }],
    ["attach with a non-URL endpoint", { ...attach(), endpoint: "not a url" }],
    ["attach with a file: endpoint", { ...attach(), endpoint: "file:///etc/passwd" }],
    ["attach with credentials in the endpoint", { ...attach(), endpoint: "https://u:p@s3.example.com" }],
    ["attach with an empty bucket", { ...attach(), bucket: "" }],
    ["attach with a leading-slash prefix", { ...attach(), prefix: "/shared/" }],
    ["attach without a region", { ...attach(), region: undefined }],
    ["attach with a missing sessionToken", { ...attach(), credentials: { ...SECRETS, sessionToken: undefined } }],
    ["attach with a numeric secretAccessKey", { ...attach(), credentials: { ...SECRETS, secretAccessKey: 5 } }],
    ["attach with an extra credential field", { ...attach(), credentials: { ...SECRETS, extra: "x" } }],
    ["attach with credentials as a string", { ...attach(), credentials: "AKIA" }],
    ["attach with an unparseable expiresAt", { ...attach(), expiresAt: "T-minus-soon" }],
    ["attach with an epoch-number expiresAt", { ...attach(), expiresAt: 1790000000 }],
    ["refresh without expiresAt", { ...refresh(), expiresAt: undefined }],
    ["refresh without reqId", { ...refresh(), reqId: undefined }],
    ["detach with keepLocalCopy false", { ...detach(), keepLocalCopy: false }],
    ["detach with no keepLocalCopy", { type: "sharedDetach", reqId: "r3" }],
  ];

  it.each(bad)("%s", (_name, frame) => {
    expect(parseCoreLinkRequestFrame(JSON.stringify(frame))).toBeNull();
    expect(() => parseCoreLinkSharedRequest(JSON.parse(JSON.stringify(frame)))).toThrow(CoreLinkSharedFrameError);
  });

  it("rejects a non-Shared-folder type and a non-object", () => {
    expect(() => parseCoreLinkSharedRequest({ type: "write", reqId: "r" })).toThrow(CoreLinkSharedFrameError);
    expect(() => parseCoreLinkSharedRequest(null)).toThrow(CoreLinkSharedFrameError);
  });

  it("rejects a malformed sharedStatus", () => {
    expect(() => parseCoreLinkSharedStatus({ type: "sharedStatus", reqId: "r", status: { state: "weird" } })).toThrow(
      CoreLinkSharedFrameError,
    );
    expect(() =>
      parseCoreLinkSharedStatus({ type: "sharedStatus", reqId: "r", status: { state: "attached", expiresAt: "x" } }),
    ).toThrow(CoreLinkSharedFrameError);
  });
});

describe("secrets never come back out", () => {
  // Every malformed variant carries real-looking secrets; none of them may surface.
  const withSecrets: unknown[] = [
    { ...attach(), endpoint: "https://AKIA-SECRET-ID-7f3a:SECRET-ACCESS-KEY-9c1d@s3.example.com" },
    { ...attach(), bucket: "" },
    { ...attach(), expiresAt: SECRETS.sessionToken },
    { ...attach(), credentials: { ...SECRETS, sessionToken: 42 } },
    { ...attach(), credentials: { ...SECRETS, secretAccessKey: [SECRETS.secretAccessKey] } },
    { ...attach(), credentials: { ...SECRETS, [SECRETS.secretAccessKey]: "x" } },
    { ...attach(), credentials: { ...SECRETS, extra: SECRETS.secretAccessKey } },
    { ...refresh(), reqId: "" },
    { ...refresh(), expiresAt: SECRETS.secretAccessKey },
  ];

  it("a thrown validation error carries no secret, in its message, name, stack or fields", () => {
    for (const frame of withSecrets) {
      let caught: unknown;
      try {
        parseCoreLinkSharedRequest(frame);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CoreLinkSharedFrameError);
      const err = caught as CoreLinkSharedFrameError;
      expect(leaks(`${err.message}\n${err.name}\n${err.stack}\n${JSON.stringify(err)}\n${String(err)}`)).toEqual([]);
    }
  });

  it("the formatter redacts accessKeyId, secretAccessKey and sessionToken", () => {
    for (const frame of [attach(), refresh()]) {
      const text = describeCoreLinkSharedFrame(frame);
      expect(leaks(text)).toEqual([]);
      expect(text).toContain(CORE_LINK_REDACTED);
      expect(text).toContain("accessKeyId");
    }
  });

  it("redacting copies: the original frame still carries the key it must send", () => {
    const frame = attach();
    const copy = redactCoreLinkSharedFrame(frame);
    expect(copy).not.toBe(frame);
    expect(leaks(JSON.stringify(copy))).toEqual([]);
    expect(leaks(JSON.stringify(frame))).toHaveLength(3);
  });

  it("redacts a stray credential field too, whatever its name", () => {
    const frame = { ...attach(), credentials: { ...SECRETS, surprise: "SURPRISE-VALUE" } } as unknown as CoreLinkRequestFrame;
    expect(describeCoreLinkSharedFrame(frame)).not.toContain("SURPRISE-VALUE");
  });

  it("leaves a frame with no credentials as it was", () => {
    const frame = detach();
    expect(redactCoreLinkSharedFrame(frame)).toBe(frame);
    expect(describeCoreLinkSharedFrame(frame)).toBe(JSON.stringify(frame));
  });
});

describe("the `shared` capability on `ready`", () => {
  it("reads version 1 and nothing else", () => {
    expect(readSharedCapability({ version: 1 })).toEqual({ version: 1 });
    expect(readSharedCapability({ version: 2 })).toBeNull();
    expect(readSharedCapability(undefined)).toBeNull();
    expect(readSharedCapability("1")).toBeNull();
  });

  it("travels on a ready frame and is optional", () => {
    const withShared: CoreLinkServerFrame = {
      type: "ready",
      version: CORE_LINK_PROTOCOL_VERSION,
      shared: { version: 1 },
    };
    const ready = JSON.parse(serializeCoreLinkFrame(withShared)) as { shared?: unknown };
    expect(readSharedCapability(ready.shared)).toEqual({ version: 1 });
    const without: CoreLinkServerFrame = { type: "ready", version: CORE_LINK_PROTOCOL_VERSION };
    expect(readSharedCapability((JSON.parse(serializeCoreLinkFrame(without)) as { shared?: unknown }).shared)).toBeNull();
  });
});

describe("the protocol version moved for the Shared-folder frames", () => {
  it("is 0.19.0, and a 0.18.0 Core is incompatible", () => {
    expect(CORE_LINK_PROTOCOL_VERSION).toBe("0.19.0");
    expect(coreLinkProtocolCompatible("0.18.0")).toBe(false);
    expect(coreLinkProtocolCompatible("0.19.2")).toBe(true);
  });
});
