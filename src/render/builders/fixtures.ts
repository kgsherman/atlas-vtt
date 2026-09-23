/**
 * Light fixtures: small holders (torch pole, lantern cage, brazier bowl, candle) drawn with the level's
 * world material (lit, shadowed and fogged like any static geometry: a holder in an unexplored cell must
 * not show), and emissive flames (unlit, light colour, masked by perception) that flicker visually. Fixtures are grouped by
 * the level a light currently belongs to (attached lights follow their token's level).
 */
import * as THREE from "three"

import { lightLevelId, lightWorldPosition } from "@/core/scene/queries"
import type { Id, LightObject, LightPreset } from "@/core/scene/types"

import type { BuildContext } from "./context"
import { hashString, hexToLinear, mixRgb, unitFromHash, type RGB } from "./color"
import { writeBox, writePrism } from "./shapes"
import { sharedGeometry } from "./shared"
import type { BucketBuild, FlameAnimation, MeshBuild } from "./types"
import { MeshWriter } from "./writer"

const IRON: RGB = hexToLinear("#2c2c30")
const WOOD: RGB = hexToLinear("#5a3d22")
const WAX: RGB = hexToLinear("#efe6cf")

/** Flame size (radius, height) per preset, feet. */
export const FLAME_SIZE: Record<LightPreset, [number, number]> = {
  torch: [0.22, 0.5],
  lantern: [0.12, 0.22],
  brazier: [0.45, 0.8],
  candle: [0.06, 0.2],
  magical: [0.3, 0.6],
  custom: [0.2, 0.4],
}

/** Unit flame: a double cone, radius 0.5, y ∈ [−0.5, 0.5]. */
export function flameGeometry(): THREE.BufferGeometry {
  return sharedGeometry("fixture:flame", (w) => {
    writePrism(w, 0, 0, 0.35, -0.5, -0.1, 8, [1, 1, 1], { radiusTop: 0.5, capBottom: true, capTop: false })
    writePrism(w, 0, 0, 0.5, -0.1, 0.5, 8, [1, 1, 1], { radiusTop: 0.02, capBottom: false, capTop: true })
  })
}

/** Holder geometry for one light at world position p over ground y `ground`. */
export function writeHolder(w: MeshWriter, preset: LightPreset, p: { x: number; y: number; z: number }, ground: number): void {
  const { x, y, z } = p
  switch (preset) {
    case "torch": {
      const bottom = Math.max(ground, y - 1.6)
      writeBox(w, x - 0.07, bottom, z - 0.07, x + 0.07, y - 0.2, z + 0.07, WOOD)
      writePrism(w, x, z, 0.1, y - 0.3, y - 0.12, 8, IRON, { radiusTop: 0.17 })
      break
    }
    case "lantern": {
      const h = 0.35
      for (const dx of [-0.2, 0.2]) for (const dz of [-0.2, 0.2]) writeBox(w, x + dx - 0.03, y - h, z + dz - 0.03, x + dx + 0.03, y + h, z + dz + 0.03, IRON)
      writeBox(w, x - 0.25, y + h, z - 0.25, x + 0.25, y + h + 0.08, z + 0.25, IRON)
      writeBox(w, x - 0.25, y - h - 0.06, z - 0.25, x + 0.25, y - h, z + 0.25, IRON)
      writePrism(w, x, z, 0.08, y + h + 0.08, y + h + 0.25, 6, IRON)
      break
    }
    case "brazier": {
      const bowlBottom = y - 0.9
      writePrism(w, x, z, 0.45, bowlBottom, y - 0.35, 12, IRON, { radiusTop: 0.85, smooth: true })
      if (bowlBottom - ground > 0.1) {
        for (let k = 0; k < 3; k++) {
          const a = (2 * Math.PI * k) / 3
          const lx = x + Math.cos(a) * 0.45
          const lz = z + Math.sin(a) * 0.45
          writeBox(w, lx - 0.06, ground, lz - 0.06, lx + 0.06, bowlBottom + 0.05, lz + 0.06, IRON)
        }
      }
      break
    }
    case "candle": {
      writePrism(w, x, z, 0.09, y - 0.6, y - 0.1, 10, WAX, { smooth: true })
      writePrism(w, x, z, 0.22, y - 0.66, y - 0.6, 12, IRON)
      break
    }
    case "magical":
    case "custom":
      break
  }
}

/** Base (un-flickered) flame transform. */
export function flameMatrix(preset: LightPreset, p: { x: number; y: number; z: number }, out = new THREE.Matrix4()): THREE.Matrix4 {
  const [r, h] = FLAME_SIZE[preset] ?? FLAME_SIZE.custom
  const lift = preset === "brazier" ? -0.3 : preset === "magical" || preset === "custom" ? 0 : h * 0.1
  return out.makeScale(r * 2, h, r * 2).setPosition(p.x, p.y + lift, p.z)
}

/** Flame colour: the light colour pushed toward white when on, a dark ember when off. */
export function flameColor(light: Pick<LightObject, "color" | "on">): RGB {
  const c = hexToLinear(light.color)
  return light.on ? mixRgb(c, [1, 1, 1], 0.35) : mixRgb(c, [0, 0, 0], 0.9)
}

const m4 = new THREE.Matrix4()

/** Fixtures bucket of a level: holders (world material) + flames (instanced, unlit overlay). */
export function buildFixturesBucket(ctx: BuildContext, levelId: Id): BucketBuild {
  const holders = new MeshWriter()
  const matrices: number[] = []
  const colors: number[] = []
  const ids: Id[] = []
  const flames: FlameAnimation[] = []
  const scene = ctx.scene
  const lights = Object.values(scene.objects)
    .filter((o): o is LightObject => o.type === "light")
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  for (const light of lights) {
    if (lightLevelId(scene, light) !== levelId || !ctx.level(levelId)) continue
    const p = lightWorldPosition(scene, light)
    const ground = ctx.sampler(levelId).heightAt(p.x, p.z)
    holders.begin(light.id)
    writeHolder(holders, light.preset, p, ground)
    holders.end()
    flameMatrix(light.preset, p, m4)
    for (const v of m4.elements) matrices.push(v)
    const c = flameColor(light)
    colors.push(c[0], c[1], c[2])
    ids.push(light.id)
    flames.push({ flicker: { ...light.flicker }, phase: unitFromHash(hashString(light.id)) * Math.PI * 2, on: light.on })
  }
  const meshes: MeshBuild[] = []
  const g = holders.build()
  if (g) meshes.push({ kind: "merged", name: "holders", slot: "world", geometry: g })
  if (ids.length > 0) {
    meshes.push({
      kind: "instanced",
      name: "flames",
      slot: "flame",
      geometry: flameGeometry(),
      matrices: new Float32Array(matrices),
      colors: new Float32Array(colors),
      ids,
      flames,
    })
  }
  return { meshes }
}

/**
 * Visual flicker factor of a flame at time t (seconds): a sum of incommensurate sines, so it never
 * visibly repeats. Radii never flicker; only the flame's size and brightness do.
 */
export function flameFlicker(anim: FlameAnimation, t: number): number {
  if (!anim.on) return 0.6
  if (!anim.flicker.enabled || anim.flicker.amount <= 0) return 1
  const s = anim.flicker.speed * Math.PI * 2
  const n = 0.5 * Math.sin(t * s + anim.phase) + 0.3 * Math.sin(t * s * 1.73 + anim.phase * 2.1) + 0.2 * Math.sin(t * s * 2.91 + anim.phase * 0.7)
  return 1 + anim.flicker.amount * n
}
