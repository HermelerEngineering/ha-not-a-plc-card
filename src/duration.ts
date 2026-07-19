/**
 * Human-friendly durations for timer presets.
 *
 * The IR keeps `preset_ms` in **milliseconds** — that stays canonical and the
 * backend is untouched. These pure helpers only translate for the editor, so a
 * preset can be typed as `5s` / `3m` / `1h` instead of `5000` / `180000` /
 * `3600000`. A bare number means **seconds**: sub-second presets are pointless
 * given the ~500 ms minimum scan cycle, so seconds is the natural default.
 */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parse a duration like `500ms`, `5s`, `2.5m`, `1h`, or a bare `5` (= 5 s) into
 * milliseconds. Returns `undefined` for anything unparseable, so the caller can
 * keep the previous value rather than clobbering it on a typo.
 */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(text.trim().toLowerCase());
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const ms = Math.round(value * UNIT_MS[match[2] ?? "s"]);
  return ms >= 0 ? ms : undefined;
}

/**
 * Format milliseconds with the largest unit that divides it exactly, so a value
 * typed as `3m` comes back as `3m` rather than `180000ms`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms === 0) return "0s";
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`;
  if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m}m`;
  if (ms % UNIT_MS.s === 0) return `${ms / UNIT_MS.s}s`;
  return `${ms}ms`;
}
