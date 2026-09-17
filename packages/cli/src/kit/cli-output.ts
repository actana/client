// Output helpers: a column-aligned table, and the JSON writer.
//
// Both exist so that "every list command emits `--json`" (#129 D10) is one
// decision made once. A noun renders rows; it does not decide how a table is
// spaced or how JSON is terminated, and it cannot accidentally emit a table on
// the `--json` path.

/** Render a header row plus body rows as a left-aligned, space-padded table. */
export function formatTable(header: string[], rows: string[][]): string[] {
  const all = [header, ...rows];
  const widths = header.map((_, column) =>
    all.reduce((wide, row) => Math.max(wide, (row[column] ?? "").length), 0),
  );
  return all.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join("  ")
      .trimEnd(),
  );
}

/**
 * Serialize a `--json` payload.
 *
 * Two spaces and a trailing newline, matching every other JSON this repository
 * writes. Machine-readable does not mean unreadable, and a payload a human can
 * skim in a terminal is what makes `--json` the flag people reach for when they
 * are debugging rather than only when they are scripting.
 */
export function formatJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

/** An ISO timestamp as a local wall clock, for a line a person reads. */
export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/** `in 4m 58s`, `12s ago`, `now`. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const delta = at - now;
  const seconds = Math.round(Math.abs(delta) / 1000);
  if (seconds === 0) return "now";
  const parts: string[] = [];
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (rest && parts.length < 2) parts.push(`${rest}s`);
  const span = parts.slice(0, 2).join(" ");
  return delta >= 0 ? `in ${span}` : `${span} ago`;
}

/** `—` for an absent value, so a table never has a hole in it. */
export function orDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}
