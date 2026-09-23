/* eslint-disable @typescript-eslint/no-explicit-any -- these tests poke at raw, untyped JSON documents */
import { describe, expect, it } from "vitest"

import { createConnector, createDoor, createFloor, createLevel, createLight, createPillar, createProp, createScene, createToken, createWall, createWindow } from "./factory"
import { bytesToBase64, chunkSamples, createHeightmap, encodeChunk, sampleCounts, writeHeights } from "./heightmap"
import { parseScene, parseSceneJson, SCENE_LIMITS, sceneSchema, serializeScene } from "./schema"
import { SCENE_SCHEMA_VERSION, type Scene, type TerrainShape } from "./types"

/** A canonical (positive signed area) regular polygon footprint at top height y. */
function ngon(cx: number, cz: number, r: number, sides: number, y: number): TerrainShape["points"] {
  return Array.from({ length: sides }, (_, k) => ({ x: cx + r * Math.cos((2 * Math.PI * k) / sides), y, z: cz + r * Math.sin((2 * Math.PI * k) / sides) }))
}

/** A small scene using every object type, with terrain and terrain edits. */
function fullScene(): Scene {
  const scene = createScene({ name: "Test", width: 20, depth: 16 })
  const ground = Object.values(scene.levels)[0]
  const upper = createLevel({ name: "Upper", elevation: 10 })
  scene.levels[upper.id] = upper
  const add = <T extends Scene["objects"][string]>(o: T) => {
    scene.objects[o.id] = o
    return o
  }
  const wall = add(createWall(ground.id, { x: 10, z: 10 }, { x: 40, z: 10 }))
  add(createDoor(wall, 10))
  add(createWindow(wall, 22))
  add(createFloor(upper.id, { x: 0, z: 0, w: 50, d: 50 }, "wood"))
  add(createConnector(ground.id, upper.id, { x: 50, z: 20, w: 10, d: 20 }, 0, "stairs"))
  add(createConnector(ground.id, upper.id, { x: 5, z: 5, w: 5, d: 5 }, 0, "ladder"))
  add(createPillar(ground.id, { x: 30, z: 30 }))
  add(createProp(ground.id, "tree", { x: 70, y: 0, z: 60 }, { rotationY: 1.2, color: "#336633" }))
  const token = createToken(ground.id, { x: 22.5, z: 22.5 }, { name: "Hero", label: "Hero", imageUrl: "https://example.com/hero.png" })
  scene.tokens[token.id] = token
  add(createLight(ground.id, "torch", { x: 12, z: 12 }))
  add(createLight(ground.id, "lantern", { x: 0.5, z: 0 }, { attachedTokenId: token.id }))
  const { samplesX, samplesZ } = sampleCounts(scene.grid, 2)
  const dense = new Float32Array(samplesX * samplesZ)
  dense[20 * samplesX + 30] = 3.5
  ground.heightmap = writeHeights(createHeightmap(2), scene.grid, dense)
  const base = new Float32Array(chunkSamples(2) ** 2)
  base[17] = -1.25
  ground.terrainEdits = {
    shapes: {
      mound: {
        id: "mound",
        name: "Mound",
        kind: "block",
        op: "add",
        order: 0,
        points: [
          { x: 20, y: 4, z: 20 },
          { x: 35, y: 4, z: 20 },
          { x: 35, y: 4, z: 30 },
          { x: 20, y: 4, z: 30 },
        ],
        base: 0,
      },
      pit: { id: "pit", kind: "cylinder", op: "carve", order: 1, points: ngon(60, 40, 5, 12, -3), base: 0 },
    },
    baseChunks: { "0,0": "", "1,0": encodeChunk(base) },
  }
  return scene
}

/** JSON round trip (what a file import sees). */
const json = (scene: Scene): Record<string, any> => JSON.parse(serializeScene(scene))

function expectInvalid(doc: unknown, pattern?: RegExp) {
  const res = parseScene(doc)
  expect(res.ok).toBe(false)
  if (!res.ok) {
    expect(res.error).toBe("invalid")
    if (pattern) expect(res.issues.join("\n")).toMatch(pattern)
  }
  return res
}

/** Mutate a JSON copy of fullScene() and expect it to be rejected. */
function rejects(mutate: (doc: Record<string, any>, scene: Scene) => void, pattern?: RegExp) {
  const scene = fullScene()
  const doc = json(scene)
  mutate(doc, scene)
  return expectInvalid(doc, pattern)
}

const firstOf = (scene: Scene, type: string) => Object.values(scene.objects).find((o) => o.type === type)!

describe("parseScene", () => {
  it("accepts a fresh scene and a full scene, round-tripping exactly", () => {
    for (const scene of [createScene(), fullScene()]) {
      const res = parseScene(json(scene))
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.scene).toEqual(scene)
        expect(res.migratedFrom).toBeNull()
      }
    }
  })

  it("parses .atlas.json text", () => {
    expect(parseSceneJson(serializeScene(fullScene(), true)).ok).toBe(true)
    expect(parseSceneJson("{nope")).toMatchObject({ ok: false, error: "invalid" })
  })

  it("reports documents from a newer version as too-new", () => {
    const doc = json(fullScene())
    doc.schemaVersion = SCENE_SCHEMA_VERSION + 1
    expect(parseScene(doc)).toMatchObject({ ok: false, error: "too-new" })
  })

  it("rejects unknown keys everywhere (strict)", () => {
    rejects((d) => (d.extra = 1), /Unrecognized key/)
    rejects((d) => (d.grid.extra = 1), /grid/)
    rejects((d) => (d.environment.directional.extra = 1), /directional/)
    rejects((d, s) => (d.objects[firstOf(s, "wall").id].secret = "x"), /Unrecognized key/)
    rejects((d) => ((Object.values(d.tokens)[0] as Record<string, unknown>).isAdmin = true))
    rejects((d) => ((Object.values(d.levels)[0] as Record<string, unknown>).extra = null))
  })

  it("enforces grid, count and string bounds", () => {
    rejects((d) => (d.grid.width = SCENE_LIMITS.maxGridCells + 1), /grid\.width/)
    rejects((d) => (d.grid.depth = 0), /grid\.depth/)
    rejects((d) => (d.grid.width = 10.5), /grid\.width/)
    rejects((d) => (d.name = "x".repeat(SCENE_LIMITS.maxString + 1)), /name/)
    rejects((d, s) => (d.objects[firstOf(s, "wall").id].dmNotes = "x".repeat(SCENE_LIMITS.maxString + 1)))
    rejects((d) => (d.levels = {}), /levels/)
    rejects((d) => {
      for (let k = 0; k <= SCENE_LIMITS.maxObjects; k++) d.objects[`o${k}`] = {}
    }, /objects: expected 0\.\.20000 entries/)
  })

  it("enforces numeric rules", () => {
    rejects((d, s) => (d.objects[firstOf(s, "light").id].dimRadius = 5), /dimRadius/)
    rejects((d, s) => (d.objects[firstOf(s, "wall").id].thickness = 0), /thickness/)
    rejects((d, s) => (d.objects[firstOf(s, "wall").id].b = { ...d.objects[firstOf(s, "wall").id].a }), /at least/)
    rejects((d, s) => (d.objects[firstOf(s, "prop").id].scale.x = -1), /scale/)
    rejects((d, s) => (d.objects[firstOf(s, "door").id].swing = 0))
    rejects((d, s) => (d.objects[firstOf(s, "connector").id].direction = 4))
    // Values JSON cannot carry but a caller could pass in.
    rejects((d, s) => (d.objects[firstOf(s, "pillar").id].position.x = Infinity))
    rejects((d, s) => (d.objects[firstOf(s, "pillar").id].size = NaN))
  })

  it("requires coordinates within the extent ± margin", () => {
    const m = SCENE_LIMITS.coordMargin
    // Grid is 20×16 cells of 5 ft = 100×80 ft.
    rejects((d, s) => (d.objects[firstOf(s, "wall").id].a = { x: -m - 1, z: 0 }), /outside the scene extent/)
    rejects((d, s) => (d.objects[firstOf(s, "pillar").id].position = { x: 50, z: 80 + m + 1 }), /outside/)
    rejects((d) => ((Object.values(d.tokens)[0] as Record<string, any>).position = { x: 100 + m + 0.5, z: 0 }), /outside/)
    rejects((d, s) => (d.objects[firstOf(s, "floor").id].rect = { x: 0, z: 0, w: 200, d: 10 }), /outside/)
    // Attached light positions are offsets from the carrier.
    const attached = (s: Scene) => Object.values(s.objects).find((o) => o.type === "light" && o.attachedTokenId)!
    rejects((d, s) => (d.objects[attached(s).id].position.x = m + 1), /attached light offset/)
    // …but inside the margin is fine.
    const scene = fullScene()
    const doc = json(scene)
    doc.objects[firstOf(scene, "pillar").id].position = { x: -m, z: 80 + m }
    expect(parseScene(doc).ok).toBe(true)
  })

  it("requires cell-aligned connectors and 1×1 ladders", () => {
    const ladder = (s: Scene) => Object.values(s.objects).find((o) => o.type === "connector" && o.style === "ladder")!
    const stairs = (s: Scene) => Object.values(s.objects).find((o) => o.type === "connector" && o.style === "stairs")!
    rejects((d, s) => (d.objects[stairs(s).id].rect.x = 51), /cell-aligned/)
    rejects((d, s) => (d.objects[ladder(s).id].rect.w = 10), /1×1/)
  })

  it("validates colours, ids, enums and image URLs", () => {
    rejects((d, s) => (d.objects[firstOf(s, "light").id].color = "orange"), /colour/)
    rejects((d, s) => (d.objects[firstOf(s, "prop").id].kind = "dragon"))
    rejects((d, s) => (d.objects[firstOf(s, "wall").id].material = "cheese"))
    rejects((d) => ((Object.values(d.tokens)[0] as Record<string, unknown>).imageUrl = "javascript:alert(1)"), /imageUrl/)
    rejects((d) => ((Object.values(d.tokens)[0] as Record<string, unknown>).imageUrl = "//evil.example/x.png"), /imageUrl/)
    rejects((d) => (d.id = "has space"), /id/)
    const ok: Record<string, any> = json(fullScene())
    const token = Object.values(ok.tokens)[0] as Record<string, unknown>
    token.imageUrl = "/assets/tokens/goblin.png"
    expect(parseScene(ok).ok).toBe(true)
  })

  it("accepts free token model references only", () => {
    for (const model of ["https://x.example/a.glb", "free:", "free:Elf", "free:-x", "elf-archer", 42]) {
      rejects((d) => ((Object.values(d.tokens)[0] as Record<string, unknown>).model = model), /model/)
    }
    const ok: Record<string, any> = json(fullScene())
    const token = Object.values(ok.tokens)[0] as Record<string, unknown>
    token.model = "free:elf-archer"
    const parsed = parseScene(ok)
    expect(parsed.ok && Object.values(parsed.scene.tokens)[0].model).toBe("free:elf-archer")
  })

  it("validates heightmaps", () => {
    const hmOf = (d: Record<string, any>) => (Object.values(d.levels) as Record<string, any>[]).find((l) => l.heightmap)!.heightmap
    rejects((d) => (hmOf(d).resolution = 3), /resolution/)
    rejects((d) => {
      const hm = hmOf(d)
      const [k] = Object.keys(hm.chunks)
      hm.chunks[`0${k}`] = hm.chunks[k]
      delete hm.chunks[k]
    }, /chunk key/)
    rejects((d) => (hmOf(d).chunks["x,1"] = hmOf(d).chunks[Object.keys(hmOf(d).chunks)[0]]), /chunk key/)
    // Wrong byte length (a res-1 chunk under a res-2 heightmap).
    rejects((d) => (hmOf(d).chunks["0,0"] = encodeChunk(new Float32Array(chunkSamples(1) ** 2))), /exactly 1024 bytes/)
    rejects((d) => (hmOf(d).chunks["0,0"] = bytesToBase64(new Uint8Array(1023)) + "="), /base64|bytes/)
    // Non-finite samples.
    rejects((d) => {
      const arr = new Float32Array(chunkSamples(2) ** 2)
      arr[5] = NaN
      hmOf(d).chunks["0,0"] = encodeChunk(arr)
    }, /finite height/)
    // Chunk beyond the grid: 20×16 cells at res 2 → 41×33 samples → 3×3 chunks of 16.
    rejects((d) => (hmOf(d).chunks["3,0"] = hmOf(d).chunks[Object.keys(hmOf(d).chunks)[0]]), /outside the grid/)
  })

  it("requires followTerrain on walls and rejects the player-only terrainProfile", () => {
    rejects((d, s) => delete d.objects[firstOf(s, "wall").id].followTerrain, /followTerrain/)
    rejects((d, s) => (d.objects[firstOf(s, "wall").id].followTerrain = "yes"), /followTerrain/)
    rejects((d, s) => (d.objects[firstOf(s, "wall").id].terrainProfile = [0, 1]), /Unrecognized key/)
    const scene = fullScene()
    const doc = json(scene)
    doc.objects[firstOf(scene, "wall").id].followTerrain = false
    const res = parseScene(doc)
    expect(res.ok && res.scene.objects[firstOf(scene, "wall").id]).toMatchObject({ followTerrain: false })
  })

  describe("terrain edits", () => {
    const groundOf = (d: Record<string, any>) => (Object.values(d.levels) as Record<string, any>[]).find((l) => l.terrainEdits)!
    const teOf = (d: Record<string, any>) => groundOf(d).terrainEdits
    const mound = (d: Record<string, any>) => teOf(d).shapes.mound

    it("round-trip and are optional", () => {
      const scene = fullScene()
      const ground = Object.values(scene.levels).find((l) => l.terrainEdits)!
      const res = parseScene(json(scene))
      expect(res.ok && res.scene.levels[ground.id].terrainEdits).toEqual(ground.terrainEdits)
      const plain = json(scene)
      delete groundOf(plain).terrainEdits
      expect(parseScene(plain).ok).toBe(true)
    })

    it("require a heightmap and at least one shape", () => {
      rejects((d) => (groundOf(d).heightmap = null), /terrainEdits: terrain edits require a heightmap/)
      rejects((d) => (teOf(d).shapes = {}), /at least one shape/)
      rejects((d) => delete teOf(d).baseChunks, /baseChunks/)
      rejects((d) => (teOf(d).extra = 1), /Unrecognized key/)
    })

    it("validate shapes strictly", () => {
      rejects((d) => (mound(d).kind = "sphere"), /kind/)
      rejects((d) => (mound(d).op = "xor"), /op/)
      rejects((d) => (mound(d).order = 1.5), /order/)
      rejects((d) => (mound(d).order = -1), /order/)
      rejects((d) => (mound(d).order = 1e6 + 1), /order/)
      rejects((d) => (mound(d).name = "x".repeat(SCENE_LIMITS.maxString + 1)), /name/)
      rejects((d) => (mound(d).secret = 1), /Unrecognized key/)
      rejects((d) => (mound(d).points[0].w = 1), /Unrecognized key/)
      rejects((d) => (mound(d).points = mound(d).points.slice(0, 2)), /points/)
      rejects((d) => (mound(d).points = ngon(50, 40, 5, SCENE_LIMITS.maxTerrainShapePoints + 1, 1)), /points/)
      rejects((d) => (mound(d).points[1].y = SCENE_LIMITS.maxTerrainHeight + 1), /points/)
      rejects((d) => (mound(d).points[1].x = NaN), /points/)
      rejects((d) => (mound(d).base = -SCENE_LIMITS.maxTerrainHeight - 1), /base/)
      rejects((d) => (teOf(d).shapes["bad id"] = { ...mound(d), id: "bad id" }), /id/)
      // The largest allowed shape is fine.
      const ok = json(fullScene())
      mound(ok).points = ngon(50, 40, 5, SCENE_LIMITS.maxTerrainShapePoints, 1)
      expect(parseScene(ok).ok).toBe(true)
    })

    it("require the canonical orientation and a non-degenerate footprint", () => {
      rejects((d) => mound(d).points.reverse(), /signed area/)
      rejects((d) => {
        mound(d).points = [
          { x: 20, y: 1, z: 20 },
          { x: 30, y: 1, z: 20 },
          { x: 40, y: 1, z: 20 },
        ]
      }, /signed area/)
    })

    it("validate base chunks like heightmap chunks, with \"\" for all-zero chunks", () => {
      rejects((d) => (teOf(d).baseChunks["00,1"] = ""), /chunk key/)
      rejects((d) => (teOf(d).baseChunks["0,1"] = encodeChunk(new Float32Array(chunkSamples(1) ** 2))), /exactly 1024 bytes/)
      rejects((d) => {
        const arr = new Float32Array(chunkSamples(2) ** 2)
        arr[3] = NaN
        teOf(d).baseChunks["0,1"] = encodeChunk(arr)
      }, /baseChunks\.0,1: chunk sample 3 is not a finite height/)
      // 20×16 cells at res 2 → 3×3 chunks.
      rejects((d) => (teOf(d).baseChunks["0,3"] = ""), /baseChunks\.0,3: chunk lies outside the grid/)
      // "" is a base-chunk sentinel only.
      rejects((d) => (groundOf(d).heightmap.chunks["2,2"] = ""), /heightmap\.chunks\.2,2: chunk must decode/)
      // Base chunks use the level's resolution.
      rejects((d) => (groundOf(d).heightmap.resolution = 4), /baseChunks\.1,0: chunk must decode to exactly 4096 bytes/)
    })

    it("require shape points within the extent ± margin", () => {
      const m = SCENE_LIMITS.coordMargin
      // Grid is 20×16 cells of 5 ft = 100×80 ft.
      rejects((d) => (mound(d).points[1].x = 100 + m + 1), /shapes\.mound\.points\.1: point lies outside the scene extent/)
      rejects((d) => (mound(d).points[0].z = -m - 1), /outside the scene extent/)
    })

    it("count shapes and points on the raw input", () => {
      const shapes = (d: Record<string, any>, n: number, sides: number) => {
        const shape = mound(d)
        teOf(d).shapes = {}
        for (let k = 0; k < n; k++) teOf(d).shapes[`s${k}`] = { ...shape, id: `s${k}`, points: ngon(50, 40, 5, sides, 1) }
      }
      rejects((d) => shapes(d, SCENE_LIMITS.maxTerrainShapesPerLevel + 1, 3), /expected at most 1000 terrain shapes, got 1001/)
      rejects((d) => shapes(d, SCENE_LIMITS.maxTerrainPointsPerLevel / 50 + 1, 50), /expected at most 16000 terrain shape points per level/)
      // A huge vertex array is refused before any per-point validation.
      rejects((d) => (mound(d).points = new Array(1e5).fill({ x: 0, y: 0, z: 0 })), /expected at most 64 points per terrain shape, got 100000/)
      const ok = json(fullScene())
      shapes(ok, SCENE_LIMITS.maxTerrainShapesPerLevel, 16)
      expect(parseScene(ok).ok).toBe(true)
    })

    it("require shape keys to match their ids (scoped to the level)", () => {
      rejects((d) => (teOf(d).shapes.mound.id = "pit"), /terrain shape \["mound"\]: id "pit" does not match its key/)
      // Shape ids may repeat across levels and reuse object ids.
      const scene = fullScene()
      const doc = json(scene)
      const upper = (Object.values(doc.levels) as Record<string, any>[]).find((l) => !l.terrainEdits)!
      upper.heightmap = { resolution: 1, chunks: {} }
      upper.terrainEdits = { shapes: { mound: mound(doc) }, baseChunks: {} }
      const wallId = firstOf(scene, "wall").id
      teOf(doc).shapes[wallId] = { ...mound(doc), id: wallId }
      expect(parseScene(doc).ok).toBe(true)
    })
  })

  it("runs reference validation", () => {
    rejects((d, s) => (d.objects[firstOf(s, "door").id].wallId = firstOf(s, "pillar").id), /not a wall/)
    rejects((d, s) => (d.objects[firstOf(s, "connector").id].toLevelId = firstOf(s, "connector").levelId), /own level/)
    rejects((d) => ((Object.values(d.tokens)[0] as Record<string, unknown>).levelId = "nowhere"), /does not exist/)
  })

  it("exposes the raw schema", () => {
    expect(sceneSchema.safeParse(json(fullScene())).success).toBe(true)
  })

  it("caps the number of reported issues", () => {
    const res = rejects((d) => {
      for (const o of Object.values(d.objects) as Record<string, unknown>[]) o.bogus = 1
      for (let k = 0; k < 100; k++) d.objects[`x${k}`] = { type: "nope" }
    })
    if (!res.ok) expect(res.issues.length).toBeLessThanOrEqual(51)
  })
})
