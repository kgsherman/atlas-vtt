/**
 * viewToScene (player-side scene reconstruction) and the strict PlayerView schema (incl. old stored views
 * and saved games from before walls had followTerrain).
 */
import { describe, expect, it } from "vitest"

import { buildOcclusionWorld } from "../occlusion"
import { groundHeightAt } from "../scene/queries"
import { sampleById } from "../scene/samples"
import type { WallObject } from "../scene/types"
import { createVisionEngine } from "../vision"
import { filterForPlayer } from "./filter"
import { MAX_TERRAIN_PROFILE, memoryObjectSchema, parsePlayerView, playerObjectSchema, playerViewSchema } from "./playerViewSchema"
import { TestHost } from "./test-utils"
import type { PlayerView, PlayerWall } from "./types"
import { objectFromPlayer, viewToScene } from "./viewToScene"

function lanternView(): { view: PlayerView; host: TestHost; brunhildId: string } {
  const scene = sampleById("crooked-lantern")!.build()
  const brunhild = Object.values(scene.tokens).find((t) => t.name === "Brunhild Ironvein")!
  const host = new TestHost(scene, ["p1"])
  host.assign(brunhild.id)
  host.dm({ t: "move-token", tokenId: brunhild.id, levelId: brunhild.levelId, x: 72.5, z: 62.5 })
  return { view: host.refresh("p1").view, host, brunhildId: brunhild.id }
}

describe("viewToScene", () => {
  const { view, brunhildId } = lanternView()
  const scene = viewToScene(view)

  it("rebuilds levels: known ones with the received terrain chunks, stubs without heightmaps", () => {
    expect(Object.keys(scene.levels).sort()).toEqual(Object.keys(view.scene.levels).sort())
    for (const l of Object.values(view.scene.levels)) {
      const lvl = scene.levels[l.id]
      expect(lvl.elevation).toBe(l.elevation)
      if (!l.known) {
        expect(lvl.heightmap).toBeNull()
        expect(lvl.name).toBe("")
      } else if (l.terrainResolution !== null) {
        expect(lvl.heightmap).toEqual({ resolution: l.terrainResolution, chunks: view.terrain[l.id] ?? {} })
      }
    }
  })

  it("maps player objects back to scene objects with neutral defaults", () => {
    expect(Object.keys(scene.objects).sort()).toEqual(Object.keys(view.objects).sort())
    for (const o of Object.values(scene.objects)) {
      const p = view.objects[o.id]
      expect(o.type).toBe(p.type)
      if (o.type === "light" && p.type === "light") {
        expect(o.on).toBe(p.emitting)
        expect(o.attachedTokenId).toBeNull()
        expect(o.preset).toBe("custom")
      }
      if (o.type === "door" && p.type === "door") {
        expect(o.state).toBe(p.state)
        expect(o.style).toBe(p.style)
        expect(scene.objects[o.wallId]?.type).toBe("wall")
      }
      if (o.type === "prop") expect(typeof o.blocksMovement).toBe("boolean")
    }
  })

  it("rebuilds tokens with defaults for the fields players never receive", () => {
    const me = scene.tokens[brunhildId]
    expect(me).toMatchObject({ name: "Brunhild Ironvein", kind: "pc", hidden: false, eyeHeight: 4 })
    for (const t of Object.values(scene.tokens)) {
      if (t.id === brunhildId) continue
      expect(t.hidden).toBe(false)
      expect(t.vision).toEqual({ darkvision: 0, blindsight: 0, blind: false })
    }
  })

  it("is simulatable: occlusion and vision run on the rebuilt scene", () => {
    const world = buildOcclusionWorld(scene)
    expect(world.primitives.length).toBeGreaterThan(0)
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(scene.tokens[brunhildId])])
    expect(Object.keys(res.perception)).toContain(view.tokens[brunhildId].levelId)
  })

  it("rebuilds walls with followTerrain (missing: true, like a migrated scene) and a copy of terrainProfile", () => {
    const piece = Object.values(view.objects).find((o): o is PlayerWall => o.type === "wall")!
    const followed = objectFromPlayer({ ...piece, terrainProfile: [1, 2.5, 3] }) as WallObject
    expect(followed).toMatchObject({ type: "wall", followTerrain: true, terrainProfile: [1, 2.5, 3] })
    expect(objectFromPlayer({ ...piece, followTerrain: false })).toMatchObject({ followTerrain: false })
    const stored = { ...piece } as Partial<PlayerWall>
    delete stored.followTerrain
    delete stored.terrainProfile
    const old = objectFromPlayer(stored as PlayerWall) as WallObject
    expect(old.followTerrain).toBe(true)
    expect(old).not.toHaveProperty("terrainProfile")
    // Never aliased: the scene the renderer keeps cannot change the view (or the host's shared arrays).
    const profile = [0, 1]
    expect((objectFromPlayer({ ...piece, terrainProfile: profile }) as WallObject).terrainProfile).not.toBe(profile)
    // The Crooked Lantern's ground floor has terrain: its follow-terrain walls arrive with their base line.
    expect(scene.objects[piece.id]).toMatchObject({ followTerrain: true, terrainProfile: piece.terrainProfile })
    expect(piece.terrainProfile?.length).toBeGreaterThanOrEqual(2)
  })

  it("places lights at their true world height on the client's ground", () => {
    const { host } = lanternView()
    const hearth = Object.values(host.scene.objects).find((o) => o.name === "Hearth fire")!
    const v = filterForPlayer(host.state, "p1", host.lastVis.get("p1")!)
    const rebuilt = viewToScene(v)
    const l = rebuilt.objects[hearth.id]
    expect(l.type).toBe("light")
    if (l.type === "light" && hearth.type === "light") {
      const hostY = groundHeightAt(host.scene, hearth.levelId, hearth.position) + hearth.position.y
      expect(groundHeightAt(rebuilt, l.levelId, l.position) + l.position.y).toBeCloseTo(hostY, 9)
    }
  })
})

describe("playerViewSchema", () => {
  const { view } = lanternView()

  it("accepts filter output unchanged", () => {
    expect(playerViewSchema.parse(view)).toEqual(view)
    expect(parsePlayerView(JSON.parse(JSON.stringify(view)))).toEqual(view)
  })

  it("rejects anything outside the allowlist", () => {
    const clone = (): PlayerView => JSON.parse(JSON.stringify(view))
    const objId = Object.keys(view.objects)[0]
    const tokId = Object.keys(view.tokens)[0]
    const levelId = Object.keys(view.scene.levels)[0]
    const bad: ((v: PlayerView) => void)[] = [
      (v) => ((v.objects[objId] as unknown as Record<string, unknown>).dmNotes = "x"),
      (v) => ((v.objects[objId] as unknown as Record<string, unknown>).name = "x"),
      (v) => ((v.tokens[tokId] as unknown as Record<string, unknown>).hidden = false),
      (v) => ((v.tokens[tokId] as unknown as Record<string, unknown>).kind = "monster"),
      (v) => ((v.scene.levels[levelId] as unknown as Record<string, unknown>).heightmap = null),
      (v) => ((v.scene.levels[levelId] as unknown as Record<string, unknown>).terrainEdits = { shapes: {}, baseChunks: {} }),
      (v) => ((v as unknown as Record<string, unknown>).memory = {}),
      (v) => ((v.scene as unknown as Record<string, unknown>).meta = {}),
      (v) => (v.objects.other = v.objects[objId]),
      (v) => {
        const door = Object.values(v.objects).find((o) => o.type === "door")
        if (door) (door as unknown as Record<string, unknown>).style = "secret"
        else (v.objects[objId] as unknown as Record<string, unknown>).type = "secret"
      },
    ]
    for (const edit of bad) {
      const v = clone()
      edit(v)
      expect(playerViewSchema.safeParse(v).success).toBe(false)
      expect(parsePlayerView(v)).toBeNull()
    }
  })

  it("accepts walls of views stored before followTerrain existed, as following the terrain", () => {
    const old: PlayerView = JSON.parse(JSON.stringify(view))
    const walls = Object.values(old.objects).filter((o) => o.type === "wall")
    expect(walls.length).toBeGreaterThan(0)
    for (const w of walls) {
      delete (w as Partial<PlayerWall>).followTerrain
      delete (w as Partial<PlayerWall>).terrainProfile
    }
    const parsed = parsePlayerView(old)!
    for (const w of walls) expect(parsed.objects[w.id]).toEqual({ ...w, followTerrain: true })
  })

  it("terrainProfile: an optional array of at most 4096 finite numbers", () => {
    const piece = Object.values(view.objects).find((o): o is PlayerWall => o.type === "wall")!
    const ok = (terrainProfile: unknown) => playerObjectSchema.safeParse({ ...piece, terrainProfile }).success
    expect(ok(undefined)).toBe(true)
    expect(ok([])).toBe(true)
    expect(ok([0, -3.25, 1e3])).toBe(true)
    expect(ok(new Array(MAX_TERRAIN_PROFILE).fill(1))).toBe(true)
    expect(MAX_TERRAIN_PROFILE).toBe(4096)
    for (const bad of [new Array(MAX_TERRAIN_PROFILE + 1).fill(1), [NaN], [Infinity], [-Infinity], ["1"], [null], 5, { 0: 1 }]) expect(ok(bad)).toBe(false)
    expect(playerObjectSchema.safeParse({ ...piece, followTerrain: "yes" }).success).toBe(false)
  })

  it("memory walls: followTerrain defaults to true (saved games), a terrainProfile is never remembered", () => {
    const piece = Object.values(view.objects).find((o): o is PlayerWall => o.type === "wall")!
    // A whole wall as remembered by a saved game from before followTerrain existed.
    const rest: Partial<PlayerWall> = { ...piece, id: piece.id.split("@")[0] }
    delete rest.followTerrain
    delete rest.terrainProfile
    expect(memoryObjectSchema.parse(rest)).toEqual({ ...rest, followTerrain: true })
    expect(memoryObjectSchema.parse({ ...rest, followTerrain: false })).toEqual({ ...rest, followTerrain: false })
    expect(memoryObjectSchema.safeParse({ ...rest, followTerrain: true, terrainProfile: [0, 0] }).success).toBe(false)
  })
})
