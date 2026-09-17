import { describe } from "vitest";
import { createMemoryPairingStore } from "../stores/memory.ts";
import { pairingStoreContract } from "./store-contract.ts";

describe("memory pairing store", () => {
  pairingStoreContract(() => createMemoryPairingStore());
});
