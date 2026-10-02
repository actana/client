// Orchestration skill payload — shipped as package data, not Control machine modules.
//
// `data/orchestration-skill.json` holds the authored skill folders byte-for-byte.
// ADR 0031 D8: embedded at install time rather than read from a live repo path.
//
// **The JSON is a static import, and has to stay one.** This module used to read the file at load
// from `import.meta.url`. A bundler that emits CommonJS (the Core's tarball bundles this CLI that
// way) has no `import.meta.url`, so `fileURLToPath(undefined)` threw the moment the module was
// evaluated and the whole CLI crashed at start (actana/control#578). A static import is something
// every bundler resolves and inlines; `orchestration-skill-payload.test.ts` bundles this module to
// CommonJS and starts it, so a dynamic read cannot come back unnoticed.

import payload from "../../data/orchestration-skill.json" with { type: "json" };

export type OrchestrationSkillPayload = {
  names: readonly string[];
  marker: string;
  files: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

const loaded: OrchestrationSkillPayload = payload;

/** The skill directory names — their addresses in a harness's skills root. */
export const ORCHESTRATION_SKILL_NAMES: readonly string[] = loaded.names;

/** The in-band marker that makes a copy ours (ADR 0031 D1). */
export const ORCHESTRATION_SKILL_MARKER: string = loaded.marker;

/** Authored skill folders: folder name → relative path → contents. */
export const ORCHESTRATION_SKILL_FILES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = loaded.files;
