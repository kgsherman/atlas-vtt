/**
 * Worlds (ARCHITECTURE §6.9): a DM's campaign. A world holds scenes (ScenesRepo, `SceneSummary.worldId`),
 * characters and players, and has one room code: players join the WORLD with it, once, and the DM hands
 * them the world's characters here, for every scene of the world.
 *
 * Supabase: `worlds`, `world_members`, `characters`, `character_players` (RLS: the world's owner) and the
 * RPCs create_world, delete_world, join_world, world_info, list_joined_worlds, set_world_member_status,
 * set_character_players.
 * Local mode keeps the same model in IndexedDB (store "worlds"): like the local scene library it is per
 * browser (every tab sees every world; memberships are keyed by each tab's user id), and it is NOT a
 * security boundary.
 */
import { localIdentity, normalizeDisplayName } from "./auth"
import { getLocalStore, type LocalStore } from "./localStore"
import { displayNameTaken, generateRoomCode, normalizeRoomCode, ROOM_CODE_RE } from "./roomCodes"
import type { MemberStatus } from "./sessionsRepo"
import { getSupabaseOrNull, NetError, unwrap, type AtlasClient } from "./supabase"

export interface WorldSummary {
  id: string
  name: string
  /** Players join the world with it (every table of the world answers to it). */
  roomCode: string
  createdAt: string
  updatedAt: string
}

export interface WorldMember {
  userId: string
  displayName: string
  status: MemberStatus
  joinedAt: string
}

export interface WorldCharacter {
  id: string
  worldId: string
  name: string
  /** #rrggbb. */
  color: string
  /** Portrait: an http(s) URL or a same-origin absolute path. */
  imageUrl: string | null
  /** The world players who play it, sorted. */
  playerIds: string[]
  createdAt: string
  updatedAt: string
}

export interface CharacterInput {
  name: string
  color?: string
  imageUrl?: string | null
}

export interface JoinedWorld {
  worldId: string
  /** The world's open table, or null while every table of the world is closed. */
  sessionId: string | null
}

export interface WorldInfo {
  worldId: string
  name: string
  roomCode: string
  role: "dm" | "player"
  /** null for the DM. */
  memberStatus: MemberStatus | null
  displayName: string | null
  dmDisplayName: string | null
  /** The table whose doors are open (for the DM and active players), else null. */
  openSessionId: string | null
  /** Names of the characters the caller plays. */
  characters: string[]
}

export interface JoinedWorldInfo extends WorldInfo {
  joinedAt: string
}

export interface WorldsRepo {
  readonly storage: "remote" | "local"
  /** My worlds (as their DM), most recently updated first. */
  list(): Promise<WorldSummary[]>
  get(id: string): Promise<WorldSummary | null>
  create(name: string): Promise<WorldSummary>
  rename(id: string, name: string): Promise<WorldSummary>
  /** Delete an EMPTY world (NetError "world_not_empty" while it has scenes); its characters and players go too. */
  remove(id: string): Promise<void>
  /** DM: the world's players, in join order. */
  listMembers(worldId: string): Promise<WorldMember[]>
  /** DM: remove a player from the world (every table of it at once) or let them back. Whether it changed. */
  setMemberStatus(worldId: string, userId: string, status: MemberStatus): Promise<boolean>
  /** DM: the world's characters, oldest first. */
  listCharacters(worldId: string): Promise<WorldCharacter[]>
  createCharacter(worldId: string, input: CharacterInput): Promise<WorldCharacter>
  updateCharacter(id: string, patch: Partial<CharacterInput>): Promise<WorldCharacter>
  removeCharacter(id: string): Promise<void>
  /** Who plays the character (replaces the list; players of its world only, at most MAX_PLAYERS_PER_CHARACTER). */
  setCharacterPlayers(character: Pick<WorldCharacter, "id" | "worldId">, userIds: readonly string[]): Promise<void>
  /** Player: join (or rejoin, possibly under another name) by room code. Throws kicked / session_not_found / is_dm / name_taken / … */
  join(roomCode: string, displayName: string): Promise<JoinedWorld>
  /** The DM or a player of the world (kicked ones too, so the UI can explain); null for anyone else. */
  info(worldId: string): Promise<WorldInfo | null>
  /** The worlds I joined as a player, most recently joined first. */
  listJoined(): Promise<JoinedWorldInfo[]>
}

export const WORLD_NAME_MAX = 200
export const CHARACTER_NAME_MAX = 64
export const MAX_WORLDS = 20
export const MAX_CHARACTERS_PER_WORLD = 100
export const MAX_PLAYERS_PER_CHARACTER = 8
export const MAX_MEMBERS_PER_WORLD = 64
export const DEFAULT_CHARACTER_COLOR = "#4f9dde"
const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const IMAGE_URL_RE = /^(https?:\/\/|\/(?!\/))/i

/** Mirrors private.normalize_world_name(). */
export function normalizeWorldName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const collapsed = name.replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim()
  const capped = [...collapsed].slice(0, WORLD_NAME_MAX).join("").trim()
  return capped || "Untitled world"
}

/** A character name (1..64 characters, whitespace collapsed), or null when blank. */
export function normalizeCharacterName(name: string): string | null {
  // eslint-disable-next-line no-control-regex
  const collapsed = name.replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim()
  const capped = [...collapsed].slice(0, CHARACTER_NAME_MAX).join("").trim()
  return capped || null
}

function characterFields(input: Partial<CharacterInput>): { name?: string; color?: string; image_url?: string | null } {
  const out: { name?: string; color?: string; image_url?: string | null } = {}
  if (input.name !== undefined) {
    const name = normalizeCharacterName(input.name)
    if (!name) throw new NetError("invalid_argument", "a character needs a name")
    out.name = name
  }
  if (input.color !== undefined) {
    if (!COLOR_RE.test(input.color)) throw new NetError("invalid_argument", "colours are #rrggbb")
    out.color = input.color.toLowerCase()
  }
  if (input.imageUrl !== undefined) {
    if (input.imageUrl !== null && (input.imageUrl.length > 2000 || !IMAGE_URL_RE.test(input.imageUrl)))
      throw new NetError("invalid_argument", "portraits are http(s) URLs")
    out.image_url = input.imageUrl
  }
  return out
}

const asMemberStatus = (s: string | null | undefined): MemberStatus | null => (s === "active" || s === "kicked" ? s : null)

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

const WORLD_COLUMNS = "id, name, room_code, created_at, updated_at"
const CHARACTER_COLUMNS = "id, world_id, name, color, image_url, created_at, updated_at"

interface WorldRow {
  id: string
  name: string
  room_code: string
  created_at: string
  updated_at: string
}

interface CharacterRow {
  id: string
  world_id: string
  name: string
  color: string
  image_url: string | null
  created_at: string
  updated_at: string
}

interface InfoRow {
  world_id: string
  name: string
  room_code: string
  role: string
  member_status: string | null
  display_name: string | null
  dm_display_name: string | null
  open_session_id: string | null
  characters: string[] | null
}

const fromWorldRow = (r: WorldRow): WorldSummary => ({ id: r.id, name: r.name, roomCode: r.room_code, createdAt: r.created_at, updatedAt: r.updated_at })

const fromCharacterRow = (r: CharacterRow, playerIds: string[]): WorldCharacter => ({
  id: r.id,
  worldId: r.world_id,
  name: r.name,
  color: r.color,
  imageUrl: r.image_url,
  playerIds: [...playerIds].sort(),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

// Generated types claim non-null; member and profile columns are NULL for the DM or without a profile.
const fromInfoRow = (r: InfoRow): WorldInfo => ({
  worldId: r.world_id,
  name: r.name,
  roomCode: r.room_code,
  role: r.role === "dm" ? "dm" : "player",
  memberStatus: asMemberStatus(r.member_status),
  displayName: r.display_name ?? null,
  dmDisplayName: r.dm_display_name ?? null,
  openSessionId: r.open_session_id ?? null,
  characters: r.characters ?? [],
})

export function createRemoteWorldsRepo(client: AtlasClient): WorldsRepo {
  const get = async (id: string): Promise<WorldSummary | null> => {
    const row = unwrap(await client.from("worlds").select(WORLD_COLUMNS).eq("id", id).maybeSingle())
    return row ? fromWorldRow(row) : null
  }
  const mustGet = async (id: string) => {
    const w = await get(id)
    if (!w) throw new NetError("not_found", "world not found")
    return w
  }
  const playersOf = async (characterId: string): Promise<string[]> =>
    (unwrap(await client.from("character_players").select("user_id").eq("character_id", characterId)) ?? []).map((r) => r.user_id)

  return {
    storage: "remote",
    async list() {
      return (unwrap(await client.from("worlds").select(WORLD_COLUMNS).order("updated_at", { ascending: false })) ?? []).map(fromWorldRow)
    },
    get,
    async create(name) {
      const id = unwrap(await client.rpc("create_world", { p_name: normalizeWorldName(name) }))
      if (typeof id !== "string") throw new NetError("unknown", "create_world returned no id")
      return mustGet(id)
    },
    async rename(id, name) {
      const row = unwrap(
        await client
          .from("worlds")
          .update({ name: normalizeWorldName(name) })
          .eq("id", id)
          .select(WORLD_COLUMNS)
          .maybeSingle()
      )
      if (!row) throw new NetError("not_found", "world not found")
      return fromWorldRow(row)
    },
    async remove(id) {
      unwrap(await client.rpc("delete_world", { p_world_id: id }))
    },
    async listMembers(worldId) {
      const rows = unwrap(
        await client
          .from("world_members")
          .select("user_id, display_name, status, joined_at")
          .eq("world_id", worldId)
          .order("joined_at", { ascending: true })
          .order("user_id", { ascending: true })
      )
      return (rows ?? []).map((m) => ({ userId: m.user_id, displayName: m.display_name, status: asMemberStatus(m.status) ?? "kicked", joinedAt: m.joined_at }))
    },
    async setMemberStatus(worldId, userId, status) {
      return unwrap(await client.rpc("set_world_member_status", { p_world_id: worldId, p_user_id: userId, p_status: status })) === true
    },
    async listCharacters(worldId) {
      const [chars, links] = await Promise.all([
        client.from("characters").select(CHARACTER_COLUMNS).eq("world_id", worldId).order("created_at", { ascending: true }).order("id", { ascending: true }),
        client.from("character_players").select("character_id, user_id").eq("world_id", worldId),
      ])
      const players = new Map<string, string[]>()
      for (const l of unwrap(links) ?? []) players.set(l.character_id, [...(players.get(l.character_id) ?? []), l.user_id])
      return (unwrap(chars) ?? []).map((r) => fromCharacterRow(r, players.get(r.id) ?? []))
    },
    async createCharacter(worldId, input) {
      const fields = characterFields({ color: DEFAULT_CHARACTER_COLOR, ...input })
      const row = unwrap(
        await client
          .from("characters")
          .insert({ world_id: worldId, name: fields.name!, color: fields.color, image_url: fields.image_url ?? null })
          .select(CHARACTER_COLUMNS)
          .single()
      )
      if (!row) throw new NetError("unknown", "the character was not created")
      return fromCharacterRow(row, [])
    },
    async updateCharacter(id, patch) {
      const row = unwrap(await client.from("characters").update(characterFields(patch)).eq("id", id).select(CHARACTER_COLUMNS).maybeSingle())
      if (!row) throw new NetError("not_found", "character not found")
      return fromCharacterRow(row, await playersOf(id))
    },
    async removeCharacter(id) {
      const rows = unwrap(await client.from("characters").delete().eq("id", id).select("id"))
      if (!rows || rows.length === 0) throw new NetError("not_found", "character not found")
    },
    async setCharacterPlayers(character, userIds) {
      const want = [...new Set(userIds)]
      if (want.length > MAX_PLAYERS_PER_CHARACTER) throw new NetError("quota_exceeded", `at most ${MAX_PLAYERS_PER_CHARACTER} players per character`)
      // One transaction on the server (the character row locked): overlapping calls never lose a player.
      unwrap(await client.rpc("set_character_players", { p_character_id: character.id, p_user_ids: want }))
    },
    async join(roomCode, displayName) {
      const rows = unwrap(await client.rpc("join_world", { p_room_code: requireCode(roomCode), p_display_name: requireName(displayName) }))
      const row = rows?.[0] as { world_id: string; session_id: string | null } | undefined
      if (!row) throw new NetError("unknown", "join_world returned nothing")
      return { worldId: row.world_id, sessionId: row.session_id ?? null }
    },
    async info(worldId) {
      const rows = unwrap(await client.rpc("world_info", { p_world_id: worldId }))
      const r = rows?.[0] as InfoRow | undefined
      return r ? fromInfoRow(r) : null
    },
    async listJoined() {
      const rows = unwrap(await client.rpc("list_joined_worlds")) as (InfoRow & { joined_at: string })[] | null
      return (rows ?? []).map((r) => ({ ...fromInfoRow(r), joinedAt: r.joined_at }))
    },
  }
}

// ---------------------------------------------------------------------------
// Local (IndexedDB, dev/offline — mirrors the SQL rules, NOT a security boundary)
// ---------------------------------------------------------------------------

export interface LocalWorldMember {
  displayName: string
  status: MemberStatus
  joinedAt: string
}

/** A world in the local store (`w:{id}`); `code:{room code}` → id. */
export interface LocalWorld {
  id: string
  /** The tab user who created it (absent: a world made for scenes from before worlds). */
  ownerId?: string
  name: string
  roomCode: string
  createdAt: string
  updatedAt: string
  members: Record<string, LocalWorldMember>
}

/** A character in the local store (`c:{id}`). */
interface LocalCharacter {
  id: string
  worldId: string
  name: string
  color: string
  imageUrl: string | null
  playerIds: string[]
  createdAt: string
  updatedAt: string
}

/** Monotonic ISO timestamps so ordering is stable within one millisecond. */
let lastStamp = 0
function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return new Date(lastStamp).toISOString()
}

/** Local world records, shared by the local worlds, scenes and sessions repositories. */
export const localWorlds = {
  get: (store: LocalStore, id: string) => store.get<LocalWorld>("worlds", `w:${id}`),
  put: (store: LocalStore, w: LocalWorld) => store.put("worlds", `w:${w.id}`, w),
  all: async (store: LocalStore) => (await store.entries<LocalWorld>("worlds", "w:")).map(([, w]) => w),
  byCode: async (store: LocalStore, code: string) => {
    const id = await store.get<string>("worlds", `code:${code}`)
    return id ? localWorlds.get(store, id) : undefined
  },
  async create(store: LocalStore, name: string, ownerId?: string): Promise<LocalWorld> {
    let code = generateRoomCode()
    for (let i = 0; i < 16 && (await store.get("worlds", `code:${code}`)); i++) code = generateRoomCode()
    const now = stamp()
    const w: LocalWorld = {
      id: crypto.randomUUID(),
      ...(ownerId ? { ownerId } : {}),
      name: normalizeWorldName(name),
      roomCode: code,
      createdAt: now,
      updatedAt: now,
      members: {},
    }
    await localWorlds.put(store, w)
    await store.put("worlds", `code:${code}`, w.id)
    return w
  },
  /** The first world ("My world" is created when there is none): where a scene goes when no world is named. */
  async default(store: LocalStore): Promise<LocalWorld> {
    const all = await localWorlds.all(store)
    const first = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]
    return first ?? localWorlds.create(store, "My world")
  },
  async touch(store: LocalStore, id: string): Promise<void> {
    const w = await localWorlds.get(store, id)
    if (w) await localWorlds.put(store, { ...w, updatedAt: stamp() })
  },
  /**
   * Local scenes stored before worlds (no `worldId`) join the first world, created as "My world" when there is
   * none. Once per store (the local worlds and scenes repositories both wait for it before reading), so two
   * callers never make two "My world"s.
   */
  adoptScenes(store: LocalStore): Promise<void> {
    let done = adoptions.get(store)
    if (!done) {
      done = (async () => {
        const orphans = (await store.entries<{ worldId?: string }>("scenes")).filter(([, r]) => !r.worldId)
        if (orphans.length === 0) return
        const world = await localWorlds.default(store)
        for (const [key, r] of orphans) await store.put("scenes", key, { ...r, worldId: world.id })
      })().catch((err: unknown) => {
        adoptions.delete(store)
        throw err
      })
      adoptions.set(store, done)
    }
    return done
  },
}

const adoptions = new WeakMap<LocalStore, Promise<void>>()

export interface LocalWorldsRepoOptions {
  store?: LocalStore | Promise<LocalStore>
  /** The acting user. Default: the per-tab local identity. */
  userId?: () => string
}

export function createLocalWorldsRepo(opts: LocalWorldsRepoOptions = {}): WorldsRepo {
  const storeP = opts.store ?? getLocalStore()
  // Scenes stored before worlds join the first world before anything reads the worlds.
  const store = async () => {
    const s = await storeP
    await localWorlds.adoptScenes(s)
    return s
  }
  const me = opts.userId ?? (() => localIdentity().userId)
  const summary = (w: LocalWorld): WorldSummary => ({ id: w.id, name: w.name, roomCode: w.roomCode, createdAt: w.createdAt, updatedAt: w.updatedAt })
  const world = async (id: string) => {
    const w = await localWorlds.get(await store(), id)
    if (!w) throw new NetError("not_found", "world not found")
    return w
  }
  const character = async (id: string) => {
    const c = await (await store()).get<LocalCharacter>("worlds", `c:${id}`)
    if (!c) throw new NetError("not_found", "character not found")
    return c
  }
  const characters = async (worldId: string) =>
    (await (await store()).entries<LocalCharacter>("worlds", "c:"))
      .map(([, c]) => c)
      .filter((c) => c.worldId === worldId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const toCharacter = (c: LocalCharacter): WorldCharacter => ({ ...c, playerIds: [...c.playerIds].sort() })
  /** Local sessions live in the same store ("sessions": s:{id}); the world's open table, and whether uid runs one. */
  const tables = async (worldId: string) =>
    (await (await store()).entries<{ id: string; dmId?: string; worldId?: string | null; status?: string }>("sessions", "s:"))
      .map(([, s]) => s)
      .filter((s) => s.worldId === worldId && s.status !== "ended")
  const info = (w: LocalWorld, openSessionId: string | null, chars: LocalCharacter[]): WorldInfo | null => {
    const uid = me()
    const m = Object.hasOwn(w.members, uid) ? w.members[uid] : undefined
    return {
      worldId: w.id,
      name: w.name,
      roomCode: w.roomCode,
      // The local library is the browser's: anyone who is not one of its players runs it.
      role: m && w.ownerId !== uid ? "player" : "dm",
      memberStatus: m?.status ?? null,
      displayName: m?.displayName ?? null,
      dmDisplayName: null,
      openSessionId: !m || m.status === "active" ? openSessionId : null,
      characters: m?.status === "active" ? chars.filter((c) => c.playerIds.includes(uid)).map((c) => c.name) : [],
    }
  }

  const repo: WorldsRepo = {
    storage: "local",
    async list() {
      return (await localWorlds.all(await store())).map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },
    async get(id) {
      const w = await localWorlds.get(await store(), id)
      return w ? summary(w) : null
    },
    async create(name) {
      const s = await store()
      if ((await localWorlds.all(s)).length >= MAX_WORLDS) throw new NetError("quota_exceeded", `at most ${MAX_WORLDS} worlds`)
      return summary(await localWorlds.create(s, name, me()))
    },
    async rename(id, name) {
      const w = { ...(await world(id)), name: normalizeWorldName(name), updatedAt: stamp() }
      await localWorlds.put(await store(), w)
      return summary(w)
    },
    async remove(id) {
      const s = await store()
      const w = await world(id)
      const scenes = await s.entries<{ worldId?: string }>("scenes")
      if (scenes.some(([, r]) => r.worldId === id)) throw new NetError("world_not_empty", "delete or move the world's scenes first")
      for (const c of await characters(id)) await s.delete("worlds", `c:${c.id}`)
      await s.delete("worlds", `code:${w.roomCode}`)
      await s.delete("worlds", `w:${id}`)
    },
    async listMembers(worldId) {
      const w = await world(worldId)
      return Object.entries(w.members)
        .map(([userId, m]) => ({ userId, displayName: m.displayName, status: m.status, joinedAt: m.joinedAt }))
        .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId))
    },
    async setMemberStatus(worldId, userId, status) {
      const w = await world(worldId)
      const m = Object.hasOwn(w.members, userId) ? w.members[userId] : undefined
      if (!m || m.status === status) return false
      await localWorlds.put(await store(), { ...w, members: { ...w.members, [userId]: { ...m, status } } })
      return true
    },
    async listCharacters(worldId) {
      await world(worldId)
      return (await characters(worldId)).map(toCharacter)
    },
    async createCharacter(worldId, input) {
      await world(worldId)
      if ((await characters(worldId)).length >= MAX_CHARACTERS_PER_WORLD)
        throw new NetError("quota_exceeded", `at most ${MAX_CHARACTERS_PER_WORLD} characters per world`)
      const f = characterFields({ color: DEFAULT_CHARACTER_COLOR, ...input })
      const now = stamp()
      const c: LocalCharacter = {
        id: crypto.randomUUID(),
        worldId,
        name: f.name!,
        color: f.color!,
        imageUrl: f.image_url ?? null,
        playerIds: [],
        createdAt: now,
        updatedAt: now,
      }
      await (await store()).put("worlds", `c:${c.id}`, c)
      return toCharacter(c)
    },
    async updateCharacter(id, patch) {
      const c = await character(id)
      const f = characterFields(patch)
      const next: LocalCharacter = {
        ...c,
        ...(f.name !== undefined ? { name: f.name } : {}),
        ...(f.color !== undefined ? { color: f.color } : {}),
        ...(f.image_url !== undefined ? { imageUrl: f.image_url } : {}),
        updatedAt: stamp(),
      }
      await (await store()).put("worlds", `c:${id}`, next)
      return toCharacter(next)
    },
    async removeCharacter(id) {
      await character(id)
      await (await store()).delete("worlds", `c:${id}`)
    },
    async setCharacterPlayers(ref, userIds) {
      const c = await character(ref.id)
      const w = await world(c.worldId)
      const want = [...new Set(userIds)].sort()
      if (want.length > MAX_PLAYERS_PER_CHARACTER) throw new NetError("quota_exceeded", `at most ${MAX_PLAYERS_PER_CHARACTER} players per character`)
      if (want.some((u) => !Object.hasOwn(w.members, u))) throw new NetError("invalid_argument", "only players of the world can play its characters")
      await (await store()).put("worlds", `c:${c.id}`, { ...c, playerIds: want, updatedAt: stamp() })
    },
    async join(roomCode, displayName) {
      const code = requireCode(roomCode)
      const name = requireName(displayName)
      const s = await store()
      const w = await localWorlds.byCode(s, code)
      if (!w) throw new NetError("session_not_found", "no world with that room code")
      const uid = me()
      const live = await tables(w.id)
      if (w.ownerId === uid || live.some((t) => t.dmId === uid)) throw new NetError("is_dm", "you are the DM of this world")
      const existing = Object.hasOwn(w.members, uid) ? w.members[uid] : undefined
      if (existing?.status === "kicked") throw new NetError("kicked", "you were removed from this world")
      if (!existing && Object.keys(w.members).length >= MAX_MEMBERS_PER_WORLD) throw new NetError("session_full", "this world has too many players")
      // Like join_world: no posing as the DM, no second player with the same name.
      if (displayNameTaken(name, uid, w.members)) throw new NetError("name_taken", "that name is taken in this world")
      await localWorlds.put(s, { ...w, members: { ...w.members, [uid]: { displayName: name, status: "active", joinedAt: existing?.joinedAt ?? stamp() } } })
      return { worldId: w.id, sessionId: live.find((t) => t.status === "active")?.id ?? null }
    },
    async info(worldId) {
      const w = await localWorlds.get(await store(), worldId)
      if (!w) return null
      const open = (await tables(worldId)).find((t) => t.status === "active")?.id ?? null
      return info(w, open, await characters(worldId))
    },
    async listJoined() {
      const uid = me()
      const out: JoinedWorldInfo[] = []
      for (const w of await localWorlds.all(await store())) {
        const m = Object.hasOwn(w.members, uid) ? w.members[uid] : undefined
        if (!m) continue
        const i = await repo.info(w.id)
        if (i) out.push({ ...i, joinedAt: m.joinedAt })
      }
      return out.sort((a, b) => b.joinedAt.localeCompare(a.joinedAt) || a.worldId.localeCompare(b.worldId))
    },
  }
  return repo
}

export interface WorldsRepoOptions extends LocalWorldsRepoOptions {
  /** null forces local mode. Default: the app client when Supabase is configured. */
  client?: AtlasClient | null
}

/** Remote repository when Supabase is configured, the local (dev) one otherwise. */
export function createWorldsRepo(opts: WorldsRepoOptions = {}): WorldsRepo {
  const client = opts.client === undefined ? getSupabaseOrNull() : opts.client
  return client ? createRemoteWorldsRepo(client) : createLocalWorldsRepo(opts)
}
