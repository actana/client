// Where Pi keeps its agent directory, for the skills fan-out (ported from Control's `@actana/shared`
// `pi-agent-dir.ts`, actana/client#11). Pi's skill folder follows `$PI_CODING_AGENT_DIR`, so the marker that
// says "Pi is on this machine" has to follow it too, or the skill is written under a directory Pi never reads.

import * as os from "node:os";
import * as path from "node:path";

/**
 * Pi's agent config directory, resolved the way Pi resolves it: `$PI_CODING_AGENT_DIR` when set (a leading
 * `~` expanded), otherwise `~/.pi/agent`.
 */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv.replace(/^~(?=$|[/\\])/, home));
  return path.join(home, ".pi", "agent");
}

/**
 * Marker directories that mean "Pi is on this machine" for the skills fan-out (Control #518 part 3).
 *
 * Without `$PI_CODING_AGENT_DIR` that is `~/.pi`. With it set, it is the directory {@link piAgentDir} resolves
 * to: home-relative when that path sits under `home`, absolute otherwise. The installer keeps an absolute marker
 * absolute (`orchestration-skill-install.ts`).
 */
export function piHomeMarkers(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): readonly string[] {
  if (!env.PI_CODING_AGENT_DIR?.trim()) return [".pi"];

  const agentDir = piAgentDir(env, home);
  const relative = path.relative(path.resolve(home), agentDir);
  if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return [relative.split(path.sep).join("/")];
  }
  return [agentDir];
}

/**
 * Resolve Pi's homeMarkers on a skill-target table at call time. The table keeps a static `.pi` marker; the
 * writer calls this with the environment and the home it is writing under before handing it to the installer.
 */
export function withPiHomeMarkersResolved<T extends { harness: string; homeMarkers: readonly string[] }>(
  targets: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): T[] {
  return targets.map((target) =>
    target.harness === "pi" ? { ...target, homeMarkers: piHomeMarkers(env, home) } : target,
  );
}
