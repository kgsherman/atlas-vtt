/**
 * A compact, JSON-friendly summary of a scene for library cards: counts plus a 2D top-down
 * schematic of one level (floors by material, walls, doors, windows, props, lights, tokens). Pure:
 * no DOM, so it can be computed anywhere and cached (localStorage) per scene version.
 */
import { MATERIAL_COLORS, PROP_LIBRARY } from "@/core/scene/defaults"
import { floorRects, openingSegment, sortedLevels, tokenRect } from "@/core/scene/queries"
import type { Id, Level, Rect, Scene, SceneLike, SceneObject, WallObject } from "@/core/scene/types"

export const DIGEST_VERSION = 1

/** [x, z, w, d, paletteIndex] */
export type DRect = [number, number, number, number, number]
/** [x1, z1, x2, z2, thickness] */
export type DSegment = [number, number, number, number, number]
/** [x, z, w, d, rotationDeg, paletteIndex] */
export type DBox = [number, number, number, number, number, number]
/** [x, z, radius, paletteIndex] */
export type DCircle = [number, number, number, number]
/** [x, z, dimRadius, brightRadius, paletteIndex] */
export type DLight = [number, number, number, number, number]

export interface LevelDigest {
  levelId: Id
  name: string
  elevation: number
  floors: DRect[]
  walls: DSegment[]
  doors: DSegment[]
  windows: DSegment[]
  /** [x, z, w, d, style] with style 0 = stairs, 1 = ladder, 2 = ramp. */
  connectors: DRect[]
  pillars: DCircle[]
  props: DBox[]
  lights: DLight[]
  tokens: DCircle[]
  backdrop: { assetId: Id; rect: [number, number, number, number] } | null
  /** Content bounds (feet), with a margin. */
  bounds: [number, number, number, number]
}

export interface SceneDigest {
  v: typeof DIGEST_VERSION
  grid: { width: number; depth: number; cellSize: number }
  levels: Array<{ id: Id; name: string; elevation: number }>
  counts: { objects: number; walls: number; doors: number; lights: number; tokens: number; props: number; images: number }
  /** Colours referenced by index from the level digests (material, prop, light and token colours). */
  palette: string[]
  primary: LevelDigest
}

export interface DigestLimits {
  floors: number
  walls: number
  props: number
  lights: number
  tokens: number
}

const DEFAULT_LIMITS: DigestLimits = { floors: 800, walls: 2000, props: 600, lights: 64, tokens: 120 }

const r1 = (v: number) => Math.round(v * 10) / 10

/** Deduplicating colour table shared by the digests of one scene. */
export class Palette {
  readonly colors: string[] = []
  private readonly index = new Map<string, number>()
  of(color: string): number {
    const c = color.toLowerCase()
    let i = this.index.get(c)
    if (i === undefined) {
      i = this.colors.length
      this.colors.push(c)
      this.index.set(c, i)
    }
    return i
  }
}

/** The level a card shows: the storey nearest elevation 0 that has floors (ties: more content). */
export function primaryLevel(scene: SceneLike): Level {
  const levels = sortedLevels(scene)
  const content = new Map<Id, { floors: number; total: number }>()
  for (const o of Object.values(scene.objects)) {
    const c = content.get(o.levelId) ?? { floors: 0, total: 0 }
    c.total++
    if (o.type === "floor") c.floors++
    content.set(o.levelId, c)
  }
  let best = levels[0]
  let bestKey: [number, number, number] | null = null
  for (const level of levels) {
    const c = content.get(level.id) ?? { floors: 0, total: 0 }
    const key: [number, number, number] = [c.floors > 0 || level.backdrop ? 0 : 1, Math.abs(level.elevation), -c.total]
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
      best = level
      bestKey = key
    }
  }
  return best
}

/** Schematic of one level. */
export function levelDigest(
  scene: SceneLike,
  levelId: Id,
  palette: Palette = new Palette(),
  limits: DigestLimits = DEFAULT_LIMITS
): LevelDigest & { palette: string[] } {
  const level = scene.levels[levelId]
  const out: LevelDigest = {
    levelId,
    name: level?.name ?? "",
    elevation: level?.elevation ?? 0,
    floors: [],
    walls: [],
    doors: [],
    windows: [],
    connectors: [],
    pillars: [],
    props: [],
    lights: [],
    tokens: [],
    backdrop: null,
    bounds: [0, 0, scene.grid.width * scene.grid.cellSize, scene.grid.depth * scene.grid.cellSize],
  }
  // Framing: the map image if any, else the built part (walls, stairs, pillars), else the floors —
  // so a tavern in a big yard is shown as a tavern, not as a lawn.
  const makeBox = () => ({ minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity })
  const image = makeBox()
  const built = makeBox()
  const ground = makeBox()
  const growBox = (box: ReturnType<typeof makeBox>, x: number, z: number) => {
    box.minX = Math.min(box.minX, x)
    box.minZ = Math.min(box.minZ, z)
    box.maxX = Math.max(box.maxX, x)
    box.maxZ = Math.max(box.maxZ, z)
  }
  const grow = (x: number, z: number) => growBox(built, x, z)
  const growRect = (r: Rect, box = built) => {
    growBox(box, r.x, r.z)
    growBox(box, r.x + r.w, r.z + r.d)
  }

  if (level?.backdrop) {
    const b = level.backdrop.rect
    out.backdrop = { assetId: level.backdrop.assetId, rect: [r1(b.x), r1(b.z), r1(b.w), r1(b.d)] }
    growRect(b, image)
  }

  const floors: Array<{ rect: Rect; color: number }> = []
  for (const o of Object.values(scene.objects) as SceneObject[]) {
    if (o.levelId !== levelId && !(o.type === "light" && o.attachedTokenId)) continue
    switch (o.type) {
      case "floor": {
        const color = palette.of(MATERIAL_COLORS[o.material] ?? MATERIAL_COLORS.stone)
        for (const rect of floorRects(o)) floors.push({ rect, color })
        growRect(o.rect, ground)
        break
      }
      case "wall":
        out.walls.push([r1(o.a.x), r1(o.a.z), r1(o.b.x), r1(o.b.z), r1(o.thickness)])
        grow(o.a.x, o.a.z)
        grow(o.b.x, o.b.z)
        break
      case "door":
      case "window": {
        const wall = scene.objects[o.wallId] as WallObject | undefined
        if (!wall || wall.type !== "wall") break
        const seg = openingSegment(wall, o)
        const entry: DSegment = [r1(seg.a.x), r1(seg.a.z), r1(seg.b.x), r1(seg.b.z), r1(wall.thickness)]
        if (o.type === "door") out.doors.push(entry)
        else out.windows.push(entry)
        break
      }
      case "connector":
        growRect(o.rect)
        out.connectors.push([r1(o.rect.x), r1(o.rect.z), r1(o.rect.w), r1(o.rect.d), o.style === "ladder" ? 1 : o.style === "ramp" ? 2 : 0])
        break
      case "pillar":
        grow(o.position.x, o.position.z)
        out.pillars.push([r1(o.position.x), r1(o.position.z), r1(o.size / 2), o.shape === "square" ? 1 : 0])
        break
      case "prop": {
        const def = PROP_LIBRARY[o.kind]
        if (!def) break
        const w = def.size.x * o.scale.x
        const d = def.size.z * o.scale.z
        out.props.push([r1(o.position.x), r1(o.position.z), r1(w), r1(d), Math.round((o.rotationY * 180) / Math.PI), palette.of(o.color ?? def.defaultColor)])
        break
      }
      case "light": {
        if (!o.on || o.hidden) break
        let x = o.position.x
        let z = o.position.z
        if (o.attachedTokenId) {
          const t = scene.tokens[o.attachedTokenId]
          if (!t || t.levelId !== levelId || t.hidden) break
          x += t.position.x
          z += t.position.z
        }
        out.lights.push([r1(x), r1(z), r1(o.dimRadius), r1(o.brightRadius), palette.of(o.color)])
        break
      }
    }
  }
  for (const t of Object.values(scene.tokens)) {
    if (t.levelId !== levelId) continue
    const rect = tokenRect(scene, t)
    out.tokens.push([r1(t.position.x), r1(t.position.z), r1((rect.w / 2) * 0.8), palette.of(t.color)])
  }

  // Biggest floor pieces first so a cap keeps the overall shape.
  floors.sort((a, b) => b.rect.w * b.rect.d - a.rect.w * a.rect.d)
  out.floors = floors.slice(0, limits.floors).map(({ rect, color }) => [r1(rect.x), r1(rect.z), r1(rect.w), r1(rect.d), color])
  out.walls = out.walls.slice(0, limits.walls)
  out.props = out.props.slice(0, limits.props)
  out.lights.sort((a, b) => b[2] - a[2])
  out.lights = out.lights.slice(0, limits.lights)
  out.tokens = out.tokens.slice(0, limits.tokens)

  const box = Number.isFinite(image.minX) ? image : Number.isFinite(built.minX) ? built : ground
  if (Number.isFinite(box.minX)) {
    const w = box.maxX - box.minX
    const d = box.maxZ - box.minZ
    const margin = box === image ? 0 : box === built ? Math.max(5, Math.max(w, d) * 0.12) : Math.max(2.5, Math.max(w, d) * 0.04)
    out.bounds = [r1(box.minX - margin), r1(box.minZ - margin), r1(w + 2 * margin), r1(d + 2 * margin)]
  }
  return { ...out, palette: palette.colors }
}

export function sceneDigest(scene: Scene, limits: DigestLimits = DEFAULT_LIMITS): SceneDigest {
  const objects = Object.values(scene.objects)
  const count = (type: SceneObject["type"]) => objects.filter((o) => o.type === type).length
  const palette = new Palette()
  const primary = primaryLevel(scene)
  const { palette: colors, ...level } = levelDigest(scene, primary.id, palette, limits)
  return {
    v: DIGEST_VERSION,
    grid: { width: scene.grid.width, depth: scene.grid.depth, cellSize: scene.grid.cellSize },
    levels: sortedLevels(scene).map((l) => ({ id: l.id, name: l.name, elevation: l.elevation })),
    counts: {
      objects: objects.length,
      walls: count("wall"),
      doors: count("door"),
      lights: count("light"),
      tokens: Object.keys(scene.tokens).length,
      props: count("prop"),
      images: Object.keys(scene.assets ?? {}).length,
    },
    palette: colors,
    primary: level,
  }
}

/** Structural check for cached digests (localStorage is untrusted input). */
export function isSceneDigest(value: unknown): value is SceneDigest {
  if (typeof value !== "object" || value === null) return false
  const d = value as Partial<SceneDigest>
  return (
    d.v === DIGEST_VERSION &&
    Array.isArray(d.levels) &&
    Array.isArray(d.palette) &&
    typeof d.counts === "object" &&
    typeof d.primary === "object" &&
    d.primary !== null &&
    Array.isArray(d.primary.floors) &&
    Array.isArray(d.primary.walls) &&
    Array.isArray(d.primary.bounds)
  )
}
