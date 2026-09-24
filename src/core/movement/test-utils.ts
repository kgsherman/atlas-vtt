/**
 * Scene builders shared by the movement tests (real scenes from core/scene/factory, real occlusion).
 */
import { buildOcclusionWorld } from "../occlusion"
import { createFloor, createLevel, createScene, createToken } from "../scene/factory"
import { createHeightmap, sampleCounts, writeHeights } from "../scene/heightmap"
import type { Cell, Id, Level, Scene, SceneObject, TerrainResolution, Token } from "../scene/types"
import { anchorPosition, findPath, validateMove } from "./index"
import type { MoveOptions, MoveValidation, PathStep } from "./types"

/** A flat scene (default 10 × 10 cells) whose ground level has a full floor. */
export function flatScene(width = 10, depth = 10): { scene: Scene; levelId: Id } {
  const scene = createScene({ width, depth })
  return { scene, levelId: Object.keys(scene.levels)[0] }
}

export function add<T extends SceneObject>(scene: Scene, o: T): T {
  scene.objects[o.id] = o
  return o
}

/** Add a level; with `floor`, a floor covering the whole grid (connector cutouts apply). */
export function addLevel(scene: Scene, partial: Partial<Level>, floor = true): Level {
  const level = createLevel(partial)
  scene.levels[level.id] = level
  if (floor) {
    const s = scene.grid.cellSize
    add(scene, createFloor(level.id, { x: 0, z: 0, w: scene.grid.width * s, d: scene.grid.depth * s }))
  }
  return level
}

/** Give a level a heightmap whose relative height at lattice point (x, z) is f(x, z). */
export function paintHeightmap(scene: Scene, levelId: Id, f: (x: number, z: number) => number, resolution: TerrainResolution = 2): void {
  const level = scene.levels[levelId]
  const hm = level.heightmap ?? createHeightmap(resolution)
  const { samplesX, samplesZ } = sampleCounts(scene.grid, hm.resolution)
  const s = scene.grid.cellSize / hm.resolution
  const dense = new Float32Array(samplesX * samplesZ)
  for (let j = 0; j < samplesZ; j++) for (let i = 0; i < samplesX; i++) dense[j * samplesX + i] = f(i * s, j * s)
  scene.levels[levelId] = { ...level, heightmap: writeHeights(hm, scene.grid, dense) }
}

/** A token whose footprint is anchored at `anchor`. */
export function tokenAt(scene: Scene, levelId: Id, anchor: Cell, partial: Partial<Token> = {}): Token {
  const size = partial.size ?? "medium"
  const token = createToken(levelId, anchorPosition(scene, size, anchor), partial)
  scene.tokens[token.id] = token
  return token
}

export const at = (i: number, j: number, levelId: Id): PathStep => ({ cell: { i, j }, levelId })

/** Path through cells on one level. */
export const walk = (levelId: Id, cells: [number, number][]): PathStep[] => cells.map(([i, j]) => at(i, j, levelId))

/** validateMove against a freshly built occlusion world (speed not enforced unless asked). */
export function check(scene: Scene, token: Token, path: PathStep[], opts: Partial<MoveOptions> = {}): MoveValidation {
  return validateMove(scene, buildOcclusionWorld(scene), token, path, { enforceSpeed: false, ...opts })
}

/** Place a token at a path step (anchor + level). */
export function place(scene: Scene, token: Token, s: PathStep): Token {
  token.position = anchorPosition(scene, token.size, s.cell)
  token.levelId = s.levelId
  return token
}

/** Single-step shorthand: places the token at `from`, returns "ok" or the reject reason of from → to. */
export function stepResult(scene: Scene, token: Token, from: PathStep, to: PathStep): string {
  place(scene, token, from)
  const r = check(scene, token, [from, to])
  return r.ok ? "ok" : (r.reason ?? "?")
}

export function path(scene: Scene, token: Token, target: PathStep, opts?: { maxSteps?: number; nodeLimit?: number }): PathStep[] | null {
  return findPath(scene, buildOcclusionWorld(scene), token, target, opts)
}
