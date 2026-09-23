/**
 * Overlay orchestration: grid, selection / hover outlines, tool previews, ruler, pending move paths
 * and editor helpers (light radius rings, connector arrows, hidden-object outlines). Token-specific
 * overlays (selection rings, drag ghosts, markers) live in the engine's token layer.
 *
 * Every part is rebuilt lazily in update() when its inputs changed; per-frame work is limited to
 * label scaling, the grid fade and the terrain overlay's gizmo (screen-space arrows that follow
 * core/geometry/gizmo gizmoHandles) and label.
 */
import * as THREE from "three"

import type { Projector } from "@/core/geometry/gizmo"
import type { PathStep } from "@/core/movement/types"
import { connectorForward, connectorGround, lightLevelId, lightWorldPosition } from "@/core/scene/queries"
import type { Id, SceneLike, Vec3 } from "@/core/scene/types"

import type { GroundSampler } from "../builders/ground"
import type { OverlayState, RulerOverlay, ToolPreview, ViewState } from "../contracts"
import type { LevelPlanEntry } from "../engine/levelPlan"
import { LAYER } from "../internal"
import { GridOverlay } from "./grid"
import { buildOutlines, disposeOutlines, type ObjectMeshRef, type OutlineMesh } from "./highlight"
import { TextLabel } from "./label"
import { buildToolPreview, disposePreview } from "./previews"
import { TerrainOverlayResources } from "./terrainOverlay"
import { aaLineGeometry, createAALineMaterial, polylinePairs } from "../materials/aaLineMaterial"
import { createEdgeAAMaterial, edgeGeometry } from "../materials/edgeAAMaterial"
import { circlePoints, dashPolyline, discEdgeGeometry, mergeEdgeGeometry, pathStepPoints, ribbonEdgeGeometry, ringEdgeGeometry } from "./ribbon"

const SELECT_COLOR = "#34d399"
const HOVER_COLOR = "#a7f3d0"
const HIDDEN_COLOR = "#a78bfa"
const RULER_COLOR = "#fbbf24"
const PENDING_COLOR = "#38bdf8"
const ARROW_COLOR = "#38bdf8"

export interface OverlayHost {
  scene(): SceneLike | null
  view(): ViewState
  plan(): ReadonlyMap<Id, LevelPlanEntry>
  /** Ground of a level, including an active terrain-brush preview. */
  ground(levelId: Id): GroundSampler
  /** Meshes that draw an object (for outlines). */
  objectRefs(id: Id): ObjectMeshRef[]
  /** Active level used for the grid (null: no levels). */
  activeLevelId(): Id | null
  worldPerPixel(): number
  /** World units per CSS pixel at a world point (perspective: depends on distance). */
  worldPerPixelAt(p: THREE.Vector3): number
  /** Centre and radius for the grid fade. */
  fade(): { x: number; z: number; radius: number }
  /**
   * World point → canvas-relative CSS px (Engine.project), for the terrain overlay's gizmo, which must
   * match the tool's screen-space hit test. Absent: no gizmo is drawn.
   */
  project?(p: Vec3): { x: number; y: number; visible: boolean }
}

type Outline = { line: OutlineMesh; attachTo: THREE.Object3D | null }

/** Opacity of a light's bright / dim radius rings (editor helpers): faint unless selected, fainter when off. */
export function lightRingOpacity(on: boolean, selected: boolean): [number, number] {
  const k = on ? 1 : 0.45
  return selected ? [0.9 * k, 0.55 * k] : [0.35 * k, 0.16 * k]
}


function overlayFill(color: string, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
}

/** Dispose all non-shared geometries and the given materials below a root, then detach it. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry && !m.geometry.userData.shared && !m.geometry.userData.cached) m.geometry.dispose()
  })
  root.removeFromParent()
}

export class OverlayManager {
  /** Overlays drawn after the world (renderOrder 1000 group). */
  readonly root = new THREE.Group()
  /** Grid, drawn before translucent ghosts (renderOrder 0 group). */
  readonly gridRoot = new THREE.Group()
  readonly grid = new GridOverlay()
  private readonly host: OverlayHost
  private state: OverlayState = { selectedIds: [], hoveredId: null, preview: null, ruler: null, pendingMoves: {}, dragGhosts: {} }

  // Outlines and rings are anti-aliased screen-space lines, ribbons, dots and end rings fade their own
  // edges (the canvas has no MSAA; materials/aaLineMaterial, materials/edgeAAMaterial).
  private readonly selectMat = createAALineMaterial(SELECT_COLOR, { opacity: 0.95, width: 2 })
  private readonly hoverMat = createAALineMaterial(HOVER_COLOR, { opacity: 0.6, width: 1.5 })
  private readonly hiddenMat = createAALineMaterial(HIDDEN_COLOR, { opacity: 0.7, width: 1.5 })
  private readonly rulerMat = createEdgeAAMaterial(RULER_COLOR, { opacity: 0.95 })
  private readonly rulerDotMat = createEdgeAAMaterial("#fafafa", { opacity: 0.95 })
  private readonly pendingMat = createEdgeAAMaterial(PENDING_COLOR, { opacity: 0.85 })
  private readonly arrowMat = overlayFill(ARROW_COLOR, 0.55)
  // Anti-aliased rim over the arrow's (aliased) fill edge.
  private readonly arrowLineMat = createAALineMaterial(ARROW_COLOR, { opacity: 0.75, width: 1 })

  private outlines: Outline[] = []
  private outlinesDirty = true
  private helpers: THREE.Object3D | null = null
  private helperOutlines: Outline[] = []
  private helpersDirty = true
  private preview: THREE.Object3D | null = null
  private previewSource: ToolPreview | null = null
  private ruler: THREE.Object3D | null = null
  private rulerLabel: TextLabel | null = null
  private rulerSource: RulerOverlay | null = null
  private rulerDirty = false
  private pending: THREE.Object3D | null = null
  private pendingDirty = false
  /** The terrain overlay's caches, gizmo and label (created with the first terrain preview). */
  private terrain: TerrainOverlayResources | null = null
  private readonly project: Projector = (p) => this.host.project?.(p) ?? null
  private readonly worldPerPixelAt = (p: THREE.Vector3) => this.host.worldPerPixelAt(p)
  private gridVersion = 0
  /** Something was (re)built: move it to the OVERLAY layer before the next draw. */
  private layersDirty = true

  constructor(host: OverlayHost) {
    this.host = host
    this.root.name = "overlays"
    this.root.renderOrder = 1000
    this.gridRoot.name = "grid"
    this.gridRoot.renderOrder = 0
    this.gridRoot.add(this.grid.mesh)
  }

  get current(): OverlayState {
    return this.state
  }

  set(partial: Partial<OverlayState>): void {
    const prev = this.state
    this.state = { ...prev, ...partial }
    if (partial.selectedIds !== undefined || partial.hoveredId !== undefined) this.outlinesDirty = true
    // Light radius rings are emphasised for selected lights.
    if (partial.selectedIds !== undefined && partial.selectedIds !== prev.selectedIds) this.helpersDirty = true
    if (partial.preview !== undefined && partial.preview !== prev.preview) this.updatePreview(partial.preview)
    if (partial.ruler !== undefined && partial.ruler !== prev.ruler) this.rulerDirty = true
    if (partial.pendingMoves !== undefined && partial.pendingMoves !== prev.pendingMoves) this.pendingDirty = true
  }

  /** Level meshes were rebuilt or the scene changed. */
  sceneChanged(): void {
    this.outlinesDirty = true
    this.helpersDirty = true
    this.pendingDirty = true
    this.rulerDirty = this.state.ruler !== null
  }

  /** View (mode, helpers, level plan, active level) changed. */
  viewChanged(): void {
    this.helpersDirty = true
    this.outlinesDirty = true
  }

  /**
   * Terrain geometry changed (edit or brush preview): the draped grid must follow. With `dirty` (the
   * engine moved the terrain mesh in place over it: a commit, a cleared preview; null = everywhere) the
   * grid's heights are refreshed in place over it when it is a lattice of the ground's spacing, else the
   * grid is rebuilt.
   */
  terrainChanged(levelId: Id, dirty?: { x: number; z: number; w: number; d: number } | null): void {
    if (levelId === this.host.activeLevelId() && (dirty === undefined || !this.grid.refreshHeights(this.host.ground(levelId), dirty))) this.gridVersion++
    // Previews draped on the terrain are rebuilt against the new heights.
    if (this.previewSource) this.updatePreview(this.previewSource, true)
  }

  /**
   * Brush preview moved terrain vertices inside `dirty`: move the draped grid in place when it is
   * already a lattice for this level, else rebuild it once.
   */
  terrainPreviewed(levelId: Id, dirty: { x: number; z: number; w: number; d: number } | null): void {
    if (levelId !== this.host.activeLevelId()) return
    if (!this.grid.refreshHeights(this.host.ground(levelId), dirty)) this.gridVersion++
  }

  /** Per frame, before rendering. */
  update(): void {
    const scene = this.host.scene()
    const view = this.host.view()
    // Grid on the active level.
    const active = this.host.activeLevelId()
    this.gridRoot.visible = view.showGrid && scene !== null && active !== null
    if (this.gridRoot.visible && scene && active) {
      this.grid.setLevel(scene.grid, this.host.ground(active), active, this.gridVersion)
      const f = this.host.fade()
      this.grid.setFade(f.x, f.z, f.radius)
    }
    if (this.outlinesDirty || this.helpersDirty || this.rulerDirty || this.pendingDirty) this.layersDirty = true
    if (this.outlinesDirty) this.rebuildOutlines()
    if (this.helpersDirty) this.rebuildHelpers()
    if (this.rulerDirty) this.rebuildRuler()
    if (this.pendingDirty) this.rebuildPending()
    if (this.layersDirty) this.markLayers()
    // Keep the ruler label at a constant pixel size.
    if (this.rulerLabel?.sprite.visible) this.rulerLabel.updateScale(this.host.worldPerPixelAt(this.rulerLabel.sprite.position))
    // Terrain overlay: gizmo arrows along the current projected axes, constant-size label.
    this.terrain?.frame(this.host.project ? this.project : null, this.worldPerPixelAt)
  }

  /**
   * Overlays live on the OVERLAY layer: the engine draws them after post-processing (exact colours,
   * no bloom / tone mapping), depth-tested against the composited scene. Outlines attached to world
   * meshes are marked individually.
   */
  private markLayers(): void {
    this.layersDirty = false
    this.root.traverse((o) => o.layers.set(LAYER.OVERLAY))
    for (const o of [...this.outlines, ...this.helperOutlines]) o.line.traverse((c) => c.layers.set(LAYER.OVERLAY))
  }

  // -------------------------------------------------------------------------

  private rebuildOutlines(): void {
    this.outlinesDirty = false
    disposeOutlines(this.outlines)
    this.outlines = []
    const scene = this.host.scene()
    if (!scene) return
    const add = (id: Id, mat: THREE.Material) => {
      if (!Object.hasOwn(scene.objects, id)) return
      for (const o of buildOutlines(this.host.objectRefs(id), mat)) {
        ;(o.attachTo ?? this.root).add(o.line)
        this.outlines.push(o)
      }
    }
    const selected = new Set(this.state.selectedIds)
    for (const id of selected) add(id, this.selectMat)
    const h = this.state.hoveredId
    if (h !== null && !selected.has(h)) add(h, this.hoverMat)
  }

  private updatePreview(p: ToolPreview | null, force = false): void {
    const prev = this.previewSource
    this.previewSource = p
    // Moving a paste ghost only changes its offset: reposition instead of rebuilding.
    if (!force && p && prev && this.preview && p.kind === "ghost-objects" && prev.kind === "ghost-objects" && p.scene === prev.scene) {
      const inner = this.preview.children[0]
      if (inner) inner.position.set(p.offset.x, 0, p.offset.z)
      return
    }
    if (this.preview) disposePreview(this.preview)
    this.preview = null
    const scene = this.host.scene()
    // Leaving the terrain overlay frees its cached geometry and hides its gizmo and label.
    if (p?.kind !== "terrain" || !scene) this.terrain?.release()
    if (!p || !scene) return
    this.preview = buildToolPreview(p, {
      ground: (id) => this.host.ground(id),
      scene,
      worldPerPixel: this.host.worldPerPixel(),
      terrain: p.kind === "terrain" ? this.terrainResources() : undefined,
    })
    this.root.add(this.preview)
    this.layersDirty = true
  }

  private terrainResources(): TerrainOverlayResources {
    if (!this.terrain) {
      this.terrain = new TerrainOverlayResources()
      this.root.add(this.terrain.decor)
    }
    return this.terrain
  }

  private rebuildRuler(): void {
    this.rulerDirty = false
    if (this.ruler) disposeTree(this.ruler)
    this.ruler = null
    const r = this.state.ruler
    this.rulerSource = r
    if (!r || r.points.length === 0) {
      if (this.rulerLabel) this.rulerLabel.sprite.visible = false
      return
    }
    const root = new THREE.Object3D()
    const wpp = this.host.worldPerPixel()
    // + half a pixel per side: the edge fade is centred on the nominal edge.
    const width = Math.max(0.2, wpp * 3) + wpp
    const lifted = r.points.map((p) => ({ x: p.x, y: p.y + 0.12, z: p.z }))
    if (lifted.length >= 2) root.add(new THREE.Mesh(edgeGeometry(ribbonEdgeGeometry(lifted, width)), this.rulerMat))
    const dotRadius = Math.max(0.25, wpp * 4) + wpp / 2
    const dots = mergeEdgeGeometry(lifted.map((p) => discEdgeGeometry(p.x, p.y + 0.01, p.z, dotRadius, 20)))
    if (dots.positions.length > 0) root.add(new THREE.Mesh(edgeGeometry(dots), this.rulerDotMat))
    // The label sprite lives directly under the overlay root (sprites share one geometry that must
    // never be disposed with the ruler tree).
    if (!this.rulerLabel) {
      this.rulerLabel = new TextLabel()
      this.rulerLabel.sprite.frustumCulled = false
      this.rulerLabel.sprite.raycast = () => {}
      this.root.add(this.rulerLabel.sprite)
    }
    const last = lifted[lifted.length - 1]
    this.rulerLabel.setText(r.label)
    this.rulerLabel.sprite.position.set(last.x, last.y + 0.2, last.z)
    this.rulerLabel.sprite.visible = r.label.length > 0
    root.traverse((o) => {
      o.renderOrder = 14
      o.frustumCulled = false
      o.raycast = () => {}
    })
    this.ruler = root
    this.root.add(root)
  }

  private rebuildPending(): void {
    this.pendingDirty = false
    if (this.pending) disposeTree(this.pending)
    this.pending = null
    const scene = this.host.scene()
    const moves = this.state.pendingMoves
    if (!scene || Object.keys(moves).length === 0) return
    const root = new THREE.Object3D()
    const wpp = this.host.worldPerPixel()
    // + half a pixel per side: the edge fade is centred on the nominal edge.
    const width = Math.max(0.25, wpp * 3) + wpp
    for (const [tokenId, steps] of Object.entries(moves) as [Id, PathStep[]][]) {
      if (steps.length < 2) continue
      const token = Object.hasOwn(scene.tokens, tokenId) ? scene.tokens[tokenId] : null
      const pts = pathStepPoints(scene, steps, token?.size ?? "medium").map((p) => ({ x: p.x, y: p.y + 0.15, z: p.z }))
      const dashes = dashPolyline(pts, 1.6, 1.0)
      const end = pts[pts.length - 1]
      const merged = mergeEdgeGeometry([...dashes.map((d) => ribbonEdgeGeometry(d, width)), ringEdgeGeometry(end.x, end.y, end.z, 1.1 - wpp / 2, 1.5 + wpp / 2, 48)])
      root.add(new THREE.Mesh(edgeGeometry(merged), this.pendingMat))
    }
    root.traverse((o) => {
      o.renderOrder = 13
      o.frustumCulled = false
      o.raycast = () => {}
    })
    this.pending = root
    this.root.add(root)
  }

  private rebuildHelpers(): void {
    this.helpersDirty = false
    if (this.helpers) {
      this.helpers.traverse((o) => {
        const l = o as THREE.Line
        if (l.material && l.userData.ownMaterial) (l.material as THREE.Material).dispose()
      })
      disposeTree(this.helpers)
    }
    this.helpers = null
    disposeOutlines(this.helperOutlines)
    this.helperOutlines = []
    const scene = this.host.scene()
    const view = this.host.view()
    if (!scene || !view.showHelpers || view.mode === "player") return
    const plan = this.host.plan()
    const drawn = (levelId: Id) => plan.get(levelId)?.mode === "solid"
    const active = this.host.activeLevelId()
    const selected = new Set(this.state.selectedIds)
    const root = new THREE.Object3D()
    for (const o of Object.values(scene.objects)) {
      if (o.type === "light") {
        const levelId = lightLevelId(scene, o)
        if (!drawn(levelId)) continue
        // Rings draw through geometry, so only the active level's lights (and selected ones) get them:
        // with every level shown, other storeys' rings would float over roofs and floors.
        const isSelected = selected.has(o.id)
        if (!isSelected && levelId !== active) continue
        const p = lightWorldPosition(scene, o)
        const ground = this.host.ground(levelId)
        const y = (x: number, z: number) => ground.heightAt(x, z) + 0.1
        const color = new THREE.Color(o.color)
        const [bright, dim] = lightRingOpacity(o.on, isSelected)
        for (const [radius, opacity] of [
          [o.brightRadius, bright],
          [o.dimRadius, dim],
        ] as const) {
          if (!(radius > 0)) continue
          const g = aaLineGeometry(polylinePairs(circlePoints(p.x, p.z, radius, 72, y)))
          const line = new THREE.Mesh(g, createAALineMaterial(color, { opacity, width: 1.5 }))
          line.userData.ownMaterial = true
          root.add(line)
        }
      } else if (o.type === "connector" && drawn(o.levelId)) {
        root.add(this.connectorArrow(scene, o))
      }
      if (o.hidden && o.type !== "light" && drawn(o.levelId)) {
        for (const ol of buildOutlines(this.host.objectRefs(o.id), this.hiddenMat)) {
          ;(ol.attachTo ?? root).add(ol.line)
          this.helperOutlines.push(ol)
        }
      }
    }
    root.traverse((o) => {
      if (o.renderOrder === 0) o.renderOrder = 11
      o.frustumCulled = false
      o.raycast = () => {}
    })
    this.helpers = root
    this.root.add(root)
  }

  /** Flat arrow over a connector pointing up the run (ladders: at the ladder's cell). */
  private connectorArrow(scene: SceneLike, c: Extract<SceneLike["objects"][string], { type: "connector" }>): THREE.Object3D {
    const r = c.rect
    const f = connectorForward(c.direction)
    const centre = { x: r.x + r.w / 2, z: r.z + r.d / 2 }
    const run = Math.abs(f.x) > 0 ? r.w : r.d
    const across = Math.abs(f.x) > 0 ? r.d : r.w
    const len = Math.max(1.5, run * 0.7)
    const half = Math.min(across * 0.3, 2)
    const y =
      c.style === "ladder" || !Object.hasOwn(scene.levels, c.toLevelId)
        ? this.host.ground(c.levelId).heightAt(centre.x, centre.z)
        : connectorGround(scene, c, centre)
    const shape = new THREE.Shape()
    // Local frame: +x along f, +y across (the shape is laid flat below).
    shape.moveTo(-len / 2, -half * 0.35)
    shape.lineTo(len / 2 - half, -half * 0.35)
    shape.lineTo(len / 2 - half, -half)
    shape.lineTo(len / 2, 0)
    shape.lineTo(len / 2 - half, half)
    shape.lineTo(len / 2 - half, half * 0.35)
    shape.lineTo(-len / 2, half * 0.35)
    shape.closePath()
    const g = new THREE.ShapeGeometry(shape)
    // Shape XY → ground XZ: x along f, y along f's left normal.
    const m = new THREE.Matrix4().set(f.x, -f.z, 0, 0, 0, 0, 1, 0, f.z, f.x, 0, 0, 0, 0, 0, 1)
    g.applyMatrix4(m)
    const mesh = new THREE.Mesh(g, this.arrowMat)
    mesh.position.set(centre.x, y + 0.3, centre.z)
    const rim = shape.getPoints().map((q) => new THREE.Vector3(q.x, q.y, 0).applyMatrix4(m))
    mesh.add(new THREE.Mesh(aaLineGeometry(polylinePairs(rim, true)), this.arrowLineMat))
    return mesh
  }

  /** World position of the ruler's label (last point), for HTML labels. */
  rulerAnchor(): Vec3 | null {
    const r = this.rulerSource
    if (!r || r.points.length === 0) return null
    const p = r.points[r.points.length - 1]
    return { x: p.x, y: p.y, z: p.z }
  }

  dispose(): void {
    disposeOutlines(this.outlines)
    disposeOutlines(this.helperOutlines)
    if (this.helpers) disposeTree(this.helpers)
    if (this.preview) disposePreview(this.preview)
    if (this.ruler) disposeTree(this.ruler)
    if (this.pending) disposeTree(this.pending)
    this.terrain?.dispose()
    this.terrain = null
    if (this.rulerLabel) {
      this.rulerLabel.sprite.removeFromParent()
      this.rulerLabel.dispose()
    }
    this.grid.dispose()
    for (const m of [this.selectMat, this.hoverMat, this.hiddenMat, this.rulerMat, this.rulerDotMat, this.pendingMat, this.arrowMat, this.arrowLineMat]) m.dispose()
  }
}
