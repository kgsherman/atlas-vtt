/**
 * Session persistence (ARCHITECTURE §6.3, §6.4): typed wrappers for every session RPC plus the two
 * reads clients do directly (the DM's session_state row, a player's own player_views row).
 *
 * Fencing: `claimHost` bumps sessions.host_epoch and returns it; `saveSessionState` and
 * `upsertPlayerView` must pass that number and fail with NetError("stale_epoch") once another host
 * has claimed the session (the host then stops and offers "Take over"). The wire epoch string
 * (HostToClient.epoch) is separate and stored alongside each player view.
 *
 * Local-only mode (`createLocalSessionsRepo`) keeps the same model in IndexedDB so the host runner
 * and player client run unchanged across tabs of one browser. It enforces the same rules but is NOT
 * a security boundary (every tab can read the store).
 */
import { normalizeFreeAssetCategories, type FreeAssetCategory } from "@/core/session/freeAssets"
import { PLAYER_VIEW_VERSION, type GameState, type PlayerView } from "@/core/session/types"

import { localIdentity, normalizeDisplayName } from "./auth"
import type { Json } from "./database.types"
import { getLocalStore, type LocalStore } from "./localStore"
import { createLocalScenesRepo, type ScenesRepo } from "./scenesRepo"
import { getSupabaseOrNull, NetError, unwrap, type AtlasClient } from "./supabase"

export type MemberStatus = "active" | "kicked"
/**
 * A session is the table of one map (ARCHITECTURE §6.8): "active" = the table is open (the room code
 * works, members connect), "closed" = the DM works alone (members are disconnected and read nothing,
 * the room code stays reserved), "ended" = gone for good.
 */
export type SessionStatus = "active" | "closed" | "ended"
export type SessionRole = "dm" | "player"

export interface CreatedSession {
  sessionId: string
  roomCode: string
}

/** A map's table (SessionsRepo.openMap). */
export interface MapTable {
  sessionId: string
  roomCode: string
  status: SessionStatus
  /** The table was created by this call (seeded from the map's latest version). */
  created: boolean
}

export interface SessionInfo {
  sessionId: string
  status: SessionStatus
  roomCode: string
  role: SessionRole
  /** null for the DM. */
  memberStatus: MemberStatus | null
  displayName: string | null
  dmDisplayName: string | null
  createdAt: string
}

export interface SessionMember {
  userId: string
  displayName: string
  status: MemberStatus
  joinedAt: string
}

/** A session as the DM sees it (sessions table). */
export interface DmSession {
  id: string
  sceneId: string | null
  roomCode: string
  status: SessionStatus
  hostEpoch: number
  createdAt: string
  endedAt: string | null
}

export interface Membership {
  sessionId: string
  displayName: string
  status: MemberStatus
  joinedAt: string
}

/** What create_session writes into session_state before any host has saved a GameState. */
export interface SessionSeed {
  kind: "seed"
  sceneId: string | null
  sceneVersion: number
  schemaVersion: number
  /** The raw scene document: run it through parseScene before use. */
  scene: unknown
  /** Free asset categories chosen when the game was started (absent in seeds from before them). */
  freeAssets?: FreeAssetCategory[]
}

export interface CreateSessionOptions {
  /** Free asset categories the game loads (GameState.freeAssets). Default: none. */
  freeAssets?: readonly FreeAssetCategory[]
}

/** session_state.state: the seed, or a GameState saved by a host (validate before use). */
export type SessionStateContent = SessionSeed | { kind: "game"; state: unknown }

export interface SessionStateRow {
  sessionId: string
  /** host_epoch of the writer (0 = the seed). */
  epoch: number
  updatedAt: string
  content: SessionStateContent
}

export interface PlayerViewRow {
  sessionId: string
  userId: string
  hostEpoch: number
  /** Wire epoch of the host run that produced `view` (compare with snapshot_ready.epoch). */
  epoch: string
  seq: number
  view: PlayerView
  updatedAt: string
}

export interface UpsertPlayerViewArgs {
  sessionId: string
  userId: string
  /** Fencing token from claimHost(). */
  hostEpoch: number
  /** Wire epoch string (HostToClient.epoch). */
  epoch: string
  seq: number
  view: PlayerView
}

export interface SessionsRepo {
  readonly storage: "remote" | "local"
  /** DM: start a session for one of my scenes, opened (older clients' "Start session"; openMap + setTableOpen). */
  createSession(sceneId: string, opts?: CreateSessionOptions): Promise<CreatedSession>
  /**
   * DM: the table of one of my maps. A map has at most one live table; when it has none, a closed one is
   * created, seeded from the map's latest version (`opts.freeAssets`: the categories the game loads).
   */
  openMap(sceneId: string, opts?: CreateSessionOptions): Promise<MapTable>
  /** DM: open (players may join and connect) or close the table's doors. Returns the new status. */
  setTableOpen(sessionId: string, open: boolean): Promise<SessionStatus>
  /**
   * DM only, fenced: the table now holds another map (after a map change). Another live table holding
   * that map ends when nobody plays there; with players it refuses (NetError "map_in_use").
   */
  setSessionScene(sessionId: string, hostEpoch: number, sceneId: string): Promise<void>
  /** Player: join (or rejoin) by room code. Throws kicked / session_not_found / is_dm / … */
  joinSession(roomCode: string, displayName: string): Promise<string>
  /** DM or member (kicked members too, so the UI can explain); null for anyone else. */
  sessionInfo(sessionId: string): Promise<SessionInfo | null>
  /** DM only. */
  listSessionMembers(sessionId: string): Promise<SessionMember[]>
  /** DM only. Returns whether a member row changed. */
  setMemberStatus(sessionId: string, userId: string, status: MemberStatus): Promise<boolean>
  /** DM only. Bumps and returns the fencing epoch. */
  claimHost(sessionId: string): Promise<number>
  /** DM only, fenced. */
  saveSessionState(sessionId: string, hostEpoch: number, state: GameState): Promise<void>
  /** DM only, fenced. false when a newer seq of the same wire epoch is already stored. */
  upsertPlayerView(args: UpsertPlayerViewArgs): Promise<boolean>
  /** DM only. true if it was live (open or closed). */
  endSession(sessionId: string): Promise<boolean>
  /** DM only (RLS). */
  loadSessionState(sessionId: string): Promise<SessionStateRow | null>
  /** A player's own row while an active member (RLS); the DM can read any. */
  loadPlayerView(sessionId: string, userId: string): Promise<PlayerViewRow | null>
  /** Sessions I run, newest first. */
  listMySessions(): Promise<DmSession[]>
  /** Sessions I joined, newest first. */
  listMyMemberships(userId: string): Promise<Membership[]>
}

// ---------------------------------------------------------------------------
// Room codes (8 characters of Crockford base32)
// ---------------------------------------------------------------------------

export const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
export const ROOM_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/

/** Mirrors private.normalize_room_code(): case-insensitive, separators ignored, I/L → 1, O → 0. */
export function normalizeRoomCode(input: string): string {
  return input
    .replace(/[\s_-]/gu, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
}

export function isValidRoomCode(input: string): boolean {
  return ROOM_CODE_RE.test(normalizeRoomCode(input))
}

/** "ABCD1234" → "ABCD-1234" for display. */
export function formatRoomCode(code: string): string {
  const c = normalizeRoomCode(code)
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

/** 40 random bits (byte & 31 is uniform: 256 is a multiple of 32). Server codes come from SQL. */
/** Names that pose as the DM (join_session refuses them; mirrors private.display_name_taken). */
export const RESERVED_DISPLAY_NAMES = ["dm", "gm", "the dm", "the gm", "dungeon master", "game master", "the dungeon master", "the game master"]

/** Whether `name` is unavailable to `uid` among a session's members (case-insensitive). */
export function displayNameTaken(name: string, uid: string, members: Readonly<Record<string, { displayName: string }>>, dmName: string | null = null): boolean {
  const lower = name.toLowerCase()
  if (RESERVED_DISPLAY_NAMES.includes(lower)) return true
  if (dmName !== null && dmName.toLowerCase() === lower) return true
  return Object.entries(members).some(([id, m]) => id !== uid && m.displayName.toLowerCase() === lower)
}

export function generateRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return [...bytes].map((b) => ROOM_CODE_ALPHABET[b & 31]).join("")
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseSessionStateContent(json: unknown): SessionStateContent {
  if (isRecord(json) && json.kind === "seed") {
    return {
      kind: "seed",
      sceneId: typeof json.sceneId === "string" ? json.sceneId : null,
      sceneVersion: typeof json.sceneVersion === "number" ? json.sceneVersion : 0,
      schemaVersion: typeof json.schemaVersion === "number" ? json.schemaVersion : 0,
      scene: json.scene,
      ...(Array.isArray(json.freeAssets) ? { freeAssets: normalizeFreeAssetCategories(json.freeAssets) } : {}),
    }
  }
  return { kind: "game", state: json }
}

/** Views are written only by the DM's host (RLS), but still check the envelope before use. */
function asPlayerView(json: unknown): PlayerView {
  if (!isRecord(json) || json.viewVersion !== PLAYER_VIEW_VERSION) throw new NetError("invalid_data", "stored player view has an unknown format")
  return json as unknown as PlayerView
}

const asMemberStatus = (s: string | null | undefined): MemberStatus | null => (s === "active" || s === "kicked" ? s : null)
const asSessionStatus = (s: string): SessionStatus => (s === "active" || s === "closed" ? s : "ended")

function requireName(displayName: string): string {
  const name = normalizeDisplayName(displayName)
  if (!name) throw new NetError("invalid_display_name", "display names are 1 to 32 characters")
  return name
}

function requireCode(roomCode: string): string {
  const code = normalizeRoomCode(roomCode)
  if (!ROOM_CODE_RE.test(code)) throw new NetError("invalid_room_code", "room codes are 8 characters")
  return code
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

export function createRemoteSessionsRepo(client: AtlasClient): SessionsRepo {
  return {
    storage: "remote",
    async createSession(sceneId, opts = {}) {
      const rows = unwrap(await client.rpc("create_session", { p_scene_id: sceneId, p_free_assets: normalizeFreeAssetCategories(opts.freeAssets ?? []) }))
      const row = rows?.[0]
      if (!row) throw new NetError("unknown", "create_session returned nothing")
      return { sessionId: row.session_id, roomCode: row.room_code }
    },
    async openMap(sceneId, opts = {}) {
      const rows = unwrap(await client.rpc("open_map", { p_scene_id: sceneId, p_free_assets: normalizeFreeAssetCategories(opts.freeAssets ?? []) }))
      const row = rows?.[0]
      if (!row) throw new NetError("unknown", "open_map returned nothing")
      return { sessionId: row.session_id, roomCode: row.room_code, status: asSessionStatus(row.status), created: row.created === true }
    },
    async setTableOpen(sessionId, open) {
      return asSessionStatus(unwrap(await client.rpc("set_table_open", { p_session_id: sessionId, p_open: open })) ?? "")
    },
    async setSessionScene(sessionId, hostEpoch, sceneId) {
      unwrap(await client.rpc("set_session_scene", { p_session_id: sessionId, p_host_epoch: hostEpoch, p_scene_id: sceneId }))
    },
    async joinSession(roomCode, displayName) {
      const sid = unwrap(await client.rpc("join_session", { p_room_code: requireCode(roomCode), p_display_name: requireName(displayName) }))
      if (typeof sid !== "string") throw new NetError("unknown", "join_session returned no id")
      return sid
    },
    async sessionInfo(sessionId) {
      const rows = unwrap(await client.rpc("session_info", { p_session_id: sessionId }))
      const r = rows?.[0]
      if (!r) return null
      // Generated types claim non-null; member/profile columns are NULL for the DM or without a profile.
      const n = r as { member_status: string | null; display_name: string | null; dm_display_name: string | null }
      return {
        sessionId: r.session_id,
        status: asSessionStatus(r.status),
        roomCode: r.room_code,
        role: r.role === "dm" ? "dm" : "player",
        memberStatus: asMemberStatus(n.member_status),
        displayName: n.display_name ?? null,
        dmDisplayName: n.dm_display_name ?? null,
        createdAt: r.created_at,
      }
    },
    async listSessionMembers(sessionId) {
      const rows = unwrap(await client.rpc("list_session_members", { p_session_id: sessionId }))
      return (rows ?? []).map((m) => ({ userId: m.user_id, displayName: m.display_name, status: asMemberStatus(m.status) ?? "kicked", joinedAt: m.joined_at }))
    },
    async setMemberStatus(sessionId, userId, status) {
      return unwrap(await client.rpc("set_member_status", { p_session_id: sessionId, p_user_id: userId, p_status: status })) === true
    },
    async claimHost(sessionId) {
      const epoch = unwrap(await client.rpc("claim_host", { p_session_id: sessionId }))
      if (typeof epoch !== "number") throw new NetError("unknown", "claim_host returned no epoch")
      return epoch
    },
    async saveSessionState(sessionId, hostEpoch, state) {
      unwrap(await client.rpc("save_session_state", { p_session_id: sessionId, p_epoch: hostEpoch, p_state: state as unknown as Json }))
    },
    async upsertPlayerView(a) {
      return (
        unwrap(
          await client.rpc("upsert_player_view", {
            p_session_id: a.sessionId,
            p_user_id: a.userId,
            p_host_epoch: a.hostEpoch,
            p_epoch: a.epoch,
            p_seq: a.seq,
            p_view: a.view as unknown as Json,
          })
        ) === true
      )
    },
    async endSession(sessionId) {
      return unwrap(await client.rpc("end_session", { p_session_id: sessionId })) === true
    },
    async loadSessionState(sessionId) {
      const row = unwrap(await client.from("session_state").select("session_id, epoch, state, updated_at").eq("session_id", sessionId).maybeSingle())
      return row ? { sessionId: row.session_id, epoch: row.epoch, updatedAt: row.updated_at, content: parseSessionStateContent(row.state) } : null
    },
    async loadPlayerView(sessionId, userId) {
      const row = unwrap(
        await client
          .from("player_views")
          .select("session_id, user_id, host_epoch, epoch, seq, view, updated_at")
          .eq("session_id", sessionId)
          .eq("user_id", userId)
          .maybeSingle()
      )
      if (!row) return null
      return {
        sessionId: row.session_id,
        userId: row.user_id,
        hostEpoch: row.host_epoch,
        epoch: row.epoch,
        seq: row.seq,
        view: asPlayerView(row.view),
        updatedAt: row.updated_at,
      }
    },
    async listMySessions() {
      const rows = unwrap(
        await client.from("sessions").select("id, scene_id, room_code, status, host_epoch, created_at, ended_at").order("created_at", { ascending: false })
      )
      return (rows ?? []).map((s) => ({
        id: s.id,
        sceneId: s.scene_id,
        roomCode: s.room_code,
        status: asSessionStatus(s.status),
        hostEpoch: s.host_epoch,
        createdAt: s.created_at,
        endedAt: s.ended_at,
      }))
    },
    async listMyMemberships(userId) {
      const rows = unwrap(
        await client
          .from("session_members")
          .select("session_id, display_name, status, joined_at")
          .eq("user_id", userId)
          .order("joined_at", { ascending: false })
      )
      return (rows ?? []).map((m) => ({
        sessionId: m.session_id,
        displayName: m.display_name,
        status: asMemberStatus(m.status) ?? "kicked",
        joinedAt: m.joined_at,
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// Local (IndexedDB, dev/offline — mirrors the SQL rules, NOT a security boundary)
// ---------------------------------------------------------------------------

interface LocalMember {
  displayName: string
  status: MemberStatus
  joinedAt: string
}

interface LocalSession {
  id: string
  dmId: string
  sceneId: string | null
  roomCode: string
  status: SessionStatus
  hostEpoch: number
  createdAt: string
  endedAt: string | null
  members: Record<string, LocalMember>
}

interface LocalStateRecord {
  epoch: number
  state: unknown
  updatedAt: string
}

interface LocalViewRecord {
  hostEpoch: number
  epoch: string
  seq: number
  view: unknown
  updatedAt: string
}

export interface LocalSessionsRepoOptions {
  store?: LocalStore | Promise<LocalStore>
  /** Where createSession reads scenes from. Default: the local scene library on the same store. */
  scenes?: ScenesRepo
  /** The acting user. Default: the per-tab local identity. */
  userId?: () => string
}

const MAX_MEMBERS = 64

export function createLocalSessionsRepo(opts: LocalSessionsRepoOptions = {}): SessionsRepo {
  const storeP = opts.store ?? getLocalStore()
  const store = () => Promise.resolve(storeP)
  const scenes = opts.scenes ?? createLocalScenesRepo(storeP)
  const me = opts.userId ?? (() => localIdentity().userId)
  const sKey = (id: string) => `s:${id}`
  const codeKey = (code: string) => `code:${code}`
  const stateKey = (id: string) => `state:${id}`
  const viewKey = (id: string, uid: string) => `view:${id}:${uid}`

  const getSession = async (id: string) => (await store()).get<LocalSession>("sessions", sKey(id))
  const putSession = async (s: LocalSession) => (await store()).put("sessions", sKey(s.id), s)
  /** The caller's session as DM, like private.is_session_dm(); not_found otherwise. */
  const dmSession = async (id: string) => {
    const s = await getSession(id)
    if (!s || s.dmId !== me()) throw new NetError("not_found", "session not found")
    return s
  }
  /** Like private.lock_fenced_session(). */
  const fenced = async (id: string, epoch: number) => {
    const s = await dmSession(id)
    if (s.status === "ended") throw new NetError("session_ended", "the session has ended")
    if (s.hostEpoch !== epoch) throw new NetError("stale_epoch", `current host epoch is ${s.hostEpoch}`)
    return s
  }

  const allSessions = async () => (await (await store()).entries<LocalSession>("sessions", "s:")).map(([, s]) => s)
  /** The live table holding a map (the partial unique index sessions_live_scene_key keeps it single). */
  const mapTable = async (sceneId: string) => (await allSessions()).find((s) => s.sceneId === sceneId && s.status !== "ended") ?? null
  const endTable = async (s: LocalSession) => {
    const st = await store()
    s.status = "ended"
    s.endedAt = new Date().toISOString()
    s.hostEpoch += 1
    await putSession(s)
    await st.delete("sessions", codeKey(s.roomCode))
    await st.deletePrefix("sessions", `view:${s.id}:`)
  }

  const repo: SessionsRepo = {
    storage: "local",
    async createSession(sceneId, opts = {}) {
      const table = await repo.openMap(sceneId, opts)
      await repo.setTableOpen(table.sessionId, true)
      return { sessionId: table.sessionId, roomCode: table.roomCode }
    },
    async openMap(sceneId, opts = {}) {
      const loaded = await scenes.load(sceneId)
      const existing = await mapTable(sceneId)
      // One live table per map (the map is this browser's, so its table is too).
      if (existing) return { sessionId: existing.id, roomCode: existing.roomCode, status: existing.status, created: false }
      if (!loaded.parsed.ok) throw new NetError("invalid_data", "the scene cannot be loaded")
      const st = await store()
      let code = generateRoomCode()
      for (let i = 0; i < 16 && (await st.get("sessions", codeKey(code))); i++) code = generateRoomCode()
      const now = new Date().toISOString()
      const session: LocalSession = {
        id: crypto.randomUUID(),
        dmId: me(),
        sceneId,
        roomCode: code,
        status: "closed",
        hostEpoch: 0,
        createdAt: now,
        endedAt: null,
        members: {},
      }
      const seed: SessionSeed = {
        kind: "seed",
        sceneId,
        sceneVersion: loaded.version,
        schemaVersion: loaded.schemaVersion,
        scene: loaded.parsed.scene,
        freeAssets: normalizeFreeAssetCategories(opts.freeAssets ?? []),
      }
      await putSession(session)
      await st.put("sessions", codeKey(code), session.id)
      await st.put<LocalStateRecord>("sessions", stateKey(session.id), { epoch: 0, state: seed, updatedAt: now })
      return { sessionId: session.id, roomCode: code, status: "closed", created: true }
    },
    async setTableOpen(sessionId, open) {
      const s = await dmSession(sessionId)
      if (s.status === "ended") throw new NetError("session_ended", "the session has ended")
      s.status = open ? "active" : "closed"
      await putSession(s)
      return s.status
    },
    async setSessionScene(sessionId, hostEpoch, sceneId) {
      const s = await fenced(sessionId, hostEpoch)
      if (!(await scenes.get(sceneId))) throw new NetError("not_found", "scene not found")
      const other = await mapTable(sceneId)
      if (other && other.id !== sessionId) {
        if (Object.values(other.members).some((m) => m.status === "active")) throw new NetError("map_in_use", "players are at another table on this map")
        await endTable(other)
      }
      s.sceneId = sceneId
      await putSession(s)
    },
    async joinSession(roomCode, displayName) {
      const code = requireCode(roomCode)
      const name = requireName(displayName)
      const sid = await (await store()).get<string>("sessions", codeKey(code))
      const s = sid ? await getSession(sid) : undefined
      if (!s || s.status === "ended") throw new NetError("session_not_found", "no active session with that room code")
      const uid = me()
      if (s.dmId === uid) throw new NetError("is_dm", "you are the DM of this session")
      if (s.status !== "active") throw new NetError("table_closed", "the DM has not opened this table")
      const existing = s.members[uid]
      if (existing?.status === "kicked") throw new NetError("kicked", "you were removed from this session")
      if (!existing && Object.keys(s.members).length >= MAX_MEMBERS) throw new NetError("session_full", "this session has too many members")
      // Like join_session: no posing as the DM, no second player with the same name.
      if (displayNameTaken(name, uid, s.members)) throw new NetError("name_taken", "that name is taken in this session")
      s.members[uid] = { displayName: name, status: "active", joinedAt: existing?.joinedAt ?? new Date().toISOString() }
      await putSession(s)
      return s.id
    },
    async sessionInfo(sessionId) {
      const s = await getSession(sessionId)
      const uid = me()
      const member = s?.members[uid]
      if (!s || (s.dmId !== uid && !member)) return null
      return {
        sessionId: s.id,
        status: s.status,
        roomCode: s.roomCode,
        role: s.dmId === uid ? "dm" : "player",
        memberStatus: member?.status ?? null,
        displayName: member?.displayName ?? null,
        dmDisplayName: null,
        createdAt: s.createdAt,
      }
    },
    async listSessionMembers(sessionId) {
      const s = await getSession(sessionId)
      if (!s || s.dmId !== me()) throw new NetError("forbidden", "only the DM can list members")
      return Object.entries(s.members)
        .map(([userId, m]) => ({ userId, displayName: m.displayName, status: m.status, joinedAt: m.joinedAt }))
        .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId))
    },
    async setMemberStatus(sessionId, userId, status) {
      const s = await getSession(sessionId)
      if (!s || s.dmId !== me()) throw new NetError("forbidden", "only the DM can change member status")
      const m = s.members[userId]
      if (!m || m.status === status) return false
      m.status = status
      await putSession(s)
      return true
    },
    async claimHost(sessionId) {
      const s = await dmSession(sessionId)
      if (s.status === "ended") throw new NetError("session_ended", "the session has ended")
      s.hostEpoch += 1
      await putSession(s)
      return s.hostEpoch
    },
    async saveSessionState(sessionId, hostEpoch, state) {
      await fenced(sessionId, hostEpoch)
      await (
        await store()
      ).put<LocalStateRecord>("sessions", stateKey(sessionId), {
        epoch: hostEpoch,
        state: JSON.parse(JSON.stringify(state)),
        updatedAt: new Date().toISOString(),
      })
    },
    async upsertPlayerView(a) {
      const s = await fenced(a.sessionId, a.hostEpoch)
      if (s.members[a.userId]?.status !== "active") throw new NetError("not_member", "the user is not an active member of this session")
      const st = await store()
      const prev = await st.get<LocalViewRecord>("sessions", viewKey(a.sessionId, a.userId))
      // Same rule as SQL: within one wire epoch an older seq never overwrites a newer one.
      if (prev && prev.hostEpoch >= a.hostEpoch && prev.epoch === a.epoch && prev.seq > a.seq) return false
      await st.put<LocalViewRecord>("sessions", viewKey(a.sessionId, a.userId), {
        hostEpoch: a.hostEpoch,
        epoch: a.epoch,
        seq: a.seq,
        view: JSON.parse(JSON.stringify(a.view)),
        updatedAt: new Date().toISOString(),
      })
      return true
    },
    async endSession(sessionId) {
      const s = await dmSession(sessionId)
      if (s.status === "ended") return false
      await endTable(s)
      return true
    },
    async loadSessionState(sessionId) {
      const s = await getSession(sessionId)
      if (!s || s.dmId !== me()) return null
      const r = await (await store()).get<LocalStateRecord>("sessions", stateKey(sessionId))
      return r ? { sessionId, epoch: r.epoch, updatedAt: r.updatedAt, content: parseSessionStateContent(r.state) } : null
    },
    async loadPlayerView(sessionId, userId) {
      const s = await getSession(sessionId)
      const uid = me()
      const allowed = s && (s.dmId === uid || (userId === uid && s.status === "active" && s.members[uid]?.status === "active"))
      if (!allowed) return null
      const r = await (await store()).get<LocalViewRecord>("sessions", viewKey(sessionId, userId))
      return r ? { sessionId, userId, hostEpoch: r.hostEpoch, epoch: r.epoch, seq: r.seq, view: asPlayerView(r.view), updatedAt: r.updatedAt } : null
    },
    async listMySessions() {
      const uid = me()
      return (await allSessions())
        .filter((s) => s.dmId === uid)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((s) => ({
          id: s.id,
          sceneId: s.sceneId,
          roomCode: s.roomCode,
          status: s.status,
          hostEpoch: s.hostEpoch,
          createdAt: s.createdAt,
          endedAt: s.endedAt,
        }))
    },
    async listMyMemberships(userId) {
      const all = await (await store()).entries<LocalSession>("sessions", "s:")
      return all
        .flatMap(([, s]) => {
          const m = s.members[userId]
          return m ? [{ sessionId: s.id, displayName: m.displayName, status: m.status, joinedAt: m.joinedAt }] : []
        })
        .sort((a, b) => b.joinedAt.localeCompare(a.joinedAt))
    },
  }
  return repo
}

export interface SessionsRepoOptions extends LocalSessionsRepoOptions {
  /** null forces local mode. Default: the app client when Supabase is configured. */
  client?: AtlasClient | null
}

/** Remote repository when Supabase is configured, the local (dev) one otherwise. */
export function createSessionsRepo(opts: SessionsRepoOptions = {}): SessionsRepo {
  const client = opts.client === undefined ? getSupabaseOrNull() : opts.client
  return client ? createRemoteSessionsRepo(client) : createLocalSessionsRepo(opts)
}
