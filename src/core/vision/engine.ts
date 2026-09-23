/**
 * VisionEngine implementation (docs/ARCHITECTURE.md §5.2, §5.4): owns an OcclusionWorld, the sample
 * layout, the LightField and per-viewer caches, and applies scene revisions incrementally.
 *
 * Worker-safe: plain data in and out, no DOM. Scene revisions are expected to be immutable (immer
 * style); VisionChange lists what changed since the previous revision.
 */
import type { AABB3 } from "../geometry/box"
import { buildOcclusionWorld } from "../occlusion"
import type { DirtyRegion, OcclusionWorld } from "../occlusion/types"
import { chunkSamples, parseChunkKey, sampleSpacing } from "../scene/heightmap"
import { structureSignature, tokenRect } from "../scene/queries"
import type { Id, Level, LightObject, Rect, SceneLike, SceneObject, SceneObjectType, Token, Vec3 } from "../scene/types"
import { eyeAtGround, resolveLightOrigin, tokenPointsAtGround } from "./eye"
import { SampleLayout, type InsideInfo } from "./layout"
import { environmentSignature, expandBounds, LightField, sceneBounds, type LightSource } from "./lightField"
import { createCellMask, createGradeMask, FULL_SUBMASK, setCell } from "./mask"
import { FootprintCache, observedObjectIds } from "./observe"
import { SceneIndex } from "./sceneIndex"
import {
  SAMPLES_PER_CELL,
  type CellMask,
  type GradeMask,
  type LightLevel,
  type Viewer,
  type VisibilityResult,
  type VisionChange,
  type VisionEngine,
} from "./types"
import { Evaluator, ViewerState } from "./viewer"

/** Viewer caches kept between computes (least recently used beyond this are dropped). */
const MAX_VIEWER_CACHES = 32
const EMPTY_KEYS: ReadonlySet<string> = new Set()

const own = <T>(rec: Record<Id, T>, id: Id): T | undefined => (Object.hasOwn(rec, id) ? rec[id] : undefined)

const regionBox = (r: DirtyRegion): AABB3 => ({ minX: r.min.x, minY: r.min.y, minZ: r.min.z, maxX: r.max.x, maxY: r.max.y, maxZ: r.max.z })

/** World rect covering the heightmap chunks that differ between two revisions of a level. */
function terrainDirtyRect(before: Level | undefined, after: Level, cellSize: number, width: number, depth: number): Rect {
  const full = { x: 0, z: 0, w: width * cellSize, d: depth * cellSize }
  const a = before?.heightmap
  const b = after.heightmap
  if (!a || !b || a.resolution !== b.resolution || before === after) return full
  const n = chunkSamples(b.resolution)
  const s = sampleSpacing(cellSize, b.resolution)
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  for (const key of new Set([...Object.keys(a.chunks), ...Object.keys(b.chunks)])) {
    if (own(a.chunks, key) === own(b.chunks, key)) continue
    const { ci, cj } = parseChunkKey(key)
    x0 = Math.min(x0, ci * n * s)
    z0 = Math.min(z0, cj * n * s)
    // A chunk owns samples [ci·n, (ci+1)·n): the lattice cells touching them reach one sample further.
    x1 = Math.max(x1, (ci + 1) * n * s)
    z1 = Math.max(z1, (cj + 1) * n * s)
  }
  if (x0 === Infinity) return { x: 0, z: 0, w: 0, d: 0 }
  return { x: x0 - s, z: z0 - s, w: x1 - x0 + 2 * s, d: z1 - z0 + 2 * s }
}

export interface SampleInspection {
  valid: boolean
  position: Vec3
  light: LightLevel
  sunlit: boolean
  /** Buried in a sight/light blocker. */
  buried: boolean
  topProbe: Vec3 | null
}

export class VisionEngineImpl implements VisionEngine {
  private scene!: SceneLike
  private worldImpl!: OcclusionWorld
  private index!: SceneIndex
  private layout!: SampleLayout
  private light!: LightField
  private evaluator!: Evaluator
  private readonly viewers = new Map<Id, ViewerState>()
  private readonly footprints = new FootprintCache()
  private readonly pointCache = new Map<Id, { key: string; points: Vec3[] }>()
  private structureSig = ""
  private envSig = ""
  /** Ids of light objects in the current scene. */
  private lightIds = new Set<Id>()
  /** Last known type and rect of floors / connectors (their old footprint matters when they move). */
  private areas = new Map<Id, { type: SceneObjectType; rect: Rect }>()
  private tick = 0

  constructor(scene: SceneLike) {
    this.setScene(scene)
  }

  /** The engine's occlusion world (the host may reuse it, e.g. for movement validation). */
  get world(): OcclusionWorld {
    return this.worldImpl
  }

  setScene(scene: SceneLike): void {
    this.scene = scene
    this.worldImpl = buildOcclusionWorld(scene)
    this.rebuild()
  }

  private rebuild(): void {
    const scene = this.scene
    const world = this.worldImpl
    this.index = new SceneIndex(scene, world)
    this.layout = new SampleLayout(this.index, world)
    this.light = new LightField(world, this.layout, scene.environment, sceneBounds(scene.grid, this.index.levels, world))
    this.evaluator = new Evaluator(world, this.layout, this.light)
    this.viewers.clear()
    this.footprints.clear()
    this.pointCache.clear()
    this.structureSig = structureSignature(scene)
    this.envSig = environmentSignature(scene.environment)
    this.lightIds = new Set()
    this.areas = new Map()
    for (const o of Object.values(scene.objects)) {
      if (o.type === "light") this.lightIds.add(o.id)
      else if (o.type === "floor" || o.type === "connector") this.areas.set(o.id, { type: o.type, rect: o.rect })
    }
    for (const id of this.lightIds) this.light.setLight(id, this.resolveLight(id))
  }

  /**
   * A light as vision sees it, or null when it is off, hidden (or its carrier is) or gone. The origin
   * is pushed out of containing light blockers (resolveLightOrigin), so a torch inside a wall or a
   * candle on a slab cannot shine through it; update() re-resolves every light after occluder edits.
   */
  private resolveLight(id: Id): LightSource | null {
    const o = own(this.scene.objects, id)
    if (!o || o.type !== "light" || !o.on || o.hidden) return null
    const token = o.attachedTokenId ? own(this.scene.tokens, o.attachedTokenId) : undefined
    if (token) {
      if (token.hidden) return null
      const ground = this.index.groundAtLevel(token.levelId, token.position.x, token.position.z)
      return {
        id,
        levelId: token.levelId,
        pos: resolveLightOrigin(this.worldImpl, { x: token.position.x + o.position.x, y: ground + o.position.y, z: token.position.z + o.position.z }, ground),
        bright: o.brightRadius,
        dim: o.dimRadius,
        castsShadows: o.castsShadows,
      }
    }
    const ground = this.index.groundAtLevel(o.levelId, o.position.x, o.position.z)
    return {
      id,
      levelId: o.levelId,
      pos: resolveLightOrigin(this.worldImpl, { x: o.position.x, y: ground + o.position.y, z: o.position.z }, ground),
      bright: o.brightRadius,
      dim: o.dimRadius,
      castsShadows: o.castsShadows,
    }
  }

  update(scene: SceneLike, change: VisionChange): void {
    const prev = this.scene
    this.scene = scene
    if (structureSignature(scene) !== this.structureSig) {
      this.worldImpl = buildOcclusionWorld(scene)
      this.rebuild()
      return
    }
    this.index.setScene(scene)
    const world = this.worldImpl
    const grid = scene.grid

    // Classify changed objects (old and new revision) into lights and occluders.
    const occluders = new Set<Id>()
    const changedLights = new Set<Id>()
    const areas: Rect[] = []
    let connectorsChanged = false
    let floorsChanged = false
    const walls = new Set<Id>()
    const ids = [...new Set(change.objects ?? [])]
    for (const id of ids) {
      const before = own(prev.objects, id)
      const after = own(scene.objects, id)
      const known = this.areas.get(id)
      if (before?.type === "light" || after?.type === "light" || this.lightIds.has(id)) changedLights.add(id)
      if ((before && before.type !== "light") || (after && after.type !== "light") || (!before && !after)) occluders.add(id)
      for (const t of [before?.type, after?.type, known?.type]) {
        if (t === "connector") connectorsChanged = true
        if (t === "floor") floorsChanged = true
        if (t === "wall") walls.add(id)
      }
      if (known) areas.push(known.rect)
      if (after && (after.type === "floor" || after.type === "connector")) {
        areas.push(after.rect)
        this.areas.set(id, { type: after.type, rect: after.rect })
      } else if (known) {
        this.areas.delete(id)
      }
      if (after?.type === "light") this.lightIds.add(id)
      else this.lightIds.delete(id)
    }
    this.footprints.invalidate(ids, walls)

    // Occluders and terrain.
    const regions: DirtyRegion[] = []
    if (occluders.size > 0) regions.push(...world.update(scene, occluders))
    const terrain = [...new Set(change.terrain ?? [])].filter((id) => this.index.levelIdx.has(id))
    for (const levelId of terrain) {
      const rect = terrainDirtyRect(own(prev.levels, levelId), scene.levels[levelId], grid.cellSize, grid.width, grid.depth)
      if (rect.w <= 0 || rect.d <= 0) continue
      areas.push(rect)
      regions.push(...world.updateTerrain(scene, levelId, rect))
      // Stairs arriving on this level interpolate up to its ground.
      for (const o of Object.values(scene.objects)) {
        if (o.type === "connector" && o.toLevelId === levelId) areas.push(o.rect)
      }
    }
    if (connectorsChanged) this.index.refreshConnectors()
    if (connectorsChanged || floorsChanged || terrain.length > 0) this.index.refreshFloors(world)

    // Sample layout under everything that changed.
    const boxes = regions.map(regionBox)
    for (const b of boxes) areas.push({ x: b.minX, z: b.minZ, w: b.maxX - b.minX, d: b.maxZ - b.minZ })
    const changedSamples: number[] = []
    const rebuiltCells: number[] = []
    const L = this.layout
    for (const a of areas) {
      const s = grid.cellSize
      const i0 = Math.floor((a.x - 0.5) / s)
      const j0 = Math.floor((a.z - 0.5) / s)
      const i1 = Math.floor((a.x + a.w + 0.5) / s)
      const j1 = Math.floor((a.z + a.d + 0.5) / s)
      for (let li = 0; li < L.nLevels; li++) {
        L.rebuildRect(li, i0, j0, i1, j1, changedSamples)
        for (let j = Math.max(0, j0); j <= Math.min(L.depth - 1, j1); j++) {
          for (let i = Math.max(0, i0); i <= Math.min(L.width - 1, i1); i++) rebuiltCells.push(li * L.cellsPerLevel + j * L.width + i)
        }
      }
    }
    if (changedSamples.length > 0) boxes.push(this.samplesBox(changedSamples))

    // Light field: sky/sun under the changes, lights whose sphere meets them, then every light
    // whose resolved state changed (moved with its token, toggled, hidden, edited…).
    for (const b of boxes) expandBounds(this.light.bounds, b)
    this.light.forgetSubCells(rebuiltCells)
    this.light.refreshBase(boxes, changedSamples)
    const envSig = environmentSignature(scene.environment)
    if (envSig !== this.envSig) {
      this.envSig = envSig
      this.light.setEnvironment(scene.environment)
    }
    const forced = new Set(this.light.lightsMeeting(boxes))
    for (const id of new Set([...this.lightIds, ...changedLights, ...this.light.lightIds()])) {
      this.light.setLight(id, this.resolveLight(id), forced.has(id))
    }

    // Viewer caches: line of sight through the dirty boxes and on changed samples is re-tested.
    if (boxes.length > 0 || changedSamples.length > 0 || rebuiltCells.length > 0) {
      for (const st of this.viewers.values()) {
        st.pending.boxes.push(...boxes)
        st.pending.samples.push(...changedSamples)
        st.pending.cells.push(...rebuiltCells)
      }
    }
  }

  /** Bounding box of the (new) positions of changed samples and their top probes. */
  private samplesBox(samples: readonly number[]): AABB3 {
    const L = this.layout
    const b: AABB3 = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
    for (const s of samples) {
      const x = L.sampleX(s)
      const z = L.sampleZ(s)
      const li = L.levelOf(Math.floor(s / SAMPLES_PER_CELL))
      const y0 = L.valid[s] ? L.y[s] : L.minY[li]
      const top = L.insideOf(s)?.top
      const y1 = top ? top.y : L.valid[s] ? L.y[s] : L.maxY[li]
      b.minX = Math.min(b.minX, x)
      b.maxX = Math.max(b.maxX, x)
      b.minZ = Math.min(b.minZ, z)
      b.maxZ = Math.max(b.maxZ, z)
      if (Number.isFinite(y0)) b.minY = Math.min(b.minY, y0)
      if (Number.isFinite(y1)) b.maxY = Math.max(b.maxY, y1)
    }
    if (b.minY > b.maxY) {
      b.minY = 0
      b.maxY = 0
    }
    return b
  }

  viewerFor(token: Token): Viewer {
    const ground = this.index.groundAtLevel(token.levelId, token.position.x, token.position.z)
    return {
      tokenId: token.id,
      levelId: token.levelId,
      eye: eyeAtGround(this.worldImpl, ground, token),
      vision: { darkvision: token.vision.darkvision, blindsight: token.vision.blindsight, blind: token.vision.blind },
    }
  }

  /** Global cell indices of a viewer's own footprint (the token's cells on its level). */
  private footprintCells(v: Viewer): Set<number> {
    const out = new Set<number>()
    const li = this.index.levelIdx.get(v.levelId)
    if (li === undefined) return out
    const L = this.layout
    const s = L.cellSize
    const token = own(this.scene.tokens, v.tokenId)
    const r = token && token.levelId === v.levelId ? tokenRect(this.scene, token) : { x: v.eye.x, z: v.eye.z, w: 0, d: 0 }
    const i0 = Math.max(0, Math.floor(r.x / s))
    const j0 = Math.max(0, Math.floor(r.z / s))
    // Cells overlapped with positive area (a degenerate rect selects the cell containing its corner).
    const i1 = Math.min(L.width - 1, r.w > 0 ? Math.ceil((r.x + r.w) / s) - 1 : i0)
    const j1 = Math.min(L.depth - 1, r.d > 0 ? Math.ceil((r.z + r.d) / s) - 1 : j0)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.add(li * L.cellsPerLevel + j * L.width + i)
    return out
  }

  private stateFor(v: Viewer, used: Set<Id>): ViewerState {
    const footprint = this.footprintCells(v)
    const eyeKey = `${v.levelId}|${v.eye.x}|${v.eye.y}|${v.eye.z}`
    const vis = v.vision
    const gradeKey = `${eyeKey}|${vis.darkvision}|${vis.blindsight}|${vis.blind}|${[...footprint].join(",")}`
    const L = this.layout
    let st = used.has(v.tokenId) ? undefined : this.viewers.get(v.tokenId)
    if (!st) {
      st = new ViewerState(v.tokenId, L.nSamples, L.nCells)
      // A second viewer with the same token id in one compute gets a throwaway state.
      if (!used.has(v.tokenId)) this.viewers.set(v.tokenId, st)
    }
    used.add(v.tokenId)
    st.configure(v, footprint, eyeKey, gradeKey)
    st.lastUsed = this.tick
    return st
  }

  compute(viewers: Viewer[]): VisibilityResult {
    this.tick++
    const used = new Set<Id>()
    const states: ViewerState[] = []
    for (const v of viewers) {
      const st = this.stateFor(v, used)
      this.evaluator.sync(st)
      states.push(st)
    }
    const result = this.assemble(states, viewers)
    this.evict()
    return result
  }

  private evict(): void {
    if (this.viewers.size <= MAX_VIEWER_CACHES) return
    const byAge = [...this.viewers.values()].filter((s) => s.lastUsed < this.tick).sort((a, b) => a.lastUsed - b.lastUsed)
    for (const st of byAge) {
      if (this.viewers.size <= MAX_VIEWER_CACHES) break
      this.viewers.delete(st.tokenId)
    }
  }

  private assemble(states: ViewerState[], viewers: Viewer[]): VisibilityResult {
    const L = this.layout
    const lf = this.light
    const perception: Record<Id, GradeMask> = {}
    const sunlit: Record<Id, CellMask> = {}
    /** 1 = some viewer perceives the sample. */
    const perceivedSample = new Uint8Array(L.nSamples)
    for (let li = 0; li < L.nLevels; li++) {
      const levelId = this.index.levels[li].id
      let gm: GradeMask | null = null
      let sm: CellMask | null = null
      const offset = li * L.cellsPerLevel
      for (let c = 0; c < L.cellsPerLevel; c++) {
        const g = offset + c
        let grade = 0
        let uniform = false
        let mask = 0
        for (const st of states) {
          const gv = st.cellGrades[g]
          if (gv === 0) continue
          if (gv > grade) grade = gv
          const m = st.cellMask.get(g)
          if (m === undefined) uniform = true
          else mask |= m
        }
        if (grade === 0) continue
        gm ??= createGradeMask(L.width, L.depth)
        gm.grades[c] = grade
        // A viewer perceiving the whole cell covers every sub-cell; otherwise the union of masks
        // (sub-cells in the mask are shown at the cell's best grade).
        if (!uniform && mask !== FULL_SUBMASK) gm.partial.set(c, mask)
        let sun = false
        for (let k = 0; k < SAMPLES_PER_CELL; k++) {
          const s = g * SAMPLES_PER_CELL + k
          for (const st of states) {
            if (st.grades[s] > 0) {
              perceivedSample[s] = 1
              break
            }
          }
          if (perceivedSample[s] && lf.sun[s]) sun = true
        }
        if (sun) {
          sm ??= createCellMask(L.width, L.depth)
          setCell(sm, c, true)
        }
      }
      if (gm) perception[levelId] = gm
      if (sm) sunlit[levelId] = sm
    }

    const illuminatingLightIds = new Set<Id>()
    for (const rec of lf.lights) {
      for (let k = 0; k < rec.samples.length; k++) {
        if (perceivedSample[rec.samples[k]]) {
          illuminatingLightIds.add(rec.id)
          break
        }
      }
    }

    const visibleTokenIds = this.visibleTokens(states, viewers)
    const observed = observedObjectIds(this.scene, perception, viewers, this.worldImpl, {
      footprint: (o: SceneObject) => this.footprints.get(this.scene, o, (id) => this.index.effectiveFloors(id), this.index.floorsEpoch),
      lightPosition: (l: LightObject) => {
        const rec = lf.lightRecord(l.id)
        if (rec) return rec.pos
        const ground = this.index.groundAtLevel(l.levelId, l.position.x, l.position.z)
        return resolveLightOrigin(this.worldImpl, { x: l.position.x, y: ground + l.position.y, z: l.position.z }, ground)
      },
    })
    return { perception, sunlit, visibleTokenIds, observedObjectIds: observed, illuminatingLightIds }
  }

  private visibleTokens(states: ViewerState[], viewers: Viewer[]): Set<Id> {
    const out = new Set<Id>()
    if (states.length === 0) return out
    const viewerIds = new Set(viewers.map((v) => v.tokenId))
    if (this.pointCache.size > 2 * Object.keys(this.scene.tokens).length + 16) this.pointCache.clear()
    for (const id of Object.keys(this.scene.tokens).sort()) {
      if (viewerIds.has(id)) continue
      const token = this.scene.tokens[id]
      if (!this.index.levelIdx.has(token.levelId)) continue
      const points = this.tokenPoints(token)
      let visible = false
      for (const p of points) {
        let lightCache = -1
        const lightAt = () => {
          if (lightCache < 0) lightCache = this.light.levelAtPoint(p.x, p.y, p.z, this.pointInside(p))
          return lightCache
        }
        for (const st of states) {
          if (this.evaluator.perceivesPoint(st, p, lightAt)) {
            visible = true
            break
          }
        }
        if (visible) break
      }
      if (visible) out.add(id)
    }
    return out
  }

  /** Token test points, cached per token until it or the occluders change (they are viewer-independent). */
  private tokenPoints(token: Token): Vec3[] {
    const key = `${this.worldImpl.version}|${token.levelId}|${token.position.x}|${token.position.z}|${token.size}|${token.height}`
    const hit = this.pointCache.get(token.id)
    if (hit && hit.key === key) return hit.points
    const ground = this.index.groundAtLevel(token.levelId, token.position.x, token.position.z)
    const points = tokenPointsAtGround(this.worldImpl, this.scene.grid.cellSize, ground, token)
    this.pointCache.set(token.id, { key, points })
    return points
  }

  /** Light blockers containing an arbitrary point (for the first-hit light rule). */
  private pointInside(p: Vec3): InsideInfo | null {
    const prims = this.worldImpl.containing(p, "light")
    if (prims.length === 0) return null
    return { sight: EMPTY_KEYS, light: new Set(prims.map((q) => q.key)), top: null }
  }

  /** Debug / test helper: the layout and light field at one sample. */
  inspectSample(levelId: Id, i: number, j: number, k = 0): SampleInspection | null {
    const li = this.index.levelIdx.get(levelId)
    const L = this.layout
    if (li === undefined || i < 0 || j < 0 || i >= L.width || j >= L.depth) return null
    const s = (li * L.cellsPerLevel + j * L.width + i) * SAMPLES_PER_CELL + k
    const ins = L.inside.get(s)
    return {
      valid: L.valid[s] === 1,
      position: { x: L.sampleX(s), y: L.y[s], z: L.sampleZ(s) },
      light: this.light.level(s),
      sunlit: this.light.sun[s] === 1,
      buried: ins !== undefined,
      topProbe: ins?.top ?? null,
    }
  }

  /** Debug / test helper: counts for diagnostics and benchmarks. */
  stats(): { levels: number; samples: number; lights: number; viewerCaches: number; worldVersion: number } {
    return {
      levels: this.layout.nLevels,
      samples: this.layout.nSamples,
      lights: [...this.light.lights].length,
      viewerCaches: this.viewers.size,
      worldVersion: this.worldImpl.version,
    }
  }
}
