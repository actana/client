// @actana/sdk/shared — Node-only. CoreShared: list, get, put, mkdir, rm, move, upload, watch and
// signedUrl on a Core's Shared folder; this entry holds the direct-S3 mode.
// Never import this from a browser-safe entry (./core/link-frames must stay Node-free).

export * from "./shared/index.ts";
