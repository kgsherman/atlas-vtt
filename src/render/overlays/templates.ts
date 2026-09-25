/**
 * Areas of effect on the map (contracts.ts TemplateOverlay, ARCHITECTURE §6.6): per template, the squares
 * it covers on every drawn level as a translucent fill with a line around the covered region (both
 * depth-tested, so tokens, walls and props stand over them), the shape's own outline draped over the
 * ground of its level (drawn through geometry, so the whole shape always reads), and a dot at its point
 * of origin. Each template's Object3D owns its geometries; materials are cached per colour and state.
 */
import * as THREE from "three"

import { groundIndex, type GroundIndex } from "@/core/scene/queries"
import type { Id, SceneLike, Vec2, Vec3 } from "@/core/scene/types"

import type { TemplateOverlay } from "../contracts"
import { aaLineGeometry, createAALineMaterial, polylinePairs } from "../materials/aaLineMaterial"
import { createEdgeAAMaterial, edgeGeometry } from "../materials/edgeAAMaterial"
import { discEdgeGeometry } from "./ribbon"

/** Draw order within the overlay root (under rulers and move paths: 13–14). */
export const TEMPLATE_ORDER = 12
/** Height of the fill above the ground (feet); a polygon offset keeps it over the floor it covers. */
const FILL_LIFT = 0.05
const LINE_LIFT = 0.1
/** Corners are sampled this far inside their cell (a cell edge on a stair or floor edge reads its own side). */
const CORNER_INSET = 0.02
/** Outline points at most this far apart (feet), so it drapes over terrain. */
const OUTLINE_STEP = 1
const POLYGON_OFFSET = { factor: -1, units: -4 }

type Style = { fill: number; region: number; outline: number; width: number }

const STYLES: Record<NonNullable<TemplateOverlay["state"]>, Style> = {
  normal: { fill: 0.3, region: 0.8, outline: 0.9, width: 1.5 },
  selected: { fill: 0.4, region: 1, outline: 1, width: 2.5 },
  draft: { fill: 0.36, region: 0.95, outline: 1, width: 2 },
}

export interface TemplateDrawContext {
  scene: SceneLike
  /** Whether a level's contents are drawn (cells on hidden levels are skipped). */
  drawn(levelId: Id): boolean
  /** World units per CSS pixel (the origin dot's size). */
  worldPerPixel: number
}

/** Shared materials (per colour, state and role), freed with the manager. */
export class TemplateMaterials {
  private readonly cache = new Map<string, THREE.Material>()

  private get<T extends THREE.Material>(key: string, make: () => T): T {
    let m = this.cache.get(key) as T | undefined
    if (!m) {
      m = make()
      m.userData.shared = true
      this.cache.set(key, m)
    }
    return m
  }

  fill(color: string, opacity: number): THREE.Material {
    return this.get(`fill|${color}|${opacity}`, () => {
      const m = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      })
      m.polygonOffset = true
      m.polygonOffsetFactor = POLYGON_OFFSET.factor
      m.polygonOffsetUnits = POLYGON_OFFSET.units
      return m
    })
  }

  line(color: string, opacity: number, width: number, depthTest: boolean): THREE.Material {
    return this.get(`line|${color}|${opacity}|${width}|${depthTest}`, () => {
      const m = createAALineMaterial(color, { opacity, width, depthTest })
      if (depthTest) {
        m.polygonOffset = true
        m.polygonOffsetFactor = POLYGON_OFFSET.factor
        m.polygonOffsetUnits = POLYGON_OFFSET.units
      }
      return m
    })
  }

  dot(color: string): THREE.Material {
    return this.get(`dot|${color}`, () => createEdgeAAMaterial(color, { opacity: 0.95 }))
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose()
    this.cache.clear()
  }
}

/** Ground height on a level at a point (stairs and terrain included). */
function heightOn(ground: GroundIndex, levelId: Id, x: number, z: number): number {
  return ground.groundHeightAt(levelId, { x, z })
}

/** Fill triangles of covered cells, each corner on the ground of its cell. */
export function cellFillGeometry(scene: SceneLike, ground: GroundIndex, levelId: Id, cells: readonly number[]): THREE.BufferGeometry {
  const w = scene.grid.width
  const cs = scene.grid.cellSize
  const pos = new Float32Array(cells.length * 12)
  const index = new Uint32Array(cells.length * 6)
  cells.forEach((c, k) => {
    const i = c % w
    const j = Math.floor(c / w)
    const x0 = i * cs
    const z0 = j * cs
    const corners: [number, number, number, number][] = [
      [x0, z0, x0 + CORNER_INSET, z0 + CORNER_INSET],
      [x0 + cs, z0, x0 + cs - CORNER_INSET, z0 + CORNER_INSET],
      [x0 + cs, z0 + cs, x0 + cs - CORNER_INSET, z0 + cs - CORNER_INSET],
      [x0, z0 + cs, x0 + CORNER_INSET, z0 + cs - CORNER_INSET],
    ]
    corners.forEach(([x, z, sx, sz], v) => pos.set([x, heightOn(ground, levelId, sx, sz) + FILL_LIFT, z], (k * 4 + v) * 3))
    index.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6)
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  return g
}

/**
 * Segment pairs of the covered region's boundary: every cell edge between a covered cell and one that is
 * not, at the covered cell's ground.
 */
export function regionBoundaryPairs(scene: SceneLike, ground: GroundIndex, levelId: Id, cells: readonly number[]): Float32Array {
  const w = scene.grid.width
  const d = scene.grid.depth
  const cs = scene.grid.cellSize
  const set = new Set(cells)
  const has = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < d && set.has(j * w + i)
  const out: number[] = []
  const y = (x: number, z: number, cx: number, cz: number) =>
    heightOn(ground, levelId, x + Math.sign(cx - x) * CORNER_INSET, z + Math.sign(cz - z) * CORNER_INSET) + LINE_LIFT
  for (const c of cells) {
    const i = c % w
    const j = Math.floor(c / w)
    const x0 = i * cs
    const z0 = j * cs
    const x1 = x0 + cs
    const z1 = z0 + cs
    const cx = x0 + cs / 2
    const cz = z0 + cs / 2
    const edge = (ax: number, az: number, bx: number, bz: number) => out.push(ax, y(ax, az, cx, cz), az, bx, y(bx, bz, cx, cz), bz)
    if (!has(i, j - 1)) edge(x0, z0, x1, z0)
    if (!has(i + 1, j)) edge(x1, z0, x1, z1)
    if (!has(i, j + 1)) edge(x1, z1, x0, z1)
    if (!has(i - 1, j)) edge(x0, z1, x0, z0)
  }
  return new Float32Array(out)
}

/** The outline densified (≤ OUTLINE_STEP apart) and draped over the level's ground. */
export function drapedOutline(ground: GroundIndex, levelId: Id, outline: readonly Vec2[]): Vec3[] {
  const out: Vec3[] = []
  const n = outline.length
  for (let k = 0; k < n; k++) {
    const a = outline[k]
    const b = outline[(k + 1) % n]
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / OUTLINE_STEP))
    for (let s = 0; s < steps; s++) {
      const x = a.x + ((b.x - a.x) * s) / steps
      const z = a.z + ((b.z - a.z) * s) / steps
      out.push({ x, y: heightOn(ground, levelId, x, z) + LINE_LIFT, z })
    }
  }
  return out
}

/** One template's meshes. */
export function buildTemplate(t: TemplateOverlay, ctx: TemplateDrawContext, materials: TemplateMaterials): THREE.Object3D {
  const root = new THREE.Object3D()
  root.name = `template:${t.id}`
  const style = STYLES[t.state ?? "normal"]
  const ground = groundIndex(ctx.scene)
  for (const levelId of Object.keys(t.cells).sort()) {
    const cells = t.cells[levelId]
    if (cells.length === 0 || !Object.hasOwn(ctx.scene.levels, levelId) || !ctx.drawn(levelId)) continue
    root.add(new THREE.Mesh(cellFillGeometry(ctx.scene, ground, levelId, cells), materials.fill(t.color, style.fill)))
    const pairs = regionBoundaryPairs(ctx.scene, ground, levelId, cells)
    if (pairs.length > 0) root.add(new THREE.Mesh(aaLineGeometry(pairs), materials.line(t.color, style.region, 1.75, true)))
  }
  if (Object.hasOwn(ctx.scene.levels, t.levelId) && ctx.drawn(t.levelId)) {
    if (t.outline.length >= 2) {
      const pts = drapedOutline(ground, t.levelId, t.outline)
      root.add(new THREE.Mesh(aaLineGeometry(polylinePairs(pts, true)), materials.line(t.color, style.outline, style.width, false)))
    }
    const y = heightOn(ground, t.levelId, t.origin.x, t.origin.z) + LINE_LIFT + 0.02
    const r = Math.max(0.35, ctx.worldPerPixel * 4.5)
    root.add(new THREE.Mesh(edgeGeometry(discEdgeGeometry(t.origin.x, y, t.origin.z, r, 20)), materials.dot(t.color)))
  }
  root.traverse((o) => {
    o.renderOrder = TEMPLATE_ORDER
    o.frustumCulled = false
    o.raycast = () => {}
  })
  return root
}

/** Free a template's geometries (its materials are shared). */
export function disposeTemplate(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) m.geometry.dispose()
  })
  root.removeFromParent()
}
