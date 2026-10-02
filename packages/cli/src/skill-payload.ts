// The `@actana/cli/skill-payload` subpath: the orchestration skill payload and nothing else.
//
// A host that bundles the skill folders (the Core daemon, a small Core helper) imports them from here
// instead of from the package root, because the root pulls in the whole client and its `ws`
// dependency. This module's graph is the payload module and its static JSON import, and
// `skill-payload-subpath.test.ts` bundles it and fails if any other client code, `ws` or the SDK
// gets in. The values are the root's own: the root re-exports from the same module.

export {
  ORCHESTRATION_SKILL_FILES,
  ORCHESTRATION_SKILL_NAMES,
  ORCHESTRATION_SKILL_MARKER,
} from "./core/orchestration-skill-payload.ts";
