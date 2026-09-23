/**
 * Tool previews (contracts.ts ToolPreview): every kind becomes a small Object3D of unlit,
 * translucent meshes/lines that owns its geometries and materials (disposePreview frees them). Lines
 * are anti-aliased screen-space segments (materials/aaLineMaterial) and ribbons fade their own edges:
 * the canvas has no MSAA. An outline on each fill's border also covers the fill's aliased edge.
 *
 * Coordinates: `rect`, `segment`, `opening`, `brush` are ground-plane shapes on their level and are
 * placed on that level's ground. `point.position.y` is relative to the level ground at (x, z), like
 * scene object Y values (ARCHITECTURE §2).
 */
import * as THREE from "three"

import type { Id, Rect, SceneLike, Vec2 } from "@/core/scene/types"

import { BuildContext, buildLevel } from "../builders"
import { doorLeafPose } from "../builders/doors"
import type { GroundSampler } from "../builders/ground"
import { writeFrameBox, writePrism } from "../builders/shapes"
import { MeshWriter } from "../builders/writer"
import type { ToolPreview } from "../contracts"
import { aaLineGeometry, createAALineMaterial, polylinePairs } from "../materials/aaLineMaterial"
import { createEdgeAAMaterial, edgeGeometry } from "../materials/edgeAAMaterial"
import { circlePoints, ribbonEdgeGeometry } from "./ribbon"

export const ACCENT = "#34d399"
export const INVALID = "#f87171"
const BRUSH_COLORS: Record<"raise" | "lower" | "smooth" | "flatten", string> = {
  raise: "#34d399",
  lower: "#fb923c",
  smooth: "#60a5fa",
  flatten: "#c084fc",
}

const LIFT = 0.08

export interface PreviewContext {
  ground(levelId: Id): GroundSampler
  /** Current scene (for the environment of ghost-object previews). */
  scene: SceneLike | null
  /** World units per CSS pixel near the preview (line widths). */
  worldPerPixel: number
}

function fillMaterial(color: string, opacity = 0.28): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false, side: THREE.DoubleSide, toneMapped: false })
}

function lineMaterial(color: string, opacity = 0.95): THREE.ShaderMaterial {
  return createAALineMaterial(color, { opacity, width: 1.5 })
}

function lineFrom(points: readonly { x: number; y: number; z: number }[], material: THREE.Material, loop = false): THREE.Mesh {
  return new THREE.Mesh(aaLineGeometry(polylinePairs(points, loop)), material)
}

/** Ribbon with analytic edge anti-aliasing (the canvas has no MSAA); `width` is the nominal width. */
function ribbonMesh(points: readonly { x: number; y: number; z: number }[], width: number, worldPerPixel: number, color: string, opacity: number): THREE.Mesh {
  // + half a pixel per side: the edge fade is centred on the nominal edge.
  return new THREE.Mesh(edgeGeometry(ribbonEdgeGeometry(points, width + worldPerPixel, LIFT)), createEdgeAAMaterial(color, { opacity }))
}

/** A rect draped on the ground (sampled on the terrain lattice). */
export function drapedRectGeometry(rect: Rect, ground: GroundSampler, lift = LIFT): THREE.BufferGeometry {
  const step = ground.flat ? Math.max(rect.w, rect.d) : ground.spacing
  const nx = Math.max(1, Math.ceil(rect.w / step))
  const nz = Math.max(1, Math.ceil(rect.d / step))
  const pos: number[] = []
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = rect.x + (rect.w * i) / nx
      const z = rect.z + (rect.d * j) / nz
      pos.push(x, ground.heightAt(x, z) + lift, z)
    }
  }
  const index: number[] = []
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i
      index.push(a, a + nx + 2, a + 1, a, a + nx + 1, a + nx + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(index)
  return g
}

/** Border points of a rect draped on the ground. */
function rectOutline(rect: Rect, ground: GroundSampler): { x: number; y: number; z: number }[] {
  const pts: Vec2[] = []
  const edge = (a: Vec2, b: Vec2) => {
    const n = ground.flat ? 1 : Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / ground.spacing))
    for (let k = 0; k < n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n })
  }
  const c = [
    { x: rect.x, z: rect.z },
    { x: rect.x + rect.w, z: rect.z },
    { x: rect.x + rect.w, z: rect.z + rect.d },
    { x: rect.x, z: rect.z + rect.d },
  ]
  for (let k = 0; k < 4; k++) edge(c[k], c[(k + 1) % 4])
  return pts.map((p) => ({ x: p.x, y: ground.heightAt(p.x, p.z) + LIFT, z: p.z }))
}

/** Translucent box along a→b with outline. */
function wallBox(a: Vec2, b: Vec2, y0: number, y1: number, thickness: number, color: string): THREE.Object3D {
  const root = new THREE.Object3D()
  const len = Math.hypot(b.x - a.x, b.z - a.z)
  const w = new MeshWriter()
  if (len > 1e-6) {
    const dx = (b.x - a.x) / len
    const dz = (b.z - a.z) / len
    writeFrameBox(w, a.x, a.z, dx, dz, 0, len, y0, Math.max(y1, y0 + 0.05), -thickness / 2, thickness / 2, [1, 1, 1])
  }
  const g = w.build()
  if (g) {
    root.add(new THREE.Mesh(g, fillMaterial(color, 0.3)))
    const edges = new THREE.EdgesGeometry(g, 20)
    root.add(new THREE.Mesh(aaLineGeometry(edges.getAttribute("position").array), lineMaterial(color)))
    edges.dispose()
  }
  // Centre line on the ground, visible even for zero-length drags.
  root.add(lineFrom([{ x: a.x, y: y0 + LIFT, z: a.z }, { x: b.x, y: y0 + LIFT, z: b.z }], lineMaterial(color)))
  return root
}

/** Ghost of a set of objects (paste preview): builder geometry with unlit translucent materials. */
function ghostObjects(p: Extract<ToolPreview, { kind: "ghost-objects" }>): THREE.Object3D {
  const root = new THREE.Object3D()
  root.position.set(p.offset.x, 0, p.offset.z)
  const scene = { grid: p.scene.grid, levels: p.scene.levels, objects: p.scene.objects, tokens: {} }
  const ctx = new BuildContext(scene)
  const levelIds = new Set(Object.values(p.scene.objects).map((o) => o.levelId))
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false })
  for (const levelId of levelIds) {
    if (!Object.hasOwn(p.scene.levels, levelId)) continue
    const level = buildLevel(ctx, levelId)
    for (const bucket of Object.values(level)) {
      for (const m of bucket.meshes) {
        if (m.slot === "glass" || m.slot === "flame") continue
        if (m.kind === "merged") root.add(new THREE.Mesh(m.geometry, material))
        else if (m.kind === "instanced") {
          const inst = new THREE.InstancedMesh(m.geometry, material, m.ids.length)
          inst.instanceMatrix.array.set(m.matrices)
          inst.instanceColor = new THREE.InstancedBufferAttribute(m.colors.slice(), 3)
          inst.userData.sharedGeometry = true
          root.add(inst)
        } else {
          const mesh = new THREE.Mesh(m.geometry, material)
          const pose = doorLeafPose(m.leaf, 0)
          mesh.position.set(pose.x, pose.y, pose.z)
          mesh.rotation.y = pose.yaw
          root.add(mesh)
        }
      }
    }
  }
  return root
}

/** Build the Object3D for a tool preview. */
export function buildToolPreview(p: ToolPreview, ctx: PreviewContext): THREE.Object3D {
  const root = new THREE.Object3D()
  root.name = `preview:${p.kind}`
  switch (p.kind) {
    case "rect": {
      const ground = ctx.ground(p.levelId)
      const color = p.color ?? ACCENT
      root.add(new THREE.Mesh(drapedRectGeometry(p.rect, ground), fillMaterial(color, 0.22)))
      root.add(lineFrom(rectOutline(p.rect, ground), lineMaterial(color), true))
      break
    }
    case "segment": {
      const ground = ctx.ground(p.levelId)
      const base = ground.heightAt((p.a.x + p.b.x) / 2, (p.a.z + p.b.z) / 2)
      root.add(wallBox(p.a, p.b, base, base + p.height, Math.max(0.05, p.thickness), p.valid ? ACCENT : INVALID))
      break
    }
    case "opening": {
      const ground = ctx.ground(p.levelId)
      const base = ground.heightAt((p.a.x + p.b.x) / 2, (p.a.z + p.b.z) / 2)
      root.add(wallBox(p.a, p.b, base + p.sill, base + p.sill + p.height, 1, p.valid ? ACCENT : INVALID))
      break
    }
    case "point": {
      const ground = ctx.ground(p.levelId)
      const color = p.color ?? ACCENT
      const g0 = ground.heightAt(p.position.x, p.position.z)
      const y = g0 + p.position.y
      const w = new MeshWriter()
      writePrism(w, 0, 0, 0.35, -0.35, 0.35, 10, [1, 1, 1], { smooth: true })
      const marker = new THREE.Mesh(w.build()!, fillMaterial(color, 0.85))
      marker.position.set(p.position.x, y, p.position.z)
      root.add(marker)
      root.add(lineFrom([{ x: p.position.x, y: g0, z: p.position.z }, { x: p.position.x, y, z: p.position.z }], lineMaterial(color, 0.7)))
      if (p.radius && p.radius > 0) {
        const pts = circlePoints(p.position.x, p.position.z, p.radius, 64, (x, z) => ground.heightAt(x, z) + LIFT)
        root.add(lineFrom(pts, lineMaterial(color, 0.8)))
      }
      break
    }
    case "brush": {
      const ground = ctx.ground(p.levelId)
      const color = BRUSH_COLORS[p.mode] ?? ACCENT
      const pts = circlePoints(p.center.x, p.center.z, p.radius, 72, (x, z) => ground.heightAt(x, z))
      root.add(ribbonMesh(pts, Math.max(0.15, ctx.worldPerPixel * 2.5), ctx.worldPerPixel, color, 0.9))
      const inner = circlePoints(p.center.x, p.center.z, p.radius * 0.5, 48, (x, z) => ground.heightAt(x, z))
      root.add(ribbonMesh(inner, Math.max(0.08, ctx.worldPerPixel * 1.2), ctx.worldPerPixel, color, 0.45))
      break
    }
    case "ghost-objects":
      root.add(ghostObjects(p))
      break
  }
  root.traverse((o) => {
    o.renderOrder = 12
    o.frustumCulled = false
    o.raycast = () => {}
  })
  return root
}

/** Free a preview's geometries and materials (shared unit geometries excluded). */
export function disposePreview(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose()
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => materials.add(x))
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose()
  })
  for (const m of materials) m.dispose()
  root.removeFromParent()
}
