/**
 * DOM plumbing for the play views: canvas pointer events → PlayController (engine.pick on the active
 * level, rAF-throttled moves), the play keymap and camera zoom via synthetic wheel events.
 */
import * as React from "react"

import type { Id } from "@/core/scene/types"
import { useKeyOverrides } from "@/components/keybindings/keymapStore"
import { useAppHotkeys } from "@/lib/hotkeys"
import { playBindings, type PlayController, type PlayKeyAction } from "@/play"
import type { Engine } from "@/render/contracts"

/** Zoom the engine camera about the canvas centre (the camera zooms on wheel events). */
export function zoomCanvas(
  canvas: HTMLCanvasElement | null,
  direction: 1 | -1
): void {
  if (!canvas) return
  const r = canvas.getBoundingClientRect()
  canvas.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: direction > 0 ? -240 : 240,
      deltaMode: 0,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      bubbles: true,
      cancelable: true,
    })
  )
}

/**
 * Play keymap with the user's remaps. The handler returns false when the key did nothing. Host-only
 * commands (level switching, vision preview) are bound only when `host`.
 */
export function usePlayKeys(
  handler: (action: PlayKeyAction, e: KeyboardEvent) => boolean | void,
  { enabled = true, host = false }: { enabled?: boolean; host?: boolean } = {}
): void {
  const overrides = useKeyOverrides("play")
  const bindings = React.useMemo(
    () => playBindings(overrides).filter((b) => host || !b.hostOnly),
    [overrides, host]
  )
  useAppHotkeys(
    bindings.map((b) => ({
      hotkey: b.hotkey,
      repeat: b.repeat ?? false,
      run: (e) => handler(b.action, e),
    })),
    { enabled }
  )
}

export interface CanvasInputOptions {
  engine: Engine | null
  canvas: HTMLCanvasElement | null
  controller: PlayController
  activeLevelId(): Id | null
  enabled: boolean
}

/** Canvas pointer events → PlayController, with picks against the active level (moves throttled to rAF). */
export function usePlayCanvasInput({
  engine,
  canvas,
  controller,
  activeLevelId,
  enabled,
}: CanvasInputOptions): void {
  const levelRef = React.useRef(activeLevelId)
  React.useEffect(() => {
    levelRef.current = activeLevelId
  })

  React.useEffect(() => {
    if (!engine || !canvas || !enabled) return
    let raf = 0
    let pending: PointerEvent | null = null

    const build = (e: PointerEvent) => {
      const levelId = levelRef.current()
      const pick = levelId
        ? engine.pick(e.clientX, e.clientY, {
            levelId,
            objects: true,
            tokens: true,
          })
        : { ground: null, objectId: null, tokenId: null, hitPoint: null }
      return {
        clientX: e.clientX,
        clientY: e.clientY,
        button: e.button,
        shift: e.shiftKey,
        pick,
      }
    }

    const flush = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      const e = pending
      pending = null
      if (e) controller.pointerMove(build(e))
    }

    const cursor = () => {
      const o = controller.overlays()
      const css = controller.dragging
        ? "grabbing"
        : controller.getTool() === "measure"
          ? "crosshair"
          : o.hoveredId
            ? "pointer"
            : "default"
      if (canvas.style.cursor !== css) canvas.style.cursor = css
    }

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      flush()
      canvas.focus({ preventScroll: true })
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // synthetic events have no capturable pointer
      }
      controller.pointerDown(build(e))
      cursor()
    }
    const onMove = (e: PointerEvent) => {
      pending = e
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0
          const ev = pending
          pending = null
          if (ev) controller.pointerMove(build(ev))
          cursor()
        })
      }
    }
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0) return
      flush()
      controller.pointerUp(build(e))
      try {
        if (canvas.hasPointerCapture(e.pointerId))
          canvas.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      cursor()
    }
    const onCancel = () => {
      if (controller.dragging) controller.cancel()
    }
    canvas.addEventListener("pointerdown", onDown)
    canvas.addEventListener("pointermove", onMove)
    canvas.addEventListener("pointerup", onUp)
    canvas.addEventListener("pointercancel", onCancel)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      canvas.removeEventListener("pointerdown", onDown)
      canvas.removeEventListener("pointermove", onMove)
      canvas.removeEventListener("pointerup", onUp)
      canvas.removeEventListener("pointercancel", onCancel)
      canvas.style.cursor = "default"
    }
  }, [engine, canvas, controller, enabled])
}
