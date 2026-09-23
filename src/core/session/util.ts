/**
 * Small JSON-value helpers shared by memory, filter and diff.
 */

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Structural equality of JSON-like values (key order ignored, undefined-valued keys count as present). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let k = 0; k < a.length; k++) if (!deepEqual(a[k], b[k])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra)
  if (ka.length !== Object.keys(rb).length) return false
  for (const k of ka) {
    if (!Object.hasOwn(rb, k) || !deepEqual(ra[k], rb[k])) return false
  }
  return true
}

/** Canonical short decimal for ids (3 decimals, no "-0"). */
export function fmtCoord(v: number): string {
  const r = Math.round(v * 1000) / 1000
  return String(r === 0 ? 0 : r)
}

/** `${sourceId}@${x},${z}`: deterministic id of a clipped wall/floor piece (its first corner). */
export function pieceId(sourceId: string, x: number, z: number): string {
  return `${sourceId}@${fmtCoord(x)},${fmtCoord(z)}`
}

export function sortedKeys(rec: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(rec).sort()
}
