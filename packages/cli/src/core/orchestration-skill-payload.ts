// Orchestration skill payload — shipped as package data, not Control machine modules.
//
// `data/orchestration-skill.json` holds the authored skill folders byte-for-byte.
// ADR 0031 D8: embedded at install time rather than read from a live repo path.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type OrchestrationSkillPayload = {
  names: readonly string[];
  marker: string;
  files: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

let cached: OrchestrationSkillPayload | null = null;

function loadPayload(): OrchestrationSkillPayload {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const jsonPath = path.join(here, "../../data/orchestration-skill.json");
  const raw = fs.readFileSync(jsonPath, "utf8");
  cached = JSON.parse(raw) as OrchestrationSkillPayload;
  return cached;
}

/** The skill directory names — their addresses in a harness's skills root. */
export const ORCHESTRATION_SKILL_NAMES: readonly string[] = loadPayload().names;

/** The in-band marker that makes a copy ours (ADR 0031 D1). */
export const ORCHESTRATION_SKILL_MARKER: string = loadPayload().marker;

/** Authored skill folders: folder name → relative path → contents. */
export const ORCHESTRATION_SKILL_FILES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = loadPayload().files;
