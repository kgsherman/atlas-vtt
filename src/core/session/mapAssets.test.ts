/**
 * Map images in sessions (ARCHITECTURE §9): masked floors are clipped by their covered rects and never
 * sent with their mask; backdrops reach players as placement only (no asset id, name or pixels).
 */
import { describe, expect, it } from "vitest"

import { createFloor } from "../scene/factory"
import { bytesToBase64 } from "../scene/heightmap"
import { floorRects } from "../scene/queries"
import type { FloorMask, FloorObject, Id, Rect, Scene } from "../scene/types"
import { cellTouched, createGradeMask, decodeMask } from "../vision/mask"
import type { GradeMask, VisibilityResult } from "../vision/types"
import { maskedFloorExploredRects } from "./clip"
import { applyPatchOps, diffViews } from "./diff"
import { playerBackdrop } from "./backdrop"
import { filterForPlayer } from "./filter"
import { updateKnowledge } from "./memory"
import { memoryObjectSchema, playerObjectSchema, playerViewSchema } from "./playerViewSchema"
import { reduceDm } from "./reduceDm"
import type { MemoryFloor } from "./sanitize"
import { createGameState } from "./state"
import { add, addLevel, addToken, flatScene, prng, TestHost } from "./test-utils"
import type { GameState, PlayerFloor, PlayerView } from "./types"
import { playerBackdropAssetId, viewToScene } from "./viewToScene"

/** Mask over `rect` at `spacing` whose cells are covered where `covered(x, z)` holds at the cell centre. */
function maskFrom(rect: Rect, spacing: number, covered: (x: number, z: number) => boolean): FloorMask {
  const cols = Math.round(rect.w / spacing)
  const rows = Math.round(rect.d / spacing)
  const bits = new Uint8Array(Math.ceil((cols * rows) / 8))
  for (let v = 0; v < rows; v++) {
    for (let u = 0; u < cols; u++) {
      if (!covered(rect.x + (u + 0.5) * spacing, rect.z + (v + 0.5) * spacing)) continue
      const k = v * cols + u
      bits[k >> 3] |= 1 << (k & 7)
    }
  }
  return { spacing, cols, rows, b64: bytesToBase64(bits) }
}

/** A disc-shaped cave floor (radius 22 ft around (30, 30)) over the rect 5..55. */
function caveFloor(levelId: Id): FloorObject {
  const rect = { x: 5, z: 5, w: 50, d: 50 }
  const floor = createFloor(levelId, rect, "dirt")
  floor.mask = maskFrom(rect, 1.25, (x, z) => Math.hypot(x - 30, z - 30) <= 22)
  return floor
}

function synthVis(scene: Scene, cells: Record<Id, [number, number][]>, observed: Id[] = []): VisibilityResult {
  const perception: Record<Id, GradeMask> = {}
  for (const [levelId, list] of Object.entries(cells)) {
    const m = createGradeMask(scene.grid.width, scene.grid.depth)
    for (const [i, j] of list) m.grades[j * m.width + i] = 3
    perception[levelId] = m
  }
  return { perception, sunlit: {}, visibleTokenIds: new Set(), observedObjectIds: new Set(observed), illuminatingLightIds: new Set() }
}

function withPlayer(scene: Scene, uid = "p1"): GameState {
  return reduceDm(createGameState({ sessionId: "s", roomCode: "R", scene }), { t: "add-player", userId: uid, displayName: uid }).state
}

/** Is world point p inside one of the rects (open interior)? */
const inRects = (rects: Rect[], x: number, z: number) => rects.some((r) => x > r.x && x < r.x + r.w && z > r.z && z < r.z + r.d)

/** Asserts every floor piece of `sourceId` lies inside the floor's covered rects and inside explored cells. */
function expectPiecesInside(view: PlayerView, source: FloorObject, cellSize: number): number {
  const covered = floorRects(source)
  const explored = decodeMask(view.masks[source.levelId].explored)
  let area = 0
  const pieces = Object.values(view.objects).filter((o): o is PlayerFloor => o.type === "floor" && o.id.startsWith(`${source.id}@`))
  for (const p of pieces) {
    expect(Object.keys(p).sort()).not.toContain("mask")
    area += p.rect.w * p.rect.d
    // Probe the piece at a fine lattice (centres of 0.625 ft squares).
    const step = 0.625
    for (let x = p.rect.x + step / 2; x < p.rect.x + p.rect.w; x += step) {
      for (let z = p.rect.z + step / 2; z < p.rect.z + p.rect.d; z += step) {
        expect(inRects(covered, x, z)).toBe(true)
        const c = Math.floor(z / cellSize) * explored.width + Math.floor(x / cellSize)
        expect(cellTouched(explored, c)).toBe(true)
      }
    }
  }
  return area
}

describe("masked floors", () => {
  it("keeps the mask in host memory but never sends it", () => {
    const { scene, ground } = flatScene(14, 14)
    for (const id of Object.keys(scene.objects)) delete scene.objects[id]
    const cave = add(scene, caveFloor(ground))
    const cells: [number, number][] = []
    for (let i = 2; i < 8; i++) for (let j = 3; j < 9; j++) cells.push([i, j])
    const vis = synthVis(scene, { [ground]: cells }, [cave.id])
    const state = updateKnowledge(withPlayer(scene), "p1", vis)
    const remembered = state.memory.p1[cave.id] as MemoryFloor
    expect(remembered.mask).toEqual(cave.mask)
    const view = filterForPlayer(state, "p1", vis)
    const json = JSON.stringify(view)
    expect(json).not.toContain('"mask"')
    expect(json).not.toContain(cave.mask!.b64.slice(0, 24))
    expect(() => playerViewSchema.parse(view)).not.toThrow()
    const area = expectPiecesInside(view, cave, scene.grid.cellSize)
    expect(area).toBeGreaterThan(100)
  })

  it("validates remembered masked floors with the host memory schema only", () => {
    const { scene, ground } = flatScene(14, 14)
    const cave = add(scene, caveFloor(ground))
    const state = updateKnowledge(withPlayer(scene), "p1", synthVis(scene, { [ground]: [[6, 6]] }, [cave.id]))
    const remembered = JSON.parse(JSON.stringify(state.memory.p1[cave.id]))
    expect(remembered.mask).toBeDefined()
    expect(memoryObjectSchema.safeParse(remembered).success).toBe(true)
    // The wire schema never accepts a mask.
    expect(playerObjectSchema.safeParse(remembered).success).toBe(false)
    expect(memoryObjectSchema.safeParse({ ...remembered, mask: { ...remembered.mask, b64: "AA==" } }).success).toBe(false)
    expect(memoryObjectSchema.safeParse({ ...remembered, extra: 1 }).success).toBe(false)
  })

  it("sends exactly mask ∩ explored cells (area), for random explored sets", () => {
    const rnd = prng(7)
    const { scene, ground } = flatScene(14, 14)
    for (const id of Object.keys(scene.objects)) delete scene.objects[id]
    const cave = add(scene, caveFloor(ground))
    const covered = floorRects(cave)
    for (let trial = 0; trial < 6; trial++) {
      const cells: [number, number][] = []
      for (let i = 0; i < 14; i++) for (let j = 0; j < 14; j++) if (rnd() < 0.35) cells.push([i, j])
      const vis = synthVis(scene, { [ground]: cells }, [cave.id])
      const state = updateKnowledge(withPlayer(scene), "p1", vis)
      const view = filterForPlayer(state, "p1", vis)
      const area = expectPiecesInside(view, cave, scene.grid.cellSize)
      // Expected: covered mask area inside explored cells (every covered rect split per cell).
      let expected = 0
      const set = new Set(cells.map(([i, j]) => `${i},${j}`))
      for (const r of covered) {
        for (let i = Math.floor(r.x / 5); i * 5 < r.x + r.w; i++) {
          for (let j = Math.floor(r.z / 5); j * 5 < r.z + r.d; j++) {
            if (!set.has(`${i},${j}`)) continue
            const w = Math.min(r.x + r.w, i * 5 + 5) - Math.max(r.x, i * 5)
            const d = Math.min(r.z + r.d, j * 5 + 5) - Math.max(r.z, j * 5)
            if (w > 0 && d > 0) expected += w * d
          }
        }
      }
      expect(area).toBeCloseTo(expected, 6)
    }
  })

  it("clips non-lattice masks rect by rect with the same guarantees", () => {
    const { scene, ground } = flatScene(14, 14)
    for (const id of Object.keys(scene.objects)) delete scene.objects[id]
    const rect = { x: 3.3, z: 4.1, w: 42, d: 42 }
    const floor = createFloor(ground, rect, "stone")
    floor.mask = maskFrom(rect, 1.5, (x, z) => (x - 3.3 < 21 || z - 4.1 < 21) && Math.hypot(x - 24, z - 25) > 4)
    add(scene, floor)
    const cells: [number, number][] = []
    for (let i = 0; i < 6; i++) for (let j = 1; j < 7; j++) cells.push([i, j])
    const vis = synthVis(scene, { [ground]: cells }, [floor.id])
    const state = updateKnowledge(withPlayer(scene), "p1", vis)
    const view = filterForPlayer(state, "p1", vis)
    expect(expectPiecesInside(view, floor, 5)).toBeGreaterThan(50)
  })

  it("merges an aligned mask back into few rects when fully explored", () => {
    const grid = { cellSize: 5, width: 20, depth: 20, diagonalRule: "5-5-5" as const }
    const rect = { x: 10, z: 10, w: 40, d: 40 }
    const floor = { rect, mask: maskFrom(rect, 1.25, () => true) }
    const explored = decodeMask({ width: 20, depth: 20, b64: bytesToBase64(new Uint8Array(Math.ceil(400 / 8)).fill(255)) })
    expect(maskedFloorExploredRects(grid, floor, explored)).toEqual([rect])
  })

  it("does not forget a masked floor when a perceived cell lies in its bounds but outside its mask", () => {
    const { scene, ground } = flatScene(14, 14)
    for (const id of Object.keys(scene.objects)) delete scene.objects[id]
    const cave = add(scene, caveFloor(ground))
    let state = updateKnowledge(withPlayer(scene), "p1", synthVis(scene, { [ground]: [[6, 6]] }, [cave.id]))
    expect(state.memory.p1[cave.id]).toBeDefined()
    // Cell (1, 1) (x 5–10, z 5–10) is inside the floor's rect but outside the disc: the floor is not
    // observed there, which must not delete it from memory.
    state = updateKnowledge(state, "p1", synthVis(scene, { [ground]: [[1, 1]] }))
    expect(state.memory.p1[cave.id]).toBeDefined()
  })

  it("runs through the real vision pipeline (cave with a token) without leaking the mask", () => {
    const { scene, ground } = flatScene(14, 14, "bright")
    for (const id of Object.keys(scene.objects)) delete scene.objects[id]
    const cave = add(scene, caveFloor(ground))
    const tok = addToken(scene, ground, 32.5, 32.5)
    const host = new TestHost(scene, ["p1"])
    host.assign(tok.id)
    const { view } = host.refresh("p1")
    expect(JSON.stringify(view)).not.toContain('"mask"')
    expect(expectPiecesInside(view, cave, 5)).toBeGreaterThan(500)
    expect(() => playerViewSchema.parse(view)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Backdrops
// ---------------------------------------------------------------------------

function backdropScene() {
  const { scene, ground } = flatScene(10, 10, "bright")
  const cellar = addLevel(scene, { name: "Cellar", elevation: -10 }, { x: 0, z: 0, w: 50, d: 50 })
  scene.assets = {
    SENTINELASSET1: { id: "SENTINELASSET1", kind: "image", name: "SENTINEL_SECRET_MAP.webp", mime: "image/webp", width: 1400, height: 1400, bytes: 12345 },
    SENTINELASSET2: { id: "SENTINELASSET2", kind: "image", name: "SENTINEL_CELLAR.png", mime: "image/png", width: 700, height: 700, bytes: 999 },
  }
  scene.levels[ground].backdrop = { assetId: "SENTINELASSET1", rect: { x: 0, z: 0, w: 50, d: 50 }, opacity: 0.9, tintWalls: true }
  scene.levels[cellar.id].backdrop = { assetId: "SENTINELASSET2", rect: { x: 0, z: 0, w: 50, d: 50 }, opacity: 1, tintWalls: false }
  const tok = addToken(scene, ground, 12.5, 12.5)
  return { scene, ground, cellar, tok }
}

describe("backdrops", () => {
  it("sends placement for known levels only, never the asset id or name", () => {
    const { scene, ground, cellar, tok } = backdropScene()
    const host = new TestHost(scene, ["p1"])
    host.assign(tok.id)
    const { view } = host.refresh("p1")
    expect(view.backdrops).toEqual({ [ground]: { rect: { x: 0, z: 0, w: 50, d: 50 }, opacity: 0.9, tintWalls: true, tilePx: 140 } })
    expect(view.backdrops?.[cellar.id]).toBeUndefined()
    const json = JSON.stringify(view)
    expect(json).not.toContain("SENTINEL")
    expect(json).not.toContain('"assetId"')
    expect(playerViewSchema.parse(view)).toEqual(view)
  })

  it("computes tilePx from the stored asset size and omits backdrops without metadata", () => {
    const { scene, ground, cellar } = backdropScene()
    expect(playerBackdrop(scene, cellar.id)?.tilePx).toBe(70)
    delete scene.assets!.SENTINELASSET1
    expect(playerBackdrop(scene, ground)).toBeNull()
    scene.levels[ground].backdrop = null
    expect(playerBackdrop(scene, ground)).toBeNull()
  })

  it("rejects views carrying masks, asset ids or unknown backdrop fields", () => {
    const { scene, tok } = backdropScene()
    const host = new TestHost(scene, ["p1"])
    host.assign(tok.id)
    const { view } = host.refresh("p1")
    const [levelId] = Object.keys(view.backdrops!)
    const withAsset = structuredClone(view)
    ;(withAsset.backdrops![levelId] as unknown as Record<string, unknown>).assetId = "x"
    expect(playerViewSchema.safeParse(withAsset).success).toBe(false)
    const floorId = Object.keys(view.objects).find((id) => view.objects[id].type === "floor")!
    const withMask = structuredClone(view)
    ;(withMask.objects[floorId] as unknown as Record<string, unknown>).mask = { spacing: 1.25, cols: 1, rows: 1, b64: "AQ==" }
    expect(playerViewSchema.safeParse(withMask).success).toBe(false)
    const badTile = structuredClone(view)
    badTile.backdrops![levelId].tilePx = 0
    expect(playerViewSchema.safeParse(badTile).success).toBe(false)
  })

  it("diffs backdrops per level and round-trips through applyPatchOps", () => {
    const { scene, ground, tok } = backdropScene()
    const host = new TestHost(scene, ["p1"])
    host.assign(tok.id)
    const first = host.refresh("p1").view
    // Change the opacity of the ground backdrop.
    host.dm({
      t: "apply-scene-patches",
      patches: [{ op: "replace", path: ["levels", ground, "backdrop", "opacity"], value: 0.5 }],
    })
    const { view: second, ops } = host.refresh("p1")
    expect(ops).toEqual([{ op: "set", path: ["backdrops", ground], value: { ...first.backdrops![ground], opacity: 0.5 } }])
    expect(applyPatchOps(first, ops)).toEqual(second)
    // Remove it: the whole record disappears.
    host.dm({ t: "apply-scene-patches", patches: [{ op: "replace", path: ["levels", ground, "backdrop"], value: null }] })
    const { view: third, ops: ops2 } = host.refresh("p1")
    expect(third.backdrops).toBeUndefined()
    expect(applyPatchOps(second, ops2)).toEqual(third)
    expect(applyPatchOps(first, diffViews(first, third))).toEqual(third)
  })

  it("maps backdrops to Level.backdrop with a synthetic asset id in viewToScene", () => {
    const { scene, ground, tok } = backdropScene()
    const host = new TestHost(scene, ["p1"])
    host.assign(tok.id)
    const { view } = host.refresh("p1")
    const rebuilt = viewToScene(view)
    expect(rebuilt.levels[ground].backdrop).toEqual({ assetId: playerBackdropAssetId(ground), rect: { x: 0, z: 0, w: 50, d: 50 }, opacity: 0.9, tintWalls: true })
    expect(playerBackdropAssetId(ground)).not.toContain("SENTINEL")
  })
})
