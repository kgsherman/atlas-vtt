/**
 * Key hints floating to the right of the cursor while the active tool asks for them (Tool.cursorKeys, e.g.
 * the terrain polygon: add corners, finish, remove the last corner, cancel). Rendered inside EngineCanvas
 * (over the canvas); follows the pointer by writing its transform directly (no React render per move),
 * flips to the left of the cursor near the right edge and hides while the pointer is off the canvas.
 */
import * as React from "react"

import { useEngine } from "@/components/canvas/engineContext"
import { CommandKbd } from "@/components/keybindings/CommandKbd"
import { Kbd } from "@/components/ui/kbd"
import type { EditorController } from "@/editor/controller"
import type { CursorKey } from "@/editor/tools/types"

/** Offset from the cursor hotspot (CSS px): clear of the crosshair. */
const OFFSET = { x: 20, y: 14 }
const MARGIN = 8

export function CursorKeys({ controller }: { controller: EditorController }) {
  const { canvas } = useEngine()
  const keys = React.useSyncExternalStore(controller.subscribe, controller.toolCursorKeys)
  const ref = React.useRef<HTMLDivElement>(null)
  const pointer = React.useRef<{ x: number; y: number } | null>(null)

  const place = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    const p = pointer.current
    if (!p || !canvas) {
      el.style.visibility = "hidden"
      return
    }
    const w = el.offsetWidth
    const h = el.offsetHeight
    let x = p.x + OFFSET.x
    if (x + w > canvas.clientWidth - MARGIN) x = p.x - OFFSET.x - w
    const y = Math.max(MARGIN, Math.min(p.y + OFFSET.y, canvas.clientHeight - MARGIN - h))
    el.style.transform = `translate(${Math.round(Math.max(MARGIN, x))}px, ${Math.round(y)}px)`
    el.style.visibility = "visible"
  }, [canvas])

  React.useEffect(() => {
    if (!canvas) return
    const move = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top }
      place()
    }
    const leave = () => {
      pointer.current = null
      place()
    }
    canvas.addEventListener("pointermove", move)
    canvas.addEventListener("pointerdown", move)
    canvas.addEventListener("pointerleave", leave)
    return () => {
      canvas.removeEventListener("pointermove", move)
      canvas.removeEventListener("pointerdown", move)
      canvas.removeEventListener("pointerleave", leave)
    }
  }, [canvas, place])

  // A new list may change the size: re-place before paint.
  React.useLayoutEffect(place, [keys, place])

  if (!keys || keys.length === 0) return null
  return (
    <div
      ref={ref}
      data-slot="cursor-keys"
      aria-hidden
      style={{ visibility: "hidden" }}
      className="pointer-events-none absolute top-0 left-0 z-10 grid grid-cols-[auto_auto] items-center gap-x-2 gap-y-1 rounded-md border bg-popover/85 px-2 py-1.5 text-xs text-popover-foreground shadow-md backdrop-blur-sm select-none"
    >
      {keys.map((k) => (
        <CursorKeyRow key={k.label} entry={k} />
      ))}
    </div>
  )
}

/** One row: the inputs (alternatives, separated by "/") and what they do. */
function CursorKeyRow({ entry }: { entry: CursorKey }) {
  const caps: React.ReactNode[] = []
  const sep = (k: string) => (
    <span key={`sep:${k}`} className="text-muted-foreground/60">
      /
    </span>
  )
  if (entry.mouse) caps.push(<Kbd key="mouse">{entry.mouse}</Kbd>)
  for (const c of entry.commands ?? []) {
    if (caps.length > 0) caps.push(sep(c))
    caps.push(<CommandKbd key={c} scope="editor" command={c} />)
  }
  return (
    <>
      <span className="flex items-center gap-1 justify-self-end">{caps}</span>
      <span className="text-muted-foreground">{entry.label}</span>
    </>
  )
}
