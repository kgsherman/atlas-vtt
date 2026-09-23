/**
 * Test helpers for the editor: a small two-level fixture scene, a store without a system clipboard
 * and a builder for synthetic ToolPointerEvents.
 */
import { matchesKeyboardEvent } from "@tanstack/hotkeys"

import { createConnector, createDoor, createFloor, createLevel, createScene, createWall, createWindow } from "@/core/scene/factory"
import type { Id, Scene, SceneObject, Vec2, Vec3 } from "@/core/scene/types"
import type { KeyOverrides } from "@/lib/keymap"

import type { EditorController } from "./controller"
import { editorBindings } from "./shortcuts"
import { createEditorStore, type CreateEditorStoreOptions } from "./store"
import type { ToolPointerEvent } from "./tools/types"

export interface Fixture {
  scene: Scene
  groundId: Id
  upperId: Id
  /** Ground-level wall (10,10)→(30,10) with a door at offset 5 and a window at offset 14. */
  wallId: Id
  doorId: Id
  windowId: Id
  /** Stairs from ground to upper at x 40..50, z 40..60. */
  stairsId: Id
}

/** 20×20-cell scene: "ground" (elevation 0, full floor) and "upper" (elevation 10, full floor). */
export function fixtureScene(): Fixture {
  const scene = createScene({ width: 20, depth: 20 })
  const groundId = Object.keys(scene.levels)[0]
  const upper = createLevel({ id: "upper", name: "Upper", elevation: 10 })
  scene.levels[upper.id] = upper
  const add = <T extends SceneObject>(o: T): T => {
    scene.objects[o.id] = o
    return o
  }
  add(createFloor(upper.id, { x: 0, z: 0, w: 100, d: 100 }, "wood"))
  const wall = add(createWall(groundId, { x: 10, z: 10 }, { x: 30, z: 10 }))
  const door = add(createDoor(wall, 5))
  const win = add(createWindow(wall, 14))
  const stairs = add(createConnector(groundId, upper.id, { x: 40, z: 40, w: 10, d: 20 }, 0))
  return { scene, groundId, upperId: upper.id, wallId: wall.id, doorId: door.id, windowId: win.id, stairsId: stairs.id }
}

export function makeStore(scene?: Scene, opts: Omit<CreateEditorStoreOptions, "scene"> = {}) {
  return createEditorStore({ systemClipboard: null, ...opts, scene: scene ?? fixtureScene().scene })
}

export interface PointerInit {
  ground?: Vec2 | null
  objectId?: Id | null
  tokenId?: Id | null
  hitPoint?: Vec3 | null
  button?: number
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
  clientX?: number
  clientY?: number
}

/**
 * A synthetic ToolPointerEvent. clientX/clientY default to the ground point scaled by 10 px/ft so
 * pixel-distance thresholds behave like a real canvas.
 */
export function pointer(init: PointerInit = {}): ToolPointerEvent {
  const ground = init.ground === undefined ? null : init.ground
  return {
    pick: {
      ground: ground ? { x: ground.x, y: 0, z: ground.z } : null,
      objectId: init.objectId ?? null,
      tokenId: init.tokenId ?? null,
      hitPoint: init.hitPoint ?? null,
    },
    snapped: ground,
    ground,
    button: init.button ?? 0,
    shift: init.shift ?? false,
    alt: init.alt ?? false,
    ctrl: init.ctrl ?? false,
    clientX: init.clientX ?? (ground ? ground.x * 10 : 0),
    clientY: init.clientY ?? (ground ? ground.z * 10 : 0),
  }
}

export const at = (x: number, z: number, init: Omit<PointerInit, "ground"> = {}) => pointer({ ...init, ground: { x, z } })

export const key = (k: string, mods: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {}) => ({
  key: k,
  shift: mods.shift ?? false,
  alt: mods.alt ?? false,
  ctrl: mods.ctrl ?? false,
})

/**
 * A key press as the app delivers it: TanStack Hotkeys matches the event against the editor bindings
 * (Linux platform: Mod = Ctrl) and the controller gets the bound action. Returns whether the key was
 * consumed; false also when nothing is bound to it. Needs a DOM (KeyboardEvent): jsdom tests only.
 */
export function pressKey(
  controller: EditorController,
  k: string,
  mods: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {},
  overrides?: KeyOverrides
): boolean {
  const e = key(k, mods)
  const event = new KeyboardEvent("keydown", { key: k, shiftKey: e.shift, altKey: e.alt, ctrlKey: e.ctrl })
  const binding = editorBindings(overrides).find((b) => matchesKeyboardEvent(event, b.hotkey, "linux"))
  return binding ? controller.keyDown(e, binding.action) : false
}
