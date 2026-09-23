import { describe, expect, it } from "vitest"

import { PROP_LIBRARY, SIZE_BODY } from "./defaults"
import { objectBounds, validateReferences } from "./integrity"
import {
  connectorForward,
  effectiveFloorRects,
  groundHeightAt,
  hasGroundAt,
  lightEffectivelyHidden,
  objectsOfType,
  rectContains,
  rectsOverlap,
  sortedLevels,
  tokenRect,
  wallLength,
} from "./queries"
import { SAMPLE_SCENES, sampleById } from "./samples"
import { parseScene, serializeScene } from "./schema"
import { sampleHeight } from "./heightmap"
import type { Id, Rect, Scene, Vec2, WallObject } from "./types"

const build = (id: string): Scene => sampleById(id)!.build()
const near = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) < 1e-3 && Math.abs(p.z - q.z) < 1e-3

/** Distance from p to segment a→b. */
function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)))
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t))
}

/** Wall endpoints that neither meet another wall's endpoint nor lie on another wall (free ends), per level. */
function freeWallEnds(scene: Scene, levelId: Id): string[] {
  const walls = objectsOfType(scene, "wall", levelId)
  const out: string[] = []
  for (const w of walls) {
    for (const p of [w.a, w.b]) {
      const joined = walls.some((o) => o !== w && (near(o.a, p) || near(o.b, p) || distToSegment(p, o.a, o.b) < 1e-3))
      if (!joined) out.push(`${p.x},${p.z}`)
    }
  }
  return out.sort()
}

/** Footprints (AABBs) of everything that blocks movement on a level: walls (inflated), pillars, blocking props. */
function movementBlockers(scene: Scene, levelId: Id): { id: Id; rect: Rect; top: number }[] {
  const out: { id: Id; rect: Rect; top: number }[] = []
  for (const o of Object.values(scene.objects)) {
    if (o.levelId !== levelId) continue
    if (o.type === "wall") out.push({ id: o.id, rect: objectBounds(scene, o)!, top: o.height })
    else if (o.type === "pillar") out.push({ id: o.id, rect: objectBounds(scene, o)!, top: o.height ?? 10 })
    else if (o.type === "prop" && o.blocksMovement) out.push({ id: o.id, rect: objectBounds(scene, o)!, top: o.position.y + PROP_LIBRARY[o.kind].size.y * o.scale.y })
  }
  return out
}

const shrink = (r: Rect, k: number): Rect => ({ x: r.x + k, z: r.z + k, w: r.w - 2 * k, d: r.d - 2 * k })

/** Checks every sample must pass: valid document, tokens standing on clear ground, lights outside solids. */
function expectCoherent(scene: Scene) {
  const parsed = parseScene(JSON.parse(serializeScene(scene)))
  if (!parsed.ok) throw new Error(parsed.issues.join("\n"))
  expect(parsed.scene).toEqual(scene)
  expect(validateReferences(scene)).toEqual([])

  const extent = { x: 0, z: 0, w: scene.grid.width * scene.grid.cellSize, d: scene.grid.depth * scene.grid.cellSize }
  for (const t of Object.values(scene.tokens)) {
    const r = tokenRect(scene, t)
    expect(r.x >= 0 && r.z >= 0 && r.x + r.w <= extent.w && r.z + r.d <= extent.d, `${t.name} inside the grid`).toBe(true)
    expect(hasGroundAt(scene, t.levelId, t.position), `${t.name} stands on ground`).toBe(true)
    // Movement clearance (0.35 ft) must leave the footprint clear of walls, pillars and blocking props.
    for (const b of movementBlockers(scene, t.levelId)) {
      expect(rectsOverlap(shrink(r, 0.35), b.rect), `${t.name} overlaps ${scene.objects[b.id].type} ${scene.objects[b.id].name ?? b.id}`).toBe(false)
    }
  }
  for (const l of objectsOfType(scene, "light")) {
    if (l.attachedTokenId) continue
    for (const b of movementBlockers(scene, l.levelId)) {
      const inside = rectContains(b.rect, l.position) && l.position.y < b.top + 0.25
      expect(inside, `light ${l.name ?? l.id} is inside ${scene.objects[b.id].type} ${scene.objects[b.id].name ?? b.id}`).toBe(false)
    }
  }
}

describe("SAMPLE_SCENES", () => {
  it("lists the three samples", () => {
    expect(SAMPLE_SCENES.map((s) => s.id)).toEqual(["crooked-lantern", "stress-test", "empty"])
    for (const s of SAMPLE_SCENES) {
      expect(s.name.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
    }
  })

  it.each(SAMPLE_SCENES.map((s) => s.id))("%s parses, validates and is coherent", (id) => {
    expectCoherent(build(id))
  })

  it("builds fresh documents with fresh ids", () => {
    const a = build("crooked-lantern")
    const b = build("crooked-lantern")
    expect(a.id).not.toBe(b.id)
    expect(Object.keys(a.objects).some((k) => k in b.objects)).toBe(false)
    expect(Object.keys(a.objects)).toHaveLength(Object.keys(b.objects).length)
  })
})

describe("The Crooked Lantern", () => {
  const scene = build("crooked-lantern")
  const levels = sortedLevels(scene)
  const [cellar, ground, upper, roof] = levels
  const tokens = Object.values(scene.tokens)
  const tokenNamed = (label: string) => tokens.find((t) => t.label === label)!

  it("has four stacked levels on a 40×30 grid under a moonlit night sky", () => {
    expect(levels.map((l) => [l.name, l.elevation])).toEqual([
      ["Cellar", -10],
      ["Ground Floor", 0],
      ["Upper Floor", 10],
      ["Roof", 20],
    ])
    expect(scene.grid).toMatchObject({ width: 40, depth: 30, cellSize: 5 })
    expect(scene.environment.skyLevel).toBe("dim")
    expect(scene.environment.ambientLevel).toBe("dark")
    expect(scene.environment.directional).toMatchObject({ enabled: true, kind: "moon", grants: "dim" })
  })

  it("has doors in every state, a secret door and windows", () => {
    const doors = objectsOfType(scene, "door")
    for (const state of ["open", "closed", "locked"]) expect(doors.some((d) => d.state === state && d.style !== "secret")).toBe(true)
    const secret = doors.filter((d) => d.style === "secret")
    expect(secret).toHaveLength(1)
    expect(secret[0].levelId).toBe(cellar.id)
    expect(objectsOfType(scene, "window").length).toBeGreaterThanOrEqual(10)
    // Openings are sized to their walls.
    for (const o of [...doors, ...objectsOfType(scene, "window")]) {
      const wall = scene.objects[o.wallId] as WallObject
      expect(o.height + (o.type === "window" ? o.sillHeight : 0)).toBeLessThanOrEqual(wall.height)
      expect(o.width).toBeLessThan(wallLength(wall))
    }
  })

  it("closes every room: walls meet at joints except the known free ends", () => {
    expect(freeWallEnds(scene, cellar.id)).toEqual([])
    // Stair side wall (both ends) and the garden-wall gate.
    expect(freeWallEnds(scene, ground.id)).toEqual(["100,40", "160,55", "160,65", "80,40"])
    // Stairwell railing end at the top of the stairs.
    expect(freeWallEnds(scene, upper.id)).toEqual(["100,40"])
    expect(freeWallEnds(scene, roof.id)).toEqual([])
  })

  it("links the cellar by ladder and the upper floor by cell-aligned stairs with a top landing", () => {
    const connectors = objectsOfType(scene, "connector")
    expect(connectors).toHaveLength(2)
    const ladder = connectors.find((c) => c.style === "ladder")!
    expect([ladder.levelId, ladder.toLevelId]).toEqual([cellar.id, ground.id])
    const lc = { x: ladder.rect.x + 2.5, z: ladder.rect.z + 2.5 }
    expect(hasGroundAt(scene, cellar.id, lc)).toBe(true)
    expect(hasGroundAt(scene, ground.id, lc)).toBe(true)

    const stairs = connectors.find((c) => c.style === "stairs")!
    expect([stairs.levelId, stairs.toLevelId]).toEqual([ground.id, upper.id])
    for (const v of [stairs.rect.x, stairs.rect.z, stairs.rect.w, stairs.rect.d]) expect(v % 5).toBe(0)
    const f = connectorForward(stairs.direction)
    const r = stairs.rect
    // Cells beyond the top edge (landing, upper level) and below the bottom edge (approach, ground).
    const centre = { x: r.x + r.w / 2, z: r.z + r.d / 2 }
    const along = f.x !== 0 ? r.w / 2 : r.d / 2
    for (const side of [-2.5, 2.5]) {
      const lateral = f.x !== 0 ? { x: 0, z: side } : { x: side, z: 0 }
      const top = { x: centre.x + f.x * (along + 2.5) + lateral.x, z: centre.z + f.z * (along + 2.5) + lateral.z }
      const bottom = { x: centre.x - f.x * (along + 2.5) + lateral.x, z: centre.z - f.z * (along + 2.5) + lateral.z }
      expect(hasGroundAt(scene, upper.id, top)).toBe(true)
      expect(hasGroundAt(scene, ground.id, bottom)).toBe(true)
      expect(groundHeightAt(scene, ground.id, { x: top.x - f.x * 3, z: top.z - f.z * 3 })).toBeGreaterThan(8)
    }
    // The stairwell is cut out of the upper floor; there is no way onto the roof.
    expect(hasGroundAt(scene, upper.id, centre)).toBe(false)
    expect(effectiveFloorRects(scene, upper.id).some((e) => rectsOverlap(e.rect, stairs.rect))).toBe(false)
    expect(connectors.some((c) => c.toLevelId === roof.id)).toBe(false)
    expect(objectsOfType(scene, "floor", roof.id).length).toBeGreaterThan(0)
  })

  it("has a gentle hill only in the outdoor meadow", () => {
    expect(ground.heightmap?.resolution).toBe(2)
    let max = 0
    for (let z = 0; z <= 150; z += 2.5) {
      for (let x = 0; x <= 200; x += 2.5) {
        const h = sampleHeight(ground.heightmap, 5, x, z)
        max = Math.max(max, h)
        // Flat under the building, the courtyard (with a margin) and the road.
        if ((x >= 25 && x <= 165 && z >= 25 && z <= 95) || (x >= 60 && x <= 80)) expect(h).toBe(0)
      }
    }
    expect(max).toBeGreaterThan(3)
    expect(max).toBeLessThanOrEqual(6)
    for (const l of [cellar, upper, roof]) expect(l.heightmap).toBeNull()
  })

  /** Height of the straight line eye→target where it crosses the vertical plane x = px. */
  const heightAtX = (eye: { x: number; y: number }, target: { x: number; y: number }, px: number) =>
    eye.y + ((px - eye.x) / (target.x - eye.x)) * (target.y - eye.y)

  it("stages the halfling-vs-giant low wall", () => {
    const halfling = tokenNamed("Pip")
    const giant = tokenNamed("Hill Giant")
    const bandit = tokens.find((t) => t.hidden)!
    expect(halfling.size).toBe("small")
    expect(halfling.vision.darkvision).toBe(60)
    expect(giant.size).toBe("huge")
    const gardenWalls = objectsOfType(scene, "wall", ground.id).filter((w) => w.name === "Garden wall")
    expect(gardenWalls.length).toBeGreaterThanOrEqual(4)
    for (const w of gardenWalls) expect(w.height).toBe(3)
    // Both stand inside the courtyard (x 110–160, z 30–90); the bandit lurks outside its east wall (x 160).
    for (const t of [halfling, giant]) expect(rectContains({ x: 110, z: 30, w: 50, d: 60 }, t.position)).toBe(true)
    expect(bandit.position.x).toBeGreaterThan(160)
    // Line of sight to the ground just behind the wall (near face x = 159.5, far face 160.5):
    // the halfling's passes below the wall top, the giant's clears it.
    const target = { x: bandit.position.x, y: 0.25 }
    const halflingEye = { x: halfling.position.x, y: halfling.eyeHeight }
    const giantEye = { x: giant.position.x, y: giant.eyeHeight }
    expect(heightAtX(halflingEye, target, 159.5)).toBeLessThan(3)
    expect(heightAtX(giantEye, target, 160.5)).toBeGreaterThan(3)
  })

  it("lets the token on the balcony see down into the courtyard", () => {
    const fighter = tokenNamed("Aldric")
    const balcony = objectsOfType(scene, "floor", upper.id).find((f) => f.name === "Balcony")!
    expect(fighter.levelId).toBe(upper.id)
    expect(rectContains(balcony.rect, fighter.position)).toBe(true)
    // The balcony overhangs the courtyard.
    expect(rectsOverlap(balcony.rect, { x: 110, z: 30, w: 50, d: 60 })).toBe(true)
    const railings = objectsOfType(scene, "wall", upper.id).filter((w) => w.name === "Railing")
    expect(railings.every((w) => w.height === 3.5)).toBe(true)
    const outer = railings.find((w) => w.a.x === 125 && w.b.x === 125)!
    const railTop = upper.elevation + outer.height
    const eye = { x: fighter.position.x, y: groundHeightAt(scene, upper.id, fighter.position) + fighter.eyeHeight }
    // A sight line to the courtyard floor 25 ft beyond the railing clears the railing's top outer edge.
    const floorPoint = { x: 150, y: 0.25 }
    expect(heightAtX(eye, floorPoint, 125 + outer.thickness / 2)).toBeGreaterThan(railTop)
    // …and nothing but open sky is above the balcony.
    expect(objectsOfType(scene, "floor", roof.id).some((f) => rectContains(f.rect, fighter.position))).toBe(false)
  })

  it("has the requested tokens and lights", () => {
    expect(tokens).toHaveLength(6)
    expect(tokens.filter((t) => t.kind === "pc")).toHaveLength(3)
    const barkeep = tokenNamed("Barkeep")
    expect(barkeep.kind).toBe("npc")
    const fighter = tokenNamed("Aldric")
    expect(fighter.vision).toEqual({ darkvision: 0, blindsight: 0, blind: false })
    expect(tokenNamed("Brunhild").vision.darkvision).toBe(60)
    expect(fighter.eyeHeight).toBe(SIZE_BODY.medium.eyeHeight)
    const bandit = tokens.find((t) => t.hidden)!
    expect(bandit.kind).toBe("monster")

    const lights = objectsOfType(scene, "light")
    for (const preset of ["torch", "lantern", "brazier", "candle", "magical"]) expect(lights.some((l) => l.preset === preset)).toBe(true)
    expect(lights.filter((l) => l.castsShadows).length).toBeGreaterThanOrEqual(10)
    const fighterLantern = lights.find((l) => l.attachedTokenId === fighter.id)!
    expect(fighterLantern.preset).toBe("lantern")
    const banditTorch = lights.find((l) => l.attachedTokenId === bandit.id)!
    expect(banditTorch.preset).toBe("torch")
    expect(lightEffectivelyHidden(scene, banditTorch)).toBe(true)
    // The cellar is dark except for one candle.
    const cellarLights = lights.filter((l) => l.levelId === cellar.id)
    expect(cellarLights.map((l) => l.preset)).toEqual(["candle"])
    expect(lights.some((l) => l.levelId === upper.id && l.preset === "magical")).toBe(true)
  })

  it("floors every room and stacks the slabs consistently", () => {
    // Every cell centre of the building is floored on the cellar footprint, ground, upper and roof.
    for (let x = 32.5; x < 110; x += 5) {
      for (let z = 32.5; z < 90; z += 5) {
        expect(hasGroundAt(scene, ground.id, { x, z }), `ground ${x},${z}`).toBe(true)
        const inStairwell = x > 80 && x < 100 && z > 30 && z < 40
        expect(hasGroundAt(scene, upper.id, { x, z }), `upper ${x},${z}`).toBe(!inStairwell)
        expect(hasGroundAt(scene, roof.id, { x, z }), `roof ${x},${z}`).toBe(true)
      }
    }
    // The whole ground level is covered by floors (outdoors included) without overlaps.
    const floors = objectsOfType(scene, "floor", ground.id)
    expect(floors.reduce((s, f) => s + f.rect.w * f.rect.d, 0)).toBe(200 * 150)
    for (const a of floors) for (const b of floors) if (a !== b) expect(rectsOverlap(a.rect, b.rect)).toBe(false)
  })
})

describe("Stress test", () => {
  const scene = build("stress-test")

  it("matches the benchmark budget", () => {
    expect(scene.grid).toMatchObject({ width: 60, depth: 60 })
    expect(Object.keys(scene.levels)).toHaveLength(3)
    const lights = objectsOfType(scene, "light")
    expect(lights).toHaveLength(20)
    expect(lights.every((l) => l.castsShadows && l.on)).toBe(true)
    expect(Object.keys(scene.tokens)).toHaveLength(15)
    const solids = ["wall", "pillar", "prop"].reduce((n, type) => n + Object.values(scene.objects).filter((o) => o.type === type).length, 0)
    expect(solids).toBeGreaterThanOrEqual(130)
    expect(solids).toBeLessThanOrEqual(180)
    for (const level of sortedLevels(scene)) expect(Object.values(scene.tokens).some((t) => t.levelId === level.id)).toBe(true)
  })

  it("is deterministic apart from ids", () => {
    const strip = (s: Scene) =>
      Object.values(s.objects)
        .filter((o) => o.type === "prop")
        .map((o) => (o.type === "prop" ? `${o.kind}@${o.position.x},${o.position.z}/${o.rotationY.toFixed(3)}` : ""))
        .sort()
    expect(strip(build("stress-test"))).toEqual(strip(scene))
  })
})

describe("Empty", () => {
  it("is a fresh createScene()", () => {
    const scene = build("empty")
    expect(Object.keys(scene.levels)).toHaveLength(1)
    expect(objectsOfType(scene, "floor")).toHaveLength(1)
    expect(Object.keys(scene.tokens)).toHaveLength(0)
  })
})
