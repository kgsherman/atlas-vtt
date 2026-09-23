/**
 * Scene builders and result accessors shared by the vision tests.
 */
import { createFloor, createLevel, createScene, createToken } from "../scene/factory"
import type { Id, Level, Rect, Scene, SceneObject, Token } from "../scene/types"
import { SUBCELLS, type GradeMask, type VisibilityResult } from "./types"

export interface TestScene {
  scene: Scene
  ground: Id
}

/** One flat level fully covered by a floor. Light: "bright" everywhere, or "dark" everywhere. */
export function flat(width: number, depth: number, light: "bright" | "dark" = "bright"): TestScene {
  const scene = createScene({ width, depth })
  scene.environment.skyLevel = light
  scene.environment.ambientLevel = light
  return { scene, ground: Object.keys(scene.levels)[0] }
}

export function add<T extends SceneObject>(scene: Scene, o: T): T {
  scene.objects[o.id] = o
  return o
}

export function addLevel(scene: Scene, partial: Partial<Level>, floor?: Rect): Level {
  const level = createLevel(partial)
  scene.levels[level.id] = level
  if (floor) add(scene, createFloor(level.id, floor))
  return level
}

export function addToken(scene: Scene, levelId: Id, x: number, z: number, partial: Partial<Token> = {}): Token {
  const t = createToken(levelId, { x, z }, partial)
  scene.tokens[t.id] = t
  return t
}

/** A new scene revision (immutable-update style) with a changed object. */
export function withObject<T extends SceneObject>(scene: Scene, o: T): Scene {
  return { ...scene, objects: { ...scene.objects, [o.id]: o } }
}

export function withoutObject(scene: Scene, id: Id): Scene {
  const objects = { ...scene.objects }
  delete objects[id]
  return { ...scene, objects }
}

export function withToken(scene: Scene, t: Token): Scene {
  return { ...scene, tokens: { ...scene.tokens, [t.id]: t } }
}

export function mask(res: VisibilityResult, levelId: Id): GradeMask | undefined {
  return res.perception[levelId]
}

/** Grade of cell (i, j) on a level (0 when the level is absent). */
export function grade(res: VisibilityResult, levelId: Id, i: number, j: number): number {
  const m = res.perception[levelId]
  return m ? m.grades[j * m.width + i] : 0
}

/** Sub-cell mask of a partial cell, or undefined when the cell is uniform. */
export function partial(res: VisibilityResult, levelId: Id, i: number, j: number): number | undefined {
  const m = res.perception[levelId]
  return m ? m.partial.get(j * m.width + i) : undefined
}

export function subPerceived(res: VisibilityResult, levelId: Id, i: number, j: number, sx: number, sz: number): boolean {
  const m = res.perception[levelId]
  if (!m || m.grades[j * m.width + i] === 0) return false
  const p = m.partial.get(j * m.width + i)
  if (p === undefined) return true
  return (p & (1 << (sz * SUBCELLS + sx))) !== 0
}

/** Number of cells with grade > 0 on a level. */
export function perceivedCount(res: VisibilityResult, levelId: Id): number {
  const m = res.perception[levelId]
  if (!m) return 0
  let n = 0
  for (let k = 0; k < m.grades.length; k++) if (m.grades[k] > 0) n++
  return n
}

export function sunlitCell(res: VisibilityResult, levelId: Id, i: number, j: number): boolean {
  const m = res.sunlit[levelId]
  if (!m) return false
  const k = j * m.width + i
  return (m.bits[k >> 3] & (1 << (k & 7))) !== 0
}
