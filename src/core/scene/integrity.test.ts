import { produce } from "immer"
import { describe, expect, it } from "vitest"

import { createConnector, createDoor, createFloor, createLevel, createLight, createPillar, createProp, createScene, createToken, createWall, createWindow } from "./factory"
import { copySelection, deleteWithDependents, objectBounds, pasteClipboard, reprojectOpenings, selectionBounds, splitWall, validateReferences } from "./integrity"
import { groundHeightAt, lightLevelId, lightWorldPosition, wallOpenings } from "./queries"
import { parseScene } from "./schema"
import type { ConnectorObject, LightObject, Scene, SceneObject, TerrainShape, WallObject } from "./types"

/** Ground (0) / upper (10) / attic (20) with a stair from ground to upper, a walled room with openings, tokens and lights. */
function fixture() {
  const scene = createScene({ width: 20, depth: 20 })
  const ground = Object.values(scene.levels)[0]
  const upper = createLevel({ id: "upper", name: "Upper", elevation: 10 })
  const attic = createLevel({ id: "attic", name: "Attic", elevation: 20 })
  scene.levels.upper = upper
  scene.levels.attic = attic
  const add = <T extends SceneObject>(o: T): T => {
    scene.objects[o.id] = o
    return o
  }
  add(createFloor(upper.id, { x: 0, z: 0, w: 100, d: 100 }, "wood"))
  const wall = add(createWall(ground.id, { x: 10, z: 10 }, { x: 30, z: 10 }))
  const door = add(createDoor(wall, 5))
  const win = add(createWindow(wall, 14))
  const upperWall = add(createWall(upper.id, { x: 10, z: 10 }, { x: 30, z: 10 }))
  const upperDoor = add(createDoor(upperWall, 10))
  const stairs = add(createConnector(ground.id, upper.id, { x: 40, z: 40, w: 10, d: 20 }, 0))
  const pillar = add(createPillar(ground.id, { x: 20, z: 20 }))
  const hero = createToken(ground.id, { x: 42.5, z: 47.5 }, { name: "Hero" })
  const ghost = createToken(upper.id, { x: 12.5, z: 12.5 }, { name: "Ghost" })
  scene.tokens[hero.id] = hero
  scene.tokens[ghost.id] = ghost
  // Lantern carried by the hero, standing on the stairs (ground interpolated to 3.75 there).
  const lantern = add(createLight(ground.id, "lantern", { x: 0.5, z: 0 }, { attachedTokenId: hero.id, position: { x: 0.5, y: 3, z: 0 } }))
  const ghostLight = add(createLight(ground.id, "magical", { x: 0, z: 0 }, { attachedTokenId: ghost.id }))
  const torch = add(createLight(upper.id, "torch", { x: 15, z: 15 }))
  return { scene, ground, upper, attic, wall, door, win, upperWall, upperDoor, stairs, pillar, hero, ghost, lantern, ghostLight, torch }
}

describe("validateReferences", () => {
  it("accepts a consistent scene", () => {
    expect(validateReferences(fixture().scene)).toEqual([])
  })

  it("reports every kind of broken reference", () => {
    const f = fixture()
    const s = f.scene
    f.door.wallId = "missing"
    f.win.levelId = f.upper.id
    const badConnector = createConnector(f.upper.id, f.ground.id, { x: 0, z: 0, w: 5, d: 5 }, 0, "ladder")
    s.objects[badConnector.id] = badConnector
    const selfConnector = createConnector(f.upper.id, f.upper.id, { x: 5, z: 0, w: 5, d: 5 }, 0, "ladder")
    s.objects[selfConnector.id] = selfConnector
    const loose = createConnector(f.ground.id, "nowhere", { x: 10, z: 0, w: 5, d: 5 }, 0, "ladder")
    s.objects[loose.id] = loose
    f.lantern.attachedTokenId = "gone"
    s.tokens[f.ghost.id].levelId = "void"
    const orphan = createPillar("void", { x: 1, z: 1 })
    s.objects[orphan.id] = orphan
    s.objects["alias"] = createPillar(f.ground.id, { x: 2, z: 2 })
    const dupe = createPillar(f.ground.id, { x: 3, z: 3 }, { id: f.hero.id })
    s.objects[dupe.id] = dupe

    const issues = validateReferences(s).join("\n")
    expect(issues).toMatch(/wallId "missing" does not exist/)
    expect(issues).toMatch(/differs from its wall's level/)
    expect(issues).toMatch(/must be higher/)
    expect(issues).toMatch(/toLevelId equals its own level/)
    expect(issues).toMatch(/toLevelId "nowhere" does not exist/)
    expect(issues).toMatch(/attachedTokenId "gone" does not exist/)
    expect(issues).toMatch(/token ".*": levelId "void" does not exist/)
    expect(issues).toMatch(/pillar ".*": levelId "void" does not exist/)
    expect(issues).toMatch(/objects\["alias"\]: id ".*" does not match its key/)
    expect(issues).toMatch(/duplicate id/)
  })

  it("reports openings that do not fit their wall and openings hosted by non-walls", () => {
    const f = fixture()
    f.win.offset = 19
    f.door.wallId = f.pillar.id
    const issues = validateReferences(f.scene).join("\n")
    expect(issues).toMatch(/does not fit on wall/)
    expect(issues).toMatch(/is a pillar, not a wall/)
  })

  it("checks terrain shape keys against their ids, scoped to the level", () => {
    const f = fixture()
    const points = [
      { x: 0, y: 1, z: 0 },
      { x: 5, y: 1, z: 0 },
      { x: 5, y: 1, z: 5 },
    ]
    const shape = (id: string): TerrainShape => ({ id, kind: "block", op: "add", order: 0, base: 0, points: structuredClone(points) })
    f.ground.heightmap = { resolution: 1, chunks: {} }
    // The same shape id on two levels, and a shape id equal to an object id, are fine.
    f.ground.terrainEdits = { shapes: { s1: shape("s1"), [f.wall.id]: shape(f.wall.id) }, baseChunks: {} }
    f.upper.heightmap = { resolution: 1, chunks: {} }
    f.upper.terrainEdits = { shapes: { s1: shape("s1") }, baseChunks: {} }
    expect(validateReferences(f.scene)).toEqual([])
    f.upper.terrainEdits.shapes.s1.id = "s2"
    expect(validateReferences(f.scene)).toEqual([`level "upper": terrain shape ["s1"]: id "s2" does not match its key`])
  })
})

describe("deleteWithDependents", () => {
  it("deletes a wall's openings with it", () => {
    const f = fixture()
    deleteWithDependents(f.scene, [f.wall.id])
    expect(f.scene.objects[f.wall.id]).toBeUndefined()
    expect(f.scene.objects[f.door.id]).toBeUndefined()
    expect(f.scene.objects[f.win.id]).toBeUndefined()
    expect(f.scene.objects[f.upperDoor.id]).toBeDefined()
    expect(validateReferences(f.scene)).toEqual([])
  })

  it("detaches a deleted token's lights at their world position", () => {
    const f = fixture()
    const before = lightWorldPosition(f.scene, f.lantern)
    const level = lightLevelId(f.scene, f.lantern)
    deleteWithDependents(f.scene, [f.hero.id])
    const light = f.scene.objects[f.lantern.id] as LightObject
    expect(f.scene.tokens[f.hero.id]).toBeUndefined()
    expect(light.attachedTokenId).toBeNull()
    expect(light.levelId).toBe(level)
    const after = lightWorldPosition(f.scene, light)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(after.z).toBeCloseTo(before.z)
    // Standing on the stairs: y is relative to the interpolated stair ground, not the level plane.
    expect(light.position.y).toBeCloseTo(3)
    expect(validateReferences(f.scene)).toEqual([])
  })

  it("deletes a level with its objects, tokens and the connectors leading to it", () => {
    const f = fixture()
    deleteWithDependents(f.scene, [f.upper.id])
    expect(f.scene.levels.upper).toBeUndefined()
    for (const o of Object.values(f.scene.objects)) expect(o.levelId).not.toBe(f.upper.id)
    expect(f.scene.objects[f.stairs.id]).toBeUndefined() // led to the deleted level
    expect(f.scene.objects[f.upperDoor.id]).toBeUndefined()
    expect(f.scene.objects[f.torch.id]).toBeUndefined()
    expect(f.scene.tokens[f.ghost.id]).toBeUndefined()
    // The ghost's light went with its carrier's level (not detached into the void).
    expect(f.scene.objects[f.ghostLight.id]).toBeUndefined()
    // Ground things survive.
    expect(f.scene.objects[f.wall.id]).toBeDefined()
    expect(f.scene.objects[f.lantern.id]).toBeDefined()
    expect(validateReferences(f.scene)).toEqual([])
  })

  it("keeps lights of surviving carriers when their stored level is deleted", () => {
    const f = fixture()
    const light = f.scene.objects[f.lantern.id] as LightObject
    light.levelId = f.attic.id // stale stored level
    deleteWithDependents(f.scene, [f.attic.id])
    const kept = f.scene.objects[f.lantern.id] as LightObject
    expect(kept).toBeDefined()
    expect(kept.attachedTokenId).toBe(f.hero.id)
    expect(kept.levelId).toBe(f.hero.levelId)
  })

  it("works on immer drafts", () => {
    const f = fixture()
    const next = produce(f.scene, (draft) => deleteWithDependents(draft, [f.hero.id, f.wall.id]))
    expect(next.tokens[f.hero.id]).toBeUndefined()
    expect(next.objects[f.door.id]).toBeUndefined()
    expect((next.objects[f.lantern.id] as LightObject).attachedTokenId).toBeNull()
    // The original is untouched.
    expect(f.scene.tokens[f.hero.id]).toBeDefined()
  })

  it("ignores unknown ids", () => {
    const f = fixture()
    const count = Object.keys(f.scene.objects).length
    deleteWithDependents(f.scene, ["nope"])
    expect(Object.keys(f.scene.objects)).toHaveLength(count)
  })
})

describe("copySelection / pasteClipboard", () => {
  it("copies selected ids plus the openings of selected walls, centred on the selection bounds", () => {
    const f = fixture()
    const clip = copySelection(f.scene, [f.wall.id, f.pillar.id])
    expect(clip.kind).toBe("atlas-clipboard")
    expect(clip.objects.map((o) => o.id).sort()).toEqual([f.wall.id, f.door.id, f.win.id, f.pillar.id].sort())
    expect(clip.sourceLevelId).toBe(f.ground.id)
    // Wall x 10..30 (± 0.25), z 10 ± 0.25; pillar (20, 20) ± 1 → bounds x 9.75..30.25, z 9.75..21.
    expect(clip.origin.x).toBeCloseTo(20)
    expect(clip.origin.z).toBeCloseTo((9.75 + 21) / 2)
    // The clipboard is a deep copy.
    const copiedWall = clip.objects[0] as WallObject
    copiedWall.height = 99
    expect((f.scene.objects[f.wall.id] as WallObject).height).not.toBe(99)
  })

  it("pastes with fresh ids, translated to the pointer", () => {
    const f = fixture()
    const clip = copySelection(f.scene, [f.wall.id])
    const ids = pasteClipboard(f.scene, clip, { targetLevelId: f.ground.id, at: { x: clip.origin.x + 50, z: clip.origin.z + 30 } })
    expect(ids).toHaveLength(3)
    for (const id of ids) expect([f.wall.id, f.door.id, f.win.id]).not.toContain(id)
    const wall = ids.map((id) => f.scene.objects[id]).find((o) => o.type === "wall") as WallObject
    expect(wall.a).toEqual({ x: 60, z: 40 })
    expect(wall.b).toEqual({ x: 80, z: 40 })
    const openings = wallOpenings(f.scene, wall.id)
    expect(openings).toHaveLength(2)
    expect(openings.map((o) => o.offset)).toEqual([5, 14])
    expect(validateReferences(f.scene)).toEqual([])
  })

  it("drops openings whose wall was not copied", () => {
    const f = fixture()
    const clip = copySelection(f.scene, [f.door.id, f.pillar.id])
    const ids = pasteClipboard(f.scene, clip, { targetLevelId: f.ground.id, at: { x: 50, z: 50 } })
    expect(ids).toHaveLength(1)
    expect(f.scene.objects[ids[0]].type).toBe("pillar")
  })

  it("re-hosts openings copied without their wall onto the wall under the pointer", () => {
    const f = fixture()
    const target = createWall(f.ground.id, { x: 50, z: 80 }, { x: 90, z: 80 })
    f.scene.objects[target.id] = target
    const clip = copySelection(f.scene, [f.door.id])
    // Door centre is (15, 10); paste it at (70, 80) on the target wall.
    expect(clip.openingCenters?.[f.door.id]).toEqual({ x: 15, z: 10 })
    const [id] = pasteClipboard(f.scene, clip, { targetLevelId: f.ground.id, at: { x: 70, z: 80 }, hostWallId: target.id })
    const door = f.scene.objects[id]
    expect(door.type).toBe("door")
    if (door.type === "door") {
      expect(door.wallId).toBe(target.id)
      expect(door.offset).toBeCloseTo(20)
    }
    // Pointer past the end of the wall: the door would not fit, so nothing is pasted.
    expect(pasteClipboard(f.scene, clip, { targetLevelId: f.ground.id, at: { x: 89.5, z: 80 }, hostWallId: target.id })).toEqual([])
    // Openings whose wall WAS copied ignore hostWallId.
    const both = copySelection(f.scene, [f.wall.id])
    const ids = pasteClipboard(f.scene, both, { targetLevelId: f.ground.id, at: { x: 20, z: 40 }, hostWallId: target.id })
    const pastedWall = ids.find((i) => f.scene.objects[i].type === "wall")!
    expect(wallOpenings(f.scene, pastedWall)).toHaveLength(2)
    expect(validateReferences(f.scene)).toEqual([])
  })

  it("remaps levels by relative order and drops items whose level does not exist", () => {
    const f = fixture()
    // Ground wall + upper wall copied from ground; pasted onto upper: ground→upper, upper→attic.
    const clip = copySelection(f.scene, [f.wall.id, f.upperWall.id])
    expect(clip.sourceLevelId).toBe(f.ground.id)
    const ids = pasteClipboard(f.scene, clip, { targetLevelId: f.upper.id, at: clip.origin })
    const pasted = ids.map((id) => f.scene.objects[id])
    const walls = pasted.filter((o) => o.type === "wall")
    expect(walls.map((w) => w.levelId).sort()).toEqual([f.attic.id, f.upper.id].sort())
    for (const o of pasted) {
      if (o.type === "door" || o.type === "window") expect(o.levelId).toBe((f.scene.objects[o.wallId] as WallObject).levelId)
    }
    // Pasted onto the attic, the upper wall would land above the top level: dropped with its door.
    const top = pasteClipboard(f.scene, clip, { targetLevelId: f.attic.id, at: clip.origin }).map((id) => f.scene.objects[id])
    expect(top.every((o) => o.levelId === f.attic.id)).toBe(true)
    expect(top.filter((o) => o.type === "wall")).toHaveLength(1)
    expect(validateReferences(f.scene)).toEqual([])
  })

  it("points connectors at the level directly above, or drops them", () => {
    const f = fixture()
    const clip = copySelection(f.scene, [f.stairs.id])
    const [id] = pasteClipboard(f.scene, clip, { targetLevelId: f.upper.id, at: { x: 12, z: 12 } })
    const c = f.scene.objects[id] as ConnectorObject
    expect(c.levelId).toBe(f.upper.id)
    expect(c.toLevelId).toBe(f.attic.id)
    // Translation is rounded to whole cells so the rect stays aligned.
    expect(c.rect.x % 5).toBe(0)
    expect(c.rect.z % 5).toBe(0)
    expect(pasteClipboard(f.scene, clip, { targetLevelId: f.attic.id, at: { x: 12, z: 12 } })).toEqual([])
  })

  it("keeps lights on copied carriers attached (with fresh ids) and detaches the others", () => {
    const f = fixture()
    const withCarrier = copySelection(f.scene, [f.hero.id, f.lantern.id])
    const ids = pasteClipboard(f.scene, withCarrier, { targetLevelId: f.ground.id, at: { x: 70, z: 70 } })
    const newToken = ids.map((id) => f.scene.tokens[id]).find(Boolean)!
    const newLight = ids.map((id) => f.scene.objects[id]).find((o) => o?.type === "light") as LightObject
    expect(newToken.id).not.toBe(f.hero.id)
    expect(newLight.attachedTokenId).toBe(newToken.id)
    expect(newLight.position).toEqual(f.lantern.position) // still an offset from the carrier

    const lightOnly = copySelection(f.scene, [f.lantern.id])
    expect((lightOnly.objects[0] as LightObject).attachedTokenId).toBeNull()
    const origWorld = lightWorldPosition(f.scene, f.lantern)
    expect(lightOnly.origin.x).toBeCloseTo(origWorld.x)
    const [lid] = pasteClipboard(f.scene, lightOnly, { targetLevelId: f.ground.id, at: { x: origWorld.x + 10, z: origWorld.z } })
    const pastedLight = f.scene.objects[lid] as LightObject
    expect(pastedLight.attachedTokenId).toBeNull()
    expect(lightWorldPosition(f.scene, pastedLight).x).toBeCloseTo(origWorld.x + 10)
    expect(validateReferences(f.scene)).toEqual([])
  })

  it("pastes into another scene using the clipboard's level offsets", () => {
    const f = fixture()
    const clip = copySelection(f.scene, [f.wall.id, f.upperWall.id, f.ghost.id])
    const other = createScene()
    const otherGround = Object.values(other.levels)[0]
    const otherUpper = createLevel({ elevation: 12 })
    other.levels[otherUpper.id] = otherUpper
    const ids = pasteClipboard(other, clip, { targetLevelId: otherGround.id, at: { x: 50, z: 50 } })
    const walls = ids.map((id) => other.objects[id]).filter((o) => o?.type === "wall")
    expect(walls.map((w) => w.levelId).sort()).toEqual([otherGround.id, otherUpper.id].sort())
    const token = ids.map((id) => other.tokens[id]).find(Boolean)!
    expect(token.levelId).toBe(otherUpper.id)
    expect(validateReferences(other)).toEqual([])
  })

  it("returns nothing for an unknown target level", () => {
    const f = fixture()
    expect(pasteClipboard(f.scene, copySelection(f.scene, [f.pillar.id]), { targetLevelId: "nope", at: { x: 0, z: 0 } })).toEqual([])
  })

  it("computes object and selection bounds", () => {
    const f = fixture()
    const prop = createProp(f.ground.id, "table", { x: 50, y: 0, z: 50 }, { rotationY: Math.PI / 2 })
    f.scene.objects[prop.id] = prop
    const b = objectBounds(f.scene, prop)!
    expect(b.w).toBeCloseTo(3)
    expect(b.d).toBeCloseTo(5)
    expect(objectBounds(f.scene, f.door)).toEqual({ x: 12.75, z: 9.75, w: 4.5, d: 0.5 })
    expect(selectionBounds(f.scene, [])).toBeNull()
    expect(selectionBounds(f.scene, [f.hero.id])).toEqual({ x: 40, z: 45, w: 5, d: 5 })
  })
})

describe("reprojectOpenings / splitWall", () => {
  const setup = () => {
    const f = fixture()
    const wall = f.scene.objects[f.wall.id] as WallObject // (10,10) → (30,10), door @5 w4, window @14 w3
    return { ...f, w: wall }
  }
  const offsets = (scene: Scene, wallId: string) => wallOpenings(scene, wallId).map((o) => [o.type, o.offset])

  it("mirrors offsets when a wall is flipped", () => {
    const { scene, w } = setup()
    const before = { a: { ...w.a }, b: { ...w.b } }
    const { a, b } = w
    w.a = b
    w.b = a
    reprojectOpenings(scene, w.id, before)
    expect(offsets(scene, w.id)).toEqual([
      ["window", 6],
      ["door", 15],
    ])
  })

  it("keeps openings in place when the far end moves, and deletes those that no longer fit", () => {
    const { scene, w, door, win } = setup()
    const before = { a: { ...w.a }, b: { ...w.b } }
    w.b = { x: 25, z: 10 } // length 15: window at 14 (needs ≤ 13.5) no longer fits
    reprojectOpenings(scene, w.id, before)
    expect(scene.objects[door.id]).toBeDefined()
    expect(scene.objects[win.id]).toBeUndefined()
    expect(offsets(scene, w.id)).toEqual([["door", 5]])
  })

  it("keeps distances from b when the start moves", () => {
    const { scene, w } = setup()
    const before = { a: { ...w.a }, b: { ...w.b } }
    w.a = { x: 5, z: 10 } // 5 ft longer at the start
    reprojectOpenings(scene, w.id, before)
    expect(offsets(scene, w.id)).toEqual([
      ["door", 10],
      ["window", 19],
    ])
  })

  it("keeps offsets when the wall is translated, and follows the wall's level", () => {
    const { scene, w, upper, door } = setup()
    const before = { a: { ...w.a }, b: { ...w.b } }
    w.a = { x: 13, z: 17 }
    w.b = { x: 33, z: 17 }
    w.levelId = upper.id
    reprojectOpenings(scene, w.id, before)
    expect(offsets(scene, w.id)).toEqual([
      ["door", 5],
      ["window", 14],
    ])
    expect(scene.objects[door.id].levelId).toBe(upper.id)
  })

  it("deletes the openings of a wall that no longer exists", () => {
    const { scene, w, door } = setup()
    const before = { a: { ...w.a }, b: { ...w.b } }
    delete scene.objects[w.id]
    reprojectOpenings(scene, w.id, before)
    expect(scene.objects[door.id]).toBeUndefined()
  })

  it("splits a wall, moving or deleting openings", () => {
    const { scene, w, door, win } = setup()
    const second = splitWall(scene, w.id, 10)!
    expect(second).toBeTruthy()
    expect(w.b).toEqual({ x: 20, z: 10 })
    expect((scene.objects[second] as WallObject).a).toEqual({ x: 20, z: 10 })
    expect((scene.objects[second] as WallObject).b).toEqual({ x: 30, z: 10 })
    expect(scene.objects[door.id]).toBeDefined() // 3..7 stays on the first half
    expect(offsets(scene, second)).toEqual([["window", 4]]) // 12.5..15.5 → rebased by 10
    expect(scene.objects[win.id]).toBeDefined()
    // A split through an opening deletes it.
    splitWall(scene, w.id, 5)
    expect(scene.objects[door.id]).toBeUndefined()
    expect(splitWall(scene, w.id, 0)).toBeNull()
    expect(validateReferences(scene)).toEqual([])
  })

  it("never creates a wall shorter than the schema minimum", () => {
    const { scene, w } = setup()
    const len = Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z)
    for (const d of [0.002, 0.009, len - 0.009, len - 0.002, -1, len + 1, Number.NaN]) expect(splitWall(scene, w.id, d), String(d)).toBeNull()
    // A skewed wall far from the origin: splits right at the minimum stay valid (or are refused).
    const skew = createWall(w.levelId, { x: 43.21, z: 17.3 }, { x: 43.21 + 3 * Math.cos(1), z: 17.3 + 3 * Math.sin(1) })
    scene.objects[skew.id] = skew
    for (const d of [0.01, 0.0100001, 3 - 0.01]) {
      const draft = structuredClone(scene)
      const id = splitWall(draft, skew.id, d)
      if (id === null) continue
      const parsed = parseScene(JSON.parse(JSON.stringify(draft)))
      expect(parsed.ok, `${d}: ${parsed.ok ? "" : parsed.issues.join("; ")}`).toBe(true)
    }
    expect(parseScene(JSON.parse(JSON.stringify(scene))).ok).toBe(true)
  })
})

describe("copySelection openings", () => {
  it("copies each selected wall followed by its openings in ascending offset, without duplicates", () => {
    const scene = createScene({ width: 20, depth: 20 })
    const L = Object.keys(scene.levels)[0]
    const add = <T extends SceneObject>(o: T): T => {
      scene.objects[o.id] = o
      return o
    }
    const w1 = add(createWall(L, { x: 0, z: 10 }, { x: 60, z: 10 }))
    const w2 = add(createWall(L, { x: 0, z: 30 }, { x: 60, z: 30 }))
    const w3 = add(createWall(L, { x: 0, z: 50 }, { x: 60, z: 50 }))
    // Created out of offset order, doors and windows interleaved.
    const o1 = [add(createWindow(w1, 40)), add(createDoor(w1, 10)), add(createWindow(w1, 25)), add(createDoor(w1, 52))]
    const o2 = [add(createDoor(w2, 30)), add(createWindow(w2, 5))]
    add(createDoor(w3, 20)) // not selected
    const clip = copySelection(scene, [w1.id, o1[2].id, w2.id, o2[0].id])
    const byOffset = (list: SceneObject[]) => [...list].sort((a, b) => ("offset" in a && "offset" in b ? a.offset - b.offset : 0)).map((o) => o.id)
    expect(clip.objects.map((o) => o.id)).toEqual([w1.id, ...byOffset(o1), w2.id, ...byOffset(o2)])
    expect(new Set(clip.objects.map((o) => o.id)).size).toBe(clip.objects.length)
    // Same result as the per-wall query.
    expect(clip.objects.map((o) => o.id)).toEqual([w1, w2].flatMap((w) => [w.id, ...wallOpenings(scene, w.id).map((o) => o.id)]))
  })

  it("scales linearly: 5000 walls with 1000 openings copy in well under a second", () => {
    const scene = createScene({ width: 200, depth: 200 })
    const L = Object.keys(scene.levels)[0]
    for (let k = 0; k < 5000; k++) {
      const x = (k % 100) * 10
      const z = Math.floor(k / 100) * 10
      const w = createWall(L, { x, z }, { x: x + 8, z })
      scene.objects[w.id] = w
      if (k % 5 === 0) {
        const d = createDoor(w, 4, { width: 3 })
        scene.objects[d.id] = d
      }
    }
    const ids = Object.keys(scene.objects)
    const t0 = performance.now()
    const clip = copySelection(scene, ids)
    const ms = performance.now() - t0
    expect(clip.objects).toHaveLength(ids.length)
    expect(ms).toBeLessThan(1000)
  })

  it("resolves many lights with one ground index: 3000 lights among 20k objects copy and bound in well under a second", () => {
    // Before, every light scanned every object for its ground (about 1 ms each at this size).
    const scene = createScene({ width: 200, depth: 200 })
    const L = Object.keys(scene.levels)[0]
    const upper = createLevel({ elevation: 10 })
    scene.levels[upper.id] = upper
    for (let k = 0; k < 20; k++) {
      const c = createConnector(L, upper.id, { x: k * 50, z: 500, w: 5, d: 20 }, 0)
      scene.objects[c.id] = c
    }
    for (let k = 0; k < 17_000; k++) {
      const p = createProp(L, "crate", { x: (k % 200) * 5 + 2.5, y: 0, z: Math.floor(k / 200) * 5 + 2.5 })
      scene.objects[p.id] = p
    }
    const carriers: string[] = []
    for (let k = 0; k < 3000; k++) {
      const x = (k % 200) * 5 + 1
      const z = 500 + Math.floor(k / 200) * 1.3
      if (k % 3 === 0) {
        const t = createToken(L, { x, z })
        scene.tokens[t.id] = t
        carriers.push(t.id)
        const l = createLight(L, "torch", { x: 0, z: 0 }, { attachedTokenId: t.id, position: { x: 0, y: 4, z: 0 } })
        scene.objects[l.id] = l
      } else {
        const l = createLight(L, "torch", { x, z })
        scene.objects[l.id] = l
      }
    }
    // Every object but the carriers: carried lights are detached at their world position.
    const ids = Object.keys(scene.objects)
    let t0 = performance.now()
    const clip = copySelection(scene, ids)
    const copyMs = performance.now() - t0
    t0 = performance.now()
    const bounds = selectionBounds(scene, ids)
    const boundsMs = performance.now() - t0
    expect(clip.objects).toHaveLength(ids.length)
    expect(bounds).not.toBeNull()
    // The fast path gives the per-light results: spot-check detached lights on and off the stair runs.
    const lights = clip.objects.filter((c, k): c is LightObject => c.type === "light" && k % 50 === 0)
    expect(lights.some((o) => (scene.objects[o.id] as LightObject).attachedTokenId !== null)).toBe(true)
    for (const o of lights) {
      const src = scene.objects[o.id] as LightObject
      const w = lightWorldPosition(scene, src)
      expect(o.attachedTokenId).toBeNull()
      expect(o.position.x).toBeCloseTo(w.x, 9)
      expect(o.position.y).toBeCloseTo(w.y - groundHeightAt(scene, o.levelId, w), 9)
      expect(o.position.z).toBeCloseTo(w.z, 9)
      expect(objectBounds(scene, src)).toEqual({ x: w.x, z: w.z, w: 0, d: 0 })
    }
    expect(copyMs).toBeLessThan(1000)
    expect(boundsMs).toBeLessThan(500)

    // Deleting the 1000 carriers detaches their lights where they are (same index per phase).
    const sample = carriers.filter((_, k) => k % 97 === 0)
    const carried = new Map(
      Object.values(scene.objects).flatMap((o) =>
        o.type === "light" && o.attachedTokenId && sample.includes(o.attachedTokenId) ? [[o.id, lightWorldPosition(scene, o)] as const] : []
      )
    )
    t0 = performance.now()
    const next = produce(scene, (d) => deleteWithDependents(d, carriers))
    const deleteMs = performance.now() - t0
    expect(Object.keys(next.tokens)).toHaveLength(0)
    expect(carried.size).toBe(sample.length)
    for (const [id, before] of carried) {
      const light = next.objects[id] as LightObject
      expect(light.attachedTokenId).toBeNull()
      const after = lightWorldPosition(next, light)
      expect(after.x).toBeCloseTo(before.x, 9)
      expect(after.y).toBeCloseTo(before.y, 9)
      expect(after.z).toBeCloseTo(before.z, 9)
    }
    expect(deleteMs).toBeLessThan(1000)
  })
})
