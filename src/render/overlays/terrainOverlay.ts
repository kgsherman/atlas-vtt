/**
 * The terrain editing mode's overlay (contracts.ts TerrainOverlay; ARCHITECTURE §7 "Terrain tools"): the
 * active level's shapes as translucent prisms over the baked terrain, the selection, the advanced mode's
 * elements, the shape being created, the translate gizmo and a value label (the brush ring is the brush
 * preview's, drawn by previews.ts).
 *
 * A shape's prism: the top is its footprint triangulated with core/scene/terrainShapes shapeTopTriangles
 * (the bake's triangulation, split along the shape's inner edges) at the per-vertex top heights, the sides run from the top down (or up, for a
 * pit) to the base; world Y = level elevation + value. There is no base cap (the base is not an element).
 * Faces are drawn twice: depth-tested with a polygon offset (tops coincide with the baked terrain) and as
 * a dim x-ray pass without depth test, so buried shapes and carved pits stay visible. A non-planar top
 * does not coincide with the terrain: the bake samples it on the lattice and interpolates across each
 * lattice triangle, which rises above a valley crease (by up to spacing·(√2/4)·|∇h_i − ∇h_j| for one
 * crease). The depth-tested fill of such a top is lifted by a bound on that (topLift), the x-ray fill and
 * the edges stay on the true top; planar tops are not lifted. Edges (the top
 * outline, the vertical edges and the base outline) are anti-aliased screen-space lines
 * (materials/aaLineMaterial), vertices are screen-space dots (materials/aaPointMaterial).
 *
 * Cost (up to 1000 shapes / 16000 points per level must stay interactive during drags and live-host
 * re-syncs): per-shape prism arrays are cached by shape object identity (a WeakMap: shapes are immutable,
 * a changed shape is a new object), and shapes are batched into two layers of merged geometry whose
 * GPU buffers are cached by the identity list of their shapes: the unselected shapes (untouched while the
 * selection is dragged) and the selected ones. A rebuild with the same shapes only creates a handful of
 * meshes around the cached geometries (`userData.cached`) and the shared materials (`userData.shared`),
 * which disposePreview skips; a layer's geometry is freed when its shape list changes or the overlay goes.
 * The hovered shape, the draft and element highlights are small and rebuilt with each overlay.
 *
 * The gizmo and the label are persistent objects (`decor`, attached once to the overlay root by the
 * OverlayManager) updated every frame by `frame()`: the arrows are drawn in screen space from
 * core/geometry/gizmo gizmoHandles, the same handles the tool hit-tests, so what is drawn is what is grabbed.
 * The loop cut preview is a set of element-coloured segments across the top (owned, rebuilt with each overlay).
 * The polygon being drawn is an outline of anti-aliased lines and corner dots (owned, rebuilt with each overlay).
 * The select sub-tool's marquee is a screen-space rect (canvas CSS px, the frame the tool tests vertices
 * and shapes in), drawn by its own tiny shader over everything else.
 */
import * as THREE from "three"

import { gizmoHandles, gizmoRing, GIZMO_RING_SEGMENTS, ringPoint, type GizmoAxis, type Projector } from "@/core/geometry/gizmo"
import { shapeEdgeCount, shapeEdgeEnds, shapeTopTriangles, signedArea, type TerrainElementRef } from "@/core/scene/terrainShapes"
import type { Id, TerrainShape } from "@/core/scene/types"

import type { TerrainOverlay } from "../contracts"
import { LAYER } from "../internal"
import { aaLineGeometry, createAALineMaterial, polylinePairs } from "../materials/aaLineMaterial"
import { aaPointGeometry, createAAPointMaterial } from "../materials/aaPointMaterial"
import { createGizmoArrowMaterial, gizmoArrowGeometry, GIZMO_SHAFT_HALF_PX } from "../materials/gizmoMaterial"
import { TextLabel } from "./label"

export const TERRAIN_OVERLAY_COLORS = {
  add: "#34d399",
  addLight: "#a7f3d0",
  addBright: "#6ee7b7",
  carve: "#fb923c",
  carveLight: "#fed7aa",
  carveBright: "#fdba74",
  invalid: "#f87171",
  /** Edges of the shape being created. */
  draft: "#f4f4f5",
  vertex: "#e4e4e7",
  element: "#fbbf24",
  elementHover: "#fef3c7",
  gizmo: { x: "#f87171", y: "#34d399", z: "#60a5fa" } as Record<GizmoAxis, string>,
  gizmoLight: { x: "#fecaca", y: "#a7f3d0", z: "#bfdbfe" } as Record<GizmoAxis, string>,
  gizmoCentre: "#f4f4f5",
  gizmoCentreFill: "#18181b",
  /** The selection box (the select tool's marquee colour). */
  marquee: "#60a5fa",
}

/**
 * Draw order inside the overlay root (tool previews default to 12): x-ray passes before depth-tested
 * ones, fills before edges, highlights, elements, the gizmo and the marquee last.
 */
export const TERRAIN_OVERLAY_ORDER = {
  xrayFill: 12.1,
  fill: 12.2,
  xrayEdge: 12.3,
  edge: 12.4,
  face: 12.5,
  elementEdge: 12.6,
  dot: 12.7,
  brush: 12.8,
  gizmo: 12.9,
  gizmoCentre: 12.95,
  marquee: 12.99,
}

/** Polygon offset of the depth-tested passes (pulled towards the camera: tops lie on the baked terrain). */
const POLYGON_OFFSET = { factor: -1, units: -6 }
/** A top vertex this close (ft) to the base has no vertical edge / side there. */
const FLAT_EPS = 1e-6

// ---------------------------------------------------------------------------
// Prisms
// ---------------------------------------------------------------------------

/** World-space geometry of one shape's prism (plain arrays; see shapePrism). */
export interface ShapePrism {
  /** Top triangles (9 floats each, non-indexed), wound so their normals face +Y. */
  top: Float32Array
  /**
   * Side triangles (9 floats each) wound so their normals face away from the footprint; a side whose top
   * meets the base at one end is a single triangle, and one that does at both ends has none.
   */
  sides: Float32Array
  /** Side face k is sides[sideStart[k] .. sideStart[k + 1]) (floats); n + 1 entries. */
  sideStart: Uint32Array
  /** Edge segment pairs (6 floats each): the top outline, the vertical edges, the base outline, the inner (loop cut) edges. */
  edges: Float32Array
  /** Top vertex positions (3 floats each), in the shape's point order. */
  vertices: Float32Array
  /**
   * How far (ft) the baked terrain can rise above the top between lattice samples (0 for a planar top or
   * without a lattice spacing): see topLift.
   */
  topLift: number
  /** The top raised by topLift, for the depth-tested fill (`top` itself when topLift is 0). */
  liftedTop: Float32Array
}

const prismCache = new WeakMap<TerrainShape, { elevation: number; spacing: number; prism: ShapePrism }>()

/**
 * The prism of a shape at a level elevation, over a terrain lattice of `spacing` feet (0: none, no lift),
 * cached by shape object identity (shapes are never mutated: an edit makes a new object, so a drag
 * re-meshes only the dragged shapes).
 */
export function shapePrism(shape: TerrainShape, elevation: number, spacing = 0): ShapePrism {
  const hit = prismCache.get(shape)
  if (hit && hit.elevation === elevation && hit.spacing === spacing) return hit.prism
  const prism = buildPrism(shape, elevation, spacing)
  prismCache.set(shape, { elevation, spacing, prism })
  return prism
}

/**
 * Bound (ft) on how far the lattice interpolation of a top (samples every `spacing` feet, linear over
 * each lattice triangle) rises above it. For any linear ℓ of gradient c, at p in lattice triangle
 * (v_k, weights λ_k): lattice value − h(p) = Σ λ_k ((h − ℓ)(v_k) − (h − ℓ)(p)) ≤ R·Σ λ_k |v_k − p|, with
 * R = max_j |∇h_j − c| over the top triangles, and Σ λ_k |v_k − p| ≤ spacing·√2/2 on a right isosceles
 * lattice triangle (at its hypotenuse's midpoint). c = the midpoint of the two most different slopes
 * (R = half their difference when there are two, e.g. a raised corner), and R never exceeds diameter/√3
 * (Jung). Also at most the top's height range (the interpolation of top samples stays within it). 0 for
 * a planar top.
 */
export function topLift(top: Float32Array, spacing: number): number {
  if (!(spacing > 0) || top.length < 18) return 0
  const gx: number[] = []
  const gz: number[] = []
  let lo = Infinity
  let hi = -Infinity
  for (let o = 0; o + 8 < top.length; o += 9) {
    for (let k = 1; k < 9; k += 3) {
      lo = Math.min(lo, top[o + k])
      hi = Math.max(hi, top[o + k])
    }
    const e1x = top[o + 3] - top[o]
    const e1z = top[o + 5] - top[o + 2]
    const e2x = top[o + 6] - top[o]
    const e2z = top[o + 8] - top[o + 2]
    const d1 = top[o + 4] - top[o + 1]
    const d2 = top[o + 7] - top[o + 1]
    const det = e1x * e2z - e1z * e2x
    // Slivers (collinear footprint vertices) have no meaningful slope; the height range still bounds them.
    if (!(Math.abs(det) > 1e-9)) continue
    gx.push((d1 * e2z - d2 * e1z) / det)
    gz.push((e1x * d2 - e2x * d1) / det)
  }
  // The two most different slopes (the set's diameter).
  let diameter = 0
  let a = 0
  let b = 0
  for (let i = 0; i < gx.length; i++) {
    for (let j = i + 1; j < gx.length; j++) {
      const d = Math.hypot(gx[i] - gx[j], gz[i] - gz[j])
      if (d > diameter) {
        diameter = d
        a = i
        b = j
      }
    }
  }
  const cx = (gx[a] + gx[b]) / 2
  const cz = (gz[a] + gz[b]) / 2
  let r = 0
  for (let i = 0; i < gx.length; i++) r = Math.max(r, Math.hypot(gx[i] - cx, gz[i] - cz))
  r = Math.min(r, diameter / Math.sqrt(3))
  const lift = Math.min(spacing * Math.SQRT1_2 * r, hi - lo)
  // Float noise of a planar top (its slopes agree to ~1e-7) is no crease.
  return lift > 1e-4 ? lift : 0
}

function buildPrism(shape: TerrainShape, elevation: number, spacing: number): ShapePrism {
  const pts = shape.points
  const n = pts.length
  const baseY = elevation + shape.base
  const tris = shapeTopTriangles(shape)
  // shapeTopTriangles' triples have cross(b − a, c − a) > 0 in (x, z), i.e. a −Y normal: reversed.
  const top = new Float32Array(tris.length * 3)
  for (let t = 0; t + 2 < tris.length; t += 3) {
    putPoint(top, t * 3, pts[tris[t]], elevation)
    putPoint(top, t * 3 + 3, pts[tris[t + 2]], elevation)
    putPoint(top, t * 3 + 6, pts[tris[t + 1]], elevation)
  }
  const lift = topLift(top, spacing)
  let liftedTop = top
  if (lift > 0) {
    liftedTop = top.slice()
    for (let k = 1; k < liftedTop.length; k += 3) liftedTop[k] += lift
  }
  const onBase = (k: number) => Math.abs(pts[k].y - shape.base) <= FLAT_EPS
  const sides = new Float32Array(n * 18)
  const sideStart = new Uint32Array(n + 1)
  const inner = shape.innerEdges ?? []
  const edges = new Float32Array(n * 18 + inner.length * 6)
  const vertices = new Float32Array(n * 3)
  const orientation = signedArea(pts) < 0 ? -1 : 1
  let s = 0
  let e = 0
  for (let k = 0; k < n; k++) {
    const a = pts[k]
    const b = pts[(k + 1) % n]
    const ay = elevation + a.y
    const by = elevation + b.y
    putPoint(vertices, k * 3, a, elevation)
    sideStart[k] = s
    // Outward horizontal normal of edge k.
    const ox = orientation * (b.z - a.z)
    const oz = -orientation * (b.x - a.x)
    if (!onBase((k + 1) % n)) s = writeOutward(sides, s, a.x, ay, a.z, b.x, by, b.z, b.x, baseY, b.z, ox, oz)
    if (!onBase(k)) s = writeOutward(sides, s, a.x, ay, a.z, b.x, baseY, b.z, a.x, baseY, a.z, ox, oz)
    e = putSegment(edges, e, a.x, ay, a.z, b.x, by, b.z)
  }
  sideStart[n] = s
  for (let k = 0; k < n; k++) {
    const a = pts[k]
    if (!onBase(k)) e = putSegment(edges, e, a.x, elevation + a.y, a.z, a.x, baseY, a.z)
  }
  for (let k = 0; k < n; k++) {
    const a = pts[k]
    const b = pts[(k + 1) % n]
    // A base edge under a top edge lying on the base is that top edge.
    if (!onBase(k) || !onBase((k + 1) % n)) e = putSegment(edges, e, a.x, baseY, a.z, b.x, baseY, b.z)
  }
  for (const [i, j] of inner) {
    const a = pts[i]
    const b = pts[j]
    e = putSegment(edges, e, a.x, elevation + a.y, a.z, b.x, elevation + b.y, b.z)
  }
  return { top, sides: trim(sides, s), sideStart, edges: trim(edges, e), vertices, topLift: lift, liftedTop }
}

const trim = (a: Float32Array, n: number) => (n === a.length ? a : a.slice(0, n))

function putPoint(out: Float32Array, o: number, p: { x: number; y: number; z: number }, elevation: number): void {
  out[o] = p.x
  out[o + 1] = elevation + p.y
  out[o + 2] = p.z
}

function putSegment(out: Float32Array, o: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  out[o] = ax
  out[o + 1] = ay
  out[o + 2] = az
  out[o + 3] = bx
  out[o + 4] = by
  out[o + 5] = bz
  return o + 6
}

/**
 * Triangle p, q, r written at `o` (skipped when degenerate), wound so its normal's horizontal part points
 * along (ox, oz). Returns the next offset.
 */
function writeOutward(
  out: Float32Array,
  o: number,
  px: number,
  py: number,
  pz: number,
  qx: number,
  qy: number,
  qz: number,
  rx: number,
  ry: number,
  rz: number,
  ox: number,
  oz: number
): number {
  const ux = qx - px
  const uy = qy - py
  const uz = qz - pz
  const vx = rx - px
  const vy = ry - py
  const vz = rz - pz
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  if (nx * nx + ny * ny + nz * nz < 1e-18) return o
  const flip = nx * ox + nz * oz < 0
  out[o] = px
  out[o + 1] = py
  out[o + 2] = pz
  out[o + (flip ? 6 : 3)] = qx
  out[o + (flip ? 7 : 4)] = qy
  out[o + (flip ? 8 : 5)] = qz
  out[o + (flip ? 3 : 6)] = rx
  out[o + (flip ? 4 : 7)] = ry
  out[o + (flip ? 5 : 8)] = rz
  return o + 9
}

/** Top edge element k of a shape (outline or inner edge; segment pair, [] out of range). */
function topEdgePair(shape: TerrainShape, elevation: number, k: number): number[] {
  const ends = shapeEdgeEnds(shape, k)
  if (!ends) return []
  const a = shape.points[ends[0]]
  const b = shape.points[ends[1]]
  return [a.x, elevation + a.y, a.z, b.x, elevation + b.y, b.z]
}

/** Outline of face `face` (segment pairs): the top outline, or side k's quad without zero-length sides. */
function faceOutline(shape: TerrainShape, elevation: number, face: number | "top"): number[] {
  const n = shape.points.length
  if (face === "top") {
    const out: number[] = []
    for (let k = 0; k < n; k++) out.push(...topEdgePair(shape, elevation, k))
    return out
  }
  const a = shape.points[face]
  const b = shape.points[(face + 1) % n]
  const y = elevation + shape.base
  const loop = [
    [a.x, elevation + a.y, a.z],
    [b.x, elevation + b.y, b.z],
    [b.x, y, b.z],
    [a.x, y, a.z],
  ]
  const out: number[] = []
  for (let k = 0; k < 4; k++) {
    const p = loop[k]
    const q = loop[(k + 1) % 4]
    if (Math.abs(p[1] - q[1]) + Math.abs(p[0] - q[0]) + Math.abs(p[2] - q[2]) > FLAT_EPS) out.push(...p, ...q)
  }
  return out
}

function concat(parts: readonly ArrayLike<number>[]): Float32Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Float32Array(n)
  n = 0
  for (const p of parts) {
    out.set(p, n)
    n += p.length
  }
  return out
}

/** Position-only geometry of non-indexed triangles (unlit fills). */
export function positionGeometry(positions: Float32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  return g
}

// ---------------------------------------------------------------------------
// Layers (merged geometry of a list of shapes, cached by the list's identities)
// ---------------------------------------------------------------------------

/** Faces and edges of one op's shapes in a layer (null: none). */
interface OpGeometry {
  faces: THREE.BufferGeometry | null
  /** Faces of the depth-tested fill: the lifted tops (ShapePrism.liftedTop); `faces` when none is lifted. */
  depthFaces: THREE.BufferGeometry | null
  edges: THREE.BufferGeometry | null
}

/** Faces for the x-ray fill and, when a top is lifted, their own for the depth-tested one. */
function opFaces(prisms: readonly ShapePrism[], wrap: (g: THREE.BufferGeometry) => THREE.BufferGeometry): Pick<OpGeometry, "faces" | "depthFaces"> {
  const faces = concat(prisms.flatMap((p) => [p.top, p.sides]))
  if (faces.length === 0) return { faces: null, depthFaces: null }
  const geometry = wrap(positionGeometry(faces))
  if (!prisms.some((p) => p.topLift > 0)) return { faces: geometry, depthFaces: geometry }
  return { faces: geometry, depthFaces: wrap(positionGeometry(concat(prisms.flatMap((p) => [p.liftedTop, p.sides])))) }
}

/** Merged geometry of a list of shapes, split by op (materials differ). */
export interface LayerGeometry {
  add: OpGeometry
  carve: OpGeometry
}

const cachedGeometry = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
  g.userData.cached = true
  return g
}

/**
 * Merged geometry of the listed shapes, rebuilt only when the list's shape identities, the elevation or
 * the lattice spacing change.
 */
export class LayerCache {
  private shapes: readonly TerrainShape[] = []
  private elevation = Number.NaN
  private spacing = Number.NaN
  private geometry: LayerGeometry | null = null
  private dotGeometry: THREE.BufferGeometry | null = null

  get(shapes: readonly TerrainShape[], elevation: number, spacing = 0): LayerGeometry {
    if (this.geometry && elevation === this.elevation && spacing === this.spacing && sameShapes(shapes, this.shapes)) return this.geometry
    this.release()
    this.shapes = shapes.slice()
    this.elevation = elevation
    this.spacing = spacing
    const build = (op: TerrainShape["op"]): OpGeometry => {
      const prisms = this.shapes.filter((s) => s.op === op).map((s) => shapePrism(s, elevation, spacing))
      if (prisms.length === 0) return { faces: null, depthFaces: null, edges: null }
      const edges = concat(prisms.map((p) => p.edges))
      return {
        ...opFaces(prisms, cachedGeometry),
        edges: edges.length > 0 ? cachedGeometry(aaLineGeometry(edges)) : null,
      }
    }
    this.geometry = { add: build("add"), carve: build("carve") }
    return this.geometry
  }

  /** Vertex dots of the current list (built on first use). */
  dots(): THREE.BufferGeometry | null {
    if (!this.geometry) return null
    if (!this.dotGeometry) {
      const pts = concat(this.shapes.map((s) => shapePrism(s, this.elevation, this.spacing).vertices))
      this.dotGeometry = pts.length > 0 ? cachedGeometry(aaPointGeometry(pts)) : null
    }
    return this.dotGeometry
  }

  /** Free the GPU geometry (the next get() rebuilds). */
  release(): void {
    const g = this.geometry
    if (g) for (const x of [g.add.faces, g.add.depthFaces, g.add.edges, g.carve.faces, g.carve.depthFaces, g.carve.edges]) x?.dispose()
    this.dotGeometry?.dispose()
    this.geometry = null
    this.dotGeometry = null
    this.shapes = []
    this.elevation = Number.NaN
    this.spacing = Number.NaN
  }
}

function sameShapes(a: readonly TerrainShape[], b: readonly TerrainShape[]): boolean {
  if (a.length !== b.length) return false
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false
  return true
}

// ---------------------------------------------------------------------------
// Resources: shared materials, layer caches, gizmo and label
// ---------------------------------------------------------------------------

type Style = "normal" | "selected" | "hover" | "draft"

const AXES: readonly GizmoAxis[] = ["x", "y", "z"]

/**
 * Everything the terrain overlay keeps between rebuilds: shared materials, the layer caches and the
 * persistent `decor` (gizmo arrows, centre dot, label) that the OverlayManager attaches to its root once.
 */
export class TerrainOverlayResources {
  /** Gizmo and label: attached once by the owner, never disposed with a preview. */
  readonly decor = new THREE.Object3D()
  readonly unselected = new LayerCache()
  readonly selected = new LayerCache()
  /** Gizmo arrow meshes (screen-space; `frame()` sets their direction and visibility). */
  readonly arrows: Record<GizmoAxis, THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>>
  readonly gizmoCentre: THREE.Mesh
  /** Rotate ring (a unit horizontal circle, scaled per frame to gizmoRing's radius). */
  readonly ring: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  private readonly ringMaterials: { normal: THREE.ShaderMaterial; lit: THREE.ShaderMaterial }
  private label: TextLabel | null = null
  private gizmo: TerrainOverlay["gizmo"] = null
  private readonly materials = new Map<string, THREE.Material>()
  private readonly decorGeometries: THREE.BufferGeometry[]

  constructor() {
    this.decor.name = "terrain-overlay-decor"
    const arrowGeometry = gizmoArrowGeometry()
    const centreGeometry = aaPointGeometry([0, 0, 0])
    const unitRing = Array.from({ length: GIZMO_RING_SEGMENTS }, (_, k) => ringPoint({ x: 0, y: 0, z: 0 }, 1, k))
    const ringGeometry = aaLineGeometry(polylinePairs(unitRing, true))
    this.decorGeometries = [arrowGeometry, centreGeometry, ringGeometry]
    for (const g of this.decorGeometries) g.userData.shared = true
    const arrows = {} as Record<GizmoAxis, THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>>
    for (const axis of AXES) {
      const m = new THREE.Mesh(arrowGeometry, createGizmoArrowMaterial(TERRAIN_OVERLAY_COLORS.gizmo[axis]))
      m.name = `gizmo:${axis}`
      m.renderOrder = TERRAIN_OVERLAY_ORDER.gizmo
      arrows[axis] = m
      this.decor.add(m)
    }
    this.arrows = arrows
    // A dark dot in a light ring: unlike the (light) vertex dots it may sit on.
    this.gizmoCentre = new THREE.Mesh(
      centreGeometry,
      createAAPointMaterial(TERRAIN_OVERLAY_COLORS.gizmoCentreFill, { size: 9, outline: 2, outlineColor: TERRAIN_OVERLAY_COLORS.gizmoCentre })
    )
    this.gizmoCentre.name = "gizmo:centre"
    this.gizmoCentre.renderOrder = TERRAIN_OVERLAY_ORDER.gizmoCentre
    this.decor.add(this.gizmoCentre)
    // Green like the Y arrow: it turns the selection about the vertical (Y) axis.
    this.ringMaterials = {
      normal: createAALineMaterial(TERRAIN_OVERLAY_COLORS.gizmo.y, { opacity: 0.85, width: 2, depthTest: false }),
      lit: createAALineMaterial(TERRAIN_OVERLAY_COLORS.gizmoLight.y, { opacity: 1, width: 3.5, depthTest: false }),
    }
    this.ring = new THREE.Mesh(ringGeometry, this.ringMaterials.normal)
    this.ring.name = "gizmo:rotate"
    this.ring.renderOrder = TERRAIN_OVERLAY_ORDER.gizmo
    this.decor.add(this.ring)
    this.decor.traverse(decorate)
    this.setDecor(null, null)
  }

  /** A shared translucent face material (depth-tested with a polygon offset, or x-ray). */
  fill(color: string, opacity: number, xray: boolean): THREE.Material {
    return this.material(`fill|${color}|${opacity}|${xray}`, () => {
      const m = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest: !xray,
        side: THREE.DoubleSide,
        toneMapped: false,
      })
      if (!xray) {
        m.polygonOffset = true
        m.polygonOffsetFactor = POLYGON_OFFSET.factor
        m.polygonOffsetUnits = POLYGON_OFFSET.units
      }
      return m
    })
  }

  /** A shared anti-aliased line material (depth-tested with a polygon offset, or x-ray). */
  line(color: string, opacity: number, width: number, xray: boolean): THREE.Material {
    return this.material(`line|${color}|${opacity}|${width}|${xray}`, () => {
      const m = createAALineMaterial(color, { opacity, width, depthTest: !xray })
      if (!xray) {
        m.polygonOffset = true
        m.polygonOffsetFactor = POLYGON_OFFSET.factor
        m.polygonOffsetUnits = POLYGON_OFFSET.units
      }
      return m
    })
  }

  /** A shared screen-space dot material (drawn through geometry). */
  dot(color: string, size: number): THREE.Material {
    return this.material(`dot|${color}|${size}`, () => createAAPointMaterial(color, { size, outline: 1.5 }))
  }

  private material(key: string, create: () => THREE.Material): THREE.Material {
    let m = this.materials.get(key)
    if (!m) {
      m = create()
      m.userData.shared = true
      this.materials.set(key, m)
    }
    return m
  }

  /** Gizmo state and label of the current overlay (null: hidden). */
  setDecor(gizmo: TerrainOverlay["gizmo"], label: TerrainOverlay["label"]): void {
    this.gizmo = gizmo
    for (const axis of AXES) {
      const mesh = this.arrows[axis]
      const u = mesh.material.uniforms
      const lit = gizmo !== null && (gizmo.active === axis || (gizmo.active === null && gizmo.hover === axis))
      u.uColor.value.set(lit ? TERRAIN_OVERLAY_COLORS.gizmoLight[axis] : TERRAIN_OVERLAY_COLORS.gizmo[axis])
      u.uShaftHalf.value = lit ? GIZMO_SHAFT_HALF_PX.highlight : GIZMO_SHAFT_HALF_PX.normal
      // While an axis is dragged the others step back.
      u.uOpacity.value = gizmo?.active && gizmo.active !== axis ? 0.3 : 1
      if (gizmo) mesh.position.set(gizmo.at.x, gizmo.at.y, gizmo.at.z)
      // Shown by frame() once the handles are known.
      mesh.visible = false
    }
    if (gizmo) this.gizmoCentre.position.set(gizmo.at.x, gizmo.at.y, gizmo.at.z)
    this.gizmoCentre.visible = false
    const ringLit = gizmo !== null && (gizmo.active === "rotate" || (gizmo.active === null && gizmo.hover === "rotate"))
    this.ring.material = ringLit ? this.ringMaterials.lit : this.ringMaterials.normal
    this.ringMaterials.normal.uniforms.uOpacity.value = gizmo?.active && gizmo.active !== "rotate" ? 0.3 : 0.85
    if (gizmo) this.ring.position.set(gizmo.at.x, gizmo.at.y, gizmo.at.z)
    this.ring.visible = false
    if (label && label.text.length > 0) {
      if (!this.label) {
        this.label = new TextLabel()
        decorate(this.label.sprite)
        this.decor.add(this.label.sprite)
      }
      this.label.setText(label.text)
      this.label.sprite.position.set(label.at.x, label.at.y, label.at.z)
      this.label.sprite.visible = true
    } else if (this.label) this.label.sprite.visible = false
  }

  /**
   * Per frame (OverlayManager.update): the gizmo arrows follow gizmoHandles (screen direction, axes seen
   * end-on or off screen hidden; no projector: hidden), the rotate ring follows gizmoRing (constant screen
   * radius, hidden edge-on), the label keeps a constant pixel size.
   */
  frame(project: Projector | null, worldPerPixelAt: (p: THREE.Vector3) => number): void {
    const g = this.gizmo
    if (g && project) {
      const handles = gizmoHandles(project, g.at)
      let any = false
      for (const axis of AXES) {
        const h = handles[axis]
        const mesh = this.arrows[axis]
        mesh.visible = h.visible
        mesh.material.uniforms.uDir.value.set(h.dir.x, h.dir.y)
        any ||= h.visible
      }
      const ring = gizmoRing(project, g.at)
      this.ring.visible = ring.visible
      if (ring.visible) this.ring.scale.set(ring.radius, 1, ring.radius)
      this.gizmoCentre.visible = any || ring.visible
    } else {
      for (const axis of AXES) this.arrows[axis].visible = false
      this.gizmoCentre.visible = false
      this.ring.visible = false
    }
    const label = this.label
    if (label?.sprite.visible) label.updateScale(worldPerPixelAt(label.sprite.position))
  }

  /** The overlay is gone: hide the decor and free the cached layer geometry. */
  release(): void {
    this.setDecor(null, null)
    this.unselected.release()
    this.selected.release()
  }

  dispose(): void {
    this.release()
    for (const m of this.materials.values()) m.dispose()
    this.materials.clear()
    for (const axis of AXES) this.arrows[axis].material.dispose()
    this.ringMaterials.normal.dispose()
    this.ringMaterials.lit.dispose()
    ;(this.gizmoCentre.material as THREE.Material).dispose()
    for (const g of this.decorGeometries) g.dispose()
    if (this.label) {
      this.label.sprite.removeFromParent()
      this.label.dispose()
      this.label = null
    }
    this.decor.removeFromParent()
  }
}

function decorate(o: THREE.Object3D): void {
  o.frustumCulled = false
  o.raycast = () => {}
  o.layers.set(LAYER.OVERLAY)
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface StylePalette {
  fill: string
  fillOpacity: number
  xrayOpacity: number
  edge: string
  edgeOpacity: number
  edgeWidth: number
  xrayEdgeOpacity: number
}

function palette(style: Style, op: TerrainShape["op"], valid = true): StylePalette {
  const c = TERRAIN_OVERLAY_COLORS
  const base = op === "add" ? c.add : c.carve
  switch (style) {
    case "normal":
      return { fill: base, fillOpacity: 0.16, xrayOpacity: 0.06, edge: base, edgeOpacity: 0.85, edgeWidth: 1.5, xrayEdgeOpacity: 0.3 }
    case "selected": {
      const bright = op === "add" ? c.addBright : c.carveBright
      return { fill: bright, fillOpacity: 0.3, xrayOpacity: 0.12, edge: bright, edgeOpacity: 1, edgeWidth: 2.25, xrayEdgeOpacity: 0.5 }
    }
    case "hover": {
      const light = op === "add" ? c.addLight : c.carveLight
      return { fill: light, fillOpacity: 0.14, xrayOpacity: 0.08, edge: light, edgeOpacity: 0.95, edgeWidth: 2, xrayEdgeOpacity: 0.45 }
    }
    case "draft":
      return valid
        ? { fill: base, fillOpacity: 0.28, xrayOpacity: 0.12, edge: c.draft, edgeOpacity: 1, edgeWidth: 2, xrayEdgeOpacity: 0.5 }
        : { fill: c.invalid, fillOpacity: 0.3, xrayOpacity: 0.14, edge: c.invalid, edgeOpacity: 1, edgeWidth: 2, xrayEdgeOpacity: 0.55 }
  }
}

/** Order of a pass: the selected / hovered / draft styles draw after (over) the normal one. */
const STYLE_ORDER: Record<Style, number> = { normal: 0, selected: 0.01, hover: 0.02, draft: 0.03 }

/** The four passes (x-ray fill, fill, x-ray edges, edges) of one op's geometry in a style. */
function addPasses(root: THREE.Object3D, res: TerrainOverlayResources, g: OpGeometry, style: Style, op: TerrainShape["op"], valid = true): void {
  const pal = palette(style, op, valid)
  const o = STYLE_ORDER[style]
  const O = TERRAIN_OVERLAY_ORDER
  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, order: number) => {
    const m = new THREE.Mesh(geometry, material)
    m.renderOrder = order + o
    root.add(m)
  }
  if (g.faces) mesh(g.faces, res.fill(pal.fill, pal.xrayOpacity, true), O.xrayFill)
  if (g.depthFaces) mesh(g.depthFaces, res.fill(pal.fill, pal.fillOpacity, false), O.fill)
  if (g.edges) {
    mesh(g.edges, res.line(pal.edge, pal.xrayEdgeOpacity, Math.max(1, pal.edgeWidth - 0.5), true), O.xrayEdge)
    mesh(g.edges, res.line(pal.edge, pal.edgeOpacity, pal.edgeWidth, false), O.edge)
  }
}

/** Owned (per overlay) geometry of one shape's prism. */
function prismGeometry(prism: ShapePrism): OpGeometry {
  return {
    ...opFaces([prism], (g) => g),
    edges: prism.edges.length > 0 ? aaLineGeometry(prism.edges) : null,
  }
}

/**
 * The disposable part of a terrain overlay: the layers' meshes (over cached geometry), the hovered
 * shape, the draft and the element highlights. Updates `res.decor` (gizmo, label) as a side effect.
 * `spacing` is the level's terrain lattice spacing (GroundSampler.spacing; see ShapePrism.topLift).
 */
export function buildTerrainOverlay(p: TerrainOverlay, elevation: number, spacing: number, res: TerrainOverlayResources): THREE.Object3D {
  const root = new THREE.Object3D()
  root.name = "terrain-overlay"
  const selectedIds = new Set<Id>(p.selectedShapeIds)
  const byId = new Map<Id, TerrainShape>()
  const unselected: TerrainShape[] = []
  const selected: TerrainShape[] = []
  for (const s of p.shapes) {
    byId.set(s.id, s)
    ;(selectedIds.has(s.id) ? selected : unselected).push(s)
  }

  const normal = res.unselected.get(unselected, elevation, spacing)
  addPasses(root, res, normal.add, "normal", "add")
  addPasses(root, res, normal.carve, "normal", "carve")
  const sel = res.selected.get(selected, elevation, spacing)
  addPasses(root, res, sel.add, "selected", "add")
  addPasses(root, res, sel.carve, "selected", "carve")

  const hovered = p.hoverShapeId !== null ? byId.get(p.hoverShapeId) : undefined
  if (hovered) addPasses(root, res, prismGeometry(shapePrism(hovered, elevation, spacing)), "hover", hovered.op)
  if (p.draft) addPasses(root, res, prismGeometry(shapePrism(p.draft.shape, elevation, spacing)), "draft", p.draft.shape.op, p.draft.valid)

  if (p.elements && selected.length > 0) addElements(root, res, p.elements, byId, selectedIds, elevation, spacing)
  if (p.outline) addOutline(root, res, p.outline)
  if (p.cuts) addCuts(root, res, p.cuts)
  const marquee = p.marquee ? marqueeMesh(p.marquee) : null
  if (marquee) root.add(marquee)

  res.setDecor(p.gizmo, p.label)
  return root
}

/** Advanced mode: vertex dots of the selected shapes (vertex mode), selected and hovered elements. */
function addElements(
  root: THREE.Object3D,
  res: TerrainOverlayResources,
  elements: NonNullable<TerrainOverlay["elements"]>,
  byId: ReadonlyMap<Id, TerrainShape>,
  selectedIds: ReadonlySet<Id>,
  elevation: number,
  spacing: number
): void {
  const O = TERRAIN_OVERLAY_ORDER
  const C = TERRAIN_OVERLAY_COLORS
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, order: number) => {
    const m = new THREE.Mesh(geometry, material)
    m.renderOrder = order
    root.add(m)
  }
  if (elements.mode === "vertex") {
    const dots = res.selected.dots()
    if (dots) add(dots, res.dot(C.vertex, 7), O.dot)
  }
  const draw = (refs: readonly TerrainElementRef[], hover: boolean) => {
    const dots: number[] = []
    const edges: number[] = []
    const faces: ArrayLike<number>[] = []
    const outlines: number[] = []
    for (const ref of refs) {
      const shape = selectedIds.has(ref.shapeId) ? byId.get(ref.shapeId) : undefined
      if (!shape) continue
      const n = shape.points.length
      if (ref.kind === "face") {
        if (ref.index !== "top" && !(Number.isInteger(ref.index) && ref.index >= 0 && ref.index < n)) continue
        const prism = shapePrism(shape, elevation, spacing)
        faces.push(ref.index === "top" ? prism.top : prism.sides.subarray(prism.sideStart[ref.index], prism.sideStart[ref.index + 1]))
        outlines.push(...faceOutline(shape, elevation, ref.index))
        continue
      }
      const count = ref.kind === "edge" ? shapeEdgeCount(shape) : n
      if (!(Number.isInteger(ref.index) && ref.index >= 0 && ref.index < count)) continue
      if (ref.kind === "vertex") {
        const v = shape.points[ref.index]
        dots.push(v.x, elevation + v.y, v.z)
      } else edges.push(...topEdgePair(shape, elevation, ref.index))
    }
    const color = hover ? C.elementHover : C.element
    const bump = hover ? 0.01 : 0
    const faceData = concat(faces)
    if (faceData.length > 0) add(positionGeometry(faceData), res.fill(color, hover ? 0.2 : 0.32, true), O.face + bump)
    if (outlines.length > 0) add(aaLineGeometry(outlines), res.line(color, 1, 2.5, true), O.elementEdge + bump)
    if (edges.length > 0) add(aaLineGeometry(edges), res.line(color, 1, hover ? 3 : 3.5, true), O.elementEdge + bump)
    if (dots.length > 0) add(aaPointGeometry(dots), res.dot(color, hover ? 10 : 9), O.dot + 0.01 + bump)
  }
  draw(elements.selected, false)
  if (elements.hover) draw([elements.hover], true)
}

/**
 * The polygon being drawn: the open chain (draft colour, red when invalid) and its closing edge (dimmed,
 * red when it would cross), each depth-tested plus a dim x-ray pass, and a dot per corner. Owned geometry.
 */
function addOutline(root: THREE.Object3D, res: TerrainOverlayResources, outline: NonNullable<TerrainOverlay["outline"]>): void {
  const C = TERRAIN_OVERLAY_COLORS
  const O = TERRAIN_OVERLAY_ORDER
  const pts = outline.points
  if (pts.length === 0) return
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, order: number) => {
    const m = new THREE.Mesh(geometry, material)
    m.renderOrder = order
    root.add(m)
  }
  const lines = (pairs: Float32Array, color: string, opacity: number) => {
    if (pairs.length === 0) return
    const g = aaLineGeometry(pairs)
    add(g, res.line(color, opacity * 0.5, 1.5, true), O.xrayEdge + 0.04)
    add(g, res.line(color, opacity, 2, false), O.edge + 0.04)
  }
  lines(polylinePairs(pts), outline.valid ? C.draft : C.invalid, 1)
  if (outline.closing !== "none" && pts.length >= 3) {
    const a = pts[pts.length - 1]
    const b = pts[0]
    lines(new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z]), outline.closing === "ok" ? C.draft : C.invalid, 0.45)
  }
  add(aaPointGeometry(pts.flatMap((q) => [q.x, q.y, q.z])), res.dot(outline.valid ? C.vertex : C.invalid, 7), O.dot + 0.04)
}

/** The loop cut preview: its segments in the element colour (red when invalid), x-ray and depth-tested. Owned geometry. */
function addCuts(root: THREE.Object3D, res: TerrainOverlayResources, cuts: NonNullable<TerrainOverlay["cuts"]>): void {
  if (cuts.segments.length === 0) return
  const pairs = new Float32Array(cuts.segments.length * 6)
  cuts.segments.forEach(([a, b], k) => pairs.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6))
  const g = aaLineGeometry(pairs)
  const color = cuts.valid ? TERRAIN_OVERLAY_COLORS.element : TERRAIN_OVERLAY_COLORS.invalid
  const xray = new THREE.Mesh(g, res.line(color, 0.55, 2, true))
  xray.renderOrder = TERRAIN_OVERLAY_ORDER.elementEdge
  const lines = new THREE.Mesh(g, res.line(color, 1, 3, false))
  lines.renderOrder = TERRAIN_OVERLAY_ORDER.elementEdge + 0.005
  root.add(xray, lines)
}

// ---------------------------------------------------------------------------
// Marquee (screen space)
// ---------------------------------------------------------------------------

/** Outline width and fill opacity of the marquee (CSS px; like the select tool's ground marquee). */
export const MARQUEE_STYLE = { line: 1.5, lineOpacity: 0.95, fill: 0.14 }

/**
 * A unit quad (position.xy ∈ {0, 1}²) stretched over the rect ± 1 CSS px (room for the anti-aliasing
 * ramp): CSS px → physical px (uPixelRatio) → NDC over the pass's viewport, y down → y up. No camera.
 */
export const MARQUEE_VERTEX = /* glsl */ `
uniform vec4 uRect;
uniform vec4 uViewport;
uniform float uPixelRatio;
varying vec2 vCss;

void main() {
  vCss = mix(uRect.xy - 1.0, uRect.zw + 1.0, position.xy);
  vec2 ndc = vCss * uPixelRatio / uViewport.zw * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`

/**
 * Signed distance (CSS px, negative inside) to the rect's border: a faint fill inside and a `uLine` px
 * outline just inside the border, both anti-aliased over one physical pixel (the canvas has no MSAA).
 */
export const MARQUEE_FRAGMENT = /* glsl */ `
uniform vec4 uRect;
uniform vec3 uColor;
uniform float uFill;
uniform float uLine;
uniform float uLineOpacity;
varying vec2 vCss;

void main() {
  vec2 d = max(uRect.xy - vCss, vCss - uRect.zw);
  float sd = max(d.x, d.y);
  // CSS px per physical pixel.
  float px = max(fwidth(vCss.x), 1e-6);
  float inside = clamp(0.5 - sd / px, 0.0, 1.0);
  float line = clamp(0.5 - (abs(sd + 0.5 * uLine) - 0.5 * uLine) / px, 0.0, 1.0);
  float a = max(uFill * inside, uLineOpacity * line);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`

const _viewport = new THREE.Vector4()

/**
 * The marquee rect as a screen-space mesh (owned geometry and material: freed with the preview), or
 * null when it is smaller than half a pixel both ways (a press that has not moved).
 */
export function marqueeMesh(m: NonNullable<TerrainOverlay["marquee"]>): THREE.Mesh | null {
  const x0 = Math.min(m.from.x, m.to.x)
  const y0 = Math.min(m.from.y, m.to.y)
  const x1 = Math.max(m.from.x, m.to.x)
  const y1 = Math.max(m.from.y, m.to.y)
  if (![x0, y0, x1, y1].every(Number.isFinite) || (x1 - x0 < 0.5 && y1 - y0 < 0.5)) return null
  const uniforms = {
    uRect: { value: new THREE.Vector4(x0, y0, x1, y1) },
    uViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
    uPixelRatio: { value: 1 },
    uColor: { value: new THREE.Color(TERRAIN_OVERLAY_COLORS.marquee) },
    uFill: { value: MARQUEE_STYLE.fill },
    uLine: { value: MARQUEE_STYLE.line },
    uLineOpacity: { value: MARQUEE_STYLE.lineOpacity },
  }
  const material = new THREE.ShaderMaterial({
    name: "atlas-overlay-marquee",
    vertexShader: MARQUEE_VERTEX,
    fragmentShader: MARQUEE_FRAGMENT,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  // The drawing-buffer viewport (physical px) of the pass and the renderer's pixel ratio (as the gizmo).
  material.onBeforeRender = (renderer) => {
    const r = renderer as Partial<THREE.WebGLRenderer>
    if (typeof r.getCurrentViewport === "function") uniforms.uViewport.value.copy(r.getCurrentViewport.call(renderer, _viewport))
    uniforms.uPixelRatio.value = typeof r.getPixelRatio === "function" ? r.getPixelRatio.call(renderer) : 1
    material.uniformsNeedUpdate = true
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = "terrain-marquee"
  mesh.renderOrder = TERRAIN_OVERLAY_ORDER.marquee
  mesh.frustumCulled = false
  return mesh
}
