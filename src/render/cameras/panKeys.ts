/**
 * Held-key camera panning shared by the editor orbit camera and the player camera. Keys are tracked by
 * physical position (`KeyboardEvent.code`), so WASD works on any layout and with Shift held. Arrow keys
 * are opt-in: the editor uses them to nudge the selection.
 */

/** Screen direction per key: x = right, y = up (away from the viewer). */
const PAN_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1],
  KeyS: [0, -1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
}

const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable
}

export class HeldPanKeys {
  /** Whether arrow keys pan too (WASD always does). */
  arrows = true
  private readonly keys = new Set<string>()

  /** Track a key press; `interactive` = the camera currently takes input. */
  keyDown(e: KeyboardEvent, interactive: boolean): void {
    if (!interactive || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return
    if (PAN_KEYS[e.code]) this.keys.add(e.code)
  }

  keyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code)
  }

  clear(): void {
    this.keys.clear()
  }

  /** Unit screen direction of the held keys, or null when they cancel out or none is held. */
  direction(): { x: number; y: number } | null {
    let x = 0
    let y = 0
    for (const k of this.keys) {
      if (!this.arrows && ARROWS.has(k)) continue
      const v = PAN_KEYS[k]
      if (v) {
        x += v[0]
        y += v[1]
      }
    }
    const l = Math.hypot(x, y)
    return l > 0 ? { x: x / l, y: y / l } : null
  }
}
