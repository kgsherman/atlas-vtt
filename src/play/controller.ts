/**
 * Play-mode pointer controller (ARCHITECTURE §8), framework-free and shared by the player view and
 * the DM's live view. The page converts DOM pointer events into PlayPointerEvents (engine.pick on the
 * active level with objects + tokens) and pushes `overlays()` to the engine when notified.
 *
 *  - Move tool: press a token to select it; drag it to preview the move — players get an A* path over
 *    legal steps with a ruler in feet (diagonal rule) and a ghost at the drop cell; the DM gets a drop
 *    on the token's level with a straight ruler. Release commits (player: requestMove with the
 *    previewed path; DM: move-token). A click on a door (leaf or within reach of its segment) toggles it;
 *    hovering there highlights it (hoveredId), so doors in walls seen edge-on still show feedback.
 *  - Move commands (RTS style): with a token selected, holding the right button previews its move to
 *    the pointer and releasing commits it; a left click or Esc meanwhile cancels. The DM's right-click
 *    on a token still opens its menu (not a command).
 *  - Alt: moves off the grid — the DM's drops go exactly under the pointer; players' moves (only when
 *    the DM allows it, host.freeMovement) end exactly there, drawn along a string-pulled route.
 *  - No path (players): the line turns the error colour; released there, the move is STRANDED — its
 *    line and ghost stay and the page offers a jump there (jumpStranded) until it is dismissed.
 *  - Measure tool: press-drag measures from cell centre to cell centre; Shift-press adds a leg.
 *  - Template tool (areas of effect, ./templateTool): hover shows the area, press places its origin,
 *    drag aims or moves it, release places it (onTemplate) and returns to the Move tool.
 */
import {
  anchorPosition,
  checkEnd,
  checkJump,
  smoothPath,
  type MotionPoint,
} from "@/core/movement"
import type { PathStep } from "@/core/movement/types"
import type { Id, SceneLike, Vec2, Vec3 } from "@/core/scene/types"
import type { OverlayState, PickResult, RulerOverlay } from "@/render/contracts"

import { doorAt, type DoorHit } from "./doors"
import {
  anchorForPoint,
  formatFeet,
  pathRoute,
  pathRuler,
  routeRuler,
  straightRuler,
} from "./geometry"
import { MeasureTool } from "./measure"
import type { MovePlanner, PlannedMove } from "./planner"
import {
  TemplateTool,
  type TemplateDraft,
  type TemplatePointer,
  type TemplateSpec,
} from "./templateTool"

export type PlayRole = "player" | "dm"
export type PlayTool = "move" | "measure" | "template"

/** The Template tool's first spec (a 20 ft sphere). */
export const DEFAULT_TEMPLATE_SPEC: TemplateSpec = {
  shape: "sphere",
  size: 20,
  width: 5,
  height: 40,
  color: "#f97316",
  label: "",
  elevation: null,
  aura: false,
}

/** Pixels the pointer must travel before a press on a token becomes a drag. */
export const DRAG_THRESHOLD_PX = 5

/** A left press held this long without moving (move tool, not on a token you can drag) pings the spot. */
export const LONG_PRESS_MS = 450

export interface PlayPointerEvent {
  clientX: number
  clientY: number
  /** 0: left, 2: right. */
  button: number
  shift: boolean
  /** Alt held: off-grid moves. */
  alt?: boolean
  /** Engine pick on the active level (objects + tokens). */
  pick: PickResult
}

export type CommittedMove =
  /**
   * Player: a validated path to request from the host; `end`: its exact end point (gridless moves);
   * `route`: the line it was drawn along (the token walks it).
   */
  | {
      kind: "path"
      tokenId: Id
      path: PathStep[]
      distance: number
      end: Vec2 | null
      route: MotionPoint[]
    }
  /** DM: place the token (DmCommand move-token). */
  | { kind: "place"; tokenId: Id; levelId: Id; position: Vec2 }
  /** Player: put the token there without walking (no path could be found). */
  | { kind: "jump"; tokenId: Id; levelId: Id; position: Vec2 }

/** A player's move that found no path, kept on screen until the player jumps or dismisses it. */
export interface StrandedMove {
  tokenId: Id
  levelId: Id
  position: Vec2
  reason: "unreachable" | "no-ground"
  /** Something this client knows of stands there (core checkJump): no jump is offered. */
  blocked: boolean
  /** The token's position when it was stranded (a move of the token dismisses it). */
  from: Vec2
  ruler: RulerOverlay | null
}

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
  /** Players may move off the grid (Alt). The DM always may. */
  freeMovement(): boolean
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
  /**
   * A long press on the map: point at that spot for the table. `shift`: held with Shift (the DM's
   * "everyone look here"). Absent: long presses do nothing.
   */
  onPing?(levelId: Id, point: Vec3, shift: boolean): void
  /**
   * The Template tool placed an area (a new one, or `editing` moved) with the spec it was placed with.
   * Absent: the tool does nothing.
   */
  onTemplate?(draft: TemplateDraft, spec: TemplateSpec): void
  /** Timer for long presses (default setTimeout); returns a cancel function. */
  setTimer?(fn: () => void, ms: number): () => void
}

interface DragState {
  tokenId: Id
  /** 0: dragged from the token; 2: a right-button move command. */
  button: 0 | 2
  x: number
  y: number
  started: boolean
  plan: PlannedMove | null
  /** Players: the gridless end point of the planned move. */
  end: Vec2 | null
  /** Players: the line the planned move is drawn along. */
  route: MotionPoint[] | null
  /** DM: the drop. */
  place: { levelId: Id; position: Vec2 } | null
  ruler: RulerOverlay | null
  ghost: { levelId: Id; position: Vec2 } | null
  lastKey: string | null
  /** Last pointer event (the preview is recomputed when Alt changes). */
  last: PlayPointerEvent | null
}

export type PlayOverlays = Pick<
  OverlayState,
  "selectedIds" | "hoveredId" | "ruler" | "dragGhosts" | "preview"
>

const NO_GHOSTS: OverlayState["dragGhosts"] = {}

function defaultTimer(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

export class PlayController {
  private readonly host: PlayControllerHost
  private tool: PlayTool = "move"
  private selected: Id | null = null
  private hovered: Id | null = null
  private drag: DragState | null = null
  private readonly measure = new MeasureTool()
  private readonly template = new TemplateTool(DEFAULT_TEMPLATE_SPEC)
  private pressed = false
  private listeners = new Set<() => void>()
  private cache: { key: unknown[]; value: PlayOverlays } | null = null
  private lockHintAt = 0
  private alt = false
  private stranded: StrandedMove | null = null
  /** A left press cancelled a move command: its release does nothing else. */
  private swallowLeft = false
  /** A left press that may become a ping (cancelled by moving or releasing first). */
  private longPress: { cancel: () => void; x: number; y: number } | null = null
  /** The press being held already pinged: its release does nothing else. */
  private pinged = false

  constructor(host: PlayControllerHost) {
    this.host = host
  }

  // ---- state --------------------------------------------------------------------------------------

  /** Listen to state changes (a bound function: pass it to useSyncExternalStore as is). */
  readonly subscribe = (listener: () => void): (() => void) => {
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
    if (tool !== "template") {
      this.template.clear()
      this.template.setEditing(null)
    }
    this.tool = tool
    this.emit()
  }

  // ---- templates ----------------------------------------------------------------------------------

  getTemplateSpec(): TemplateSpec {
    return this.template.getSpec()
  }

  /** What the Template tool places next (the draft on screen follows). */
  setTemplateSpec(spec: TemplateSpec): void {
    this.template.setSpec(spec)
    this.emit()
  }

  /** The area being placed (hover or drag), for the page to draw; null when there is none. */
  templateDraft(): TemplateDraft | null {
    return this.tool === "template" ? this.template.getDraft() : null
  }

  /** The template being moved (Template tool), or null. */
  templateEditing(): Id | null {
    return this.tool === "template" ? this.template.getEditing() : null
  }

  /** Move an existing template: the Template tool with its spec; the next placement replaces it. */
  editTemplate(id: Id, spec: TemplateSpec, angle: number): void {
    this.setTool("template")
    this.template.setSpec(spec)
    this.template.setEditing(id, angle)
    this.emit()
  }

  private templatePointer(e: PlayPointerEvent): TemplatePointer {
    const g = e.pick.ground
    return {
      ground: g ? { x: g.x, z: g.z } : null,
      tokenId: e.pick.tokenId,
      shift: e.shift,
      alt: e.alt ?? false,
    }
  }

  private placeTemplate(draft: TemplateDraft | null): void {
    if (draft) this.host.onTemplate?.(draft, this.template.getSpec())
    this.setTool("move")
  }

  /** The page owns selection; the controller mirrors it for overlays. */
  setSelected(tokenId: Id | null): void {
    if (tokenId === this.selected) return
    this.selected = tokenId
    if (this.stranded && this.stranded.tokenId !== tokenId) this.stranded = null
    this.emit()
  }

  getSelected(): Id | null {
    return this.selected
  }

  getScene(): SceneLike | null {
    return this.host.scene()
  }

  /** A drag or move command is in progress (the page suppresses camera follow / shortcuts meanwhile). */
  get dragging(): boolean {
    return (this.drag?.started ?? false) || this.template.pressed
  }

  /** A right-button move command is being held. */
  get commanding(): boolean {
    return this.drag?.button === 2
  }

  /** The stranded move (no path found), if any. */
  getStranded(): StrandedMove | null {
    return this.stranded
  }

  /** Jump the stranded move's token to its target (CommittedMove "jump"). */
  jumpStranded(): void {
    const s = this.stranded
    if (!s || s.blocked) return
    this.stranded = null
    this.host.onMove({
      kind: "jump",
      tokenId: s.tokenId,
      levelId: s.levelId,
      position: s.position,
    })
    this.emit()
  }

  dismissStranded(): void {
    if (!this.stranded) return
    this.stranded = null
    this.emit()
  }

  /** Alt pressed or released (off-grid moves): refresh an in-progress preview. */
  setAlt(alt: boolean): void {
    if (alt === this.alt) return
    this.alt = alt
    const d = this.drag
    const scene = this.host.scene()
    if (!d?.started || !d.last || !scene) return
    d.lastKey = null
    if (this.updateDrag(scene, d, { ...d.last, alt })) this.emit()
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
    const s = d ? null : this.stranded
    const ruler = d?.ruler ?? s?.ruler ?? measureRuler
    const ghost = d
      ? d.ghost
      : s
        ? { levelId: s.levelId, position: s.position }
        : null
    const ghostOf = d?.tokenId ?? s?.tokenId ?? null
    const key = [this.selected, this.hovered, ruler, d?.ghost ?? s]
    if (this.cache && this.cache.key.every((v, k) => v === key[k]))
      return this.cache.value
    let dragGhosts = NO_GHOSTS
    if (ghost && ghostOf && scene && Object.hasOwn(scene.tokens, ghostOf))
      dragGhosts = { [ghostOf]: ghost }
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

  /** Returns whether the press was used (a right press that is not a move command is left to the page). */
  pointerDown(e: PlayPointerEvent): boolean {
    this.alt = e.alt ?? false
    if (e.button === 2) return this.commandDown(e)
    if (e.button !== 0) return false
    // A left press while a move command is held cancels it, and does nothing else.
    if (this.drag?.button === 2) {
      this.abandonDrag()
      this.swallowLeft = true
      return true
    }
    const scene = this.host.scene()
    const levelId = this.host.activeLevelId()
    if (!scene || !levelId) return false
    this.pressed = true
    if (this.stranded) {
      this.stranded = null
      this.emit()
    }
    if (this.tool === "measure") {
      if (!e.pick.ground) return true
      this.measure.press(scene.grid, levelId, e.pick.ground, e.shift)
      this.host.setCameraControls(false)
      this.emit()
      return true
    }
    if (this.tool === "template") {
      const placed = this.template.down(
        scene,
        levelId,
        this.templatePointer(e),
        (id) => this.host.canSelect(id),
        this.selected
      )
      if (placed) {
        this.pressed = false
        this.placeTemplate(placed)
        return true
      }
      if (this.template.pressed) this.host.setCameraControls(false)
      else if (this.template.getSpec().aura)
        this.host.onHint("Click one of your tokens to give it the aura")
      this.emit()
      return true
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
        this.drag = newDrag(tokenId, 0, e)
        this.host.setCameraControls(false)
      }
    }
    if (!this.drag) this.armLongPress(levelId, e)
    return true
  }

  /** Start timing a press that pings its spot if held still (see LONG_PRESS_MS). */
  private armLongPress(levelId: Id, e: PlayPointerEvent): void {
    this.cancelLongPress()
    this.pinged = false
    const onPing = this.host.onPing
    const ground = e.pick.ground
    if (!onPing || !ground) return
    const point = { x: ground.x, y: ground.y, z: ground.z }
    const shift = e.shift
    const timer = this.host.setTimer ?? defaultTimer
    const cancel = timer(() => {
      if (this.longPress?.cancel !== cancel) return
      this.longPress = null
      if (!this.pressed || this.drag) return
      this.pinged = true
      onPing(levelId, point, shift)
    }, LONG_PRESS_MS)
    this.longPress = { cancel, x: e.clientX, y: e.clientY }
  }

  private cancelLongPress(): void {
    const lp = this.longPress
    this.longPress = null
    lp?.cancel()
  }

  /** Right press: start a move command for the selected token. */
  private commandDown(e: PlayPointerEvent): boolean {
    const scene = this.host.scene()
    const tokenId = this.selected
    if (this.tool !== "move" || this.drag || this.pressed || !scene || !tokenId)
      return false
    if (!Object.hasOwn(scene.tokens, tokenId) || !this.host.canDrag(tokenId))
      return false
    // The DM's right-click on a token opens its menu.
    if (this.host.role === "dm" && e.pick.tokenId) return false
    if (this.host.role === "player" && this.host.movementLocked()) {
      this.hintLocked()
      return false
    }
    this.stranded = null
    const d = newDrag(tokenId, 2, e)
    d.started = true
    this.drag = d
    this.host.setCameraControls(false)
    this.updateDrag(scene, d, e)
    this.emit()
    return true
  }

  pointerMove(e: PlayPointerEvent): void {
    const scene = this.host.scene()
    if (!scene) return
    this.alt = e.alt ?? false
    const lp = this.longPress
    if (
      lp &&
      Math.hypot(e.clientX - lp.x, e.clientY - lp.y) >= DRAG_THRESHOLD_PX
    )
      this.cancelLongPress()
    if (this.tool === "measure") {
      if (
        this.pressed &&
        e.pick.ground &&
        this.measure.move(scene.grid, e.pick.ground)
      )
        this.emit()
      return
    }
    if (this.tool === "template") {
      const levelId = this.host.activeLevelId()
      const p = this.templatePointer(e)
      const changed = this.template.pressed
        ? this.template.drag(scene, p)
        : levelId !== null && this.template.hover(scene, levelId, p)
      if (changed) this.emit()
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
    if (this.swallowLeft) return
    if (this.pressed) return
    // Hover feedback: selectable tokens first, else the door a click here would toggle (the same
    // doorAt rule as pointerUp: its leaf, or ground within reach of its segment — a door in a wall
    // seen edge-on from above is a thin line, so an exact leaf pick is rare).
    const hovered: Id | null =
      e.pick.tokenId && this.host.canSelect(e.pick.tokenId)
        ? e.pick.tokenId
        : (doorAt(
            scene,
            this.host.activeLevelId(),
            e.pick.objectId,
            e.pick.ground ? { x: e.pick.ground.x, z: e.pick.ground.z } : null
          )?.door.id ?? null)
    if (hovered !== this.hovered) {
      this.hovered = hovered
      this.emit()
    }
  }

  /** Returns whether the release was used (a right release ending a move command). */
  pointerUp(e: PlayPointerEvent): boolean {
    this.alt = e.alt ?? false
    if (e.button === 2) {
      const d = this.drag
      if (d?.button !== 2) return false
      this.drag = null
      this.host.setCameraControls(true)
      const scene = this.host.scene()
      // The preview follows the pointer: the release point is where it was last shown.
      if (scene) this.commit(scene, d)
      this.emit()
      return true
    }
    if (e.button !== 0) return false
    if (this.swallowLeft) {
      this.swallowLeft = false
      return true
    }
    if (this.drag?.button === 2) return true
    this.cancelLongPress()
    if (this.pinged) {
      this.pinged = false
      this.pressed = false
      return true
    }
    const wasPressed = this.pressed
    this.pressed = false
    const scene = this.host.scene()
    if (this.tool === "measure") {
      this.measure.release()
      this.host.setCameraControls(true)
      this.emit()
      return true
    }
    if (this.tool === "template") {
      this.host.setCameraControls(true)
      if (this.template.pressed) this.placeTemplate(this.template.up())
      return true
    }
    const d = this.drag
    this.drag = null
    this.host.setCameraControls(true)
    if (d?.started) {
      if (scene) this.commit(scene, d)
      this.emit()
      return true
    }
    if (!wasPressed || !scene) return false
    if (d) return true // a click on a draggable token: selected on press
    if (e.pick.tokenId && this.host.canSelect(e.pick.tokenId)) return true
    const levelId = this.host.activeLevelId()
    const ground = e.pick.ground
      ? { x: e.pick.ground.x, z: e.pick.ground.z }
      : null
    const hit = doorAt(scene, levelId, e.pick.objectId, ground)
    if (hit) {
      this.host.onDoor(hit)
      return true
    }
    if (this.host.role === "dm" && this.selected) {
      this.selected = null
      this.host.onSelect(null)
      this.emit()
    }
    return true
  }

  /** Escape / lost pointer: abandon the gesture (and clear the ruler and a stranded move). */
  cancel(): void {
    // Escape (or a lost pointer) during a press drops that press; otherwise it leaves the Template tool.
    if (this.tool === "template" && this.template.pressed) {
      this.template.clear()
      this.pressed = false
      this.host.setCameraControls(true)
      this.emit()
      return
    }
    if (this.tool === "template") {
      this.template.clear()
      this.template.setEditing(null)
      this.tool = "move"
      this.pressed = false
      this.host.setCameraControls(true)
      this.emit()
      return
    }
    const had =
      this.drag !== null ||
      this.pressed ||
      !this.measure.empty ||
      this.stranded !== null
    this.drag = null
    this.pressed = false
    this.stranded = null
    this.cancelLongPress()
    this.pinged = false
    this.measure.clear()
    this.host.setCameraControls(true)
    if (had) this.emit()
  }

  /** Drop the drag / move command without committing it. */
  private abandonDrag(): void {
    this.drag = null
    this.host.setCameraControls(true)
    this.emit()
  }

  /**
   * The scene changed (a patch arrived): refresh an in-progress drag preview; a stranded move whose
   * token moved (or left) is dismissed.
   */
  sceneChanged(): void {
    this.cache = null
    const d = this.drag
    if (d?.started) {
      d.lastKey = null
      d.plan = null
      const scene = this.host.scene()
      if (scene && d.last) this.updateDrag(scene, d, d.last)
    }
    const s = this.stranded
    if (s) {
      const scene = this.host.scene()
      const t =
        scene && Object.hasOwn(scene.tokens, s.tokenId)
          ? scene.tokens[s.tokenId]
          : null
      if (!t || t.position.x !== s.from.x || t.position.z !== s.from.z)
        this.stranded = null
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
    d.last = e
    if (!Object.hasOwn(scene.tokens, d.tokenId)) return false
    const token = scene.tokens[d.tokenId]
    const free =
      this.alt && (this.host.role === "dm" || this.host.freeMovement())
    if (this.host.role === "dm") {
      const ground = this.host.groundAt(e.clientX, e.clientY, token.levelId)
      if (!ground) return false
      const anchor = anchorForPoint(scene.grid, token.size, ground)
      const key = free
        ? `${ground.x.toFixed(2)},${ground.z.toFixed(2)}`
        : `${anchor.i},${anchor.j}`
      if (key === d.lastKey) return false
      d.lastKey = key
      const position = free
        ? { x: ground.x, z: ground.z }
        : anchorPosition(scene, token.size, anchor)
      d.place = { levelId: token.levelId, position }
      d.ghost = d.place
      d.ruler = straightRuler(scene, token.levelId, token.position, position)
      return true
    }
    const planner = this.host.planner
    const levelId = this.host.activeLevelId() ?? token.levelId
    const ground = e.pick.ground
    if (!planner || !ground) return false
    const anchor = anchorForPoint(scene.grid, token.size, ground)
    const point = free ? { x: ground.x, z: ground.z } : null
    const key = `${anchor.i},${anchor.j}|${levelId}|${point ? `${point.x.toFixed(2)},${point.z.toFixed(2)}` : ""}`
    if (key === d.lastKey && d.plan) return false
    d.lastKey = key
    const plan = planner.plan(d.tokenId, anchor, levelId)
    const world = planner.occlusion()
    d.plan = plan
    d.end = null
    d.route = null
    d.ghost = null
    d.ruler = null
    if (!plan || !world) return true
    if (plan.path) {
      const last = plan.path[plan.path.length - 1]
      const centre = anchorPosition(scene, token.size, last.cell)
      if (point && !checkEnd(scene, world, token, last, centre, point))
        d.end = point
      d.route = d.end
        ? smoothPath(scene, world, token, plan.path, d.end)
        : pathRoute(scene, token.size, plan.path)
      const limit = this.host.speedLimit(d.tokenId)
      const suffix =
        limit !== null && plan.distance > limit + 1e-6
          ? `over ${formatFeet(limit)} speed`
          : undefined
      d.ruler = d.end
        ? routeRuler(scene, d.route, plan.distance, suffix)
        : pathRuler(scene, token.size, plan.path, suffix)
      d.ghost = { levelId: plan.target.levelId, position: d.end ?? centre }
    } else if (plan.reason === "same-cell") {
      // Gridless: a step within the token's own cell.
      const start = planner.startStep(token)
      const moved =
        point &&
        Math.hypot(point.x - token.position.x, point.z - token.position.z) >
          0.05
      if (
        moved &&
        !checkEnd(scene, world, token, start, token.position, point)
      ) {
        d.end = point
        d.route = [
          { levelId: token.levelId, position: { ...token.position } },
          { levelId: token.levelId, position: point },
        ]
        d.ruler = routeRuler(scene, d.route, 0)
        d.ghost = { levelId: token.levelId, position: point }
      }
    } else {
      const target = point ?? anchorPosition(scene, token.size, anchor)
      d.ghost = { levelId: plan.target.levelId, position: target }
      d.ruler = straightRuler(
        scene,
        token.levelId,
        token.position,
        target,
        plan.reason === "no-ground" ? "no floor there" : "no path",
        "blocked"
      )
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
    const token = Object.hasOwn(scene.tokens, d.tokenId)
      ? scene.tokens[d.tokenId]
      : null
    if (!plan || !token) return
    if (plan.reason === "same-cell") {
      const planner = this.host.planner
      if (d.end && d.route && planner)
        this.host.onMove({
          kind: "path",
          tokenId: d.tokenId,
          path: [planner.startStep(token)],
          distance: 0,
          end: d.end,
          route: d.route,
        })
      return
    }
    if (!plan.path) {
      if (
        (plan.reason === "unreachable" || plan.reason === "no-ground") &&
        d.ghost
      ) {
        const world = this.host.planner?.occlusion()
        this.stranded = {
          tokenId: d.tokenId,
          levelId: d.ghost.levelId,
          position: d.ghost.position,
          reason: plan.reason,
          blocked:
            !!world &&
            checkJump(
              scene,
              world,
              token,
              d.ghost.levelId,
              d.ghost.position
            ) === "blocked",
          from: { ...token.position },
          ruler: d.ruler,
        }
      }
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
      end: d.end,
      route: d.route ?? pathRoute(scene, token.size, plan.path),
    })
  }
}

function newDrag(tokenId: Id, button: 0 | 2, e: PlayPointerEvent): DragState {
  return {
    tokenId,
    button,
    x: e.clientX,
    y: e.clientY,
    started: false,
    plan: null,
    end: null,
    route: null,
    place: null,
    ruler: null,
    ghost: null,
    lastKey: null,
    last: null,
  }
}
