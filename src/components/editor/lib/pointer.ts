/**
 * DOM pointer → ToolPointerEvent (editor/tools/types.ts): pick on the active level, ground point,
 * snapping with the editor's snap mode (Alt = free placement), modifier keys and click count.
 */
import type { SnapMode } from "@/core/grid/grid"
import type { GridSettings, Vec2 } from "@/core/scene/types"
import { snapGround } from "@/editor/snapping"
import type { ToolPointerEvent } from "@/editor/tools/types"
import type { PickResult } from "@/render/contracts"

export interface DomPointerLike {
  clientX: number
  clientY: number
  button: number
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  detail?: number
}

export function toToolPointerEvent(
  e: DomPointerLike,
  pick: PickResult,
  ctx: { grid: GridSettings; snapMode: SnapMode; altHeld: boolean },
  opts: { button?: number } = {}
): ToolPointerEvent {
  const ground: Vec2 | null = pick.ground ? { x: pick.ground.x, z: pick.ground.z } : null
  const alt = e.altKey || ctx.altHeld
  return {
    pick,
    ground,
    snapped: ground ? snapGround(ctx.grid, ground, ctx.snapMode, alt) : null,
    button: opts.button ?? e.button,
    shift: e.shiftKey,
    alt,
    // Cmd acts as Ctrl on macOS.
    ctrl: e.ctrlKey || e.metaKey,
    clientX: e.clientX,
    clientY: e.clientY,
    detail: e.detail,
  }
}

/** Grid cell and world point under the cursor, for the status bar. */
export function cursorReadout(grid: GridSettings, p: Vec2 | null): { i: number; j: number; x: number; z: number; inside: boolean } | null {
  if (!p) return null
  const i = Math.floor(p.x / grid.cellSize)
  const j = Math.floor(p.z / grid.cellSize)
  return { i, j, x: p.x, z: p.z, inside: i >= 0 && j >= 0 && i < grid.width && j < grid.depth }
}

/** Keyboard focus is in something that takes text: editor shortcuts must not fire. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false
  const el = target as HTMLElement
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type)
  }
  return false
}

/**
 * Floors are the "background" of a level: with the select tool, a press on an unselected floor must
 * start a marquee (and hovering the ground must not outline the whole floor), while a plain click
 * still selects it. Returns the event with the floor hit removed, and the floor that was under it.
 */
export function stripBackgroundFloor<E extends { pick: PickResult; shift: boolean; ctrl: boolean }>(
  scene: { objects: Record<string, { type: string }> },
  selection: readonly string[],
  e: E
): { event: E; floorId: string | null } {
  const id = e.pick.objectId
  if (!id || e.pick.tokenId || !Object.hasOwn(scene.objects, id) || scene.objects[id].type !== "floor" || selection.includes(id)) return { event: e, floorId: null }
  if (e.shift || e.ctrl) return { event: e, floorId: null }
  return { event: { ...e, pick: { ...e.pick, objectId: null, hitPoint: null, hitNormal: null } }, floorId: id }
}

const NAVIGATION_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Enter", " "])

/**
 * Whether an editor shortcut may use this key given where keyboard focus is: navigation keys (arrows,
 * page keys, Enter, Space) belong to a focused widget (slider, toggle group, button, menu…) and only
 * reach the canvas when nothing interactive is focused; other keys work anywhere but text fields.
 */
export function editorMayHandleKey(key: string, target: EventTarget | null): boolean {
  if (isTextEntryTarget(target)) return false
  if (!NAVIGATION_KEYS.has(key)) return true
  if (!target || typeof (target as Element).tagName !== "string") return true
  const tag = (target as Element).tagName
  return tag === "BODY" || tag === "CANVAS" || tag === "HTML"
}
