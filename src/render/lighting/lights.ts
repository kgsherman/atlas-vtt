/**
 * Light manager, CPU side (PERFORMANCE §2): resolve scene lights into world space, cull them
 * (off / hidden, dim sphere outside the frustum, above the cutaway) and rank the survivors by screen
 * contribution so the top MAX_LIGHTS go into uniform slots.
 */
import * as THREE from "three"

import type { OcclusionWorld } from "@/core/occlusion/types"
import { adjacentLevels, groundIndex, levelById, lightEffectivelyHidden, lightLevelId, lightWorldPosition, type GroundIndex } from "@/core/scene/queries"
import type { FlickerSettings, Id, LightObject, LightPreset, SceneLike, Vec3 } from "@/core/scene/types"
import { resolveLightOrigin } from "@/core/vision"

import { flickerSeed } from "./flicker"

export interface ResolvedLight {
  id: Id
  levelId: Id
  /**
   * Shadow / capture origin: the world position pushed out of containing light blockers, the same point
   * the CPU light field (core/vision) casts from. A light on a floor surface or inside a wall must not
   * see through the blocker it sits in (the occluder test ignores primitives containing the source).
   */
  position: Vec3
  /** Linear RGB (not multiplied by intensity). */
  color: [number, number, number]
  intensity: number
  bright: number
  dim: number
  flicker: FlickerSettings
  seed: number
  castsShadows: boolean
  /** Radius of the emitting body (feet): penumbra size of the ultra tier's soft shadows. */
  sourceRadius: number
}

/** Emitter radius per preset (a torch head, a lantern's flame, a brazier's coals, a magical orb). */
export const LIGHT_SOURCE_RADIUS: Record<LightPreset, number> = {
  torch: 0.5,
  lantern: 0.35,
  brazier: 0.9,
  candle: 0.15,
  magical: 0.6,
  custom: 0.5,
}

const colorCache = new Map<string, [number, number, number]>()
const scratchColor = new THREE.Color()

/** "#rrggbb" (sRGB) → linear RGB, cached. */
export function linearColor(hex: string): [number, number, number] {
  let c = colorCache.get(hex)
  if (!c) {
    try {
      scratchColor.set(hex)
    } catch {
      scratchColor.setRGB(1, 1, 1)
    }
    c = [scratchColor.r, scratchColor.g, scratchColor.b]
    colorCache.set(hex, c)
  }
  return c
}

/**
 * Lights that emit: `on`, and not effectively hidden unless `includeHidden` (the DM with vision "off"
 * sees hidden lights; previews and players never do). Sorted by id for determinism. Positions are pushed
 * out of the light blockers of `world` like the authoritative light field (core/vision
 * resolveLightWorldOrigin), with the ground heights read from one `groundIndex(scene)` instead of a scan
 * of every object per light (engine scenes are never mutated in place, so the memoised index is valid).
 */
export function resolveLights(scene: SceneLike, world: OcclusionWorld, opts: { includeHidden: boolean }): ResolvedLight[] {
  const out: ResolvedLight[] = []
  let ground: GroundIndex | null = null
  for (const o of Object.values(scene.objects)) {
    if (o.type !== "light" || !o.on) continue
    if (!opts.includeHidden && lightEffectivelyHidden(scene, o)) continue
    const dim = Math.max(0, o.dimRadius)
    if (!(dim > 0) || !(o.intensity > 0)) continue
    ground ??= groundIndex(scene)
    const l = resolveLight(scene, world, ground, o, dim)
    // Non-finite values would corrupt the packed uniform array (and three's array upload).
    if (!Number.isFinite(l.position.x + l.position.y + l.position.z + l.dim + l.bright + l.intensity)) continue
    out.push(l)
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Light origin exactly as core/vision resolveLightWorldOrigin computes it (lightWorldPosition, pushed out
 * of light blockers with slabs pushed toward the light's ground), reading ground heights from `ground`.
 * The raw world position if that fails (degenerate documents).
 */
export function lightOrigin(world: OcclusionWorld, scene: SceneLike, ground: GroundIndex, o: LightObject): Vec3 {
  try {
    const carrier = o.attachedTokenId && Object.hasOwn(scene.tokens, o.attachedTokenId) ? scene.tokens[o.attachedTokenId] : null
    const at = carrier ? carrier.position : o.position
    const g = ground.groundHeightAt(carrier ? carrier.levelId : o.levelId, at)
    const p = carrier ? { x: at.x + o.position.x, y: g + o.position.y, z: at.z + o.position.z } : { x: at.x, y: g + o.position.y, z: at.z }
    return resolveLightOrigin(world, p, g)
  } catch {
    try {
      return lightWorldPosition(scene, o)
    } catch {
      return { x: o.position.x, y: o.position.y, z: o.position.z }
    }
  }
}

function resolveLight(scene: SceneLike, world: OcclusionWorld, ground: GroundIndex, o: LightObject, dim: number): ResolvedLight {
  return {
    id: o.id,
    levelId: lightLevelId(scene, o),
    position: lightOrigin(world, scene, ground, o),
    color: linearColor(o.color),
    intensity: o.intensity,
    bright: Math.min(Math.max(0, o.brightRadius), dim),
    dim,
    flicker: o.flicker,
    seed: flickerSeed(o.id),
    castsShadows: o.castsShadows,
    sourceRadius: LIGHT_SOURCE_RADIUS[o.preset] ?? 0.3,
  }
}

/**
 * World Y of the cutaway plane: the underside of the slab of the level above the active one. Lights
 * whose dim sphere lies entirely above it cannot reach any drawn geometry. null = no cutaway.
 */
export function cutawayPlaneY(scene: Pick<SceneLike, "levels">, activeLevelId: Id | null): number | null {
  if (!activeLevelId || !levelById(scene, activeLevelId)) return null
  const { above } = adjacentLevels(scene, activeLevelId)
  return above ? above.elevation - above.floorThickness : null
}

const _center = new THREE.Vector3()
const _ndc = new THREE.Vector3()
const _camPos = new THREE.Vector3()

/**
 * Rough fraction of the screen covered by a light's dim sphere (projected disc clipped to the NDC
 * square). 1 when the camera is inside the sphere; 0 when entirely off screen.
 */
export function screenCoverage(center: Vec3, radius: number, camera: THREE.Camera): number {
  _center.set(center.x, center.y, center.z)
  camera.getWorldPosition(_camPos)
  const dist = _camPos.distanceTo(_center)
  if (dist <= radius) return 1
  let rNdc: number
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const c = camera as THREE.OrthographicCamera
    const halfH = (c.top - c.bottom) / (2 * c.zoom)
    rNdc = radius / Math.max(halfH, 1e-6)
  } else if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const c = camera as THREE.PerspectiveCamera
    const t = Math.tan(THREE.MathUtils.degToRad(c.getEffectiveFOV()) / 2)
    rNdc = radius / Math.max(Math.sqrt(Math.max(dist * dist - radius * radius, 1e-6)) * t, 1e-6)
  } else {
    return 0.5
  }
  _ndc.copy(_center).project(camera)
  if (!Number.isFinite(_ndc.x) || !Number.isFinite(_ndc.y)) return 0.5
  const w = Math.max(0, Math.min(1, _ndc.x + rNdc) - Math.max(-1, _ndc.x - rNdc))
  const h = Math.max(0, Math.min(1, _ndc.y + rNdc) - Math.max(-1, _ndc.y - rNdc))
  // Clipped bounding square × π/4 (disc in its square), over the NDC area of 4.
  return Math.min(1, (w * h * Math.PI) / 16)
}

export interface RankedLight extends ResolvedLight {
  coverage: number
  score: number
}

export interface LightCullOptions {
  frustum: THREE.Frustum
  camera: THREE.Camera
  cutawayY: number | null
  maxLights: number
}

const _sphere = new THREE.Sphere()

/** Frustum ∩ dim sphere and cutaway culling, then the top `maxLights` by coverage × intensity. */
export function cullAndRankLights(lights: ResolvedLight[], opts: LightCullOptions): RankedLight[] {
  const out: RankedLight[] = []
  for (const l of lights) {
    if (opts.cutawayY !== null && l.position.y - l.dim > opts.cutawayY) continue
    _sphere.center.set(l.position.x, l.position.y, l.position.z)
    _sphere.radius = l.dim
    if (!opts.frustum.intersectsSphere(_sphere)) continue
    const coverage = screenCoverage(l.position, l.dim, opts.camera)
    out.push({ ...l, coverage, score: coverage * Math.max(l.intensity, 1e-3) })
  }
  out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out.slice(0, opts.maxLights)
}
