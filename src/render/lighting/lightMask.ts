/**
 * Per-cell point-light mask (PERFORMANCE §2 light culling): a small grid over XZ holding, per cell, a
 * bitmask of the uniform slots whose dim disc overlaps the cell. The world / token shaders skip a slot
 * whose bit is clear before fetching its uniforms (atPointLights), which removes the dead iterations of
 * the light loop (every slotted light otherwise pays a distance test per fragment). XZ only, so it is
 * conservative across levels: the in-loop `d >= dimRadius` test stays.
 *
 * Pure (no three.js): the lighting system uploads the result as an R32UI texture.
 */

/** Target cell size (feet) and the largest grid side; the cell grows when the discs span more. */
export const LIGHT_MASK_CELL = 10
export const LIGHT_MASK_MAX_SIDE = 256
/** Discs are grown by this much (feet) so float rounding on the GPU side can never lose a lit cell. */
const DISC_MARGIN = 0.05

export interface LightMaskSlot {
  x: number
  z: number
  /** Dim radius (feet). */
  dim: number
}

export interface LightMask {
  /** World XZ of the grid's corner. */
  originX: number
  originZ: number
  /** Cell size (feet). */
  cell: number
  width: number
  depth: number
  /** Row-major by z then x: bits[j * width + i], bit s = slot s. */
  bits: Uint32Array
}

/**
 * Mask of `slots` (at most 32, in uniform slot order) over the XZ bounds of their dim discs. null when no
 * slot has a positive, finite radius (nothing to draw: the shader then treats every bit as clear).
 */
export function buildLightMask(slots: readonly LightMaskSlot[], cellSize = LIGHT_MASK_CELL, maxSide = LIGHT_MASK_MAX_SIDE): LightMask | null {
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  const n = Math.min(slots.length, 32)
  for (let s = 0; s < n; s++) {
    const l = slots[s]
    if (!(l.dim > 0) || !Number.isFinite(l.x + l.z + l.dim)) continue
    x0 = Math.min(x0, l.x - l.dim - DISC_MARGIN)
    z0 = Math.min(z0, l.z - l.dim - DISC_MARGIN)
    x1 = Math.max(x1, l.x + l.dim + DISC_MARGIN)
    z1 = Math.max(z1, l.z + l.dim + DISC_MARGIN)
  }
  if (!(x1 > x0 && z1 > z0)) return null
  const cell = Math.max(cellSize, (x1 - x0) / maxSide, (z1 - z0) / maxSide)
  const width = Math.min(maxSide, Math.max(1, Math.ceil((x1 - x0) / cell)))
  const depth = Math.min(maxSide, Math.max(1, Math.ceil((z1 - z0) / cell)))
  const bits = new Uint32Array(width * depth)
  for (let s = 0; s < n; s++) {
    const l = slots[s]
    if (!(l.dim > 0) || !Number.isFinite(l.x + l.z + l.dim)) continue
    const bit = (1 << s) >>> 0
    const r = l.dim + DISC_MARGIN
    const r2 = r * r
    const i0 = Math.max(0, Math.floor((l.x - r - x0) / cell))
    const i1 = Math.min(width - 1, Math.floor((l.x + r - x0) / cell))
    const j0 = Math.max(0, Math.floor((l.z - r - z0) / cell))
    const j1 = Math.min(depth - 1, Math.floor((l.z + r - z0) / cell))
    for (let j = j0; j <= j1; j++) {
      const cz0 = z0 + j * cell
      const dz = Math.max(cz0 - l.z, 0, l.z - (cz0 + cell))
      for (let i = i0; i <= i1; i++) {
        const cx0 = x0 + i * cell
        const dx = Math.max(cx0 - l.x, 0, l.x - (cx0 + cell))
        // Closed disc ∩ closed cell rectangle.
        if (dx * dx + dz * dz <= r2) bits[j * width + i] = (bits[j * width + i] | bit) >>> 0
      }
    }
  }
  return { originX: x0, originZ: z0, cell, width, depth, bits }
}

/** Slot bits at world (x, z): 0 outside the grid (no disc reaches there). Mirrors atLightMaskAt. */
export function lightMaskAt(mask: LightMask, x: number, z: number): number {
  const i = Math.floor((x - mask.originX) / mask.cell)
  const j = Math.floor((z - mask.originZ) / mask.cell)
  if (i < 0 || j < 0 || i >= mask.width || j >= mask.depth) return 0
  return mask.bits[j * mask.width + i]
}

/**
 * Packed point-light slots (uniforms.ts layout, `vec4s` vec4 per slot) → the mask's slot list: position
 * XZ and dim radius. Read from the packed uniform array so the mask sees exactly what the shader does.
 */
export function packedLightSlots(packed: Float32Array, count: number, vec4s: number): LightMaskSlot[] {
  const out: LightMaskSlot[] = []
  for (let k = 0; k < count; k++) {
    const o = k * vec4s * 4
    out.push({ x: packed[o], z: packed[o + 2], dim: packed[o + 3] })
  }
  return out
}

/**
 * Whether `key` (count, then x, z, dim per slot) still describes `slots`; if not, it is rewritten. The
 * mask is rebuilt only then: slots are re-ranked every frame, so a light's slot can change without any
 * light moving.
 */
export function updateLightMaskKey(key: Float32Array, slots: readonly LightMaskSlot[]): boolean {
  let same = key[0] === slots.length
  for (let k = 0; k < slots.length && same; k++) {
    const o = 1 + k * 3
    same = key[o] === slots[k].x && key[o + 1] === slots[k].z && key[o + 2] === slots[k].dim
  }
  if (same) return true
  key[0] = slots.length
  for (let k = 0; k < slots.length; k++) {
    const o = 1 + k * 3
    key[o] = slots[k].x
    key[o + 1] = slots[k].z
    key[o + 2] = slots[k].dim
  }
  return false
}
