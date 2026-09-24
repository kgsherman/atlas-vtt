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

/** PointerEvent.buttons bit of a PointerEvent.button (left, middle, right). */
const BUTTON_BITS = [1, 4, 2]
/** After a right-button move command ends, the context menu that follows the release is swallowed. */
const MENU_SUPPRESS_MS = 400

/**
 * Canvas pointer events → PlayController, with picks against the active level (moves throttled to
 * rAF). Left and right buttons are tracked through `buttons`, so a press of one while the other is
 * held (a chorded press, which the browser reports as a pointermove) still reaches the controller: a
 * left click cancels a right-button move command. Alt (off-grid moves) is followed from pointer events
 * and key presses.
 */
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
    /** Left / right buttons last seen held (PointerEvent.buttons bits 1 and 2). */
    let held = 0
    /** Right-button move command in progress, and until when its context menu is swallowed. */
    let commanding = false
    let suppressMenuUntil = 0

    const build = (e: PointerEvent, button = e.button) => {
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
        button,
        shift: e.shiftKey,
        alt: e.altKey,
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
      const css = controller.commanding
        ? "crosshair"
        : controller.dragging
          ? "grabbing"
          : controller.getTool() === "measure"
            ? "crosshair"
            : o.hoveredId
              ? "pointer"
              : "default"
      if (canvas.style.cursor !== css) canvas.style.cursor = css
    }

    const capture = (e: PointerEvent) => {
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // synthetic events have no capturable pointer
      }
    }
    const releaseCapture = (e: PointerEvent) => {
      try {
        if (canvas.hasPointerCapture(e.pointerId))
          canvas.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
    }

    const press = (e: PointerEvent, button: 0 | 2) => {
      flush()
      if (button === 0) canvas.focus({ preventScroll: true })
      const used = controller.pointerDown(build(e, button))
      if (button === 2 && used) {
        commanding = true
        suppressMenuUntil = Infinity
      }
      if (used || button === 0) capture(e)
    }
    const release = (e: PointerEvent, button: 0 | 2) => {
      flush()
      controller.pointerUp(build(e, button))
      if (button === 2 && commanding) {
        commanding = false
        suppressMenuUntil = performance.now() + MENU_SUPPRESS_MS
      }
    }
    /** Presses and releases of the left / right buttons since the last event. */
    const transitions = (e: PointerEvent, kind: "down" | "move" | "up") => {
      let now = e.buttons & 3
      const bit = BUTTON_BITS[e.button] ?? 0
      // Synthetic events may carry no `buttons`: trust `button` for downs and ups.
      if (kind === "down") now |= bit & 3
      if (kind === "up") now &= ~bit
      const pressed = now & ~held
      const released = held & ~now
      held = now
      if (released & 2) release(e, 2)
      if (released & 1) release(e, 0)
      if (pressed & 1) press(e, 0)
      if (pressed & 2) press(e, 2)
      return pressed | released
    }

    const onDown = (e: PointerEvent) => {
      transitions(e, "down")
      cursor()
    }
    const onMove = (e: PointerEvent) => {
      controller.setAlt(e.altKey)
      if (transitions(e, "move")) {
        cursor()
        return
      }
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
      transitions(e, "up")
      if (held === 0) releaseCapture(e)
      cursor()
    }
    const onCancel = () => {
      held = 0
      if (commanding) suppressMenuUntil = performance.now() + MENU_SUPPRESS_MS
      commanding = false
      if (controller.dragging) controller.cancel()
    }
    const onContextMenu = (e: Event) => {
      if (commanding || performance.now() < suppressMenuUntil)
        e.preventDefault()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return
      controller.setAlt(e.type === "keydown")
      // Firefox focuses its menu bar when Alt is released alone.
      if (controller.dragging) e.preventDefault()
    }
    const onBlur = () => controller.setAlt(false)
    canvas.addEventListener("pointerdown", onDown)
    canvas.addEventListener("pointermove", onMove)
    canvas.addEventListener("pointerup", onUp)
    canvas.addEventListener("pointercancel", onCancel)
    canvas.addEventListener("contextmenu", onContextMenu)
    window.addEventListener("keydown", onKey)
    window.addEventListener("keyup", onKey)
    window.addEventListener("blur", onBlur)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      canvas.removeEventListener("pointerdown", onDown)
      canvas.removeEventListener("pointermove", onMove)
      canvas.removeEventListener("pointerup", onUp)
      canvas.removeEventListener("pointercancel", onCancel)
      canvas.removeEventListener("contextmenu", onContextMenu)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("keyup", onKey)
      window.removeEventListener("blur", onBlur)
      canvas.style.cursor = "default"
    }
  }, [engine, canvas, controller, enabled])
}
