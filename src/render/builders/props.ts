/**
 * Pillars and props as InstancedMeshes (one per unit geometry per level). Prop geometry adds visual
 * detail inside the silhouette of PROP_LIBRARY parts (the shapes core/occlusion blocks with).
 *
 * A prop kind is made of "pieces": `tinted` pieces are multiplied by the prop's colour (vertex
 * colours are shading multipliers), fixed pieces carry their own colour (tree trunks, mattresses,
 * water). `uniformXZ` pieces are scaled by max(scale.x, scale.z) like the library's cylinder parts.
 *
 * Terrain rule: a prop's base sits at ground(centre) + y; a resting prop (y = 0) reaches down to the
 * lowest ground under its resting parts, which the instance transform achieves by stretching the
 * prop vertically between that bottom and its unchanged top.
 */
import * as THREE from "three"

import { PROP_LIBRARY } from "@/core/scene/defaults"
import { levelCeilingY } from "@/core/scene/queries"
import type { Id, PillarObject, PropKind, PropObject } from "@/core/scene/types"

import type { BuildContext } from "./context"
import { hexToLinear, materialColor, tint, type RGB } from "./color"
import { orientedCorners } from "./ground"
import { writeBox, writeCylinderX, writePrism, writeQuadOutward, type FaceColor } from "./shapes"
import type { BucketBuild, InstancedBuild } from "./types"
import { sharedGeometry } from "./shared"
import type { MeshWriter } from "./writer"
import { SURF } from "../internal"

const WHITE: RGB = [1, 1, 1]
const shade = (f: number): RGB => [f, f, f]
/** Near-white multiplier with a subtle deterministic per-face variation. */
const facet =
  (key: string, amount = 0.04, base = 1): FaceColor =>
  (face) =>
    tint(shade(base), `${key}:${face}`, amount)

interface PropPiece {
  name: string
  tinted: boolean
  uniformXZ: boolean
  build: (w: MeshWriter) => void
}

const BROWN_TRUNK: RGB = hexToLinear("#5a3d22")
const DARK_WOOD: RGB = hexToLinear("#4a3320")
const STONE: RGB = hexToLinear("#8f8b85")
const LINEN: RGB = hexToLinear("#e8e1d0")
const PILLOW: RGB = hexToLinear("#f2efe6")
const WATER: RGB = hexToLinear("#1d3a4a")

/** Stack of frusta: [y, radius] profile points from bottom to top. */
function writeProfile(w: MeshWriter, profile: readonly [number, number][], sides: number, color: FaceColor, smooth: boolean, phase = 0): void {
  for (let k = 0; k + 1 < profile.length; k++) {
    const [y0, r0] = profile[k]
    const [y1, r1] = profile[k + 1]
    writePrism(w, 0, 0, r0, y0, y1, sides, color, {
      radiusTop: r1,
      smooth,
      phase,
      capBottom: k === 0,
      capTop: k + 2 === profile.length,
    })
  }
}

const PROP_PIECES: Record<PropKind, PropPiece[]> = {
  table: [
    {
      name: "wood",
      tinted: true,
      uniformXZ: false,
      build: (w) => {
        writeBox(w, -2.5, 2.2, -1.5, 2.5, 2.5, 1.5, facet("table:top"))
        for (const x of [-2.2, 2.2]) for (const z of [-1.2, 1.2]) writeBox(w, x - 0.15, 0, z - 0.15, x + 0.15, 2.2, z + 0.15, shade(0.85))
      },
    },
  ],
  chair: [
    {
      name: "wood",
      tinted: true,
      uniformXZ: false,
      build: (w) => {
        writeBox(w, -0.75, 1.3, -0.75, 0.75, 1.55, 0.75, facet("chair:seat"))
        for (const x of [-0.62, 0.62]) for (const z of [-0.62, 0.62]) writeBox(w, x - 0.09, 0, z - 0.09, x + 0.09, 1.3, z + 0.09, shade(0.85))
        writeBox(w, -0.75, 1.55, 0.55, 0.75, 3, 0.75, shade(0.93))
      },
    },
  ],
  crate: [
    {
      name: "wood",
      tinted: true,
      uniformXZ: false,
      build: (w) => {
        writeBox(w, -1.48, 0, -1.48, 1.48, 2.98, 1.48, facet("crate", 0.05))
        for (const x of [-1.37, 1.37]) for (const z of [-1.37, 1.37]) writeBox(w, x - 0.13, 0, z - 0.13, x + 0.13, 3, z + 0.13, shade(0.72))
        for (const y of [0, 2.75]) {
          writeBox(w, -1.5, y, -1.5, 1.5, y + 0.25, -1.24, shade(0.72))
          writeBox(w, -1.5, y, 1.24, 1.5, y + 0.25, 1.5, shade(0.72))
          writeBox(w, -1.5, y, -1.5, -1.24, y + 0.25, 1.5, shade(0.72))
          writeBox(w, 1.24, y, -1.5, 1.5, y + 0.25, 1.5, shade(0.72))
        }
      },
    },
  ],
  barrel: [
    {
      name: "wood",
      tinted: true,
      uniformXZ: true,
      build: (w) => {
        writeProfile(w, [
          [0, 1.08],
          [1.75, 1.22],
          [3.5, 1.08],
        ], 14, facet("barrel", 0.05), true)
        for (const y of [0.35, 1.65, 3.0]) writePrism(w, 0, 0, 1.25, y, y + 0.18, 14, shade(0.42), { smooth: true, capTop: false, capBottom: false })
      },
    },
  ],
  chest: [
    {
      name: "wood",
      tinted: true,
      uniformXZ: false,
      build: (w) => {
        writeBox(w, -1.46, 0, -0.96, 1.46, 1.3, 0.96, facet("chest:body"))
        writeBox(w, -1.46, 1.3, -0.96, 1.46, 1.98, 0.96, shade(0.92))
        for (const x of [-0.9, 0.9]) writeBox(w, x - 0.1, 0, -1, x + 0.1, 2, 1, shade(0.45))
        writeBox(w, -0.15, 1.05, -1, 0.15, 1.45, -0.94, shade(0.4))
      },
    },
  ],
  bookshelf: [
    {
      name: "wood",
      tinted: true,
      uniformXZ: false,
      build: (w) => {
        writeBox(w, -2, 0, -0.75, 2, 7, 0.75, facet("shelf"))
        for (let k = 0; k < 5; k++) writeBox(w, -1.9, 0.3 + k * 1.35, 0.6, 1.9, 0.42 + k * 1.35, 0.78, shade(0.8))
      },
    },
    {
      name: "books",
      tinted: false,
      uniformXZ: false,
      build: (w) => {
        const palette = ["#7a2e2e", "#2e4a7a", "#3d6b3a", "#8a6a2a", "#5a3a6a"].map(hexToLinear)
        for (let row = 0; row < 4; row++) {
          let x = -1.85
          let k = 0
          while (x < 1.7) {
            const bw = 0.18 + ((row * 7 + k * 3) % 5) * 0.03
            const bh = 0.85 + ((row * 5 + k * 7) % 4) * 0.06
            const y0 = 0.42 + row * 1.35
            writeBox(w, x, y0, 0.62, Math.min(1.85, x + bw), y0 + bh, 0.77, palette[(row * 3 + k) % palette.length])
            x += bw + 0.02
            k++
          }
        }
      },
    },
  ],
  bed: [
    {
      name: "frame",
      tinted: true,
      uniformXZ: false,
      build: (w) => {
        writeBox(w, -1.75, 0, -3.5, 1.75, 1.2, 3.5, facet("bed"))
        writeBox(w, -1.75, 1.2, -3.5, 1.75, 2, -3.2, shade(0.85))
      },
    },
    {
      name: "linen",
      tinted: false,
      uniformXZ: false,
      build: (w) => {
        writeBox(w, -1.6, 1.2, -3.2, 1.6, 1.7, 3.4, LINEN)
        writeBox(w, -1.2, 1.7, -3.1, 1.2, 1.95, -2.4, PILLOW)
      },
    },
  ],
  altar: [
    {
      name: "stone",
      tinted: true,
      uniformXZ: false,
      build: (w) => {
        writeBox(w, -2.3, 0, -1.3, 2.3, 3.1, 1.3, facet("altar", 0.03, 0.9))
        writeBox(w, -2.5, 3.1, -1.5, 2.5, 3.5, 1.5, facet("altar:top", 0.03))
      },
    },
  ],
  statue: [
    {
      name: "base",
      tinted: false,
      uniformXZ: false,
      build: (w) => writeBox(w, -1.5, 0, -1.5, 1.5, 1, 1.5, (face) => tint(STONE, `statue:base:${face}`, 0.04)),
    },
    {
      name: "figure",
      tinted: true,
      uniformXZ: true,
      build: (w) => {
        writeProfile(w, [
          [1, 0.9],
          [4.5, 0.7],
          [6.2, 0.62],
          [6.6, 0.3],
        ], 12, facet("statue"), true)
        writePrism(w, 0, 0, 0.42, 6.6, 7.9, 10, WHITE, { smooth: true, radiusTop: 0.3 })
      },
    },
  ],
  tree: [
    {
      name: "trunk",
      tinted: false,
      uniformXZ: true,
      build: (w) => writePrism(w, 0, 0, 0.75, 0, 7.5, 9, (face) => tint(BROWN_TRUNK, `trunk:${face}`, 0.08), { radiusTop: 0.5, smooth: true }),
    },
    {
      name: "canopy",
      tinted: true,
      uniformXZ: true,
      build: (w) =>
        writeProfile(w, [
          [7, 2.8],
          [9, 4],
          [14.5, 3.9],
          [18, 1.6],
        ], 10, facet("canopy", 0.1), false, 0.3),
    },
  ],
  bush: [
    {
      name: "leaves",
      tinted: true,
      uniformXZ: true,
      build: (w) =>
        writeProfile(w, [
          [0, 1.5],
          [1, 2],
          [2, 1.95],
          [3, 1.1],
        ], 9, facet("bush", 0.1), false),
    },
  ],
  rock: [
    {
      name: "rock",
      tinted: true,
      uniformXZ: true,
      build: (w) =>
        writeProfile(w, [
          [0, 2.1],
          [0.5, 2.25],
          [2.6, 1.85],
          [4, 0.8],
        ], 7, facet("rock", 0.12), false, 0.4),
    },
  ],
  well: [
    {
      name: "wall",
      tinted: true,
      uniformXZ: true,
      build: (w) => {
        const sides = 16
        const ro = 2.5
        const ri = 1.9
        writePrism(w, 0, 0, ro, 0, 3, sides, facet("well", 0.05), { capTop: false, capBottom: true })
        // Inner face (normals toward the axis) and the top ring.
        for (let k = 0; k < sides; k++) {
          const a0 = (2 * Math.PI * k) / sides
          const a1 = (2 * Math.PI * (k + 1)) / sides
          const mid = (a0 + a1) / 2
          const pi = (a: number, y: number, r: number): [number, number, number] => [r * Math.cos(a), y, r * Math.sin(a)]
          writeQuadOutward(w, pi(a0, 0.8, ri), pi(a1, 0.8, ri), pi(a1, 3, ri), pi(a0, 3, ri), [-Math.cos(mid), 0, -Math.sin(mid)], shade(0.7), SURF.FACE)
          writeQuadOutward(w, pi(a0, 3, ri), pi(a1, 3, ri), pi(a1, 3, ro), pi(a0, 3, ro), [0, 1, 0], shade(0.95), SURF.CAP)
        }
      },
    },
    {
      name: "water",
      tinted: false,
      uniformXZ: true,
      build: (w) => writePrism(w, 0, 0, 1.9, 0.6, 0.8, 16, WATER, { capBottom: false }),
    },
  ],
  cart: [
    {
      name: "body",
      tinted: true,
      uniformXZ: false,
      build: (w) => {
        writeBox(w, -2, 1.6, -3.2, 2, 2.2, 3.2, facet("cart:bed"))
        writeBox(w, -2, 2.2, -3.2, -1.82, 3.4, 3.2, shade(0.9))
        writeBox(w, 1.82, 2.2, -3.2, 2, 3.4, 3.2, shade(0.9))
        writeBox(w, -1.82, 2.2, -3.2, 1.82, 3.2, -3.02, shade(0.9))
        writeBox(w, -1.82, 2.2, 3.02, 1.82, 3.2, 3.2, shade(0.9))
        for (const x of [-0.8, 0.8]) writeBox(w, x - 0.1, 1.7, 3.2, x + 0.1, 1.9, 4, shade(0.8))
      },
    },
    {
      name: "wheels",
      tinted: false,
      uniformXZ: false,
      build: (w) => {
        for (const x of [-2.5, 2.2]) for (const z of [-2, 2]) writeCylinderX(w, x, x + 0.3, 1.5, z, 1.5, 12, DARK_WOOD)
        writeBox(w, -2.2, 1.35, -2.1, 2.2, 1.6, -1.9, DARK_WOOD)
        writeBox(w, -2.2, 1.35, 1.9, 2.2, 1.6, 2.1, DARK_WOOD)
      },
    },
  ],
}

/** Unit geometry of one prop piece (local unscaled feet, base at y = 0). */
export function propPieceGeometry(kind: PropKind, piece: PropPiece): THREE.BufferGeometry {
  return sharedGeometry(`prop:${kind}:${piece.name}`, piece.build)
}

export function propPieces(kind: PropKind): readonly PropPiece[] {
  return PROP_PIECES[kind] ?? PROP_PIECES.crate
}

// ---------------------------------------------------------------------------
// Transforms (Terrain rule)
// ---------------------------------------------------------------------------

export interface PropPlacement {
  /** Bottom and top world Y after the Terrain rule. */
  bottom: number
  top: number
  /** Vertical stretch applied so the unscaled base reaches `bottom`. */
  stretch: number
  baseY: number
}

export function propPlacement(ctx: BuildContext, prop: PropObject): PropPlacement {
  const def = PROP_LIBRARY[prop.kind] ?? PROP_LIBRARY.crate
  const ground = ctx.sampler(prop.levelId)
  const sx = Math.abs(prop.scale.x)
  const sy = Math.abs(prop.scale.y)
  const sz = Math.abs(prop.scale.z)
  const baseY = ground.heightAt(prop.position.x, prop.position.z) + prop.position.y
  const top = baseY + def.size.y * sy
  let bottom = baseY
  if (prop.position.y === 0) {
    const cos = Math.cos(prop.rotationY)
    const sin = Math.sin(prop.rotationY)
    for (const part of def.parts) {
      if (part.offset.y !== 0) continue
      const lx = part.offset.x * sx
      const lz = part.offset.z * sz
      const c = { x: prop.position.x + cos * lx + sin * lz, z: prop.position.z - sin * lx + cos * lz }
      const poly =
        part.shape === "box"
          ? orientedCorners(c, (part.size.x * sx) / 2, (part.size.z * sz) / 2, { x: cos, z: -sin })
          : orientedCorners(c, (Math.max(sx, sz) * part.size.x) / 2, (Math.max(sx, sz) * part.size.x) / 2)
      bottom = Math.min(bottom, ground.rangeOverPolygon(poly).min)
    }
  }
  const stretch = top > baseY ? (top - bottom) / (top - baseY) : 1
  return { bottom, top, stretch, baseY }
}

const m4 = new THREE.Matrix4()
const q4 = new THREE.Quaternion()
const yAxis = new THREE.Vector3(0, 1, 0)
const v3a = new THREE.Vector3()
const v3b = new THREE.Vector3()

/** Instance matrix of a prop piece. */
export function propPieceMatrix(prop: PropObject, placement: PropPlacement, uniformXZ: boolean, out = new THREE.Matrix4()): THREE.Matrix4 {
  const sx = Math.abs(prop.scale.x)
  const sy = Math.abs(prop.scale.y)
  const sz = Math.abs(prop.scale.z)
  const u = Math.max(sx, sz)
  q4.setFromAxisAngle(yAxis, prop.rotationY)
  v3a.set(prop.position.x, placement.bottom, prop.position.z)
  v3b.set(uniformXZ ? u : sx, sy * placement.stretch, uniformXZ ? u : sz)
  return out.compose(v3a, q4, v3b)
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

interface InstanceAccumulator {
  matrices: number[]
  colors: number[]
  ids: Id[]
}

function accumulator(): InstanceAccumulator {
  return { matrices: [], colors: [], ids: [] }
}

function pushInstance(acc: InstanceAccumulator, m: THREE.Matrix4, color: RGB, id: Id): void {
  for (const v of m.elements) acc.matrices.push(v)
  acc.colors.push(color[0], color[1], color[2])
  acc.ids.push(id)
}

function toBuild(name: string, geometry: THREE.BufferGeometry, acc: InstanceAccumulator): InstancedBuild {
  return {
    kind: "instanced",
    name,
    slot: "world",
    geometry,
    matrices: new Float32Array(acc.matrices),
    colors: new Float32Array(acc.colors),
    ids: acc.ids,
  }
}

/** Props bucket: one instanced mesh per (kind, piece) present on the level. */
export function buildPropsBucket(ctx: BuildContext, levelId: Id): BucketBuild {
  const groups = new Map<string, { geometry: THREE.BufferGeometry; acc: InstanceAccumulator }>()
  for (const prop of ctx.ofType(levelId, "prop")) {
    const kind = PROP_LIBRARY[prop.kind] ? prop.kind : "crate"
    const placement = propPlacement(ctx, prop)
    if (!(placement.top - placement.bottom > 1e-6)) continue
    const color = hexToLinear(prop.color ?? PROP_LIBRARY[kind].defaultColor)
    for (const piece of propPieces(kind)) {
      const key = `prop:${kind}:${piece.name}`
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { geometry: propPieceGeometry(kind, piece), acc: accumulator() }))
      pushInstance(g.acc, propPieceMatrix(prop, placement, piece.uniformXZ, m4), piece.tinted ? color : WHITE, prop.id)
    }
  }
  return { meshes: [...groups.entries()].map(([name, g]) => toBuild(name, g.geometry, g.acc)) }
}

export function pillarGeometry(shape: PillarObject["shape"]): THREE.BufferGeometry {
  return shape === "square"
    ? sharedGeometry("pillar:square", (w) => {
        writeBox(w, -0.5, 0, -0.5, 0.5, 1, 0.5, facet("pillar:square", 0.03))
      })
    : sharedGeometry("pillar:round", (w) => writePrism(w, 0, 0, 0.5, 0, 1, 16, WHITE, { smooth: true }))
}

/** Pillar extent per the Terrain rule; null height = up to the level's ceiling. */
export function pillarExtent(ctx: BuildContext, p: PillarObject): { bottom: number; top: number } {
  const ground = ctx.sampler(p.levelId)
  const half = p.size / 2
  const bottom = ground.rangeOverPolygon(orientedCorners(p.position, half, half)).min
  const top = p.height === null ? levelCeilingY(ctx.scene, p.levelId) : ground.heightAt(p.position.x, p.position.z) + p.height
  return { bottom, top }
}

/** Pillars bucket: one instanced mesh per shape. */
export function buildPillarsBucket(ctx: BuildContext, levelId: Id): BucketBuild {
  const groups = new Map<PillarObject["shape"], InstanceAccumulator>()
  for (const p of ctx.ofType(levelId, "pillar")) {
    if (!(p.size > 0)) continue
    const { bottom, top } = pillarExtent(ctx, p)
    if (!(top - bottom > 1e-6)) continue
    const shape = p.shape === "square" ? "square" : "round"
    let acc = groups.get(shape)
    if (!acc) groups.set(shape, (acc = accumulator()))
    m4.makeScale(p.size, top - bottom, p.size).setPosition(p.position.x, bottom, p.position.z)
    pushInstance(acc, m4, tint(materialColor(p.material), p.id, 0.04), p.id)
  }
  return { meshes: [...groups.entries()].map(([shape, acc]) => toBuild(`pillar:${shape}`, pillarGeometry(shape), acc)) }
}
