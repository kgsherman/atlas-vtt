/**
 * Token visuals (instanced by the engine's token layer): a base disc and a ring in the token colour
 * plus a rounded body whose height is the token's `height`. Unit geometries are shared; the engine
 * computes per-token instance transforms with tokenTransforms().
 */
import * as THREE from "three"

import { SIZE_FOOTPRINT } from "@/core/scene/defaults"
import { tokenGroundY } from "@/core/scene/queries"
import type { Id, SceneLike, Token } from "@/core/scene/types"

import { hexToLinear, type RGB } from "./color"
import { sharedGeometry } from "./shared"
import { writePrism, writeQuadOutward } from "./shapes"
import { SURF } from "../internal"
import type { MeshWriter } from "./writer"

export const TOKEN_BASE_HEIGHT = 0.12

/** Flat annulus between radii ri and ro at height y, facing up. */
export function writeAnnulus(w: MeshWriter, ri: number, ro: number, y: number, sides: number, color: RGB): void {
  for (let k = 0; k < sides; k++) {
    const a0 = (2 * Math.PI * k) / sides
    const a1 = (2 * Math.PI * (k + 1)) / sides
    writeQuadOutward(
      w,
      [ri * Math.cos(a0), y, ri * Math.sin(a0)],
      [ro * Math.cos(a0), y, ro * Math.sin(a0)],
      [ro * Math.cos(a1), y, ro * Math.sin(a1)],
      [ri * Math.cos(a1), y, ri * Math.sin(a1)],
      [0, 1, 0],
      color,
      SURF.CAP
    )
  }
}

/** Base disc: radius 0.5, y ∈ [0, TOKEN_BASE_HEIGHT]. */
export function tokenBaseGeometry(): THREE.BufferGeometry {
  return sharedGeometry("token:base", (w) => writePrism(w, 0, 0, 0.5, 0, TOKEN_BASE_HEIGHT, 28, [0.35, 0.35, 0.35], { smooth: true }))
}

/** Coloured ring on top of the base (outer radius 0.5). */
export function tokenRingGeometry(): THREE.BufferGeometry {
  return sharedGeometry("token:ring", (w) => {
    writeAnnulus(w, 0.36, 0.5, TOKEN_BASE_HEIGHT + 0.01, 28, [1, 1, 1])
    writePrism(w, 0, 0, 0.5, TOKEN_BASE_HEIGHT - 0.02, TOKEN_BASE_HEIGHT + 0.01, 28, [1, 1, 1], { smooth: true, capTop: false, capBottom: false })
  })
}

/** Rounded body: radius 0.5, height 1 (scaled per token). */
export function tokenBodyGeometry(): THREE.BufferGeometry {
  return sharedGeometry("token:body", (w) => {
    const profile: [number, number][] = [
      [0, 0.46],
      [0.72, 0.5],
      [0.86, 0.44],
      [0.95, 0.3],
      [1, 0.12],
    ]
    for (let k = 0; k + 1 < profile.length; k++) {
      writePrism(w, 0, 0, profile[k][1], profile[k][0], profile[k + 1][0], 18, [0.9, 0.9, 0.9], {
        radiusTop: profile[k + 1][1],
        smooth: true,
        capBottom: k === 0,
        capTop: k + 2 === profile.length,
      })
    }
  })
}

/** Flat outline ring (radius 0.5) used for faded markers, selection and state rings. */
export function tokenOutlineGeometry(): THREE.BufferGeometry {
  return sharedGeometry("token:outline", (w) => writeAnnulus(w, 0.42, 0.5, 0, 36, [1, 1, 1]))
}

export interface TokenVisual {
  id: Id
  levelId: Id
  x: number
  /** Ground Y under the token (world). */
  y: number
  z: number
  /** Footprint side (feet). */
  side: number
  height: number
  color: RGB
}

export function tokenVisual(scene: Pick<SceneLike, "grid" | "levels" | "objects">, token: Token): TokenVisual {
  return {
    id: token.id,
    levelId: token.levelId,
    x: token.position.x,
    y: tokenGroundY(scene, token),
    z: token.position.z,
    side: (SIZE_FOOTPRINT[token.size] ?? 1) * scene.grid.cellSize,
    height: Math.max(0.5, token.height),
    color: hexToLinear(token.color),
  }
}

export interface TokenTransforms {
  base: THREE.Matrix4
  body: THREE.Matrix4
  /** Outline ring just above the base (markers, selection). */
  outline: THREE.Matrix4
}

/** Instance transforms of a token at scale factor `s` (appear/disappear animation). */
export function tokenTransforms(v: Pick<TokenVisual, "x" | "y" | "z" | "side" | "height">, s = 1, out?: TokenTransforms): TokenTransforms {
  const o = out ?? { base: new THREE.Matrix4(), body: new THREE.Matrix4(), outline: new THREE.Matrix4() }
  const d = v.side * 0.9 * s
  o.base.makeScale(d, s, d).setPosition(v.x, v.y, v.z)
  const bd = v.side * 0.45 * s
  o.body.makeScale(bd, Math.max(0.1, v.height - TOKEN_BASE_HEIGHT) * s, bd).setPosition(v.x, v.y + TOKEN_BASE_HEIGHT * s, v.z)
  const od = v.side * 1.02 * s
  o.outline.makeScale(od, 1, od).setPosition(v.x, v.y + TOKEN_BASE_HEIGHT + 0.03, v.z)
  return o
}
