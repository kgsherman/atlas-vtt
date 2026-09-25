import { beforeEach, describe, expect, it, vi } from "vitest"

import { createScene } from "@/core/scene/factory"

import { createMemoryStore, type LocalStore } from "./localStore"
import { ROOM_CODE_RE } from "./roomCodes"
import { createLocalScenesRepo } from "./scenesRepo"
import { createLocalSessionsRepo } from "./sessionsRepo"
import { isNetError, type AtlasClient } from "./supabase"
import { createLocalWorldsRepo, createRemoteWorldsRepo, normalizeCharacterName, normalizeWorldName, type WorldsRepo } from "./worldsRepo"

vi.mock("@/core/scene/schema", () => ({
  parseScene: (json: unknown) => ({ ok: true, scene: structuredClone(json), migratedFrom: null }),
  serializeScene: (scene: unknown) => JSON.stringify(scene),
}))

const DM = "d0000000-0000-4000-8000-000000000001"
const P1 = "a1000000-0000-4000-8000-000000000001"
const P2 = "a2000000-0000-4000-8000-000000000002"

async function expectNetError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(isNetError(err), `expected NetError(${code}), got ${String(err)}`).toBe(true)
  expect((err as { code: string }).code).toBe(code)
}

describe("names", () => {
  it("normalises like the SQL functions", () => {
    expect(normalizeWorldName("  Storm   King's\tThunder ")).toBe("Storm King's Thunder")
    expect(normalizeWorldName("   ")).toBe("Untitled world")
    expect(normalizeCharacterName(" Aria \n Vey ")).toBe("Aria Vey")
    expect(normalizeCharacterName(" ")).toBeNull()
    expect(normalizeCharacterName("x".repeat(80))).toHaveLength(64)
  })
})

describe("local worlds repo (dev mode, mirrors the SQL rules)", () => {
  let store: LocalStore
  let as: string
  let worlds: WorldsRepo

  beforeEach(() => {
    store = createMemoryStore()
    as = DM
    worlds = createLocalWorldsRepo({ store, userId: () => as })
  })

  it("creates, lists, renames and deletes worlds (only empty ones)", async () => {
    const tod = await worlds.create(" Tyranny  of Dragons ")
    const skt = await worlds.create("Storm King's Thunder")
    expect(tod.name).toBe("Tyranny of Dragons")
    expect(tod.roomCode).toMatch(ROOM_CODE_RE)
    expect(tod.roomCode).not.toBe(skt.roomCode)
    expect((await worlds.list()).map((w) => w.name)).toEqual(["Storm King's Thunder", "Tyranny of Dragons"])
    expect((await worlds.rename(tod.id, "ToD")).name).toBe("ToD")
    expect((await worlds.list())[0].id).toBe(tod.id)
    const scenes = createLocalScenesRepo(store)
    const scene = await scenes.create(createScene({ name: "Keep" }), { worldId: tod.id })
    await expectNetError(worlds.remove(tod.id), "world_not_empty")
    await scenes.remove(scene.id)
    await worlds.remove(tod.id)
    expect(await worlds.get(tod.id)).toBeNull()
    await expectNetError(worlds.remove(tod.id), "not_found")
  })

  it("players join by code, once per world; the DM of a live table cannot; names are unique per world", async () => {
    const w = await worlds.create("ToD")
    // The world's creator runs it, table or not.
    await expectNetError(worlds.join(w.roomCode, "Me"), "is_dm")
    expect((await worlds.info(w.id))?.role).toBe("dm")
    const scenes = createLocalScenesRepo(store)
    const sessions = createLocalSessionsRepo({ store, scenes, userId: () => as })
    await sessions.openMap((await scenes.create(createScene({ name: "Keep" }), { worldId: w.id })).id)
    await expectNetError(worlds.join(w.roomCode, "Me"), "is_dm")
    as = P1
    expect(await worlds.join(w.roomCode.toLowerCase(), "  Alice ")).toEqual({ worldId: w.id, sessionId: null })
    await expectNetError(worlds.join("ZZZZZZZZ", "Alice"), "session_not_found")
    await expectNetError(worlds.join("nope", "Alice"), "invalid_room_code")
    as = P2
    await expectNetError(worlds.join(w.roomCode, "ALICE"), "name_taken")
    await expectNetError(worlds.join(w.roomCode, "gm"), "name_taken")
    await worlds.join(w.roomCode, "Bob")
    expect(await worlds.info(w.id)).toMatchObject({ role: "player", memberStatus: "active", displayName: "Bob", openSessionId: null, characters: [] })
    expect(await worlds.listJoined()).toEqual([expect.objectContaining({ worldId: w.id, name: "ToD", displayName: "Bob" })])
    as = DM
    expect((await worlds.listMembers(w.id)).map((m) => [m.userId, m.displayName, m.status])).toEqual([
      [P1, "Alice", "active"],
      [P2, "Bob", "active"],
    ])
    expect(await worlds.setMemberStatus(w.id, P2, "kicked")).toBe(true)
    expect(await worlds.setMemberStatus(w.id, P2, "kicked")).toBe(false)
    as = P2
    await expectNetError(worlds.join(w.roomCode, "Bob"), "kicked")
    expect(await worlds.info(w.id)).toMatchObject({ memberStatus: "kicked", openSessionId: null })
  })

  it("characters: added, changed, played by players of the world only", async () => {
    const w = await worlds.create("ToD")
    as = P1
    await worlds.join(w.roomCode, "Alice")
    as = DM
    const aria = await worlds.createCharacter(w.id, { name: " Aria ", color: "#AA3355" })
    expect(aria).toMatchObject({ name: "Aria", color: "#aa3355", imageUrl: null, playerIds: [] })
    const borin = await worlds.createCharacter(w.id, { name: "Borin" })
    await expectNetError(worlds.createCharacter(w.id, { name: "  " }), "invalid_argument")
    await expectNetError(worlds.updateCharacter(aria.id, { color: "red" }), "invalid_argument")
    await expectNetError(worlds.updateCharacter(aria.id, { imageUrl: "javascript:alert(1)" }), "invalid_argument")
    expect(await worlds.updateCharacter(aria.id, { name: "Aria Vey", imageUrl: "https://example.test/a.webp" })).toMatchObject({
      name: "Aria Vey",
      imageUrl: "https://example.test/a.webp",
    })
    await worlds.setCharacterPlayers(aria, [P1, P1])
    await expectNetError(worlds.setCharacterPlayers(borin, [P2]), "invalid_argument")
    expect((await worlds.listCharacters(w.id)).map((c) => [c.name, c.playerIds])).toEqual([
      ["Aria Vey", [P1]],
      ["Borin", []],
    ])
    as = P1
    expect((await worlds.info(w.id))?.characters).toEqual(["Aria Vey"])
    as = DM
    await worlds.removeCharacter(borin.id)
    expect((await worlds.listCharacters(w.id)).map((c) => c.name)).toEqual(["Aria Vey"])
    await expectNetError(worlds.removeCharacter(borin.id), "not_found")
  })

  it("scenes stored before worlds join one \"My world\", however many readers come first", async () => {
    const at = "2026-09-20T10:00:00.000Z"
    for (const id of ["old-1", "old-2"]) await store.put("scenes", id, { id, name: id, latestVersion: 1, createdAt: at, updatedAt: at })
    const scenes = createLocalScenesRepo(store)
    // The home page asks for the worlds and the scenes at once.
    const [list, all] = await Promise.all([worlds.list(), scenes.list(), createLocalWorldsRepo({ store }).list()])
    expect(list.map((w) => w.name)).toEqual(["My world"])
    expect(new Set(all.map((x) => x.worldId))).toEqual(new Set([list[0].id]))
    expect(await worlds.list()).toHaveLength(1)
  })

  it("scenes go into the world named, else the first one", async () => {
    const scenes = createLocalScenesRepo(store)
    const first = await scenes.create(createScene({ name: "Keep" }))
    const mine = (await worlds.list())[0]
    expect(mine.name).toBe("My world")
    expect(first.worldId).toBe(mine.id)
    const skt = await worlds.create("SKT")
    expect((await scenes.create(createScene({ name: "Giant hall" }), { worldId: skt.id })).worldId).toBe(skt.id)
    expect((await scenes.create(createScene({ name: "Crypt" }))).worldId).toBe(mine.id)
    await expectNetError(scenes.create(createScene({ name: "Nowhere" }), { worldId: "no-such-world" }), "not_found")
    expect((await scenes.list({ worldId: skt.id })).map((s) => s.name)).toEqual(["Giant hall"])
  })
})

describe("remote worlds repo", () => {
  function fakeClient(rpc: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
    const client = {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args })
        return rpc(fn, args)
      }),
    }
    return { client: client as unknown as AtlasClient, calls }
  }

  it("normalises join input and maps the row (no open table: null)", async () => {
    const { client, calls } = fakeClient(() => ({ data: [{ world_id: "w", session_id: null }], error: null }))
    const repo = createRemoteWorldsRepo(client)
    expect(await repo.join("abcd-efgh", "  Bob ")).toEqual({ worldId: "w", sessionId: null })
    expect(calls).toEqual([{ fn: "join_world", args: { p_room_code: "ABCDEFGH", p_display_name: "Bob" } }])
    await expectNetError(repo.join("bad", "Bob"), "invalid_room_code")
    await expectNetError(repo.join("ABCDEFGH", " "), "invalid_display_name")
  })

  it("maps world_info rows, including NULL member columns for the DM", async () => {
    const row = {
      world_id: "w",
      name: "ToD",
      room_code: "ABCDEFGH",
      role: "dm",
      member_status: null,
      display_name: null,
      dm_display_name: null,
      open_session_id: "s",
      characters: [],
    }
    const repo = createRemoteWorldsRepo(fakeClient(() => ({ data: [row], error: null })).client)
    expect(await repo.info("w")).toEqual({
      worldId: "w",
      name: "ToD",
      roomCode: "ABCDEFGH",
      role: "dm",
      memberStatus: null,
      displayName: null,
      dmDisplayName: null,
      openSessionId: "s",
      characters: [],
    })
    expect(await createRemoteWorldsRepo(fakeClient(() => ({ data: [], error: null })).client).info("w")).toBeNull()
  })

  it("maps the RPC error codes of worlds", async () => {
    const repo = createRemoteWorldsRepo(fakeClient(() => ({ data: null, error: { code: "P0001", message: "world_not_empty", details: "" } })).client)
    await expectNetError(repo.remove("w"), "world_not_empty")
  })
})
