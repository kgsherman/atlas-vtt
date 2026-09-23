import { beforeEach, describe, expect, it, vi } from "vitest"

import { createScene } from "@/core/scene/factory"
import { SCENE_SCHEMA_VERSION } from "@/core/scene/types"
import type { GameState, PlayerView } from "@/core/session/types"

import { createMemoryStore, type LocalStore } from "./localStore"
import { createLocalScenesRepo } from "./scenesRepo"
import {
  createLocalSessionsRepo,
  createRemoteSessionsRepo,
  formatRoomCode,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  parseSessionStateContent,
  ROOM_CODE_RE,
  type SessionsRepo,
} from "./sessionsRepo"
import { isNetError, type AtlasClient } from "./supabase"

vi.mock("@/core/scene/schema", () => ({
  parseScene: (json: unknown) => ({ ok: true, scene: structuredClone(json), migratedFrom: null }),
  serializeScene: (scene: unknown) => JSON.stringify(scene),
}))

const DM = "d0000000-0000-4000-8000-000000000001"
const P1 = "a1000000-0000-4000-8000-000000000001"
const P2 = "a2000000-0000-4000-8000-000000000002"
const P3 = "a3000000-0000-4000-8000-000000000003"

async function expectNetError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(isNetError(err), `expected NetError(${code}), got ${String(err)}`).toBe(true)
  expect((err as { code: string }).code).toBe(code)
}

const view = (userId: string, extra: Partial<PlayerView> = {}) => ({ viewVersion: 1, sessionId: "s", userId, ...extra }) as unknown as PlayerView
const state = { stateVersion: 1, marker: "saved" } as unknown as GameState

describe("room codes", () => {
  it("generates 8 Crockford base32 characters", () => {
    for (let i = 0; i < 200; i++) expect(generateRoomCode()).toMatch(ROOM_CODE_RE)
  })

  it("normalises like the SQL function (case, separators, I/L/O)", () => {
    expect(normalizeRoomCode(" abcd-efgh ")).toBe("ABCDEFGH")
    expect(normalizeRoomCode("il0o_1234")).toBe("11001234")
    expect(isValidRoomCode("abcd efgh")).toBe(true)
    expect(isValidRoomCode("ABCDEFGU")).toBe(false) // U is not in the alphabet
    expect(isValidRoomCode("ABC")).toBe(false)
    expect(formatRoomCode("abcdefgh")).toBe("ABCD-EFGH")
  })
})

describe("parseSessionStateContent", () => {
  it("recognises the create_session seed", () => {
    expect(parseSessionStateContent({ kind: "seed", sceneId: "x", sceneVersion: 3, schemaVersion: 1, scene: { a: 1 } })).toEqual({
      kind: "seed",
      sceneId: "x",
      sceneVersion: 3,
      schemaVersion: 1,
      scene: { a: 1 },
    })
  })

  it("reads the free asset categories of the seed (known ones, sorted, each once)", () => {
    const content = parseSessionStateContent({ kind: "seed", sceneId: "x", sceneVersion: 1, schemaVersion: 2, scene: {}, freeAssets: ["token-models", "maps", "token-models"] })
    expect(content).toMatchObject({ kind: "seed", freeAssets: ["token-models"] })
  })

  it("treats anything else as a saved game state (validated by the host)", () => {
    expect(parseSessionStateContent({ stateVersion: 1 })).toEqual({ kind: "game", state: { stateVersion: 1 } })
  })
})

describe("local sessions repo (dev mode, mirrors the SQL rules)", () => {
  let store: LocalStore
  let as: string
  let repo: SessionsRepo
  let sceneId: string

  beforeEach(async () => {
    store = createMemoryStore()
    as = DM
    const scenes = createLocalScenesRepo(store)
    repo = createLocalSessionsRepo({ store, scenes, userId: () => as })
    const scene = createScene({ name: "Keep" })
    sceneId = (await scenes.create(scene)).id
    await scenes.saveVersion(sceneId, { ...scene, name: "Keep v2" })
  })

  it("creates a session seeded from the latest scene version", async () => {
    const { sessionId, roomCode } = await repo.createSession(sceneId)
    expect(roomCode).toMatch(ROOM_CODE_RE)
    const row = await repo.loadSessionState(sessionId)
    expect(row?.epoch).toBe(0)
    expect(row?.content).toMatchObject({ kind: "seed", sceneId, sceneVersion: 2, schemaVersion: SCENE_SCHEMA_VERSION, freeAssets: [] })
    expect(row?.content.kind === "seed" && (row.content.scene as { name: string }).name).toBe("Keep v2")
    expect(await repo.listMySessions()).toEqual([expect.objectContaining({ id: sessionId, status: "active", hostEpoch: 0 })])
  })

  it("seeds the free asset categories chosen for the game", async () => {
    const { sessionId } = await repo.createSession(sceneId, { freeAssets: ["token-models", "token-models"] })
    const row = await repo.loadSessionState(sessionId)
    expect(row?.content).toMatchObject({ kind: "seed", freeAssets: ["token-models"] })
  })

  it("joins by room code, rejects the DM, bad codes and kicked players", async () => {
    const { sessionId, roomCode } = await repo.createSession(sceneId)
    await expectNetError(repo.joinSession(roomCode, "DM"), "is_dm")
    as = P1
    expect(await repo.joinSession(roomCode.toLowerCase(), "  Alice ")).toBe(sessionId)
    await expectNetError(repo.joinSession("ZZZZZZZZ", "Alice"), "session_not_found")
    await expectNetError(repo.joinSession("nope", "Alice"), "invalid_room_code")
    await expectNetError(repo.joinSession(roomCode, " "), "invalid_display_name")
    expect(await repo.sessionInfo(sessionId)).toMatchObject({ role: "player", memberStatus: "active", displayName: "Alice" })
    // Names: no posing as the DM, no duplicates (any case); renaming yourself is fine.
    as = P2
    await expectNetError(repo.joinSession(roomCode, "alice"), "name_taken")
    await expectNetError(repo.joinSession(roomCode, "Dungeon Master"), "name_taken")
    expect(await repo.joinSession(roomCode, "Bob")).toBe(sessionId)
    as = P1
    expect(await repo.joinSession(roomCode, "ALICE")).toBe(sessionId)
    await expectNetError(repo.joinSession(roomCode, "bob"), "name_taken")
    await expectNetError(repo.listSessionMembers(sessionId), "forbidden")
    await expectNetError(repo.claimHost(sessionId), "not_found")

    as = DM
    expect(await repo.setMemberStatus(sessionId, P1, "kicked")).toBe(true)
    expect(await repo.setMemberStatus(sessionId, P1, "kicked")).toBe(false)
    expect(await repo.listSessionMembers(sessionId)).toEqual([expect.objectContaining({ userId: P1, status: "kicked" }), expect.objectContaining({ userId: P2, status: "active" })])
    as = P1
    await expectNetError(repo.joinSession(roomCode, "Alice"), "kicked")
    expect((await repo.sessionInfo(sessionId))?.memberStatus).toBe("kicked")
    as = P3
    expect(await repo.sessionInfo(sessionId)).toBeNull()
  })

  it("fences state writes by host epoch", async () => {
    const { sessionId, roomCode } = await repo.createSession(sceneId)
    as = P1
    await repo.joinSession(roomCode, "Alice")
    as = DM
    expect(await repo.claimHost(sessionId)).toBe(1)
    expect(await repo.claimHost(sessionId)).toBe(2)
    await expectNetError(repo.saveSessionState(sessionId, 1, state), "stale_epoch")
    await repo.saveSessionState(sessionId, 2, state)
    const row = await repo.loadSessionState(sessionId)
    expect(row).toMatchObject({ epoch: 2, content: { kind: "game", state: { marker: "saved" } } })

    expect(await repo.upsertPlayerView({ sessionId, userId: P1, hostEpoch: 2, epoch: "w1", seq: 5, view: view(P1) })).toBe(true)
    expect(await repo.upsertPlayerView({ sessionId, userId: P1, hostEpoch: 2, epoch: "w1", seq: 4, view: view(P1) })).toBe(false)
    expect(await repo.upsertPlayerView({ sessionId, userId: P1, hostEpoch: 2, epoch: "w2", seq: 0, view: view(P1) })).toBe(true)
    await expectNetError(repo.upsertPlayerView({ sessionId, userId: P1, hostEpoch: 1, epoch: "w1", seq: 9, view: view(P1) }), "stale_epoch")
    await expectNetError(repo.upsertPlayerView({ sessionId, userId: P2, hostEpoch: 2, epoch: "w1", seq: 1, view: view(P2) }), "not_member")

    as = P1
    expect(await repo.loadPlayerView(sessionId, P1)).toMatchObject({ epoch: "w2", seq: 0, hostEpoch: 2 })
    await expectNetError(repo.saveSessionState(sessionId, 2, state), "not_found")
    expect(await repo.loadSessionState(sessionId)).toBeNull()
    as = P2
    expect(await repo.loadPlayerView(sessionId, P1)).toBeNull()
  })

  it("ending a session bumps the epoch, frees the room code and drops views", async () => {
    const { sessionId, roomCode } = await repo.createSession(sceneId)
    as = P1
    await repo.joinSession(roomCode, "Alice")
    as = DM
    const epoch = await repo.claimHost(sessionId)
    await repo.upsertPlayerView({ sessionId, userId: P1, hostEpoch: epoch, epoch: "w", seq: 1, view: view(P1) })
    expect(await repo.endSession(sessionId)).toBe(true)
    expect(await repo.endSession(sessionId)).toBe(false)
    await expectNetError(repo.claimHost(sessionId), "session_ended")
    await expectNetError(repo.saveSessionState(sessionId, epoch + 1, state), "session_ended")
    expect(await repo.loadPlayerView(sessionId, P1)).toBeNull()
    as = P1
    await expectNetError(repo.joinSession(roomCode, "Alice"), "session_not_found")
    expect(await repo.listMyMemberships(P1)).toEqual([expect.objectContaining({ sessionId, status: "active" })])
  })
})

// ---------------------------------------------------------------------------
// Remote wrappers against a fake supabase client (no network)
// ---------------------------------------------------------------------------

type RpcResult = { data: unknown; error: unknown }

function fakeClient(rpcImpl: (fn: string, args: Record<string, unknown>) => RpcResult, table: RpcResult = { data: null, error: null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const query: string[] = []
  const builder: Record<string, unknown> = {}
  for (const m of ["select", "eq", "order"]) {
    builder[m] = (...args: unknown[]) => {
      query.push(`${m}(${args.map((a) => JSON.stringify(a)).join(",")})`)
      return builder
    }
  }
  builder.maybeSingle = async () => table
  builder.then = (resolve: (v: RpcResult) => unknown) => Promise.resolve(table).then(resolve)
  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return rpcImpl(fn, args)
    }),
    from: (name: string) => {
      query.push(`from(${name})`)
      return builder
    },
  }
  return { client: client as unknown as AtlasClient, calls, query }
}

describe("remote sessions repo", () => {
  it("normalises and validates join input before calling the RPC", async () => {
    const { client, calls } = fakeClient(() => ({ data: "sid", error: null }))
    const repo = createRemoteSessionsRepo(client)
    expect(await repo.joinSession("abcd-efgh", "  Bob  ")).toBe("sid")
    expect(calls).toEqual([{ fn: "join_session", args: { p_room_code: "ABCDEFGH", p_display_name: "Bob" } }])
    await expectNetError(repo.joinSession("bad", "Bob"), "invalid_room_code")
    await expectNetError(repo.joinSession("ABCDEFGH", ""), "invalid_display_name")
    expect(calls).toHaveLength(1)
  })

  it("maps RPC exception codes to typed NetErrors", async () => {
    const { client } = fakeClient((fn) => ({ data: null, error: { message: fn === "join_session" ? "kicked" : "stale_epoch", code: "P0001", details: "why", hint: null } }))
    const repo = createRemoteSessionsRepo(client)
    await expectNetError(repo.joinSession("ABCDEFGH", "Bob"), "kicked")
    await expectNetError(repo.saveSessionState("s", 1, state), "stale_epoch")
  })

  it("maps permission errors and network failures", async () => {
    const denied = createRemoteSessionsRepo(fakeClient(() => ({ data: null, error: { message: "permission denied for function claim_host", code: "42501" } })).client)
    await expectNetError(denied.claimHost("s"), "permission_denied")
    const offline = createRemoteSessionsRepo(fakeClient(() => ({ data: null, error: { message: "TypeError: fetch failed", code: "" } })).client)
    await expectNetError(offline.claimHost("s"), "network")
  })

  it("passes every upsert_player_view argument (fencing + wire epoch + seq)", async () => {
    const { client, calls } = fakeClient(() => ({ data: true, error: null }))
    const repo = createRemoteSessionsRepo(client)
    const v = view(P1)
    expect(await repo.upsertPlayerView({ sessionId: "s", userId: P1, hostEpoch: 3, epoch: "w", seq: 7, view: v })).toBe(true)
    expect(calls[0]).toEqual({ fn: "upsert_player_view", args: { p_session_id: "s", p_user_id: P1, p_host_epoch: 3, p_epoch: "w", p_seq: 7, p_view: v } })
  })

  it("maps session_info rows, including NULL member columns for the DM", async () => {
    const row = { session_id: "s", status: "active", room_code: "ABCDEFGH", role: "dm", member_status: null, display_name: null, dm_display_name: "Kev", created_at: "t" }
    const repo = createRemoteSessionsRepo(fakeClient(() => ({ data: [row], error: null })).client)
    expect(await repo.sessionInfo("s")).toEqual({
      sessionId: "s",
      status: "active",
      roomCode: "ABCDEFGH",
      role: "dm",
      memberStatus: null,
      displayName: null,
      dmDisplayName: "Kev",
      createdAt: "t",
    })
    const none = createRemoteSessionsRepo(fakeClient(() => ({ data: [], error: null })).client)
    expect(await none.sessionInfo("s")).toBeNull()
  })

  it("reads the caller's own player_views row and checks its envelope", async () => {
    const good = { session_id: "s", user_id: P1, host_epoch: 2, epoch: "w", seq: 4, view: view(P1), updated_at: "t" }
    const { client, query } = fakeClient(() => ({ data: null, error: null }), { data: good, error: null })
    expect(await createRemoteSessionsRepo(client).loadPlayerView("s", P1)).toMatchObject({ hostEpoch: 2, epoch: "w", seq: 4 })
    expect(query).toContain(`eq("user_id","${P1}")`)
    const bad = fakeClient(() => ({ data: null, error: null }), { data: { ...good, view: { nope: true } }, error: null })
    await expectNetError(createRemoteSessionsRepo(bad.client).loadPlayerView("s", P1), "invalid_data")
  })
})
