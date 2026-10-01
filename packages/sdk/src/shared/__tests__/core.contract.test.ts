// The contract suite against the through-the-Core mode, on a fake Core HTTP server
// built from control PR 620 / 619 route shapes. Real-Core runs are control's job.
import { createThroughCoreShared } from "../core.ts";
import { runCoreSharedContract } from "./contract.ts";
import { fakeCoreFetch, startFakeCoreFiles } from "./fake-core-files.ts";

runCoreSharedContract("through the Core on a fake Files API", async () => {
  const core = await startFakeCoreFiles();
  return {
    shared: createThroughCoreShared({
      baseUrl: core.baseUrl,
      bearer: null,
      fetch: fakeCoreFetch(),
      events: core.events,
    }),
    dispose: () => core.close(),
  };
});
