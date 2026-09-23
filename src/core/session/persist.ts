/**
 * GameState persistence (docs/ARCHITECTURE.md §6.3): the host saves its GameState into
 * `session_state` (fenced by the host epoch) and reloads it on the next host start.
 *
 * `parseGameState` treats the stored JSON as untrusted:
 *  - SHAPE is validated strictly (zod strict objects at every depth, bounded sizes, exact base64 lengths
 *    for explored masks, remembered objects through `memoryObjectSchema` — the wire allowlist plus a
 *    remembered floor's mask, which host memory keeps and views never carry); anything
 *    malformed rejects the whole state (null);
 *  - the scene goes through `parseScene` (migrations + strict schema + reference integrity);
 *  - dangling REFERENCES are dropped rather than rejected, so a state saved just before a scene edit
 *    still loads: ownership of tokens that no longer exist or by users who are not players, knowledge
 *    (explored / memory / revealed) of users who are not players, explored masks of unknown levels or
 *    of another grid size, and remembered objects on levels that no longer exist.
 */
import { z } from "zod"

import { base64ToBytes } from "../scene/heightmap"
import { idSchema, parseScene } from "../scene/schema"
import type { Id } from "../scene/types"
import type { EncodedMask } from "../vision/types"
import { memoryObjectSchema } from "./playerViewSchema"
import { GAME_STATE_VERSION, type GameState, type PlayerObject, type SessionPlayer } from "./types"

export const GAME_STATE_LIMITS = {
  maxPlayers: 256,
  /** User ids (Supabase uuids, local per-tab uuids, test ids): printable ASCII. */
  maxUserIdLength: 128,
  maxDisplayName: 64,
  maxSessionIdLength: 128,
  maxRoomCodeLength: 64,
  /** Owners of one token. */
  maxOwnersPerToken: 256,
  /** Remembered objects per player (the scene itself allows ≤ 20k objects). */
  maxMemoryPerPlayer: 25_000,
  maxRevealedPerPlayer: 20_000,
  /** Grids are ≤ 200×200 cells. */
  maxMaskSide: 200,
} as const

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"])

const userIdSchema = z
  .string()
  .min(1)
  .max(GAME_STATE_LIMITS.maxUserIdLength)
  .regex(/^[\x21-\x7e]+$/, "invalid user id")
  .refine((s) => !FORBIDDEN_KEYS.has(s), "invalid user id")

/** Remembered object ids: a scene id (memory holds whole objects, never clipped pieces). */
const memoryKeySchema = idSchema

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "invalid base64")

const side = z.int().min(1).max(GAME_STATE_LIMITS.maxMaskSide)

/** Base64 of exactly `bytes` bytes (canonical length, so decoding never pads or truncates). */
function hasByteLength(b64: string, bytes: number): boolean {
  if (b64.length !== 4 * Math.ceil(bytes / 3)) return false
  try {
    return base64ToBytes(b64).length === bytes
  } catch {
    return false
  }
}

/** The (u32 cell, u16 sub-cell mask) pairs of an encoded mask's `partial`: sorted, in range, non-empty masks. */
function validPartial(b64: string, cells: number): boolean {
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(b64)
  } catch {
    return false
  }
  if (bytes.length === 0 || bytes.length % 6 !== 0) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let last = -1
  for (let o = 0; o < bytes.length; o += 6) {
    const cell = view.getUint32(o, true)
    const mask = view.getUint16(o + 4, true)
    if (cell <= last || cell >= cells || mask === 0) return false
    last = cell
  }
  return true
}

const encodedMaskSchema = z
  .strictObject({ width: side, depth: side, b64: base64, partial: base64.optional() })
  .superRefine((m, ctx) => {
    const cells = m.width * m.depth
    if (!hasByteLength(m.b64, Math.ceil(cells / 8))) ctx.addIssue({ code: "custom", message: "mask bits have the wrong length" })
    if (m.partial !== undefined && !validPartial(m.partial, cells)) ctx.addIssue({ code: "custom", message: "invalid partial cells" })
  })

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)

const playerSchema = z.strictObject({
  userId: userIdSchema,
  displayName: z.string().min(1).max(GAME_STATE_LIMITS.maxDisplayName),
  color: colorSchema,
  movementLocked: z.boolean(),
})

/**
 * Record with a validated key schema whose size is checked BEFORE the values are walked. zod's record
 * silently drops a "__proto__" key; a stored state carrying one is corrupt or hostile, so reject it.
 */
function boundedRecord<K extends z.ZodType<string>, V extends z.ZodType>(key: K, value: V, max: number) {
  return z
    .custom<Record<string, unknown>>((v) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return false
      const keys = Object.keys(v)
      return keys.length <= max && !keys.includes("__proto__")
    }, `expected an object with at most ${max} entries`)
    .pipe(z.record(key, value))
}

const gameStateShape = z.strictObject({
  stateVersion: z.literal(GAME_STATE_VERSION),
  sessionId: z.string().min(1).max(GAME_STATE_LIMITS.maxSessionIdLength),
  roomCode: z.string().max(GAME_STATE_LIMITS.maxRoomCodeLength),
  scene: z.unknown(),
  players: boundedRecord(userIdSchema, playerSchema, GAME_STATE_LIMITS.maxPlayers),
  owners: boundedRecord(idSchema, z.array(userIdSchema).max(GAME_STATE_LIMITS.maxOwnersPerToken), 20_000),
  movementLocked: z.boolean(),
  sharedVision: z.boolean(),
  enforceSpeed: z.boolean(),
  explored: boundedRecord(userIdSchema, boundedRecord(idSchema, encodedMaskSchema, 64), GAME_STATE_LIMITS.maxPlayers),
  // Entries are validated one by one below (strict wire allowlist), after the size check.
  memory: boundedRecord(userIdSchema, boundedRecord(memoryKeySchema, z.unknown(), GAME_STATE_LIMITS.maxMemoryPerPlayer), GAME_STATE_LIMITS.maxPlayers),
  revealed: boundedRecord(userIdSchema, z.array(idSchema).max(GAME_STATE_LIMITS.maxRevealedPerPlayer), GAME_STATE_LIMITS.maxPlayers),
  seq: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
})

export type ParseGameStateResult = { ok: true; state: GameState } | { ok: false; issues: string[] }

const MAX_ISSUES = 20

function issuesOf(error: z.ZodError): string[] {
  return error.issues.slice(0, MAX_ISSUES).map((i) => {
    const path = i.path.map(String).join(".")
    return path ? `${path}: ${i.message}` : i.message
  })
}

/** Validate and normalise a stored GameState. See the module comment for what is rejected vs dropped. */
export function parseGameStateDetailed(json: unknown): ParseGameStateResult {
  let raw: z.infer<typeof gameStateShape>
  try {
    const res = gameStateShape.safeParse(json)
    if (!res.success) return { ok: false, issues: issuesOf(res.error) }
    raw = res.data
  } catch (err) {
    // Hostile getters / proxies.
    return { ok: false, issues: [`unreadable state: ${err instanceof Error ? err.message : String(err)}`] }
  }

  const parsedScene = parseScene(raw.scene)
  if (!parsedScene.ok) return { ok: false, issues: [`scene ${parsedScene.error}`, ...parsedScene.issues.slice(0, MAX_ISSUES - 1)] }
  const scene = parsedScene.scene
  const grid = scene.grid
  const hasLevel = (id: Id) => Object.hasOwn(scene.levels, id)

  // ---- players ------------------------------------------------------------------------------
  const players = {} as Record<string, SessionPlayer>
  for (const [uid, p] of Object.entries(raw.players)) {
    if (p.userId !== uid) return { ok: false, issues: [`players.${uid}: record key must equal userId`] }
    players[uid] = { userId: p.userId, displayName: p.displayName, color: p.color, movementLocked: p.movementLocked }
  }
  const isPlayer = (uid: string) => Object.hasOwn(players, uid)

  // ---- owners: existing tokens, players only, sorted and unique ------------------------------
  const owners = {} as Record<string, string[]>
  for (const [tokenId, list] of Object.entries(raw.owners)) {
    if (!Object.hasOwn(scene.tokens, tokenId)) continue
    const users = [...new Set(list.filter(isPlayer))].sort()
    if (users.length > 0) owners[tokenId] = users
  }

  // ---- explored: players, existing levels, current grid size --------------------------------
  const explored = {} as Record<string, Record<Id, EncodedMask>>
  for (const [uid, levels] of Object.entries(raw.explored)) {
    if (!isPlayer(uid)) continue
    const out = {} as Record<string, EncodedMask>
    for (const [levelId, m] of Object.entries(levels)) {
      if (!hasLevel(levelId) || m.width !== grid.width || m.depth !== grid.depth) continue
      const enc: EncodedMask = { width: m.width, depth: m.depth, b64: m.b64 }
      if (m.partial !== undefined) enc.partial = m.partial
      out[levelId] = enc
    }
    explored[uid] = out
  }

  // ---- memory: strict allowlist per entry (+ floor masks); entries on missing levels are dropped ------
  const memory = {} as Record<string, Record<Id, PlayerObject>>
  for (const [uid, entries] of Object.entries(raw.memory)) {
    const out = {} as Record<string, PlayerObject>
    for (const [id, value] of Object.entries(entries)) {
      const res = memoryObjectSchema.safeParse(value)
      if (!res.success) return { ok: false, issues: issuesOf(res.error).map((s) => `memory.${uid}.${id}: ${s}`) }
      const o = res.data as PlayerObject
      if (o.id !== id) return { ok: false, issues: [`memory.${uid}.${id}: record key must equal the entry id`] }
      if (!isPlayer(uid)) continue
      if (!hasLevel(o.levelId) || (o.type === "connector" && !hasLevel(o.toLevelId))) continue
      out[id] = o
    }
    if (isPlayer(uid)) memory[uid] = out
  }

  // ---- revealed: players only, sorted and unique --------------------------------------------
  const revealed = {} as Record<string, Id[]>
  for (const [uid, ids] of Object.entries(raw.revealed)) {
    if (!isPlayer(uid)) continue
    revealed[uid] = [...new Set(ids)].sort()
  }

  return {
    ok: true,
    state: {
      stateVersion: GAME_STATE_VERSION,
      sessionId: raw.sessionId,
      roomCode: raw.roomCode,
      scene,
      players,
      owners,
      movementLocked: raw.movementLocked,
      sharedVision: raw.sharedVision,
      enforceSpeed: raw.enforceSpeed,
      explored,
      memory,
      revealed,
      seq: raw.seq,
    },
  }
}

/** Validate a stored GameState (parsed JSON). null when it cannot be loaded. */
export function parseGameState(json: unknown): GameState | null {
  const res = parseGameStateDetailed(json)
  return res.ok ? res.state : null
}

/** Parse a GameState from JSON text (syntax errors → null). */
export function parseGameStateJson(text: string): GameState | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  return parseGameState(json)
}

/**
 * JSON text of a GameState for storage. GameState is plain JSON data already; this pins the field
 * order and drops `undefined` optionals so a save → load round trip is lossless.
 */
export function serializeGameState(state: GameState): string {
  const ordered: GameState = {
    stateVersion: state.stateVersion,
    sessionId: state.sessionId,
    roomCode: state.roomCode,
    scene: state.scene,
    players: state.players,
    owners: state.owners,
    movementLocked: state.movementLocked,
    sharedVision: state.sharedVision,
    enforceSpeed: state.enforceSpeed,
    explored: state.explored,
    memory: state.memory,
    revealed: state.revealed,
    seq: state.seq,
  }
  return JSON.stringify(ordered)
}
