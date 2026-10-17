/**
 * Safe literal inlining.
 *
 * FalkorDB will not accept a query parameter inside a variable-length
 * relationship bound (`-[r:COUPLED*1..$hops]->`) — it fails at plan time with
 * "Encountered unhandled type in inlined properties". The only way to express a
 * bounded traversal with a runtime-chosen depth is to put the depth in the
 * Cypher text.
 *
 * That is only safe if the value cannot be anything but an integer, so it goes
 * through `intLiteral` rather than template interpolation. These strings are
 * never derived from user text, and the tests in `verify` exercise both ends of
 * the range.
 */
export function intLiteral(value: unknown, bounds: { min: number; max: number; fallback: number }): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(bounds.fallback);
  return String(Math.min(bounds.max, Math.max(bounds.min, Math.trunc(n))));
}

/** A float parameter is fine as a parameter; only relationship bounds need inlining. */
export function clampFloat(value: unknown, bounds: { min: number; max: number; fallback: number }): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}
