/**
 * Play-mode pointer controller (ARCHITECTURE §8), framework-free and shared by the player view and
 * the DM's live view. The page converts DOM pointer events into PlayPointerEvents (engine.pick on the
 * active level with objects + tokens) and pushes `overlays()` to the engine when notified.
 *
 *  - Move tool: press a token to select it; drag it to preview the move — players get an A* path over
 *    legal steps with a ruler in feet (diagonal rule) and a ghost at the drop cell; the DM gets a free
 *    drop on the token's level with a straight ruler. Release commits (player: requestMove with the
 *    previewed path; DM: move-token). A click on a door (leaf or within reach of its segment) toggles it.
 *  - Measure tool: press-drag measures from cell centre to cell centre; Shift-press adds a leg.
 */
import { anchorPosition } from "@/core/movement"
import type { PathStep } from "@/core/movement/types"
import type { Id, SceneLike, Vec2 } from "@/core/scene/types"
import type { OverlayState, PickResult, RulerOverlay } from "@/render/contracts"

import { doorAt, type DoorHit } from "./doors"
import {
  anchorForPoint,
  formatFeet,
  pathRuler,
  straightRuler,
} from "./geometry"
import { MeasureTool } from "./measure"
import type { MovePlanner, PlannedMove } from "./planner"

export type PlayRole = "player" | "dm"
export type PlayTool = "move" | "measure"

/** Pixels the pointer must travel before a press on a token becomes a drag. */
export const DRAG_THRESHOLD_PX = 5

export interface PlayPointerEvent {
  clientX: number
  clientY: number
  button: number
  shift: boolean
  /** Engine pick on the active level (objects + tokens). */
  pick: PickResult
}

export type CommittedMove =
  /** Player: a validated path to request from the host. */
  | { kind: "path"; tokenId: Id; path: PathStep[]; distance: number }
  /** DM: place the token (DmCommand move-token). */
  | { kind: "place"; tokenId: Id; levelId: Id; position: Vec2 }

export interface PlayControllerHost {
  role: PlayRole
  scene(): SceneLike | null
  activeLevelId(): Id | null
  /** Tokens the user may select. */
  canSelect(tokenId: Id): boolean
  /** Tokens the user may drag. */
  canDrag(tokenId: Id): boolean
  /** Players: movement locked by the DM (drags are refused with a hint). */
  movementLocked(): boolean
  /** Speed limit for a token's move when enforced (feet), else null. */
  speedLimit(tokenId: Id): number | null
  /** Ground point under the pointer on a given level (DM drags keep the token's level). */
  groundAt(clientX: number, clientY: number, levelId: Id): Vec2 | null
  /** Path planning (players). */
  planner: MovePlanner | null
  onSelect(tokenId: Id | null): void
  onMove(move: CommittedMove): void
  onDoor(hit: DoorHit): void
  /** Explain why nothing happened (toast). */
  onHint(message: string): void
  setCameraControls(enabled: boolean): void
}

interface DragState {
  tokenId: Id
  x: number
  y: number
  started: boolean
  plan: PlannedMove | null
  place: { levelId: Id; position: Vec2 } | null
  ruler: RulerOverlay | null
  lastCellKey: string | null
}

export type PlayOverlays = Pick<
  OverlayState,
  "selectedIds" | "hoveredId" | "ruler" | "dragGhosts" | "preview"
>

const NO_GHOSTS: OverlayState["dragGhosts"] = {}

export class PlayController {
  private readonly host: PlayControllerHost
  private tool: PlayTool = "move"
  private selected: Id | null = null
  private hovered: Id | null = null
  private drag: DragState | null = null
  private readonly measure = new MeasureTool()
  private pressed = false
  private listeners = new Set<() => void>()
  private cache: { key: unknown[]; value: PlayOverlays } | null = null
  private lockHintAt = 0

  constructor(host: PlayControllerHost) {
    this.host = host
  }

  // ---- state --------------------------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    this.cache = null
    for (const l of [...this.listeners]) l()
  }

  getTool(): PlayTool {
    return this.tool
  }

  setTool(tool: PlayTool): void {
    if (tool === this.tool) return
    this.cancel()
    if (tool !== "measure") this.measure.clear()
    this.tool = tool
    this.emit()
  }

  /** The page owns selection; the controller mirrors it for overlays. */
  setSelected(tokenId: Id | null): void {
    if (tokenId === this.selected) return
    this.selected = tokenId
    this.emit()
  }

  getSelected(): Id | null {
    return this.selected
  }

  /** A drag is in progress (the page suppresses camera follow / shortcuts meanwhile). */
  get dragging(): boolean {
    return this.drag?.started ?? false
  }

  /** Current drag preview (for HUD readouts). */
  dragPreview(): {
    tokenId: Id
    plan: PlannedMove | null
    ruler: RulerOverlay | null
  } | null {
    const d = this.drag
    return d && d.started
      ? { tokenId: d.tokenId, plan: d.plan, ruler: d.ruler }
      : null
  }

  measuredFeet(): number | null {
    const scene = this.host.scene()
    if (!scene || this.measure.empty) return null
    return this.measure.distance(scene.grid)
  }

  overlays(): PlayOverlays {
    const scene = this.host.scene()
    const d = this.drag?.started ? this.drag : null
    const measureRuler =
      this.tool === "measure" ? this.measure.ruler(scene) : null
    const ruler = d?.ruler ?? measureRuler
    const ghostKey = d ? (d.plan?.path ? d.plan.target : d.place) : null
    const key = [this.selected, this.hovered, ruler, ghostKey]
    if (this.cache && this.cache.key.every((v, k) => v === key[k]))
      return this.cache.value
    let dragGhosts = NO_GHOSTS
    if (d && scene && Object.hasOwn(scene.tokens, d.tokenId)) {
      const t = scene.tokens[d.tokenId]
      if (d.place)
        dragGhosts = {
          [d.tokenId]: { levelId: d.place.levelId, position: d.place.position },
        }
      else if (d.plan?.path)
        dragGhosts = {
          [d.tokenId]: {
            levelId: d.plan.target.levelId,
            position: anchorPosition(scene, t.size, d.plan.target.cell),
          },
        }
    }
    const value: PlayOverlays = {
      selectedIds: this.selected ? [this.selected] : [],
      hoveredId: this.hovered,
      ruler,
      dragGhosts,
      preview: null,
    }
    this.cache = { key, value }
    return value
  }

  // ---- pointer ------------------------------------------------------------------------------------

  pointerDown(e: PlayPointerEvent): void {
    if (e.button !== 0) return
    const scene = this.host.scene()
    const levelId = this.host.activeLevelId()
    if (!scene || !levelId) return
    this.pressed = true
    if (this.tool === "measure") {
      if (!e.pick.ground) return
      this.measure.press(scene.grid, levelId, e.pick.ground, e.shift)
      this.host.setCameraControls(false)
      this.emit()
      return
    }
    const tokenId = e.pick.tokenId
    if (
      tokenId &&
      Object.hasOwn(scene.tokens, tokenId) &&
      this.host.canSelect(tokenId)
    ) {
      if (tokenId !== this.selected) {
        this.selected = tokenId
        this.host.onSelect(tokenId)
        this.emit()
      }
      if (this.host.canDrag(tokenId)) {
        this.drag = {
          tokenId,
          x: e.clientX,
          y: e.clientY,
          started: false,
          plan: null,
          place: null,
          ruler: null,
          lastCellKey: null,
        }
        this.host.setCameraControls(false)
      }
    }
  }

  pointerMove(e: PlayPointerEvent): void {
    const scene = this.host.scene()
    if (!scene) return
    if (this.tool === "measure") {
      if (
        this.pressed &&
        e.pick.ground &&
        this.measure.move(scene.grid, e.pick.ground)
      )
        this.emit()
      return
    }
    const d = this.drag
    if (d) {
      if (!d.started) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD_PX)
          return
        if (this.host.role === "player" && this.host.movementLocked()) {
          this.hintLocked()
          this.drag = null
          this.host.setCameraControls(true)
          return
        }
        d.started = true
      }
      if (this.updateDrag(scene, d, e)) this.emit()
      return
    }
    if (this.pressed) return
    // Hover feedback: selectable tokens, and doors for players.
    let hovered: Id | null = null
    if (e.pick.tokenId && this.host.canSelect(e.pick.tokenId))
      hovered = e.pick.tokenId
    else if (
      e.pick.objectId &&
      Object.hasOwn(scene.objects, e.pick.objectId) &&
      scene.objects[e.pick.objectId].type === "door"
    )
      hovered = e.pick.objectId
    if (hovered !== this.hovered) {
      this.hovered = hovered
      this.emit()
    }
  }

  pointerUp(e: PlayPointerEvent): void {
    if (e.button !== 0) return
    const wasPressed = this.pressed
    this.pressed = false
    const scene = this.host.scene()
    if (this.tool === "measure") {
      this.measure.release()
      this.host.setCameraControls(true)
      this.emit()
      return
    }
    const d = this.drag
    this.drag = null
    this.host.setCameraControls(true)
    if (d?.started) {
      if (scene) this.commit(scene, d)
      this.emit()
      return
    }
    if (!wasPressed || !scene) return
    if (d) return // a click on a draggable token: selected on press
    if (e.pick.tokenId && this.host.canSelect(e.pick.tokenId)) return
    const levelId = this.host.activeLevelId()
    const ground = e.pick.ground
      ? { x: e.pick.ground.x, z: e.pick.ground.z }
      : null
    const hit = doorAt(scene, levelId, e.pick.objectId, ground)
    if (hit) {
      this.host.onDoor(hit)
      return
    }
    if (this.host.role === "dm" && this.selected) {
      this.selected = null
      this.host.onSelect(null)
      this.emit()
    }
  }

  /** Escape / lost pointer: abandon the gesture (and clear the ruler). */
  cancel(): void {
    const had = this.drag !== null || this.pressed || !this.measure.empty
    this.drag = null
    this.pressed = false
    this.measure.clear()
    this.host.setCameraControls(true)
    if (had) this.emit()
  }

  /** The scene changed (a patch arrived): refresh an in-progress drag preview. */
  sceneChanged(): void {
    this.cache = null
    const d = this.drag
    if (d?.started) {
      d.lastCellKey = null
      d.plan = null
    }
    this.emit()
  }

  // ---- internals ----------------------------------------------------------------------------------

  private hintLocked(): void {
    const now = Date.now()
    if (now - this.lockHintAt < 1500) return
    this.lockHintAt = now
    this.host.onHint("Movement is locked by the DM")
  }

  private updateDrag(
    scene: SceneLike,
    d: DragState,
    e: PlayPointerEvent
  ): boolean {
    if (!Object.hasOwn(scene.tokens, d.tokenId)) return false
    const token = scene.tokens[d.tokenId]
    if (this.host.role === "dm") {
      const ground = this.host.groundAt(e.clientX, e.clientY, token.levelId)
      if (!ground) return false
      const anchor = anchorForPoint(scene.grid, token.size, ground)
      const key = `${anchor.i},${anchor.j}`
      if (key === d.lastCellKey) return false
      d.lastCellKey = key
      const position = anchorPosition(scene, token.size, anchor)
      d.place = { levelId: token.levelId, position }
      d.ruler = straightRuler(scene, token.levelId, token.position, position)
      return true
    }
    const planner = this.host.planner
    const levelId = this.host.activeLevelId() ?? token.levelId
    const ground = e.pick.ground
    if (!planner || !ground) return false
    const anchor = anchorForPoint(scene.grid, token.size, ground)
    const key = `${anchor.i},${anchor.j}|${levelId}`
    if (key === d.lastCellKey && d.plan) return false
    d.lastCellKey = key
    const plan = planner.plan(d.tokenId, anchor, levelId)
    d.plan = plan
    if (plan?.path) {
      const limit = this.host.speedLimit(d.tokenId)
      const suffix =
        limit !== null && plan.distance > limit + 1e-6
          ? `over ${formatFeet(limit)} speed`
          : undefined
      d.ruler = pathRuler(scene, token.size, plan.path, suffix)
    } else if (plan && plan.reason !== "same-cell") {
      const target = anchorPosition(scene, token.size, anchor)
      d.ruler = straightRuler(
        scene,
        token.levelId,
        token.position,
        target,
        plan.reason === "no-ground" ? "no floor there" : "no path"
      )
    } else {
      d.ruler = null
    }
    return true
  }

  private commit(scene: SceneLike, d: DragState): void {
    if (this.host.role === "dm") {
      if (!d.place) return
      const t = scene.tokens[d.tokenId]
      if (
        t &&
        t.levelId === d.place.levelId &&
        t.position.x === d.place.position.x &&
        t.position.z === d.place.position.z
      )
        return
      this.host.onMove({
        kind: "place",
        tokenId: d.tokenId,
        levelId: d.place.levelId,
        position: d.place.position,
      })
      return
    }
    const plan = d.plan
    if (!plan) return
    if (!plan.path) {
      if (plan.reason === "no-ground")
        this.host.onHint("There's no floor there")
      else if (plan.reason === "unreachable")
        this.host.onHint("No path to that spot")
      return
    }
    const limit = this.host.speedLimit(d.tokenId)
    if (limit !== null && plan.distance > limit + 1e-6) {
      this.host.onHint(
        `That's farther than the token can move (${formatFeet(limit)})`
      )
      return
    }
    this.host.onMove({
      kind: "path",
      tokenId: d.tokenId,
      path: plan.path,
      distance: plan.distance,
    })
  }
}
