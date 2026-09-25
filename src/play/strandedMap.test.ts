/**
 * A stranded move (no path found, kept on screen until the player jumps or dismisses it) goes when the
 * map it was about goes: the DM moved the game to another map, even one where the token stands at the
 * same spot (sceneChanged).
 */
import { describe, expect, it } from "vitest"

import { add, flatScene, tokenAt } from "@/core/movement/test-utils"
import { createWall } from "@/core/scene/factory"
import type { Scene, SceneLike } from "@/core/scene/types"
import type { PickResult } from "@/render/contracts"

import {
  PlayController,
  type CommittedMove,
  type PlayControllerHost,
  type PlayPointerEvent,
} from "./controller"
import { MovePlanner } from "./planner"

const command = (x: number, z: number): PlayPointerEvent => {
  const pick: PickResult = {
    ground: { x, y: 0, z },
    objectId: null,
    tokenId: null,
    hitPoint: null,
  }
  return { clientX: 0, clientY: 0, button: 2, shift: false, pick }
}

/** A token outside a closed box, and a right-button move into the box: stranded. */
function stranded() {
  const { scene, levelId } = flatScene(10, 10)
  for (const [a, b] of [
    [
      { x: 30, z: 30 },
      { x: 45, z: 30 },
    ],
    [
      { x: 45, z: 30 },
      { x: 45, z: 45 },
    ],
    [
      { x: 45, z: 45 },
      { x: 30, z: 45 },
    ],
    [
      { x: 30, z: 45 },
      { x: 30, z: 30 },
    ],
  ])
    add(scene, createWall(levelId, a, b))
  const token = tokenAt(scene, levelId, { i: 1, j: 1 })
  let current: SceneLike = scene
  const planner = new MovePlanner()
  planner.setScene(scene)
  const moves: CommittedMove[] = []
  const host: PlayControllerHost = {
    role: "player",
    scene: () => current,
    activeLevelId: () => levelId,
    canSelect: () => true,
    canDrag: () => true,
    movementLocked: () => false,
    freeMovement: () => false,
    speedLimit: () => null,
    groundAt: () => null,
    planner,
    onSelect: () => {},
    onMove: (m) => moves.push(m),
    onDoor: () => {},
    onHint: () => {},
    setCameraControls: () => {},
  }
  const controller = new PlayController(host)
  controller.setSelected(token.id)
  controller.pointerDown(command(37.5, 37.5))
  controller.pointerUp(command(37.5, 37.5))
  expect(controller.getStranded()).toMatchObject({ tokenId: token.id, levelId })
  const show = (next: SceneLike) => {
    current = next
    planner.setScene(next)
    controller.sceneChanged()
  }
  return { scene, levelId, token, controller, moves, show }
}

describe("stranded moves across maps", () => {
  it("stays while its level and token stay", () => {
    const { scene, controller, show } = stranded()
    show({ ...scene, tokens: { ...scene.tokens } })
    expect(controller.getStranded()).not.toBeNull()
  })

  it("goes when its level is gone, though the token stands where it did (another map)", () => {
    const { scene, token, controller, moves, show } = stranded()
    const other: Scene = flatScene(10, 10).scene
    const otherLevel = Object.keys(other.levels)[0]
    other.tokens[token.id] = { ...scene.tokens[token.id], levelId: otherLevel }
    show(other)
    expect(controller.getStranded()).toBeNull()
    // Nothing left to jump to (no "Jump there" into a level the host no longer has).
    controller.jumpStranded()
    expect(moves).toEqual([])
    expect(controller.overlays().ruler).toBeNull()
  })
})
