/**
 * DOM plumbing for the play views: canvas pointer events → PlayController (engine.pick on the active
 * level, rAF-throttled moves), the play keymap (window, capture phase), camera zoom via synthetic wheel
 * events, and a guard that keeps the app-wide "d" theme hotkey from firing while WASD pans the map.
 */
import * as React from "react"

import type { Id } from "@/core/scene/types"
import { resolvePlayKey, type PlayController, type PlayKeyAction } from "@/play"
import type { Engine } from "@/render/contracts"

/** Keyboard focus is in something that takes text: shortcuts must not fire. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false
  const el = target as HTMLElement
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type
    return ![
      "checkbox",
      "radio",
      "button",
      "submit",
      "reset",
      "range",
      "color",
      "file",
    ].includes(type)
  }
  return false
}

/** A modal dialog, sheet or menu is open: map shortcuts must not fire underneath it. */
export function overlayOpen(): boolean {
  return (
    document.querySelector(
      '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"], [role="menu"], [role="listbox"]'
    ) !== null
  )
}

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
 * The theme provider toggles dark/light on a bare "d" key press (window listener). On the map, "d"
 * pans right (the camera reads `code`), so hide the key from that listener while this hook is mounted.
 */
export function useGuardThemeHotkey(enabled = true): void {
  React.useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return
      if (e.key === "d" || e.key === "D") {
        try {
          Object.defineProperty(e, "key", { value: "", configurable: true })
        } catch {
          // Non-configurable in some engine: the theme toggles, nothing else breaks.
        }
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [enabled])
}

/** Play keymap on window (capture phase so it wins over app-wide handlers). */
export function usePlayKeys(
  handler: (action: PlayKeyAction, e: KeyboardEvent) => boolean | void,
  enabled = true
): void {
  const ref = React.useRef(handler)
  React.useEffect(() => {
    ref.current = handler
  })
  React.useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTextEntry(e.target) || overlayOpen()) return
      const action = resolvePlayKey({
        key: e.key,
        code: e.code,
        shift: e.shiftKey,
        ctrl: e.ctrlKey || e.metaKey,
        alt: e.altKey,
      })
      if (!action || (e.repeat && action.type !== "zoom")) return
      const consumed = ref.current(action, e)
      if (consumed !== false) e.preventDefault()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [enabled])
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
