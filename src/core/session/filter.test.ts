/**
 * filterForPlayer: the allowlist (sentinel leak test), memory-only objects, clipping to explored cells,
 * lights, tokens, level stubs, terrain zeroing and masks. Cells are 5 ft: cell (i, j) spans
 * x ∈ [5i, 5i+5), z ∈ [5j, 5j+5).
 */
import { produce } from "immer"
import { describe, expect, it } from "vitest"

import { createConnector, createDoor, createFloor, createLight, createPillar, createProp, createWall, createWindow } from "../scene/factory"
import { createHeightmap, decodeChunk, sampleCounts, writeHeights } from "../scene/heightmap"
import { levelGround, wallLength } from "../scene/queries"
import { sampleById } from "../scene/samples"
import { blockShape, cylinderShape, writeTerrain } from "../scene/terrainShapes"
import type { DoorObject, Id, Scene, SceneLike, WallObject, WindowObject } from "../scene/types"
import { openingFrame, wallBaseKnots, wallProfile, type WallProfile } from "../scene/wallProfile"
import { artExtent, createGradeMask, decodeGrades, decodeMask } from "../vision/mask"
import type { GradeMask, VisibilityResult } from "../vision/types"
import { buildOcclusionWorld, primitiveBounds, primitiveTopAt, TerrainSampler } from "../occlusion"
import type { OccluderPrimitive } from "../occlusion/types"
import { diffViews } from "./diff"
import { filterForPlayer } from "./filter"
import { updateKnowledge } from "./memory"
import { playerViewSchema } from "./playerViewSchema"
import { reduceDm } from "./reduceDm"
import { viewToScene } from "./viewToScene"
import { createGameState } from "./state"
import { add, addLevel, addToken, flatScene, prng, TestHost } from "./test-utils"
import type { GameState, PlayerDoor, PlayerLight, PlayerView, PlayerWall, PlayerWindow } from "./types"

/** A synthetic visibility result: grade 3 on the listed cells ([i, j] or [i, j, subMask]). */
function synthVis(scene: Scene, cells: Record<Id, [number, number, number?][]>, observed: Id[] = [], extra: Partial<VisibilityResult> = {}): VisibilityResult {
  const perception: Record<Id, GradeMask> = {}
  for (const [levelId, list] of Object.entries(cells)) {
    const m = createGradeMask(scene.grid.width, scene.grid.depth)
    for (const [i, j, sub] of list) {
      const c = j * m.width + i
      m.grades[c] = 3
      if (sub !== undefined) m.partial.set(c, sub)
    }
    perception[levelId] = m
  }
  return {
    perception,
    sunlit: {},
    visibleTokenIds: new Set(),
    observedObjectIds: new Set(observed),
    illuminatingLightIds: new Set(),
    ...extra,
  }
}

function withPlayer(scene: Scene, uid = "p1"): GameState {
  return reduceDm(createGameState({ sessionId: "s", roomCode: "R", scene }), { t: "add-player", userId: uid, displayName: uid }).state
}

function know(state: GameState, vis: VisibilityResult, uid = "p1") {
  const s = updateKnowledge(state, uid, vis)
  return { state: s, view: filterForPlayer(s, uid, vis) }
}

// ---------------------------------------------------------------------------
// Sentinel leak test
// ---------------------------------------------------------------------------

function sentinelFixture() {
  const { scene, ground } = flatScene(24, 12)
  scene.name = "Tavern"
  scene.meta.tags = ["SENTINEL_META_TAG"]
  scene.levels[ground].name = "Ground"
  // Room A: x 0–50, z 0–30.
  add(scene, createWall(ground, { x: 0, z: 0 }, { x: 50, z: 0 }))
  add(scene, createWall(ground, { x: 0, z: 0 }, { x: 0, z: 30 }))
  const wallS = add(scene, createWall(ground, { x: 0, z: 30 }, { x: 50, z: 30 }, { name: "South wall", dmNotes: "SENTINEL_WALL_NOTES" }))
  const wallE = add(scene, createWall(ground, { x: 50, z: 0 }, { x: 50, z: 30 }))
  const secret = add(scene, createDoor(wallE, 15, { style: "secret", state: "closed", name: "SENTINEL_SECRET_NAME", dmNotes: "SENTINEL_SECRET_NOTES" }))
  const locked = add(scene, createDoor(wallS, 25, { state: "locked", name: "SENTINEL_LOCKED_NAME", dmNotes: "SENTINEL_LOCKED_NOTES" }))
  const hiddenWall = add(scene, createWall(ground, { x: 30, z: 24 }, { x: 40, z: 24 }, { hidden: true, name: "SENTINEL_HIDDEN_WALL" }))
  const hiddenProp = add(scene, createProp(ground, "barrel", { x: 42, y: 0, z: 6 }, { hidden: true, name: "SENTINEL_HIDDEN_PROP" }))
  const lockedProp = add(scene, createProp(ground, "crate", { x: 8, y: 0, z: 25 }, { editorLocked: true, name: "SENTINEL_PROP_NAME", dmNotes: "SENTINEL_PROP_NOTES" }))
  const lockedPillar = add(scene, createPillar(ground, { x: 27.5, z: 7.5 }, { editorLocked: true, name: "SENTINEL_PILLAR" }))
  const lamp = add(scene, createLight(ground, "lantern", { x: 25, z: 2 }, { name: "SENTINEL_LAMP_NAME", dmNotes: "SENTINEL_LAMP_NOTES" }))
  const hiddenLamp = add(scene, createLight(ground, "candle", { x: 30, z: 2 }, { hidden: true }))
  const pc = addToken(scene, ground, 12.5, 12.5, { name: "Pip Thistledown", label: "Pip", kind: "pc", dmNotes: "SENTINEL_PC_NOTES" })
  const friend = addToken(scene, ground, 7.5, 17.5, { name: "SENTINEL_FRIEND_NAME", label: "Aldric", kind: "pc", speed: 7777 })
  const npc = addToken(scene, ground, 32.5, 12.5, { name: "SENTINEL_NPC_NAME", label: "Barkeep", kind: "npc", dmNotes: "SENTINEL_NPC_NOTES" })
  const npcLantern = add(scene, createLight(ground, "lantern", { x: 0.6, z: 0 }, { attachedTokenId: npc.id, name: "SENTINEL_NPC_LANTERN" }))
  const monster = addToken(scene, ground, 37.5, 17.5, {
    name: "SENTINEL_MONSTER_NAME",
    label: "Goblin",
    kind: "monster",
    vision: { darkvision: 4321, blindsight: 17, blind: false },
    speed: 1234,
    eyeHeight: 3.21,
  })
  const hiddenTok = addToken(scene, ground, 22.5, 22.5, { name: "SENTINEL_HIDDEN_TOKEN", hidden: true })
  const torch = add(scene, createLight(ground, "torch", { x: 0.6, z: 0 }, { attachedTokenId: hiddenTok.id, name: "SENTINEL_TORCH" }))
  // Room B, behind the east wall.
  const crateB = add(scene, createProp(ground, "crate", { x: 75, y: 0, z: 15 }, { name: "SENTINEL_ROOM_B" }))
  const monsterB = addToken(scene, ground, 77.5, 12.5, { name: "SENTINEL_ROOM_B_MONSTER", label: "SENTINEL_ROOM_B_LABEL" })
  // A level nothing refers to.
  const attic = addLevel(scene, { name: "SENTINEL_ATTIC", elevation: 30 })
  return { scene, ground, secret, locked, hiddenWall, hiddenProp, lockedProp, lockedPillar, lamp, hiddenLamp, pc, friend, npc, npcLantern, monster, hiddenTok, torch, crateB, monsterB, attic, wallE }
}

describe("sentinel leak test", () => {
  const f = sentinelFixture()
  const host = new TestHost(f.scene, ["p1", "p2"])
  host.assign(f.pc.id, "p1")
  host.assign(f.friend.id, "p2")
  const { view } = host.refresh("p1")
  const json = JSON.stringify(view)

  it("sends none of the DM-only strings", () => {
    expect(json).not.toContain("SENTINEL")
    for (const key of ["dmNotes", "editorLocked", "hidden", "attachedTokenId", "preset", "blocksMovement", "meta"]) {
      expect(json).not.toContain(`"${key}"`)
    }
  })

  it("sends none of the hidden / unobserved / secret ids", () => {
    for (const id of [f.secret.id, f.hiddenWall.id, f.hiddenProp.id, f.hiddenLamp.id, f.hiddenTok.id, f.torch.id, f.crateB.id, f.monsterB.id, f.attic.id]) {
      expect(json).not.toContain(id)
    }
  })

  it("round-trips the strict PlayerView schema unchanged", () => {
    expect(playerViewSchema.parse(view)).toEqual(view)
    expect(playerViewSchema.parse(JSON.parse(json))).toEqual(view)
  })

  it("sends the visible, non-secret things in their player form", () => {
    expect(view.objects[f.lockedProp.id]).toMatchObject({ type: "prop", kind: "crate" })
    expect(view.objects[f.lockedPillar.id]).toMatchObject({ type: "pillar" })
    const door = view.objects[f.locked.id] as PlayerDoor
    expect(door.type).toBe("door")
    expect(door.state).toBe("closed")
    const lamp = view.objects[f.lamp.id] as PlayerLight
    expect(lamp).toMatchObject({ type: "light", on: true })
    // The east wall arrives uninterrupted over the secret door (z 13–17): nothing marks where it is.
    const east = Object.values(view.objects).filter((o): o is PlayerWall => o.type === "wall" && o.id.startsWith(`${f.wallE.id}@`))
    const over = east.filter((w) => Math.min(w.a.z, w.b.z) <= 13 && Math.max(w.a.z, w.b.z) >= 17)
    expect(over).toHaveLength(1)
    expect(Object.values(view.objects).some((o) => (o.type === "door" || o.type === "window") && east.some((w) => w.id === o.wallId))).toBe(false)
  })

  it("gives full token details only for controlled tokens; labels for the rest", () => {
    expect(view.controlledTokenIds).toEqual([f.pc.id])
    expect(view.visionTokenIds).toEqual([f.pc.id])
    expect(view.tokens[f.pc.id]).toMatchObject({ name: "Pip Thistledown", label: "Pip", speed: 30, eyeHeight: f.pc.eyeHeight })
    for (const other of [f.npc, f.monster, f.friend]) {
      const t = view.tokens[other.id]
      expect(t).toBeDefined()
      expect(Object.keys(t).sort()).toEqual(["color", "height", "id", "imageUrl", "label", "levelId", "position", "size"])
    }
    expect(json).not.toContain('"speed":1234')
    expect(json).not.toContain("4321")
    expect(json).not.toContain('"speed":7777')
  })

  it("sends a carried light resolved at its visible carrier, never its attachment", () => {
    const l = view.objects[f.npcLantern.id] as PlayerLight
    expect(l).toBeDefined()
    expect(l.levelId).toBe(f.ground)
    expect(l.position.x).toBeCloseTo(f.npc.position.x + 0.6)
    expect(l.position.z).toBeCloseTo(f.npc.position.z)
    expect(l.emitting).toBe(true)
  })

  it("sends only known levels, with names", () => {
    expect(Object.keys(view.scene.levels)).toEqual([f.ground])
    expect(view.scene.levels[f.ground]).toEqual({ id: f.ground, known: true, name: "Ground", elevation: 0, height: 10, floorThickness: 1, terrainResolution: null })
  })

  it("reveals a secret door once it is observed open, and then only as a wooden door", () => {
    const f2 = sentinelFixture()
    const h2 = new TestHost(f2.scene, ["p1", "p2"])
    h2.assign(f2.pc.id, "p1")
    h2.refresh("p1")
    h2.dm({ t: "set-door", doorId: f2.secret.id, state: "open" })
    const opened = h2.refresh("p1").view
    expect(opened.objects[f2.secret.id]).toMatchObject({ type: "door", style: "wood", state: "open" })
    expect(JSON.stringify(opened)).not.toContain("secret")
    expect(h2.state.revealed.p1).toEqual([f2.secret.id])
    // Closed again: still known to p1 (revealed), still "wood".
    h2.dm({ t: "set-door", doorId: f2.secret.id, state: "closed" })
    expect(h2.refresh("p1").view.objects[f2.secret.id]).toMatchObject({ style: "wood", state: "closed" })
    // p2 never saw it open.
    expect(h2.state.revealed.p2 ?? []).toEqual([])
  })
})

describe("The Crooked Lantern", () => {
  const scene = sampleById("crooked-lantern")!.build()
  const byName = (name: string) => Object.values(scene.objects).find((o) => o.name === name)!
  const tokenByName = (name: string) => Object.values(scene.tokens).find((t) => t.name === name)!
  const brunhild = tokenByName("Brunhild Ironvein")
  const bandit = tokenByName("Bandit Lookout")
  const barkeep = tokenByName("Old Moss")
  const host = new TestHost(scene, ["p1"])
  host.assign(brunhild.id, "p1")
  // Step out from behind the round pillar that hides the bar from her starting spot.
  host.dm({ t: "move-token", tokenId: brunhild.id, levelId: brunhild.levelId, x: 72.5, z: 62.5 })
  const { view } = host.refresh("p1")
  const json = JSON.stringify(view)

  it("never leaks the hidden bandit, its torch, the cellar secret door or DM text", () => {
    expect(json).not.toContain(bandit.id)
    expect(json).not.toContain(byName("Bandit's torch").id)
    expect(json).not.toContain(byName("Secret door (loose stones)").id)
    for (const s of ["Old Moss", "Bandit", "barkeep has the key", "Pantry door", "dmNotes", "Contraband"]) expect(json).not.toContain(s)
    expect(playerViewSchema.parse(view)).toEqual(view)
  })

  it("shows the barkeep by label and the common room around Brunhild", () => {
    expect(view.tokens[barkeep.id]).toMatchObject({ label: "Barkeep" })
    expect(view.tokens[barkeep.id].name).toBeUndefined()
    expect(view.tokens[brunhild.id].name).toBe("Brunhild Ironvein")
    const pantry = byName("Pantry door")
    if (view.objects[pantry.id]) expect((view.objects[pantry.id] as PlayerDoor).state).toBe("closed")
    // The hearth is observed from the common room.
    expect(view.objects[byName("Hearth fire").id]).toMatchObject({ type: "light" })
  })

  it("sends a stub for the upper floor referenced by the stairs, a known ground floor", () => {
    const ground = Object.values(scene.levels).find((l) => l.name === "Ground Floor")!
    expect(view.scene.levels[ground.id].known).toBe(true)
    const stairs = byName("Stairs")
    if (view.objects[stairs.id]) {
      const upper = scene.objects[stairs.id].type === "connector" ? (scene.objects[stairs.id] as { toLevelId: Id }).toLevelId : ""
      expect(view.scene.levels[upper]).toBeDefined()
    }
    for (const l of Object.values(view.scene.levels)) {
      if (!l.known) {
        expect(l.name).toBeNull()
        expect(l.terrainResolution).toBeNull()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Clipping
// ---------------------------------------------------------------------------

describe("clipping to explored cells", () => {
  it("a 100 ft wall with one explored cell arrives clipped to that cell", () => {
    const { scene, ground } = flatScene(30, 10)
    const wall = add(scene, createWall(ground, { x: 0, z: 25 }, { x: 100, z: 25 }))
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: [[4, 5]] }, [wall.id]))
    const pieces = Object.values(view.objects).filter((o) => o.type === "wall")
    expect(pieces).toEqual([
      {
        id: `${wall.id}@20,25`,
        type: "wall",
        levelId: ground,
        a: { x: 20, z: 25 },
        b: { x: 25, z: 25 },
        height: 10,
        thickness: 0.5,
        material: "stone",
        followTerrain: true,
      },
    ])
  })

  it("a wall merely touching an explored cell edge is not sent (no dilation)", () => {
    const { scene, ground } = flatScene(30, 10)
    // Strip z ∈ [24.5, 25]: touches row 5 only along its edge.
    const wall = add(scene, createWall(ground, { x: 0, z: 24.75 }, { x: 100, z: 24.75 }))
    const s0 = withPlayer(scene)
    // Observed via row 4 earlier, then only row 5 explored in the view.
    const s1 = updateKnowledge(s0, "p1", synthVis(scene, { [ground]: [[2, 4]] }, [wall.id]))
    const s2: GameState = { ...s1, explored: { p1: {} } }
    const s3 = updateKnowledge(s2, "p1", synthVis(scene, { [ground]: [[4, 5]] }, []))
    expect(s3.memory.p1[wall.id]).toBeDefined()
    const view = filterForPlayer(s3, "p1", synthVis(scene, { [ground]: [[4, 5]] }, []))
    expect(Object.values(view.objects).filter((o) => o.type === "wall")).toEqual([])
  })

  it("clips walls to explored sub-cells", () => {
    const { scene, ground } = flatScene(30, 10)
    const wall = add(scene, createWall(ground, { x: 0, z: 25 }, { x: 100, z: 25 }))
    // Cell (4, 5): only sub-cells sx = 1, 2 of the first sub-row (z ∈ [25, 26.25]).
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: [[4, 5, 0b0110]] }, [wall.id]))
    const pieces = Object.values(view.objects).filter((o): o is PlayerWall => o.type === "wall")
    expect(pieces).toHaveLength(1)
    expect(pieces[0].a).toEqual({ x: 21.25, z: 25 })
    expect(pieces[0].b).toEqual({ x: 23.75, z: 25 })
    expect(pieces[0].id).toBe(`${wall.id}@21.25,25`)
  })

  it("a diagonal wall is cut to the explored cells it crosses", () => {
    const { scene, ground } = flatScene(20, 20)
    const wall = add(scene, createWall(ground, { x: 0, z: 0 }, { x: 50, z: 50 }, { thickness: 0.2 }))
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: [[3, 3], [4, 4]] }, [wall.id]))
    const pieces = Object.values(view.objects).filter((o): o is PlayerWall => o.type === "wall")
    expect(pieces).toHaveLength(1)
    // Along the diagonal from ~(15, 15) to ~(25, 25), slightly widened by the strip's cross-section.
    // From the corner of (3, 3) to the far corner of (4, 4) (the cells touch at (20, 20), so one run).
    expect(pieces[0].a.x).toBeCloseTo(15, 6)
    expect(pieces[0].a.z).toBeCloseTo(15, 6)
    expect(pieces[0].b.x).toBeCloseTo(25, 6)
    expect(pieces[0].b.z).toBeCloseTo(25, 6)
  })

  it("a level-wide floor arrives over the explored cells and a one-cell ring (rows merged)", () => {
    const { scene, ground } = flatScene(20, 20)
    const floorId = Object.keys(scene.objects)[0]
    const cells: [number, number][] = []
    for (const j of [2, 3]) for (const i of [1, 2, 3, 4]) cells.push([i, j])
    cells.push([7, 5])
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: cells }, [floorId]))
    const floors = Object.values(view.objects).filter((o) => o.type === "floor")
    // The ground extent: explored cells and the (floored) cells next to them — cols 0–5 × rows 1–4 and
    // cols 6–8 × rows 4–6 — merged row by row.
    expect(floors).toEqual([
      { id: `${floorId}@0,5`, type: "floor", levelId: ground, rect: { x: 0, z: 5, w: 30, d: 15 }, material: "grass" },
      { id: `${floorId}@0,20`, type: "floor", levelId: ground, rect: { x: 0, z: 20, w: 45, d: 5 }, material: "grass" },
      { id: `${floorId}@30,25`, type: "floor", levelId: ground, rect: { x: 30, z: 25, w: 15, d: 10 }, material: "grass" },
    ])
  })

  it("floor pieces are clipped at cell granularity and to the floor's own rect", () => {
    const { scene, ground } = flatScene(20, 20, "bright")
    const floorId = Object.keys(scene.objects)[0]
    const small = add(scene, createFloor(ground, { x: 11, z: 11, w: 12, d: 2 }, "wood"))
    // Full cell (2, 2) and, to its right, cell (3, 2) with only its left half explored: the partial
    // cell counts as explored for floors (the explored mask still hides its other half).
    const half = 0b0011_0011_0011_0011
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: [[2, 2], [3, 2, half]] }, [floorId, small.id]))
    // With the ring of cells next to them (the half cell's own ring stops inside it: cell (4, 2) is not
    // touched), cols 1–3 × rows 1–3.
    expect(view.objects[`${floorId}@5,5`]).toEqual({ id: `${floorId}@5,5`, type: "floor", levelId: ground, rect: { x: 5, z: 5, w: 15, d: 15 }, material: "grass" })
    expect(view.objects[`${small.id}@11,11`]).toEqual({ id: `${small.id}@11,11`, type: "floor", levelId: ground, rect: { x: 11, z: 11, w: 9, d: 2 }, material: "wood" })
    expect(Object.values(view.objects).filter((o) => o.type === "floor")).toHaveLength(2)
  })

  it("merges explored runs into few rects", () => {
    const { scene, ground } = flatScene(20, 20)
    const floorId = Object.keys(scene.objects)[0]
    // An L shape: rows 0–3 cols 0–5, rows 4–5 cols 0–1.
    const cells: [number, number][] = []
    for (let j = 0; j < 4; j++) for (let i = 0; i < 6; i++) cells.push([i, j])
    for (let j = 4; j < 6; j++) for (let i = 0; i < 2; i++) cells.push([i, j])
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: cells }, [floorId]))
    const rects = Object.values(view.objects).flatMap((o) => (o.type === "floor" ? [o.rect] : []))
    // With the one-cell ring: rows 0–4 cols 0–6, rows 5–6 cols 0–2.
    expect(rects).toEqual([
      { x: 0, z: 0, w: 35, d: 25 },
      { x: 0, z: 25, w: 15, d: 10 },
    ])
  })

  it("a prop one cell across a wall from an explored room is not sent", () => {
    const { scene, ground } = flatScene(20, 10)
    // Room x 0–25 (cells i 0–4); wall on x = 25; the crate sits in cell (5, 2) just beyond it.
    add(scene, createWall(ground, { x: 25, z: 0 }, { x: 25, z: 50 }))
    const crate = add(scene, createProp(ground, "crate", { x: 27.5, y: 0, z: 12.5 }))
    const pc = addToken(scene, ground, 12.5, 12.5)
    const host = new TestHost(scene, ["p1"])
    host.assign(pc.id)
    const { view, vis } = host.refresh("p1")
    expect(vis.observedObjectIds.has(crate.id)).toBe(false)
    expect(view.objects[crate.id]).toBeUndefined()
    // Even if it were remembered, it lies in no explored cell: still not sent.
    const forced: GameState = { ...host.state, memory: { p1: { ...host.state.memory.p1, [crate.id]: { id: crate.id, type: "prop", levelId: ground, kind: "crate", position: { x: 27.5, y: 0, z: 12.5 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 }, color: null, blocksSight: true, castsShadows: true } } } }
    expect(filterForPlayer(forced, "p1", vis).objects[crate.id]).toBeUndefined()
    // …while one that is inside the room is.
    const inside = { ...forced.memory.p1[crate.id], position: { x: 17.5, y: 0, z: 12.5 } }
    const forced2: GameState = { ...forced, memory: { p1: { ...forced.memory.p1, [crate.id]: inside } } }
    expect(filterForPlayer(forced2, "p1", vis).objects[crate.id]).toBeDefined()
  })

  it("an opening lands on the right piece with a rebased offset", () => {
    const { scene, ground } = flatScene(30, 10)
    const wall = add(scene, createWall(ground, { x: 0, z: 25 }, { x: 100, z: 25 }))
    const door = add(scene, createDoor(wall, 52, { state: "open" }))
    const win = add(scene, createWindow(wall, 12.5))
    const vis = synthVis(scene, { [ground]: [[2, 5], [10, 5]] }, [wall.id, door.id, win.id])
    const { view } = know(withPlayer(scene), vis)
    const pieces = Object.values(view.objects).filter((o): o is PlayerWall => o.type === "wall")
    expect(pieces.map((p) => p.id).sort()).toEqual([`${wall.id}@10,25`, `${wall.id}@50,25`].sort())
    const d = view.objects[door.id] as PlayerDoor
    expect(d.wallId).toBe(`${wall.id}@50,25`)
    expect(d.offset).toBe(2)
    const w = view.objects[win.id] as PlayerWindow
    expect(w.wallId).toBe(`${wall.id}@10,25`)
    expect(w.offset).toBe(2.5)
  })

  it("widens a wall piece to contain a sent opening that sticks out of the explored cells", () => {
    const { scene, ground } = flatScene(30, 10)
    const wall = add(scene, createWall(ground, { x: 0, z: 25 }, { x: 100, z: 25 }))
    const door = add(scene, createDoor(wall, 49, { state: "closed" }))
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: [[10, 5]] }, [wall.id, door.id]))
    const pieces = Object.values(view.objects).filter((o): o is PlayerWall => o.type === "wall")
    expect(pieces).toHaveLength(1)
    expect(pieces[0]).toMatchObject({ id: `${wall.id}@47,25`, a: { x: 47, z: 25 }, b: { x: 55, z: 25 } })
    expect(view.objects[door.id]).toMatchObject({ wallId: `${wall.id}@47,25`, offset: 2 })
  })

  it("does not send an opening whose remembered host wall is unknown or outside explored cells", () => {
    const { scene, ground } = flatScene(30, 10)
    const wall = add(scene, createWall(ground, { x: 0, z: 25 }, { x: 100, z: 25 }))
    const door = add(scene, createDoor(wall, 72.5))
    // The door is remembered, but only cell (2, 5) is explored.
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: [[2, 5]] }, [wall.id, door.id]))
    expect(view.objects[door.id]).toBeUndefined()
  })

  it("connectors, pillars and props are whole or nothing", () => {
    const { scene, ground } = flatScene(20, 10)
    const upper = addLevel(scene, { name: "Upper", elevation: 10 }, { x: 50, z: 0, w: 50, d: 50 })
    const stairs = add(scene, createConnector(ground, upper.id, { x: 20, z: 10, w: 30, d: 10 }, 1, "stairs"))
    const pillar = add(scene, createPillar(ground, { x: 5, z: 40 }, { size: 3 }))
    const vis = synthVis(scene, { [ground]: [[4, 2], [1, 8]] }, [stairs.id, pillar.id])
    const { view } = know(withPlayer(scene), vis)
    expect(view.objects[stairs.id]).toMatchObject({ rect: { x: 20, z: 10, w: 30, d: 10 }, toLevelId: upper.id })
    expect(view.objects[pillar.id]).toMatchObject({ position: { x: 5, z: 40 }, size: 3 })
  })
})

// ---------------------------------------------------------------------------
// Levels, terrain, masks, flags
// ---------------------------------------------------------------------------

describe("wall pieces on terrain", () => {
  /** Bumpy slope (world Y at elevation 0): sampled at resolution 2, so follow-terrain walls get strips. */
  const bumps = (x: number, z: number) => 0.3 * x + 0.15 * z + 1.5 * Math.sin(x / 3) * Math.cos(z / 4)

  function withTerrain(scene: Scene, levelId: Id, h: (x: number, z: number) => number = bumps): void {
    const hm = createHeightmap(2)
    const { samplesX, samplesZ } = sampleCounts(scene.grid, 2)
    const s = scene.grid.cellSize / 2
    const dense = new Float32Array(samplesX * samplesZ)
    for (let j = 0; j < samplesZ; j++) for (let i = 0; i < samplesX; i++) dense[j * samplesX + i] = h(i * s, j * s)
    scene.levels[levelId] = { ...scene.levels[levelId], heightmap: writeHeights(hm, scene.grid, dense) }
  }

  /**
   * 8 × 4 cells. W (follow) along z = 10 with a closed door and a window; D (follow) diagonal; OFF (follow off,
   * 3 ft: buried where the slope rises above it) along z = 5; EDGE (follow) runs past the east edge.
   */
  function slope(flat = false) {
    const { scene, ground } = flatScene(8, 4)
    if (!flat) withTerrain(scene, ground)
    const wall = add(scene, createWall(ground, { x: 0, z: 10 }, { x: 40, z: 10 }, { height: 10 }))
    const door = add(scene, createDoor(wall, 6, { state: "closed", height: 7 }))
    const win = add(scene, createWindow(wall, 12.5, { sillHeight: 3, height: 4 }))
    const diag = add(scene, createWall(ground, { x: 2.5, z: 2.5 }, { x: 37.5, z: 18.5 }, { height: 8 }))
    const off = add(scene, createWall(ground, { x: 0, z: 5 }, { x: 40, z: 5 }, { height: 3, followTerrain: false }))
    const edge = add(scene, createWall(ground, { x: 30, z: 15 }, { x: 60, z: 15 }, { height: 20 }))
    return { scene, ground, wall, door, win, diag, off, edge, ids: [wall.id, door.id, win.id, diag.id, off.id, edge.id] }
  }

  /** Explored columns [i0, i1) on every row; `partial`: the first column only on sub-cells 0b0110 of each sub-row. */
  const columns = (i0: number, i1: number, partial = false): [number, number, number?][] => {
    const out: [number, number, number?][] = []
    for (let j = 0; j < 4; j++) for (let i = i0; i < i1; i++) out.push(partial && i === i0 ? [i, j, 0b0110_0110_0110_0110] : [i, j])
    return out
  }

  /** A wall's base line as a client (or the host) computes it: core/scene/wallProfile on the scene's own terrain. */
  function profileIn(sc: SceneLike, wall: WallObject): WallProfile {
    const level = sc.levels[wall.levelId]
    const ground = level.heightmap ? new TerrainSampler(level, sc.grid) : null
    return wallProfile(wall, ground, level.elevation, { a: 0, b: 0 })
  }

  /** Player pieces of the view with their host wall, the client's scene wall and the piece's offset along the host wall. */
  function piecesOf(scene: Scene, view: PlayerView) {
    const client = viewToScene(view)
    return Object.values(view.objects)
      .filter((o): o is PlayerWall => o.type === "wall")
      .map((piece) => {
        const host = scene.objects[piece.id.split("@")[0]] as WallObject
        const cw = client.objects[piece.id] as WallObject
        return { piece, host, cw, client, t0: Math.hypot(piece.a.x - host.a.x, piece.a.z - host.a.z), len: wallLength(piece) }
      })
  }

  const kindOf = (p: OccluderPrimitive) => (p.sourceType === "door" ? "door" : p.key.includes("#lintel:") ? "lintel" : p.key.includes("#sill:") ? "sill" : "full")

  for (const [i0, i1, partial] of [
    [0, 3, false],
    [0, 4, false],
    [0, 5, true],
    [5, 8, false],
    [4, 8, true],
    [3, 8, false],
    [1, 2, false],
    [2, 6, true],
  ] as const) {
    it(`client tops and opening heights are the host's (columns ${i0}–${i1 - 1} explored${partial ? ", first one partly" : ""})`, () => {
      const f = slope()
      const { view } = know(withPlayer(f.scene), synthVis(f.scene, { [f.ground]: columns(i0, i1, partial) }, f.ids))
      expect(playerViewSchema.parse(view)).toEqual(view)
      const r = prng(i0 * 16 + i1)
      const pieces = piecesOf(f.scene, view)
      expect(pieces.length).toBeGreaterThan(0)
      const profiles = new Map<Id, WallProfile>()
      for (const { piece, host, cw, client, t0, len } of pieces) {
        expect(piece.followTerrain).toBe(host.followTerrain)
        // Follow-terrain pieces carry the host's base line; the others stand on the elevation.
        expect(piece.terrainProfile !== undefined).toBe(host.followTerrain)
        const hp = profileIn(f.scene, host)
        const cp = profileIn(client, cw)
        profiles.set(piece.id, cp)
        expect(cp.follow).toBe(host.followTerrain)
        for (let k = 0; k <= 24; k++) {
          const u = k === 0 ? 0 : k === 24 ? len : r() * len
          expect(cp.topAt(u), `${piece.id} at ${u}`).toBeCloseTo(hp.topAt(t0 + u), 9)
        }
        if (!host.followTerrain) for (const b of cp.base) expect(b).toBe(0)
      }
      // Door heads and window sills / heads (world Y) as on the host.
      let openings = 0
      for (const o of Object.values(view.objects)) {
        if (o.type !== "door" && o.type !== "window") continue
        const { piece, host, cw, client, t0 } = pieces.find((p) => p.piece.id === o.wallId)!
        const hostOpening = f.scene.objects[o.id] as DoorObject | WindowObject
        const hf = openingFrame(profileIn(f.scene, host), host, hostOpening)!
        const cf = openingFrame(profiles.get(piece.id)!, cw, client.objects[o.id] as DoorObject | WindowObject)!
        expect(cf.u0 + t0).toBeCloseTo(hf.u0, 9)
        expect(cf.u1 + t0).toBeCloseTo(hf.u1, 9)
        expect(cf.base, o.id).toBeCloseTo(hf.base, 9)
        expect(cf.head, o.id).toBeCloseTo(hf.head, 9)
        expect(cf.sillTop, o.id).toBeCloseTo(hf.sillTop, 9)
        expect(cf.hasSill).toBe(hf.hasSill)
        openings++
      }
      if (i0 <= 1) expect(openings).toBeGreaterThan(0)

      // End to end through the occluders both sides build: the tops of the player's wall pieces, lintels
      // and closed doors at points along them are the host's.
      const client = viewToScene(view)
      const hostPrims = buildOcclusionWorld(f.scene).primitives
      const playerPrims = buildOcclusionWorld(client).primitives.filter((p) => p.sourceType === "wall" || p.sourceType === "door")
      expect(playerPrims.length).toBeGreaterThan(0)
      for (const p of playerPrims) {
        const kind = kindOf(p)
        if (kind === "sill") continue
        if (p.shape !== "box" && p.shape !== "strip") throw new Error(`unexpected ${p.shape}`)
        const hostId = p.sourceId.split("@")[0]
        const cw = client.objects[p.sourceType === "door" ? (view.objects[p.sourceId] as PlayerDoor).wallId : p.sourceId] as WallObject
        const len = wallLength(cw)
        const dir = { x: (cw.b.x - cw.a.x) / len, z: (cw.b.z - cw.a.z) / len }
        const hx = p.halfExtents.x
        for (const s of [-0.9, -0.45, 0, 0.3, 0.85]) {
          const x = p.center.x + dir.x * hx * s
          const z = p.center.z + dir.z * hx * s
          const top = primitiveTopAt(p, x, z)
          expect(top, p.key).not.toBeNull()
          const hostTops = hostPrims
            .filter((h) => h.sourceId === hostId && kindOf(h) === kind)
            .map((h) => primitiveTopAt(h, x, z))
            .filter((t) => t !== null)
          expect(
            hostTops.some((t) => Math.abs(t - top!) < 1e-6),
            `${p.key} at (${x}, ${z}): ${top} vs ${hostTops}`
          ).toBe(true)
        }
      }
    })
  }

  it("a follow-off wall buried by the terrain is still sent, and stays buried on the client", () => {
    const f = slope()
    // Columns 4–7 (x 20–40): the ground along OFF (z = 5) is 6–13 ft, above its 3 ft top.
    const { view } = know(withPlayer(f.scene), synthVis(f.scene, { [f.ground]: columns(4, 8) }, f.ids))
    const pieces = piecesOf(f.scene, view).filter((p) => p.host.id === f.off.id)
    expect(pieces).toHaveLength(1)
    const { piece, cw, client, len } = pieces[0]
    expect(piece).toMatchObject({ a: { x: 20, z: 5 }, b: { x: 40, z: 5 }, height: 3, followTerrain: false })
    expect(piece.terrainProfile).toBeUndefined()
    const cp = profileIn(client, cw)
    for (let u = 0; u <= len; u += 2.5) {
      expect(cp.topAt(u)).toBe(3)
      expect(levelGround(client, f.ground, 20 + u, 5)).toBeGreaterThan(3)
    }
    // Its occluder is the host's (a box from just below the elevation to 3 ft).
    const [box, ...more] = buildOcclusionWorld(client).primitives.filter((p) => p.sourceId === piece.id)
    expect(more).toEqual([])
    expect(box.shape).toBe("box")
    expect(primitiveBounds(box).minY).toBeCloseTo(-0.05, 9)
    expect(primitiveBounds(box).maxY).toBeCloseTo(3, 9)
  })

  it("a follow wall crossing unexplored cells keeps the host's tops; the terrain there stays clipped", () => {
    const { scene, ground } = flatScene(8, 4)
    withTerrain(scene, ground)
    // The centreline z = 9.5 lies in row 1 (unexplored, and beyond the one-cell ring of row 3); the 12 ft
    // thick strip reaches row 3 (explored), so the ground under the piece depends on samples z = 7.5 the
    // client never receives.
    const wall = add(scene, createWall(ground, { x: 0, z: 9.5 }, { x: 40, z: 9.5 }, { height: 8, thickness: 12 }))
    const cells: [number, number][] = [2, 3, 4, 5].map((i) => [i, 3])
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: cells }, [wall.id]))
    const [p] = piecesOf(scene, view)
    expect(piecesOf(scene, view)).toHaveLength(1)
    expect(p.piece).toMatchObject({ a: { x: 10, z: 9.5 }, b: { x: 30, z: 9.5 }, followTerrain: true })

    // The terrain sent is exactly what the ground extent allows: no sample of row z = 7.5 (sz = 3).
    const without: Scene = { ...scene, objects: Object.fromEntries(Object.entries(scene.objects).filter(([id]) => id !== wall.id)) }
    expect(know(withPlayer(without), synthVis(without, { [ground]: cells })).view.terrain).toEqual(view.terrain)
    const chunk = decodeChunk(view.terrain[ground]["0,0"], 2)
    for (let sx = 0; sx < 16; sx++) expect(chunk[3 * 16 + sx]).toBe(0)
    expect(bumps(15, 7.5)).not.toBe(0)

    // The profile is the host's ground at the piece's own base knots (its centreline), nothing else.
    const knots = wallBaseKnots(p.piece, 2.5)
    expect(p.piece.terrainProfile).toHaveLength(knots.length)
    knots.forEach((u, k) => expect(p.piece.terrainProfile![k]).toBeCloseTo(levelGround(scene, ground, 10 + u, 9.5), 9))

    // With it the client's tops are the host's; its own clipped ground would put them elsewhere.
    const hp = profileIn(scene, p.host)
    const cp = profileIn(p.client, p.cw)
    const bare = profileIn(p.client, { ...p.cw, terrainProfile: undefined })
    let worst = 0
    for (let u = 0; u <= p.len; u += 0.25) {
      expect(cp.topAt(u)).toBeCloseTo(hp.topAt(p.t0 + u), 9)
      worst = Math.max(worst, Math.abs(bare.topAt(u) - hp.topAt(p.t0 + u)))
    }
    expect(worst).toBeGreaterThan(0.5)
  })

  it("flat levels: pieces follow the level elevation, without a profile, and openings keep their heights", () => {
    const f = slope(true)
    const { view } = know(withPlayer(f.scene), synthVis(f.scene, { [f.ground]: columns(0, 3) }, f.ids))
    const walls = Object.values(view.objects).filter((o): o is PlayerWall => o.type === "wall")
    expect(walls.length).toBeGreaterThan(0)
    for (const w of walls) {
      const host = f.scene.objects[w.id.split("@")[0]] as WallObject
      expect(w.height).toBe(host.height)
      expect(w.followTerrain).toBe(host.followTerrain)
      expect(w).not.toHaveProperty("terrainProfile")
    }
    expect((view.objects[f.door.id] as PlayerDoor).height).toBe(7)
    const win = view.objects[f.win.id] as PlayerWindow
    expect([win.sillHeight, win.height]).toEqual([3, 4])
  })

  it("terrain edits change the profiles; unchanged terrain gives the same arrays (no patch)", () => {
    const f = slope()
    const vis = synthVis(f.scene, { [f.ground]: columns(0, 8) }, f.ids)
    const first = know(withPlayer(f.scene), vis)
    const again = filterForPlayer(first.state, "p1", vis)
    expect(diffViews(first.view, again)).toEqual([])
    const piece = Object.values(first.view.objects).find((o): o is PlayerWall => o.type === "wall" && o.id.startsWith(`${f.wall.id}@`))!
    expect((again.objects[piece.id] as PlayerWall).terrainProfile).toBe(piece.terrainProfile)
    // Raise the terrain by 2 ft: the pieces are re-sent 2 ft higher.
    const raised: Scene = { ...f.scene, levels: { ...f.scene.levels } }
    withTerrain(raised, f.ground, (x, z) => bumps(x, z) + 2)
    const moved = filterForPlayer({ ...first.state, scene: raised }, "p1", vis)
    const next = moved.objects[piece.id] as PlayerWall
    next.terrainProfile!.forEach((v, k) => expect(v).toBeCloseTo(piece.terrainProfile![k] + 2, 5))
    expect(diffViews(first.view, moved).some((op) => op.path.join("/") === `objects/${piece.id}`)).toBe(true)
  })
})

describe("levels", () => {
  it("sends a stub for the unexplored level at the other end of a seen connector", () => {
    // Dark everywhere; the PC sees by darkvision. The cellar below the ladder hole is out of sight.
    const { scene, ground } = flatScene(20, 10, "dark")
    const cellar = addLevel(scene, { name: "Secret Cellar", elevation: -10 }, { x: 70, z: 0, w: 30, d: 50 })
    const ladder = add(scene, createConnector(cellar.id, ground, { x: 25, z: 10, w: 5, d: 5 }, 0, "ladder"))
    const pc = addToken(scene, ground, 7.5, 12.5, { vision: { darkvision: 60, blindsight: 0, blind: false } })
    const host = new TestHost(scene, ["p1"])
    host.assign(pc.id)
    const { view, vis } = host.refresh("p1")
    expect(vis.perception[cellar.id]).toBeUndefined()
    expect(view.objects[ladder.id]).toMatchObject({ levelId: cellar.id, toLevelId: ground })
    expect(view.scene.levels[ground].known).toBe(true)
    expect(view.scene.levels[cellar.id]).toEqual({ id: cellar.id, known: false, name: null, elevation: -10, height: 10, floorThickness: 1, terrainResolution: null })
    expect(view.masks[cellar.id]).toBeUndefined()
    expect(view.terrain[cellar.id]).toBeUndefined()
    expect(JSON.stringify(view)).not.toContain("Secret Cellar")
  })

  it("sends a stub for the level of an own token with nothing explored there", () => {
    const { scene, ground } = flatScene(10, 10)
    const tower = addLevel(scene, { name: "Tower", elevation: 40 })
    const scout = addToken(scene, tower.id, 12.5, 12.5)
    let s = withPlayer(scene)
    s = reduceDm(s, { t: "assign-token", tokenId: scout.id, userId: "p1", assigned: true }).state
    const { view } = know(s, synthVis(scene, { [ground]: [[0, 0]] }))
    expect(view.tokens[scout.id]).toBeDefined()
    expect(view.scene.levels[tower.id]).toEqual({ id: tower.id, known: false, name: null, elevation: 40, height: 10, floorThickness: 1, terrainResolution: null })
  })

  it("omits levels nothing refers to", () => {
    const { scene, ground } = flatScene(10, 10)
    const attic = addLevel(scene, { name: "Attic", elevation: 20 })
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: [[0, 0]] }))
    expect(view.scene.levels[attic.id]).toBeUndefined()
  })
})

describe("terrain", () => {
  function terrainScene() {
    const { scene, ground } = flatScene(20, 20)
    const hm = createHeightmap(2)
    const { samplesX, samplesZ } = sampleCounts(scene.grid, 2)
    const dense = new Float32Array(samplesX * samplesZ).fill(3)
    scene.levels[ground] = { ...scene.levels[ground], heightmap: writeHeights(hm, scene.grid, dense) }
    return { scene, ground }
  }

  it("sends only chunks overlapping the ground extent, with samples touching none of its cells zeroed", () => {
    const { scene, ground } = terrainScene()
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: [[3, 3]] }))
    expect(view.scene.levels[ground].terrainResolution).toBe(2)
    expect(Object.keys(view.terrain[ground])).toEqual(["0,0"])
    const samples = decodeChunk(view.terrain[ground]["0,0"], 2)
    const n = 16
    for (let sz = 0; sz < n; sz++) {
      for (let sx = 0; sx < n; sx++) {
        // Cell (3, 3) and its ring (2..4, 2..4) span samples 4..10 (inclusive) on both axes at resolution 2.
        const inside = sx >= 4 && sx <= 10 && sz >= 4 && sz <= 10
        expect(samples[sz * n + sx]).toBe(inside ? 3 : 0)
      }
    }
  })

  it("includes the neighbouring chunk when the extent touches its first sample column", () => {
    const { scene, ground } = terrainScene()
    // Cell (6, 3): its ring reaches column 7, whose last samples are the first column of chunk (1, 0).
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: [[6, 3]] }))
    expect(Object.keys(view.terrain[ground]).sort()).toEqual(["0,0", "1,0"])
    const right = decodeChunk(view.terrain[ground]["1,0"], 2)
    for (let sz = 0; sz < 16; sz++) {
      for (let sx = 0; sx < 16; sx++) expect(right[sz * 16 + sx]).toBe(sx === 0 && sz >= 4 && sz <= 10 ? 3 : 0)
    }
  })

  it("never sends terrain shapes or the painted base (terrainEdits), only the baked terrain", () => {
    const { scene, ground } = flatScene(8, 8)
    const hill = { ...blockShape("SENTINELhill", { x: 10, z: 10, w: 10, d: 10 }, 0, 4, 0), name: "SENTINEL_SHAPE_NAME" }
    const pit = cylinderShape("SENTINELpit", { x: 30, z: 30 }, 4, 12, 0, -2, 1)
    scene.levels[ground] = produce(scene.levels[ground], (d) => {
      expect(writeTerrain(d, scene.grid, { upsert: [hill, pit] })).toBe(true)
    })
    expect(Object.keys(scene.levels[ground].terrainEdits!.baseChunks).length).toBeGreaterThan(0)
    const wall = add(scene, createWall(ground, { x: 5, z: 15 }, { x: 35, z: 15 }))
    const cells: [number, number][] = []
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) cells.push([i, j])
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: cells }, [wall.id]))
    const json = JSON.stringify(view)
    for (const s of ["terrainEdits", "baseChunks", "shapes", "SENTINEL"]) expect(json).not.toContain(s)
    expect(playerViewSchema.parse(view)).toEqual(view)
    // The baked terrain arrives (the block's top, the pit's floor), and the wall stands on it.
    const client = viewToScene(view)
    expect(levelGround(client, ground, 15, 12.5)).toBeCloseTo(4, 6)
    expect(levelGround(client, ground, 30, 30)).toBeCloseTo(-2, 6)
    const piece = Object.values(view.objects).find((o): o is PlayerWall => o.type === "wall")!
    expect(piece.terrainProfile).toContain(4)
  })

  it("sends no terrain for unexplored levels", () => {
    const { scene, ground } = terrainScene()
    const other = addLevel(scene, { name: "Other", elevation: 20 })
    const { view } = know(withPlayer(scene), synthVis(scene, { [ground]: [[3, 3]] }))
    expect(view.terrain[other.id]).toBeUndefined()
  })
})

describe("masks and flags", () => {
  it("encodes current perception, persistent explored and sunlit ∧ perceived per known level", () => {
    const { scene, ground } = flatScene(10, 10)
    const s0 = withPlayer(scene)
    const first = know(s0, synthVis(scene, { [ground]: [[1, 1], [2, 1]] }))
    const sunlit = { width: 10, depth: 10, bits: new Uint8Array(13), partial: new Map<number, number>() }
    sunlit.bits[0] = 0xff // cells 0..7 of row 0: none perceived now
    sunlit.bits[1] = 0b0000_1100 // cells 10, 11 → (0,1), (1,1)
    const second = know(first.state, synthVis(scene, { [ground]: [[1, 1], [5, 5]] }, [], { sunlit: { [ground]: sunlit } }))
    const m = second.view.masks[ground]
    const perception = decodeGrades(m.perception)
    expect(perception.grades[11]).toBe(3)
    expect(perception.grades[12]).toBe(0)
    const explored = decodeMask(m.explored)
    expect([11, 12, 55].map((c) => (explored.bits[c >> 3] >> (c & 7)) & 1)).toEqual([1, 1, 1])
    const sun = decodeMask(m.sunlit)
    // Only the perceived sunlit cell (1, 1) survives.
    const setCells: number[] = []
    for (let c = 0; c < 100; c++) if ((sun.bits[c >> 3] >> (c & 7)) & 1) setCells.push(c)
    expect(setCells).toEqual([11])
  })

  it("reports the effective movement lock and session flags", () => {
    const { scene } = flatScene(4, 4)
    let s = withPlayer(scene)
    s = reduceDm(s, { t: "set-movement-locked", locked: true, userId: "p1" }).state
    s = reduceDm(s, { t: "set-enforce-speed", enabled: true }).state
    const view = filterForPlayer(s, "p1", synthVis(scene, {}))
    expect(view.flags).toEqual({ movementLocked: true, sharedVision: false, enforceSpeed: true })
    s = reduceDm(s, { t: "set-free-movement", enabled: true }).state
    expect(filterForPlayer(s, "p1", synthVis(scene, {})).flags.freeMovement).toBe(true)
  })

  it("never sends hidden objects even if a player remembers them", () => {
    const { scene, ground } = flatScene(20, 10)
    const crate = add(scene, createProp(ground, "crate", { x: 12.5, y: 0, z: 12.5 }))
    const first = know(withPlayer(scene), synthVis(scene, { [ground]: [[2, 2]] }, [crate.id]))
    expect(first.view.objects[crate.id]).toBeDefined()
    const hidden = reduceDm(first.state, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["objects", crate.id, "hidden"], value: true }] }).state
    // Out of sight now (nothing perceived), but still never sent.
    expect(filterForPlayer(hidden, "p1", synthVis(scene, {})).objects[crate.id]).toBeUndefined()
  })
})

describe("static lights", () => {
  it("are fixtures from memory, emitting only while illuminating something perceived", () => {
    const { scene, ground } = flatScene(20, 10, "dark")
    const torch = add(scene, createLight(ground, "torch", { x: 12.5, z: 12.5 }, { name: "Wall torch" }))
    const s = know(withPlayer(scene), synthVis(scene, { [ground]: [[2, 2]] }, [torch.id], { illuminatingLightIds: new Set([torch.id]) }))
    expect(s.view.objects[torch.id]).toMatchObject({ type: "light", emitting: true, on: true, position: { x: 12.5, y: 5, z: 12.5 } })
    const later = filterForPlayer(s.state, "p1", synthVis(scene, {}))
    expect(later.objects[torch.id]).toMatchObject({ emitting: false })
    expect(later.objects[torch.id]).not.toHaveProperty("name")
  })

  it("a remembered fixture picked up by a hidden token disappears; picked up by a visible one it follows it", () => {
    const { scene, ground } = flatScene(20, 10, "dark")
    const torch = add(scene, createLight(ground, "torch", { x: 12.5, z: 12.5 }))
    const thief = addToken(scene, ground, 80, 20, { hidden: true })
    const s = know(withPlayer(scene), synthVis(scene, { [ground]: [[2, 2]] }, [torch.id]))
    expect(s.view.objects[torch.id]).toBeDefined()
    const taken = reduceDm(s.state, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["objects", torch.id, "attachedTokenId"], value: thief.id }] }).state
    expect(filterForPlayer(taken, "p1", synthVis(scene, {})).objects[torch.id]).toBeUndefined()
    // Out of sight and carried by a visible token: the remembered fixture stays, no longer emitting.
    const shown = reduceDm(taken, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["tokens", thief.id, "hidden"], value: false }] }).state
    expect(filterForPlayer(shown, "p1", synthVis(scene, {}, [], { illuminatingLightIds: new Set([torch.id]) })).objects[torch.id]).toMatchObject({ emitting: false, position: { x: 12.5 } })
    // With the carrier in view, the light is sent resolved at the carrier instead.
    const seen = filterForPlayer(shown, "p1", synthVis(scene, {}, [], { visibleTokenIds: new Set([thief.id]) }))
    expect(seen.objects[torch.id]).toMatchObject({ position: { x: 80 + 12.5, z: 20 + 12.5 }, emitting: true })
  })

  it("carried lights disappear with their carrier and never enter memory", () => {
    const { scene, ground } = flatScene(20, 10)
    const npc = addToken(scene, ground, 32.5, 12.5, { kind: "npc" })
    const lantern = add(scene, createLight(ground, "lantern", { x: 0, z: 0 }, { attachedTokenId: npc.id }))
    const pc = addToken(scene, ground, 12.5, 12.5)
    const host = new TestHost(scene, ["p1"])
    host.assign(pc.id)
    expect(host.refresh("p1").view.objects[lantern.id]).toBeDefined()
    expect(host.state.memory.p1[lantern.id]).toBeUndefined()
    host.dm({ t: "apply-scene-patches", patches: [{ op: "replace", path: ["tokens", npc.id, "hidden"], value: true }] })
    const { view } = host.refresh("p1")
    expect(view.tokens[npc.id]).toBeUndefined()
    expect(view.objects[lantern.id]).toBeUndefined()
  })
})

describe("invariants on The Crooked Lantern (every PC)", () => {
  const scene = sampleById("crooked-lantern")!.build()
  const pcs = Object.values(scene.tokens).filter((t) => t.kind === "pc")
  const host = new TestHost(scene, pcs.map((_, k) => `p${k}`))
  pcs.forEach((t, k) => host.assign(t.id, `p${k}`))

  it.each(pcs.map((t, k) => [t.name, `p${k}`]))("%s: every piece of data is justified by explored cells or visibility", (_name, uid) => {
    const { view, vis } = host.refresh(uid)
    expect(playerViewSchema.parse(view)).toEqual(view)
    // Floors and terrain reach over the art extent: explored cells and those one sub-cell beyond.
    const explored = (levelId: Id) => (view.masks[levelId] ? artExtent(decodeMask(view.masks[levelId].explored)) : null)
    const touched = (m: ReturnType<typeof explored>, i: number, j: number) =>
      !!m && i >= 0 && j >= 0 && i < m.width && j < m.depth && (((m.bits[(j * m.width + i) >> 3] >> ((j * m.width + i) & 7)) & 1) === 1 || m.partial.has(j * m.width + i))
    // Floor pieces cover the extent only.
    for (const o of Object.values(view.objects)) {
      if (o.type !== "floor") continue
      const m = explored(o.levelId)
      for (let j = Math.floor(o.rect.z / 5); j < Math.ceil((o.rect.z + o.rect.d) / 5); j++) {
        for (let i = Math.floor(o.rect.x / 5); i < Math.ceil((o.rect.x + o.rect.w) / 5); i++) expect(touched(m, i, j)).toBe(true)
      }
    }
    // Non-zero terrain samples touch a cell of the extent.
    for (const [levelId, chunks] of Object.entries(view.terrain)) {
      const res = view.scene.levels[levelId].terrainResolution!
      const m = explored(levelId)
      for (const [key, b64] of Object.entries(chunks)) {
        const [ci, cj] = key.split(",").map(Number)
        const n = 8 * res
        const samples = decodeChunk(b64, res)
        for (let lz = 0; lz < n; lz++) {
          for (let lx = 0; lx < n; lx++) {
            if (samples[lz * n + lx] === 0) continue
            const sx = ci * n + lx
            const sz = cj * n + lz
            const is = sx % res === 0 ? [sx / res - 1, sx / res] : [Math.floor(sx / res)]
            const js = sz % res === 0 ? [sz / res - 1, sz / res] : [Math.floor(sz / res)]
            expect(is.some((i) => js.some((j) => touched(m, i, j)))).toBe(true)
          }
        }
      }
    }
    // Tokens: own / vision tokens or currently visible ones, never hidden.
    for (const id of Object.keys(view.tokens)) {
      expect(scene.tokens[id].hidden).toBe(false)
      expect(view.controlledTokenIds.includes(id) || view.visionTokenIds.includes(id) || vis.visibleTokenIds.has(id)).toBe(true)
    }
  })
})

describe("token models", () => {
  it("sends a visible token's model reference (and nothing for tokens without one); viewToScene keeps it", () => {
    const { scene, ground } = flatScene(10, 10)
    const own = addToken(scene, ground, 7.5, 7.5, { kind: "pc", model: "free:elf-archer" })
    const other = addToken(scene, ground, 17.5, 7.5, { kind: "npc", model: "free:kenku-rogue" })
    const plain = addToken(scene, ground, 27.5, 7.5, { kind: "npc" })
    let s = withPlayer(scene)
    s = reduceDm(s, { t: "assign-token", tokenId: own.id, userId: "p1", assigned: true }).state
    const cells: [number, number][] = [1, 3, 5].map((i) => [i, 1])
    const { view } = know(s, synthVis(scene, { [ground]: cells }, [], { visibleTokenIds: new Set([own.id, other.id, plain.id]) }))
    expect(view.tokens[own.id].model).toBe("free:elf-archer")
    expect(view.tokens[other.id].model).toBe("free:kenku-rogue")
    expect("model" in view.tokens[plain.id]).toBe(false)
    expect(playerViewSchema.parse(view)).toEqual(view)
    expect(viewToScene(view).tokens[other.id].model).toBe("free:kenku-rogue")
    expect("model" in viewToScene(view).tokens[plain.id]).toBe(false)
  })

  it("the view schema refuses anything but a model reference", () => {
    const { scene, ground } = flatScene(4, 4)
    const t = addToken(scene, ground, 2.5, 2.5, { kind: "pc", model: "free:elf-archer" })
    let s = withPlayer(scene)
    s = reduceDm(s, { t: "assign-token", tokenId: t.id, userId: "p1", assigned: true }).state
    const { view } = know(s, synthVis(scene, { [ground]: [[0, 0]] }))
    for (const model of ["https://evil.example/x.glb", "free:", "free:Elf", "asset:x"]) {
      const bad = { ...view, tokens: { [t.id]: { ...view.tokens[t.id], model } } }
      expect(playerViewSchema.safeParse(bad).success, model).toBe(false)
    }
  })
})
