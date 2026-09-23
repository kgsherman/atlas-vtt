/**
 * Layout for the level axis (the expanded level switcher): the elevation range it shows, its ticks, and
 * where each level's label sits so labels never overlap yet stay as close as they can to their level.
 * Framework-free.
 */

/** Feet shown past the lowest / highest level, and the least range the axis ever shows. */
const MARGIN = 10
const MIN_LOW = -10
const MIN_HIGH = 50

/** Elevation range of the axis: min(lowest − 10, −10) → max(highest + 10, 50). */
export function levelAxisBounds(elevations: readonly number[]): { lo: number; hi: number } {
  let lo = MIN_LOW
  let hi = MIN_HIGH
  for (const e of elevations) {
    lo = Math.min(lo, e - MARGIN)
    hi = Math.max(hi, e + MARGIN)
  }
  return { lo, hi }
}

/** Round tick values (1, 2, 2.5 or 5 × 10ⁿ apart) covering [lo, hi], about `target` of them. */
export function axisTicks(lo: number, hi: number, target = 6): number[] {
  if (!(hi > lo)) return [lo]
  const raw = (hi - lo) / target
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow
  const ticks: number[] = []
  for (let k = Math.ceil(lo / step); k * step <= hi + 1e-9; k++) ticks.push(Math.round(k * step * 1e6) / 1e6)
  return ticks
}

/**
 * Label positions for ascending `targets`: the least-squares closest positions that are at least `gap`
 * apart and inside [lo, hi]. Substituting wᵢ = zᵢ − i·gap turns the gap constraint into wᵢ ≤ wᵢ₊₁, so this
 * is an isotonic regression (pool adjacent violators) of tᵢ − i·gap, clipped to the shifted bounds, which
 * is optimal for the bounded problem too. When the labels cannot fit they are spread evenly from `lo`.
 */
export function spreadLabels(targets: readonly number[], gap: number, lo: number, hi: number): number[] {
  const n = targets.length
  if (n === 0) return []
  const top = hi - (n - 1) * gap
  if (top < lo) return targets.map((_, i) => lo + (i * (hi - lo)) / Math.max(1, n - 1))

  // Pool adjacent violators: blocks of (mean, size), merged while a block's mean exceeds the next's.
  const mean: number[] = []
  const size: number[] = []
  for (let i = 0; i < n; i++) {
    let m = targets[i] - i * gap
    let s = 1
    while (mean.length > 0 && mean[mean.length - 1] > m) {
      const pm = mean.pop()!
      const ps = size.pop()!
      m = (pm * ps + m * s) / (ps + s)
      s += ps
    }
    mean.push(m)
    size.push(s)
  }

  const out: number[] = []
  for (let b = 0; b < mean.length; b++) {
    const w = Math.min(top, Math.max(lo, mean[b]))
    for (let k = 0; k < size[b]; k++) out.push(w + out.length * gap)
  }
  return out
}
