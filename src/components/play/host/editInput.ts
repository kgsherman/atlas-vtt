/**
 * Edit on the map screen: canvas pointer events → the editor controller, on the host's own
 * engine (no second WebGL context). Mirrors the editor viewport's input handling (components/editor
 * EditorViewport): picks on the editor's active level, marching its terrain, + snapping (Alt = free),
 * canvas-relative positions and pressed buttons, floors as background for the select tool,
 * right-click-without-drag as a tool click, tool extras applied in one undo step, the active tool's
 * CSS cursor (Tool.cursor), and the cursor readout (cell and point under the cursor) for the status bar.
 */
import * as React from "react"

import type { EditorContextValue } from "@/components/editor/context"
import {
  cursorReadout,
  editorCursor,
  stripBackgroundFloor,
  toToolPointerEvent,
  type DomPointerLike,
} from "@/components/editor/lib/pointer"
import {
  applyExtras,
  extrasApply,
  newItemIds,
} from "@/components/editor/lib/toolExtras"
import { toolMeta } from "@/components/editor/toolMeta"
import {
  sameCursor,
  type CursorStore,
} from "@/components/editor/lib/viewportInfo"
import type { Vec3 } from "@/core/scene/types"
import type { Engine } from "@/render/contracts"

const RIGHT_CLICK_SLOP = 5

export function useHostEditInput(
  engine: Engine | null,
  canvas: HTMLCanvasElement | null,
  ctx: EditorContextValue | null,
  readout: CursorStore | null
): void {
  React.useEffect(() => {
    if (!engine || !canvas || !ctx) return
    const { store, controller, extras } = ctx
    let leftDown = false
    let rightDown: { x: number; y: number } | null = null
    let pendingMove: PointerEvent | null = null
    let raf = 0
    let floorPress: { id: string; x: number; y: number } | null = null

    const build = (e: DomPointerLike, button?: number) => {
      const s = store.getState()
      const pick = engine.pick(e.clientX, e.clientY, {
        levelId: s.activeLevelId,
        objects: true,
        tokens: true,
        terrain: true,
      })
      return toToolPointerEvent(
        e,
        pick,
        { grid: s.scene.grid, snapMode: s.snapMode, altHeld: s.altHeld },
        { button, origin: canvas.getBoundingClientRect() }
      )
    }
    const background = <E extends ReturnType<typeof build>>(ev: E) => {
      const s = store.getState()
      return s.tool === "select"
        ? stripBackgroundFloor(s.scene, s.selection, ev)
        : { event: ev, floorId: null }
    }
    const setCursor = (css: string) => {
      if (canvas.style.cursor !== css) canvas.style.cursor = css
    }
    const updateCursor = () => setCursor(editorCursor(controller, leftDown))
    const updateReadout = (ground: Vec3 | null) => {
      if (!readout) return
      const s = store.getState()
      const level = Object.hasOwn(s.scene.levels, s.activeLevelId)
        ? s.scene.levels[s.activeLevelId]
        : null
      const next = cursorReadout(s.scene.grid, ground, level?.elevation ?? 0)
      if (!sameCursor(next, readout.getState().cursor))
        readout.setState({ cursor: next })
    }
    const processMove = (e: PointerEvent) => {
      const ev = background(build(e)).event
      controller.pointerMove(ev)
      updateReadout(ev.pick.ground)
      updateCursor()
    }
    const flushMove = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      const e = pendingMove
      pendingMove = null
      if (e) processMove(e)
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 2) {
        rightDown = { x: e.clientX, y: e.clientY }
        return
      }
      if (e.button !== 0) return
      canvas.focus({ preventScroll: true })
      flushMove()
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // synthetic events
      }
      leftDown = true
      const stripped = background(build(e))
      const ev = stripped.event
      floorPress =
        stripped.floorId && store.getState().selection.length === 0
          ? { id: stripped.floorId, x: e.clientX, y: e.clientY }
          : null
      const s = store.getState()
      const x = extras.getState()
      if (extrasApply(s.tool, x) && !s.readOnly) {
        const before = s.scene
        s.beginTransaction(`Add ${toolMeta(s.tool).label.toLowerCase()}`)
        try {
          controller.pointerDown(ev)
          const now = store.getState()
          const created = newItemIds(before, now.scene)
          if (created.objects.length + created.tokens.length > 0)
            now.apply((d) => applyExtras(d, created, x), "Tool options")
        } finally {
          store.getState().commitTransaction()
        }
      } else {
        controller.pointerDown(ev)
      }
      if (controller.activeTool().capturesPointer)
        engine.setCameraControlsEnabled(false)
      updateReadout(ev.pick.ground)
      updateCursor()
    }
    const onPointerMove = (e: PointerEvent) => {
      pendingMove = e
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0
          const ev = pendingMove
          pendingMove = null
          if (ev) processMove(ev)
        })
      }
    }
    const onPointerUp = (e: PointerEvent) => {
      flushMove()
      if (e.button === 2) {
        const start = rightDown
        rightDown = null
        if (
          start &&
          Math.hypot(e.clientX - start.x, e.clientY - start.y) <=
            RIGHT_CLICK_SLOP
        )
          controller.pointerDown(build(e, 2))
        return
      }
      if (e.button !== 0 || !leftDown) return
      leftDown = false
      controller.pointerUp(background(build(e)).event)
      const press = floorPress
      floorPress = null
      if (
        press &&
        Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4 &&
        Object.hasOwn(store.getState().scene.objects, press.id)
      )
        store.getState().select([press.id])
      try {
        if (canvas.hasPointerCapture(e.pointerId))
          canvas.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      engine.setCameraControlsEnabled(true)
      updateCursor()
    }
    const onPointerCancel = () => {
      if (!leftDown) return
      leftDown = false
      floorPress = null
      controller.cancelGesture()
      engine.setCameraControlsEnabled(true)
    }
    const onPointerLeave = (e: PointerEvent) => {
      if (leftDown) return
      pendingMove = null
      updateReadout(null)
      const s = store.getState()
      controller.pointerMove(
        toToolPointerEvent(
          e,
          { ground: null, objectId: null, tokenId: null, hitPoint: null },
          { grid: s.scene.grid, snapMode: s.snapMode, altHeld: false },
          { origin: canvas.getBoundingClientRect() }
        )
      )
    }
    const onContextMenu = (e: Event) => e.preventDefault()

    canvas.addEventListener("pointerdown", onPointerDown)
    canvas.addEventListener("pointermove", onPointerMove)
    canvas.addEventListener("pointerup", onPointerUp)
    canvas.addEventListener("pointercancel", onPointerCancel)
    canvas.addEventListener("lostpointercapture", onPointerCancel)
    canvas.addEventListener("pointerleave", onPointerLeave)
    canvas.addEventListener("contextmenu", onContextMenu)
    // Tool switches, sub-tool switches and the tool's own state (terrain phases, hovers) move the cursor.
    updateCursor()
    const unsubCursor = controller.subscribe(updateCursor)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      unsubCursor()
      canvas.removeEventListener("pointerdown", onPointerDown)
      canvas.removeEventListener("pointermove", onPointerMove)
      canvas.removeEventListener("pointerup", onPointerUp)
      canvas.removeEventListener("pointercancel", onPointerCancel)
      canvas.removeEventListener("lostpointercapture", onPointerCancel)
      canvas.removeEventListener("pointerleave", onPointerLeave)
      canvas.removeEventListener("contextmenu", onContextMenu)
      controller.cancelGesture()
      engine.setCameraControlsEnabled(true)
      canvas.style.cursor = "default"
      readout?.setState({ cursor: null })
    }
  }, [engine, canvas, ctx, readout])
}
