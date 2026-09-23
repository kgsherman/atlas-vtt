/**
 * Select tool: click selects, Shift/Ctrl-click toggles, drag on empty ground marquee-selects on the
 * active level, drag on a selected item moves the selection (snapped, ONE transaction per drag),
 * R / Shift+R rotates the selection, Escape cancels a drag or clears the selection.
 */
import { objectBounds } from "@/core/scene/integrity"
import { tokenRect } from "@/core/scene/queries"
import type { Id, Rect, Scene, Vec2 } from "@/core/scene/types"
import type { ToolPreview } from "@/render/contracts"

import { itemLevelId } from "../store"
import { alignDelta, applyMove, planMove, snapDragDelta, type MovePlan } from "../transform"
import { createPreviewCache, isKeyAction, MARQUEE_COLOR, pointerSnapMode, rectFromCorners, rotateTurns, type ToolDeps } from "./shared"
import type { Tool, ToolPointerEvent } from "./types"

/** Pointer travel (CSS px) before a press on an item turns into a drag. */
const DRAG_THRESHOLD_PX = 4
/** Marquees smaller than this (feet) are treated as a click on empty ground. */
const MARQUEE_MIN = 0.25

type Gesture =
  | { kind: "pending"; start: Vec2; clientX: number; clientY: number; hitId: Id; wasSelected: boolean }
  | {
      kind: "drag"
      start: Vec2
      grabbedId: Id
      /** Scene when the drag started (anchors snap against the ORIGINAL positions). */
      base: Scene
      /** Items moved by document edits. */
      plan: MovePlan
      /** Tokens moved as play actions on release (live sessions), with their start positions. */
      playTokens: { id: Id; levelId: Id; position: Vec2 }[]
      delta: Vec2
      txnId: number
    }
  | { kind: "marquee"; start: Vec2; end: Vec2; additive: boolean }

export interface SelectTool extends Tool {
  /** Object/token under the cursor (hover outline), when no gesture is active. */
  hoveredId(): Id | null
  /** Tokens being dragged as play actions (live sessions): drawn as translucent ghosts. */
  dragGhosts(): Record<Id, { levelId: Id; position: Vec2 }>
}

const inside = (r: Rect, outer: Rect) => r.x >= outer.x - 1e-9 && r.z >= outer.z - 1e-9 && r.x + r.w <= outer.x + outer.w + 1e-9 && r.z + r.d <= outer.z + outer.d + 1e-9

/** Selectable items on a level whose footprint lies entirely inside `rect` (editor-locked objects excluded). */
export function itemsInRect(scene: Scene, levelId: Id, rect: Rect): Id[] {
  const out: Id[] = []
  for (const o of Object.values(scene.objects)) {
    if (o.editorLocked || itemLevelId(scene, o.id) !== levelId) continue
    const b = objectBounds(scene, o)
    if (b && inside(b, rect)) out.push(o.id)
  }
  for (const t of Object.values(scene.tokens)) {
    if (t.levelId === levelId && inside(tokenRect(scene, t), rect)) out.push(t.id)
  }
  return out.sort()
}

/** The selectable item under the pointer: token first, then object; editor-locked objects are skipped. */
export function pickedItem(scene: Scene, e: Pick<ToolPointerEvent, "pick">): Id | null {
  const { tokenId, objectId } = e.pick
  if (tokenId && Object.hasOwn(scene.tokens, tokenId)) return tokenId
  if (objectId && Object.hasOwn(scene.objects, objectId) && !scene.objects[objectId].editorLocked) return objectId
  return null
}

export function createSelectTool(deps: ToolDeps): SelectTool {
  const { store } = deps
  let gesture: Gesture | null = null
  let hovered: Id | null = null
  let ghosts: Record<Id, { levelId: Id; position: Vec2 }> = {}

  const changed = () => {
    preview.bump()
    deps.invalidate?.()
  }

  const preview = createPreviewCache(store, (): ToolPreview | null => {
    if (gesture?.kind !== "marquee") return null
    return { kind: "rect", levelId: store.getState().activeLevelId, rect: rectFromCorners(gesture.start, gesture.end), color: MARQUEE_COLOR }
  })

  const setGhosts = (next: Record<Id, { levelId: Id; position: Vec2 }>) => {
    ghosts = next
    changed()
  }

  const startDrag = (g: Extract<Gesture, { kind: "pending" }>) => {
    const s = store.getState()
    const full = planMove(s.scene, s.selection)
    let plan = full
    let playTokens: { id: Id; levelId: Id; position: Vec2 }[] = []
    if (s.playActions && full.tokens.length > 0) {
      playTokens = full.tokens.map((t) => ({ id: t.id, levelId: t.levelId, position: { ...t.position } }))
      plan = { ...full, tokens: [] }
    }
    const txnId = s.beginTransaction(`Move ${s.selection.length === 1 ? "item" : `${s.selection.length} items`}`)
    gesture = { kind: "drag", start: g.start, grabbedId: g.hitId, base: s.scene, plan, playTokens, delta: { x: 0, z: 0 }, txnId }
  }

  const endDrag = (commit: boolean) => {
    if (gesture?.kind !== "drag") return
    const g = gesture
    gesture = null
    const s = store.getState()
    if (s.history.transaction?.id === g.txnId) {
      if (commit) s.commitTransaction()
      else s.cancelTransaction()
    }
    if (commit && g.playTokens.length > 0 && (g.delta.x !== 0 || g.delta.z !== 0)) {
      s.moveTokens(g.playTokens.map((t) => ({ id: t.id, position: { x: t.position.x + g.delta.x, z: t.position.z + g.delta.z } })))
    }
    setGhosts({})
  }

  const tool: SelectTool = {
    id: "select",

    get capturesPointer() {
      return gesture !== null
    },

    onPointerDown(e) {
      if (e.button !== 0) return
      const s = store.getState()
      const hit = pickedItem(s.scene, e)
      if (hit) {
        if (e.shift || e.ctrl) {
          s.toggleSelected(hit)
          gesture = null
          changed()
          return
        }
        const wasSelected = s.selection.includes(hit)
        if (!wasSelected) s.select([hit])
        gesture = e.ground ? { kind: "pending", start: { ...e.ground }, clientX: e.clientX, clientY: e.clientY, hitId: hit, wasSelected } : null
      } else if (e.ground) {
        gesture = { kind: "marquee", start: { ...e.ground }, end: { ...e.ground }, additive: e.shift || e.ctrl }
      }
      changed()
    },

    onPointerMove(e) {
      const s = store.getState()
      if (!gesture) {
        const h = pickedItem(s.scene, e)
        if (h !== hovered) {
          hovered = h
          changed()
        }
        return
      }
      if (!e.ground) return
      if (gesture.kind === "marquee") {
        gesture.end = { ...e.ground }
        changed()
        return
      }
      if (gesture.kind === "pending") {
        const px = Math.hypot(e.clientX - gesture.clientX, e.clientY - gesture.clientY)
        if (px < DRAG_THRESHOLD_PX) return
        startDrag(gesture)
      }
      const g = gesture as Extract<Gesture, { kind: "drag" }>
      // Re-read: startDrag() just opened the transaction.
      const now = store.getState()
      if (now.history.transaction?.id !== g.txnId) {
        // The transaction was cancelled underneath us (undo during the drag): abandon the gesture.
        gesture = null
        setGhosts({})
        return
      }
      const raw = { x: e.ground.x - g.start.x, z: e.ground.z - g.start.z }
      const snapped = snapDragDelta(g.base, g.grabbedId, raw, pointerSnapMode(store, e))
      const d = alignDelta(g.plan, g.base.grid.cellSize, snapped.x, snapped.z)
      if (d.x === g.delta.x && d.z === g.delta.z) return
      g.delta = d
      if (g.plan.objects.length + g.plan.tokens.length > 0) {
        now.apply((draft) => applyMove(draft, g.plan, d.x, d.z), "Move")
      }
      if (g.playTokens.length > 0) {
        const next: Record<Id, { levelId: Id; position: Vec2 }> = {}
        for (const t of g.playTokens) next[t.id] = { levelId: t.levelId, position: { x: t.position.x + d.x, z: t.position.z + d.z } }
        setGhosts(next)
      }
    },

    onPointerUp(e) {
      if (!gesture) return
      const s = store.getState()
      switch (gesture.kind) {
        case "pending":
          // A click (no drag) on an item of a multi-selection selects just that item.
          if (gesture.wasSelected && !e.shift && !e.ctrl) s.select([gesture.hitId])
          gesture = null
          break
        case "drag":
          endDrag(true)
          break
        case "marquee": {
          const end = e.ground ?? gesture.end
          const rect = rectFromCorners(gesture.start, end)
          const additive = gesture.additive
          gesture = null
          if (rect.w < MARQUEE_MIN && rect.d < MARQUEE_MIN) {
            if (!additive) s.clearSelection()
          } else {
            s.select(itemsInRect(s.scene, s.activeLevelId, rect), additive ? "add" : "replace")
          }
          break
        }
      }
      changed()
    },

    onKeyDown(e) {
      if (isKeyAction(e, "escape")) {
        if (gesture) {
          tool.cancel?.()
          return true
        }
        if (store.getState().selection.length > 0) {
          store.getState().clearSelection()
          return true
        }
        return false
      }
      const turns = rotateTurns(e)
      if (turns !== 0 && !gesture) {
        if (store.getState().selection.length === 0) return false
        store.getState().rotateSelection(turns)
        return true
      }
      return false
    },

    cancel() {
      if (gesture?.kind === "drag") endDrag(false)
      gesture = null
      changed()
    },

    preview: () => preview.get(),

    hoveredId: () => (gesture ? null : hovered),

    dragGhosts: () => ghosts,
  }
  return tool
}
