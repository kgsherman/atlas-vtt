/**
 * updateKnowledge (ARCHITECTURE §5.4): explored |= perceived, memory refresh + deletion rule, secret
 * door reveal — unit tests on synthetic visibility results, then end-to-end scenarios on the real
 * vision engine.
 */
import { describe, expect, it } from "vitest"

import { anchorPosition } from "../movement"
import { createConnector, createDoor, createLight, createProp, createWall } from "../scene/factory"
import type { Id, Scene } from "../scene/types"
import { createGradeMask, decodeMask, FULL_SUBMASK } from "../vision/mask"
import type { GradeMask, VisibilityResult } from "../vision/types"
import { updateKnowledge } from "./memory"
import { reduceDm } from "./reduceDm"
import { createGameState } from "./state"
import { add, addLevel, addToken, flatScene, TestHost } from "./test-utils"
import type { GameState, PlayerDoor, PlayerLight, PlayerProp } from "./types"

function synthVis(scene: Scene, cells: Record<Id, [number, number, number?][]>, observed: Id[] = []): VisibilityResult {
  const perception: Record<Id, GradeMask> = {}
  for (const [levelId, list] of Object.entries(cells)) {
    const m = createGradeMask(scene.grid.width, scene.grid.depth)
    for (const [i, j, sub] of list) {
      m.grades[j * m.width + i] = 3
      if (sub !== undefined) m.partial.set(j * m.width + i, sub)
    }
    perception[levelId] = m
  }
  return { perception, sunlit: {}, visibleTokenIds: new Set(), observedObjectIds: new Set(observed), illuminatingLightIds: new Set() }
}

function withPlayer(scene: Scene): GameState {
  return reduceDm(createGameState({ sessionId: "s", roomCode: "R", scene }), { t: "add-player", userId: "p1", displayName: "p1" }).state
}

const bit = (m: { bits: Uint8Array }, c: number) => (m.bits[c >> 3] >> (c & 7)) & 1

describe("explored", () => {
  it("ORs perceived cells (with sub-cell partials) into the persistent mask", () => {
    const { scene, ground } = flatScene(10, 10)
    let s = withPlayer(scene)
    s = updateKnowledge(s, "p1", synthVis(scene, { [ground]: [[1, 1], [2, 1, 0b1]] }))
    s = updateKnowledge(s, "p1", synthVis(scene, { [ground]: [[5, 5], [2, 1, 0b10]] }))
    const m = decodeMask(s.explored.p1[ground])
    expect(bit(m, 11)).toBe(1)
    expect(bit(m, 55)).toBe(1)
    expect(bit(m, 12)).toBe(0)
    expect(m.partial.get(12)).toBe(0b11)
    // Completing the sub-cells promotes the cell.
    s = updateKnowledge(s, "p1", synthVis(scene, { [ground]: [[2, 1, FULL_SUBMASK & ~0b11]] }))
    const m2 = decodeMask(s.explored.p1[ground])
    expect(bit(m2, 12)).toBe(1)
    expect(m2.partial.has(12)).toBe(false)
  })

  it("returns the same state object when nothing new is known", () => {
    const { scene, ground } = flatScene(10, 10)
    const crate = add(scene, createProp(ground, "crate", { x: 7.5, y: 0, z: 7.5 }))
    const vis = synthVis(scene, { [ground]: [[1, 1]] }, [crate.id])
    const s1 = updateKnowledge(withPlayer(scene), "p1", vis)
    expect(updateKnowledge(s1, "p1", vis)).toBe(s1)
    expect(updateKnowledge(s1, "p1", synthVis(scene, { [ground]: [[1, 1]] }, [crate.id]))).toBe(s1)
  })

  it("ignores perception computed for another grid size or unknown levels", () => {
    const { scene, ground } = flatScene(10, 10)
    const stale = synthVis({ ...scene, grid: { ...scene.grid, width: 8 } }, { [ground]: [[1, 1]], nowhere: [[0, 0]] })
    const s0 = withPlayer(scene)
    expect(updateKnowledge(s0, "p1", stale)).toBe(s0)
  })
})

describe("memory", () => {
  it("remembers observed objects as sanitised copies (no DM fields)", () => {
    const { scene, ground } = flatScene(10, 10)
    const crate = add(scene, createProp(ground, "crate", { x: 7.5, y: 0, z: 7.5 }, { name: "Loot", dmNotes: "secret", editorLocked: true }))
    const s = updateKnowledge(withPlayer(scene), "p1", synthVis(scene, { [ground]: [[1, 1]] }, [crate.id]))
    const m = s.memory.p1[crate.id] as PlayerProp
    expect(Object.keys(m).sort()).toEqual(["blocksSight", "castsShadows", "color", "id", "kind", "levelId", "position", "rotationY", "scale", "type"])
  })

  it("never remembers hidden objects, attached lights or unrevealed secret doors", () => {
    const { scene, ground } = flatScene(10, 10)
    const wall = add(scene, createWall(ground, { x: 0, z: 10 }, { x: 50, z: 10 }))
    const hidden = add(scene, createProp(ground, "crate", { x: 7.5, y: 0, z: 7.5 }, { hidden: true }))
    const tok = addToken(scene, ground, 12.5, 12.5)
    const carried = add(scene, createLight(ground, "torch", { x: 0, z: 0 }, { attachedTokenId: tok.id }))
    const secret = add(scene, createDoor(wall, 10, { style: "secret", state: "closed" }))
    const s = updateKnowledge(withPlayer(scene), "p1", synthVis(scene, { [ground]: [[1, 1], [2, 2]] }, [wall.id, hidden.id, carried.id, secret.id]))
    expect(Object.keys(s.memory.p1)).toEqual([wall.id])
  })

  it("auto-reveals a secret door observed open (remembered as wood), not one observed closed", () => {
    const { scene, ground } = flatScene(10, 10)
    const wall = add(scene, createWall(ground, { x: 0, z: 10 }, { x: 50, z: 10 }))
    const shut = add(scene, createDoor(wall, 10, { style: "secret", state: "closed" }))
    const open = add(scene, createDoor(wall, 30, { style: "secret", state: "open" }))
    const s = updateKnowledge(withPlayer(scene), "p1", synthVis(scene, { [ground]: [[1, 1], [5, 1]] }, [wall.id, shut.id, open.id]))
    expect(s.revealed.p1).toEqual([open.id])
    expect(s.memory.p1[open.id]).toMatchObject({ style: "wood", state: "open" })
    expect(s.memory.p1[shut.id]).toBeUndefined()
  })

  it("stores locked doors as closed", () => {
    const { scene, ground } = flatScene(10, 10)
    const wall = add(scene, createWall(ground, { x: 0, z: 10 }, { x: 50, z: 10 }))
    const door = add(scene, createDoor(wall, 10, { state: "locked", style: "iron" }))
    const s = updateKnowledge(withPlayer(scene), "p1", synthVis(scene, { [ground]: [[1, 1]] }, [wall.id, door.id]))
    expect((s.memory.p1[door.id] as PlayerDoor).state).toBe("closed")
  })

  it("remembers static lights at their world height (stairs and terrain resolved)", () => {
    const { scene, ground } = flatScene(10, 10)
    const upper = addLevel(scene, { name: "Upper", elevation: 10 })
    add(scene, createConnector(ground, upper.id, { x: 0, z: 0, w: 20, d: 5 }, 1, "stairs"))
    // Half way up the run (x = 10 of 0..20): ground 5, torch 5 ft above it.
    const torch = add(scene, createLight(ground, "torch", { x: 10, z: 2.5 }))
    const s = updateKnowledge(withPlayer(scene), "p1", synthVis(scene, { [ground]: [[2, 0]] }, [torch.id]))
    expect((s.memory.p1[torch.id] as PlayerLight).position).toEqual({ x: 10, y: 10, z: 2.5 })
  })

  describe("deletion rule", () => {
    function setup() {
      const { scene, ground } = flatScene(10, 10)
      const crate = add(scene, createProp(ground, "crate", { x: 7.5, y: 0, z: 7.5 }))
      const s = updateKnowledge(withPlayer(scene), "p1", synthVis(scene, { [ground]: [[1, 1]] }, [crate.id]))
      return { scene, ground, crate, s }
    }
    const patch = (s: GameState, patches: Parameters<typeof reduceDm>[1] & { t: "apply-scene-patches" }) => reduceDm(s, patches).state

    it("keeps a deleted object while its remembered spot is not perceived", () => {
      const { ground, crate, s } = setup()
      const s1 = patch(s, { t: "apply-scene-patches", patches: [{ op: "remove", path: ["objects", crate.id] }] })
      const s2 = updateKnowledge(s1, "p1", synthVis(s1.scene, { [ground]: [[8, 8]] }))
      expect(s2.memory.p1[crate.id]).toBeDefined()
    })

    it("forgets a deleted object once its remembered spot is perceived", () => {
      const { ground, crate, s } = setup()
      const s1 = patch(s, { t: "apply-scene-patches", patches: [{ op: "remove", path: ["objects", crate.id] }] })
      const s2 = updateKnowledge(s1, "p1", synthVis(s1.scene, { [ground]: [[1, 1]] }))
      expect(s2.memory.p1[crate.id]).toBeUndefined()
    })

    it("forgets an object that became hidden, once its spot is perceived", () => {
      const { ground, crate, s } = setup()
      const s1 = patch(s, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["objects", crate.id, "hidden"], value: true }] })
      expect(updateKnowledge(s1, "p1", synthVis(s1.scene, { [ground]: [[8, 8]] })).memory.p1[crate.id]).toBeDefined()
      // Hidden objects are still reported as observed by vision; memory drops them.
      expect(updateKnowledge(s1, "p1", synthVis(s1.scene, { [ground]: [[1, 1]] }, [crate.id])).memory.p1[crate.id]).toBeUndefined()
    })

    it("forgets a moved object at its old spot when that spot is seen empty", () => {
      const { ground, crate, s } = setup()
      const s1 = patch(s, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["objects", crate.id, "position"], value: { x: 42.5, y: 0, z: 42.5 } }] })
      const unseen = updateKnowledge(s1, "p1", synthVis(s1.scene, { [ground]: [[5, 5]] }))
      expect((unseen.memory.p1[crate.id] as PlayerProp).position).toEqual({ x: 7.5, y: 0, z: 7.5 })
      const seen = updateKnowledge(s1, "p1", synthVis(s1.scene, { [ground]: [[1, 1]] }))
      expect(seen.memory.p1[crate.id]).toBeUndefined()
    })

    it("keeps an unchanged object whose cell is perceived but that vision did not report", () => {
      const { ground, crate, s } = setup()
      const s2 = updateKnowledge(s, "p1", synthVis(s.scene, { [ground]: [[1, 1]] }))
      expect(s2.memory.p1[crate.id]).toBeDefined()
    })
  })
})

// ---------------------------------------------------------------------------
// Real-vision scenarios
// ---------------------------------------------------------------------------

describe("memory on the real vision engine", () => {
  /**
   * Dark 150 × 50 ft field. A wall along x = 50 with a door at z 23–27. The PC carries a torch
   * (bright 20 / dim 40), so what it perceives is what the torch lights.
   */
  function darkField() {
    const { scene, ground } = flatScene(30, 10, "dark")
    const wall = add(scene, createWall(ground, { x: 50, z: 0 }, { x: 50, z: 50 }))
    const door = add(scene, createDoor(wall, 25, { state: "open" }))
    const crate = add(scene, createProp(ground, "crate", { x: 27.5, y: 0, z: 12.5 }))
    const pc = addToken(scene, ground, 37.5, 27.5)
    const torch = add(scene, createLight(ground, "torch", { x: 0, z: 0 }, { attachedTokenId: pc.id }))
    void torch
    const host = new TestHost(scene, ["p1"])
    host.assign(pc.id)
    return { host, ground, wall, door, crate, pc }
  }
  const moveTo = (h: TestHost, tokenId: Id, levelId: Id, x: number, z: number) => h.dm({ t: "move-token", tokenId, levelId, x, z })

  it("a door closed out of sight still appears open until it is seen again", () => {
    const { host, ground, door, pc } = darkField()
    expect(host.refresh().view.objects[door.id]).toMatchObject({ state: "open" })
    moveTo(host, pc.id, ground, 137.5, 27.5)
    host.refresh()
    host.dm({ t: "set-door", doorId: door.id, state: "closed" })
    const { view, ops } = host.refresh()
    expect(view.objects[door.id]).toMatchObject({ state: "open" })
    expect(ops).toEqual([])
    moveTo(host, pc.id, ground, 37.5, 27.5)
    expect(host.refresh().view.objects[door.id]).toMatchObject({ state: "closed" })
  })

  it("crates added, moved or deleted in an explored but unperceived room produce no diff until perceived", () => {
    const { host, ground, crate, pc } = darkField()
    expect(host.refresh().view.objects[crate.id]).toBeDefined()
    moveTo(host, pc.id, ground, 137.5, 27.5)
    const away = host.refresh().view
    expect(away.objects[crate.id]).toBeDefined()

    const added = createProp(ground, "crate", { x: 32.5, y: 0, z: 37.5 })
    host.dm({ t: "apply-scene-patches", patches: [{ op: "add", path: ["objects", added.id], value: added }] })
    expect(host.refresh().ops).toEqual([])
    host.dm({ t: "apply-scene-patches", patches: [{ op: "replace", path: ["objects", crate.id, "position"], value: { x: 22.5, y: 0, z: 42.5 } }] })
    expect(host.refresh().ops).toEqual([])
    host.dm({ t: "apply-scene-patches", patches: [{ op: "remove", path: ["objects", crate.id] }] })
    const { ops, view } = host.refresh()
    expect(ops).toEqual([])
    expect(view.objects[crate.id]).toMatchObject({ position: { x: 27.5, y: 0, z: 12.5 } })
    expect(view.objects[added.id]).toBeUndefined()

    // Back in the light: the removed crate is forgotten, the new one appears.
    moveTo(host, pc.id, ground, 32.5, 22.5)
    const back = host.refresh().view
    expect(back.objects[crate.id]).toBeUndefined()
    expect(back.objects[added.id]).toBeDefined()
  })

  /**
   * Bright corridor along row 5 (z 25–30) from x 0 to 150, walled on both sides. A side room
   * (x 40–65, z 0–25) opens onto it through a gap in the north wall at x 50–55; it can only be seen
   * from the middle of the corridor.
   */
  function corridor() {
    const { scene, ground } = flatScene(30, 12)
    add(scene, createWall(ground, { x: 0, z: 25 }, { x: 50, z: 25 }))
    add(scene, createWall(ground, { x: 55, z: 25 }, { x: 150, z: 25 }))
    add(scene, createWall(ground, { x: 0, z: 30 }, { x: 150, z: 30 }))
    add(scene, createWall(ground, { x: 40, z: 0 }, { x: 40, z: 25 }))
    add(scene, createWall(ground, { x: 65, z: 0 }, { x: 65, z: 25 }))
    const chest = add(scene, createProp(ground, "chest", { x: 52.5, y: 0, z: 7.5 }))
    const pc = addToken(scene, ground, 2.5, 27.5)
    const host = new TestHost(scene, ["p1"])
    host.assign(pc.id)
    return { host, ground, pc, chest, scene }
  }
  const sideCell = 2 * 30 + 10 // cell (10, 2): x 50–55, z 10–15, inside the side room

  it("walking a corridor explores side rooms seen mid-path", () => {
    const { host, ground, pc, chest } = corridor()
    host.refresh()
    expect(bit(decodeMask(host.state.explored.p1[ground]), sideCell)).toBe(0)
    const path = Array.from({ length: 30 }, (_, i) => ({ cell: { i, j: 5 }, levelId: ground }))
    const out = host.request("p1", { t: "move", reqId: "walk", tokenId: pc.id, path })
    expect(out.result).toEqual({ reqId: "walk", ok: true, applied: 29 })
    expect(out.visited).toHaveLength(29)
    expect(host.state.scene.tokens[pc.id].position).toEqual(anchorPosition(host.state.scene, "medium", { i: 29, j: 5 }))
    const { view, vis } = host.refresh()
    // From the corridor's end the side room is out of sight…
    expect(vis.perception[ground].grades[sideCell]).toBe(0)
    // …but it was seen on the way past, so it is explored and remembered.
    expect(bit(decodeMask(host.state.explored.p1[ground]), sideCell)).toBe(1)
    expect(view.objects[chest.id]).toBeDefined()
  })

  it("teleporting to the end without the per-step passes would not have explored it", () => {
    const { host, ground, pc } = corridor()
    host.refresh()
    host.dm({ t: "move-token", tokenId: pc.id, levelId: ground, x: 147.5, z: 27.5 })
    host.refresh()
    expect(bit(decodeMask(host.state.explored.p1[ground]), sideCell)).toBe(0)
  })
})
