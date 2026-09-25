/**
 * What an area of effect reaches (docs/ARCHITECTURE.md §6.6), from the 3D occlusion world:
 *
 *  - A point is in the area when it lies in the shape's volume (shape.ts) AND a straight line from the
 *    point of origin reaches it (5e "line of effect": only an obstruction giving total cover stops it).
 *    Lines are tested on the LIGHT channel (what casts shadows: walls, closed doors that block light,
 *    window sills and lintels but not the glass, pillars, floor slabs and terrain, stairs, solid props),
 *    from the origin pushed out of any blocker it lies in (core/vision resolveLightOrigin).
 *  - A cell (5 ft square) is covered on a level when it has ground there and some point of its standing
 *    column (the column's point nearest the origin's height, its foot, middle and top: 0.25 to 5 ft above
 *    the ground, below the ceiling) is in the area. Every level is considered, so a fireball in a
 *    courtyard reaches the balcony above it, but not the room behind the balcony's wall or the cellar
 *    under the courtyard's paving.
 *  - A token is affected when a point of one of its columns is in the area: the centres of the squares
 *    it occupies (squares whose centre is inside its footprint; its own centre when it stands off the
 *    grid and covers no square centre), from 0.25 ft above the ground up to its height (the column's
 *    point nearest the origin's height, its foot, middle and head, below the ceiling). This is the 5e grid
 *    rule (a creature in an affected square is affected) with the creature's own height: a halfling
 *    behind a low wall is spared where a giant is not.
 *
 * Each viewer runs this on the scene it has: the DM on the whole scene, a player on the scene built
 * from their view (they get no occluder they have not seen, so nothing is learnt from the result).
 */
import { SIZE_FOOTPRINT } from "../scene/defaults"
import { groundIndex, levelById, levelCeilingY, sortedLevels, type GroundIndex } from "../scene/queries"
import type { GridSettings, Id, SceneLike, Token, Vec2, Vec3 } from "../scene/types"
import type { OcclusionWorld, SegmentQueryOptions } from "../occlusion/types"
import { resolveLightOrigin } from "../vision/eye"
import { areaVolume, type AreaVolume } from "./shape"
import type { AreaGeometry } from "./types"

/** The standing column sampled per cell: from this far above the ground… */
export const CELL_COLUMN_LOW = 0.25
/** …up to this far (kept CELL_CEILING_MARGIN below the ceiling). */
export const CELL_COLUMN_HIGH = 5
const CELL_CEILING_MARGIN = 0.25

const LIGHT: SegmentQueryOptions = { channel: "light" }

export interface AreaEffect {
  /** Where lines of effect start: the nominal origin pushed out of any light blocker it lies in. */
  origin: Vec3
  /** Covered cells per level id: ascending cell indices (j · grid.width + i). Levels with none are absent. */
  cells: Record<Id, number[]>
  /** Affected tokens (of those tested), sorted by id. */
  tokenIds: Id[]
}

export interface AreaEffectOptions {
  /** Tokens to test (default: every token of the scene). */
  tokens?: Iterable<Token>
  /** The scene's GroundIndex (default: groundIndex(scene), memoised; pass one for scenes changed in place). */
  ground?: GroundIndex
  /** Skip the cells (only tokens are needed). */
  noCells?: boolean
}

const EMPTY: AreaEffect = { origin: { x: 0, y: 0, z: 0 }, cells: {}, tokenIds: [] }

/**
 * The area's reach in `scene` (a normalised geometry, see normalizeArea), with lines of effect tested in
 * `world` (the occlusion world of the same scene).
 */
export function computeAreaEffect(scene: SceneLike, world: OcclusionWorld, g: AreaGeometry, opts: AreaEffectOptions = {}): AreaEffect {
  if (!levelById(scene, g.levelId)) return EMPTY
  const ground = opts.ground ?? groundIndex(scene)
  const groundY = ground.groundHeightAt(g.levelId, { x: g.x, z: g.z })
  const vol = areaVolume(g, groundY)
  const origin = resolveLightOrigin(world, vol.origin, groundY)
  const reaches = (p: Vec3) => vol.contains(p) && !world.segmentBlocked(origin, p, LIGHT)
  const cells = opts.noCells ? {} : coveredCells(scene, ground, vol, reaches)
  const tokenIds: Id[] = []
  const cs = scene.grid.cellSize
  const b = vol.bounds
  for (const t of opts.tokens ?? Object.values(scene.tokens)) {
    const half = (SIZE_FOOTPRINT[t.size] * cs) / 2
    const x = t.position.x
    const z = t.position.z
    if (x + half < b.minX || x - half > b.maxX || z + half < b.minZ || z - half > b.maxZ) continue
    if (!levelById(scene, t.levelId)) continue
    const ceiling = levelCeilingY(scene, t.levelId) - CELL_CEILING_MARGIN
    const height = Math.max(t.height, CELL_COLUMN_LOW + 0.1)
    const hit = tokenColumns(scene.grid, t).some((c) => {
      const gy = ground.groundHeightAt(t.levelId, c)
      const lo = gy + CELL_COLUMN_LOW
      const hi = Math.max(lo, Math.min(gy + height - 0.1, ceiling))
      return columnReached(c.x, c.z, lo, hi, vol, reaches)
    })
    if (hit) tokenIds.push(t.id)
  }
  tokenIds.sort()
  return { origin, cells, tokenIds }
}

function coveredCells(scene: SceneLike, ground: GroundIndex, vol: AreaVolume, reaches: (p: Vec3) => boolean): Record<Id, number[]> {
  const grid = scene.grid
  const cs = grid.cellSize
  const b = vol.bounds
  const i0 = Math.max(0, Math.floor(b.minX / cs))
  const i1 = Math.min(grid.width - 1, Math.floor(b.maxX / cs))
  const j0 = Math.max(0, Math.floor(b.minZ / cs))
  const j1 = Math.min(grid.depth - 1, Math.floor(b.maxZ / cs))
  const out: Record<Id, number[]> = {}
  if (i0 > i1 || j0 > j1) return out
  for (const level of sortedLevels(scene)) {
    const ceiling = levelCeilingY(scene, level.id) - CELL_CEILING_MARGIN
    const list: number[] = []
    for (let j = j0; j <= j1; j++) {
      const z = (j + 0.5) * cs
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * cs
        const c = { x, z }
        if (!ground.hasGroundAt(level.id, c)) continue
        const gy = ground.groundHeightAt(level.id, c)
        const lo = gy + CELL_COLUMN_LOW
        const hi = Math.max(lo, Math.min(gy + CELL_COLUMN_HIGH, ceiling))
        if (columnReached(x, z, lo, hi, vol, reaches)) list.push(j * grid.width + i)
      }
    }
    if (list.length > 0) out[level.id] = list
  }
  return out
}

/**
 * Whether the area reaches a vertical column [lo, hi] at (x, z): its point nearest the origin's height,
 * then its foot, middle and top (a column entirely outside the volume's height range is skipped).
 */
function columnReached(x: number, z: number, lo: number, hi: number, vol: AreaVolume, reaches: (p: Vec3) => boolean): boolean {
  if (hi < vol.bounds.minY || lo > vol.bounds.maxY) return false
  const nearest = Math.min(hi, Math.max(lo, vol.origin.y))
  for (const y of [nearest, lo, (lo + hi) / 2, hi]) if (reaches({ x, y, z })) return true
  return false
}

/** The columns a token is tested at: centres of the squares it occupies, or its own centre when it covers none. */
function tokenColumns(grid: GridSettings, t: Pick<Token, "position" | "size">): Vec2[] {
  const cs = grid.cellSize
  const half = (SIZE_FOOTPRINT[t.size] * cs) / 2 + 1e-6
  const { x, z } = t.position
  const out: Vec2[] = []
  const i0 = Math.max(0, Math.ceil((x - half) / cs - 0.5))
  const i1 = Math.min(grid.width - 1, Math.floor((x + half) / cs - 0.5))
  const j0 = Math.max(0, Math.ceil((z - half) / cs - 0.5))
  const j1 = Math.min(grid.depth - 1, Math.floor((z + half) / cs - 0.5))
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push({ x: (i + 0.5) * cs, z: (j + 0.5) * cs })
  return out.length > 0 ? out : [{ x, z }]
}

/**
 * The geometry of an area carried by a token (an aura, Spirit Guardians…): centred on the token, on its
 * level, and for round shapes measured from the edge of its space (radius + half its footprint).
 */
export function areaAroundToken(g: AreaGeometry, token: Pick<Token, "levelId" | "position" | "size">, cellSize: number): AreaGeometry {
  const round = g.shape === "sphere" || g.shape === "cylinder"
  return {
    ...g,
    levelId: token.levelId,
    x: token.position.x,
    z: token.position.z,
    size: round ? g.size + (SIZE_FOOTPRINT[token.size] * cellSize) / 2 : g.size,
  }
}
