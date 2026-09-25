/**
 * diffViews / applyPatchOps: exact round trips (property test over random views), op granularity,
 * immutability, hostile paths, and the size of the patch for exploring one more cell.
 */
import { describe, expect, it } from "vitest"

import { sampleById } from "../scene/samples"
import { encodeMask, getCell, setCell } from "../vision/mask"
import { applyPatchOps, diffViews } from "./diff"
import { filterForPlayer } from "./filter"
import { decodeMaskCached } from "./masks"
import { playerViewSchema } from "./playerViewSchema"
import { prng, TestHost } from "./test-utils"
import type { PatchOp, PlayerObject, PlayerToken, PlayerView } from "./types"

// ---------------------------------------------------------------------------
// Random views
// ---------------------------------------------------------------------------

type Rand = () => number

const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
const int = (r: Rand, n: number) => Math.floor(r() * n)
// (+ 0 normalises −0, which JSON would turn into 0.)
const num = (r: Rand) => Math.round((r() * 200 - 50) * 100) / 100 + 0
const id = (r: Rand) => `id${int(r, 40)}`
const b64 = (r: Rand) => Array.from({ length: 4 * (1 + int(r, 4)) }, () => pick(r, [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789+/"])).join("")

function randomObject(r: Rand, oid: string, levels: string[]): PlayerObject {
  const levelId = pick(r, levels)
  switch (int(r, 5)) {
    case 0:
      return { id: oid, type: "floor", levelId, rect: { x: num(r), z: num(r), w: 5, d: 5 }, material: "wood", ...(r() < 0.5 ? { thickness: 1 } : {}) }
    case 1: {
      const follow = r() < 0.7
      return {
        id: oid,
        type: "wall",
        levelId,
        a: { x: num(r), z: num(r) },
        b: { x: num(r), z: num(r) },
        height: 10,
        thickness: 0.5,
        material: "stone",
        followTerrain: follow,
        ...(follow && r() < 0.6 ? { terrainProfile: Array.from({ length: 2 + int(r, 6) }, () => num(r)) } : {}),
      }
    }
    case 2:
      return {
        id: oid,
        type: "door",
        levelId,
        wallId: `${id(r)}@1,2`,
        offset: num(r),
        width: 4,
        height: 7,
        leaves: "single",
        hinge: "start",
        swing: 1,
        state: pick(r, ["open", "closed"] as const),
        style: "wood",
      }
    case 3:
      return {
        id: oid,
        type: "prop",
        levelId,
        kind: pick(r, ["crate", "barrel", "table"] as const),
        position: { x: num(r), y: 0, z: num(r) },
        rotationY: num(r),
        scale: { x: 1, y: 1, z: 1 },
        color: r() < 0.5 ? null : "#aabbcc",
        blocksSight: r() < 0.5,
        castsShadows: true,
      }
    default:
      return {
        id: oid,
        type: "light",
        levelId,
        position: { x: num(r), y: 5, z: num(r) },
        color: "#ffaa00",
        intensity: 1,
        brightRadius: 20,
        dimRadius: 40,
        flicker: { enabled: r() < 0.5, speed: 3, amount: 0.1 },
        on: r() < 0.5,
        castsShadows: true,
        emitting: r() < 0.5,
      }
  }
}

function randomToken(r: Rand, tid: string, levels: string[]): PlayerToken {
  const t: PlayerToken = { id: tid, levelId: pick(r, levels), position: { x: num(r), z: num(r) }, size: "medium", height: 6, color: "#112233", imageUrl: null, label: r() < 0.5 ? null : `T${int(r, 9)}` }
  if (r() < 0.4) {
    t.name = `N${int(r, 9)}`
    t.speed = 30
    t.vision = { darkvision: 60, blindsight: 0, blind: false }
    t.eyeHeight = 5
  }
  return t
}

function randomView(r: Rand): PlayerView {
  const levels = ["L0", "L1", "L2"].filter((_, k) => k === 0 || r() < 0.6)
  const view: PlayerView = {
    viewVersion: 1,
    sessionId: "s",
    userId: "u",
    scene: {
      name: pick(r, ["A", "B"]),
      grid: { cellSize: 5, width: 10, depth: 10, diagonalRule: pick(r, ["5-5-5", "5-10-5"] as const), visionOrigin: "square" },
      environment: {
        skyLevel: pick(r, ["bright", "dark"] as const),
        ambientLevel: "dark",
        ambientColor: "#000000",
        ambientIntensity: 0.1,
        directional: { enabled: r() < 0.5, kind: "moon", azimuth: 1, elevation: 1, color: "#ffffff", intensity: 1, grants: "dim" },
        backgroundColor: "#000000",
      },
      levels: {},
    },
    objects: {},
    tokens: {},
    terrain: {},
    masks: {},
    controlledTokenIds: [],
    visionTokenIds: [],
    flags: { movementLocked: r() < 0.5, sharedVision: r() < 0.5, enforceSpeed: r() < 0.5 },
  }
  for (const l of levels) {
    view.scene.levels[l] = { id: l, known: r() < 0.7, name: r() < 0.5 ? null : l, elevation: 0, height: 10, floorThickness: 1, terrainResolution: r() < 0.5 ? null : 2 }
    if (r() < 0.6) {
      const chunks: Record<string, string> = {}
      for (let k = int(r, 4); k > 0; k--) chunks[`${int(r, 3)},${int(r, 3)}`] = b64(r)
      view.terrain[l] = chunks
    }
    if (r() < 0.8) view.masks[l] = { perception: { width: 10, depth: 10, b64: b64(r) }, explored: { width: 10, depth: 10, b64: b64(r), ...(r() < 0.3 ? { partial: b64(r) } : {}) }, sunlit: { width: 10, depth: 10, b64: b64(r) } }
  }
  for (let k = int(r, 25); k > 0; k--) {
    const oid = r() < 0.3 ? `${id(r)}@${int(r, 50)},${int(r, 50)}` : id(r)
    view.objects[oid] = randomObject(r, oid, levels)
  }
  for (let k = int(r, 6); k > 0; k--) {
    const tid = `t${int(r, 10)}`
    view.tokens[tid] = randomToken(r, tid, levels)
  }
  const tids = Object.keys(view.tokens)
  view.controlledTokenIds = tids.filter(() => r() < 0.4).sort()
  view.visionTokenIds = tids.filter(() => r() < 0.4).sort()
  return view
}

/** A random edit of a view (small changes mostly, sometimes large ones). */
function mutate(r: Rand, v: PlayerView): PlayerView {
  const next: PlayerView = JSON.parse(JSON.stringify(v))
  const levels = Object.keys(next.scene.levels)
  for (let k = 1 + int(r, 6); k > 0; k--) {
    switch (int(r, 9)) {
      case 0: {
        const oid = id(r)
        next.objects[oid] = randomObject(r, oid, levels)
        break
      }
      case 1: {
        const keys = Object.keys(next.objects)
        if (keys.length) delete next.objects[pick(r, keys)]
        break
      }
      case 2: {
        const keys = Object.keys(next.tokens)
        if (keys.length) next.tokens[pick(r, keys)].position = { x: num(r), z: num(r) }
        else next.tokens.t1 = randomToken(r, "t1", levels)
        break
      }
      case 3: {
        const l = pick(r, levels)
        next.terrain[l] = { ...(next.terrain[l] ?? {}), [`${int(r, 3)},${int(r, 3)}`]: b64(r) }
        break
      }
      case 4: {
        const l = pick(r, levels)
        if (next.masks[l]) next.masks[l].explored = { width: 10, depth: 10, b64: b64(r) }
        else delete next.terrain[l]
        break
      }
      case 5:
        next.flags.movementLocked = !next.flags.movementLocked
        break
      case 6:
        next.controlledTokenIds = Object.keys(next.tokens).filter(() => r() < 0.5).sort()
        break
      case 7: {
        const l = `L${3 + int(r, 2)}`
        next.scene.levels[l] = { id: l, known: false, name: null, elevation: 10, height: 10, floorThickness: 1, terrainResolution: null }
        if (r() < 0.5) next.terrain[l] = { "0,0": b64(r) }
        break
      }
      default: {
        const keys = Object.keys(next.tokens)
        if (keys.length && r() < 0.5) {
          const t = next.tokens[pick(r, keys)]
          if (t.name === undefined) t.name = "x"
          else delete t.name
        } else next.scene.environment.directional.enabled = !next.scene.environment.directional.enabled
      }
    }
  }
  return next
}

describe("diffViews / applyPatchOps", () => {
  it("round-trips random views exactly (property test)", () => {
    const r = prng(0x5e55)
    for (let n = 0; n < 400; n++) {
      const prev = randomView(r)
      const next = n % 5 === 0 ? randomView(r) : mutate(r, prev)
      const snapshot = JSON.stringify(prev)
      const ops = diffViews(prev, next)
      const applied = applyPatchOps(prev, ops)
      expect(applied).toEqual(next)
      // Pure: the previous view is never modified.
      expect(JSON.stringify(prev)).toBe(snapshot)
      // Ops survive the wire.
      expect(applyPatchOps(JSON.parse(snapshot), JSON.parse(JSON.stringify(ops)))).toEqual(next)
      expect(diffViews(next, JSON.parse(JSON.stringify(next)))).toEqual([])
    }
  })

  it("produces no ops for identical views and a root set for no previous view", () => {
    const v = randomView(prng(1))
    expect(diffViews(v, v)).toEqual([])
    expect(diffViews(null, v)).toEqual([{ op: "set", path: [], value: v }])
    expect(applyPatchOps(randomView(prng(2)), diffViews(null, v))).toEqual(v)
  })

  it("uses object / token / chunk / mask granularity", () => {
    const base = randomView(prng(3))
    base.objects.w1 = randomObject(prng(4), "w1", ["L0"])
    base.tokens.t1 = randomToken(prng(5), "t1", ["L0"])
    base.terrain.L0 = { "0,0": "AAAA", "1,0": "BBBB" }
    base.masks.L0 = { perception: { width: 10, depth: 10, b64: "AAAA" }, explored: { width: 10, depth: 10, b64: "AAAA" }, sunlit: { width: 10, depth: 10, b64: "AAAA" } }
    const next: PlayerView = JSON.parse(JSON.stringify(base))
    ;(next.objects.w1 as { levelId: string }).levelId = "L0x"
    next.tokens.t1.position = { x: 1, z: 2 }
    next.terrain.L0["1,0"] = "CCCC"
    next.masks.L0.explored = { width: 10, depth: 10, b64: "AAAB" }
    next.flags.enforceSpeed = !next.flags.enforceSpeed
    const paths = diffViews(base, next).map((op) => op.path.join("/"))
    expect(paths.sort()).toEqual(["flags", "masks/L0/explored", "objects/w1", "terrain/L0/1,0", "tokens/t1"].sort())
  })

  it("rejects prototype-polluting paths", () => {
    const v = randomView(prng(6))
    for (const path of [["__proto__", "x"], ["objects", "constructor"], ["objects", "prototype", "x"]]) {
      expect(() => applyPatchOps(v, [{ op: "set", path, value: 1 }])).toThrow()
    }
    expect(() => applyPatchOps(v, [{ op: "del", path: [] }])).toThrow()
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it("applies deletes and nested sets on missing parents", () => {
    const v = randomView(prng(7))
    const ops: PatchOp[] = [
      { op: "set", path: ["terrain", "Lnew", "0,0"], value: "AAAA" },
      { op: "del", path: ["objects", "missing"] },
    ]
    const out = applyPatchOps(v, ops)
    expect(out.terrain.Lnew).toEqual({ "0,0": "AAAA" })
    expect(v.terrain.Lnew).toBeUndefined()
  })
})

describe("patch size", () => {
  it("exploring one more cell yields a diff under 2 KB (The Crooked Lantern)", () => {
    const scene = sampleById("crooked-lantern")!.build()
    const brunhild = Object.values(scene.tokens).find((t) => t.name === "Brunhild Ironvein")!
    const host = new TestHost(scene, ["p1"])
    host.assign(brunhild.id)
    const { view, vis } = host.refresh("p1")
    const level = brunhild.levelId
    const enc = host.state.explored.p1[level]
    const mask = decodeMaskCached(enc)
    // An unexplored cell next to an explored one (row-major scan: deterministic).
    let target = -1
    for (let c = 0; c < mask.width * mask.depth && target < 0; c++) {
      if (getCell(mask, c) || mask.partial.has(c)) continue
      const i = c % mask.width
      if ((i + 1 < mask.width && getCell(mask, c + 1)) || (i > 0 && getCell(mask, c - 1))) target = c
    }
    expect(target).toBeGreaterThanOrEqual(0)
    const grown = { width: mask.width, depth: mask.depth, bits: mask.bits.slice(), partial: new Map(mask.partial) }
    setCell(grown, target, true)
    const state = { ...host.state, explored: { p1: { ...host.state.explored.p1, [level]: encodeMask(grown) } } }
    const next = filterForPlayer(state, "p1", vis)
    const ops = diffViews(view, next)
    expect(ops.some((op) => op.path.join("/") === `masks/${level}/explored`)).toBe(true)
    expect(JSON.stringify(ops).length).toBeLessThan(2048)
    expect(applyPatchOps(view, ops)).toEqual(next)
    expect(playerViewSchema.parse(next)).toEqual(next)
  })

  it("an idle refresh sends nothing", () => {
    const scene = sampleById("crooked-lantern")!.build()
    const brunhild = Object.values(scene.tokens).find((t) => t.name === "Brunhild Ironvein")!
    const host = new TestHost(scene, ["p1"])
    host.assign(brunhild.id)
    host.refresh("p1")
    expect(host.refresh("p1").ops).toEqual([])
  })
})
