/**
 * Strict zod schema of the PlayerView wire type (core/session/types.ts). It pins the allowlist: a view
 * carrying any field not listed here fails to parse. Used by tests (filter output must round-trip
 * unchanged) and by clients to validate snapshots loaded from the database.
 */
import { z } from "zod"

import { TOKEN_MODEL_REF_RE } from "../scene/tokenModel"
import { PLAYER_VIEW_VERSION, type PlayerView } from "./types"

const MAX_ID = 64
const MAX_STRING = 2000

/** Scene ids (nanoid alphabet). */
const id = z
  .string()
  .min(1)
  .max(MAX_ID)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((s) => s !== "__proto__")
/** Object ids: a scene id, or a clipped piece id `${sourceId}@${x},${z}`. */
const objectId = z
  .string()
  .max(MAX_ID + 48)
  .regex(/^[A-Za-z0-9_-]+(@-?\d+(\.\d+)?(e-?\d+)?,-?\d+(\.\d+)?(e-?\d+)?)?$/)
  .refine((s) => s !== "__proto__")
const text = z.string().max(MAX_STRING)
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const num = z.number()
const nonNeg = z.number().min(0)
const vec2 = z.strictObject({ x: num, z: num })
const vec3 = z.strictObject({ x: num, y: num, z: num })
const rect = z.strictObject({ x: num, z: num, w: nonNeg, d: nonNeg })
const material = z.enum(["stone", "brick", "wood", "plaster", "dirt", "grass", "sand", "water", "metal", "marble", "tile", "cobble"])
const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/)

const floor = z.strictObject({
  id: objectId,
  type: z.literal("floor"),
  levelId: id,
  rect,
  material,
  thickness: nonNeg.optional(),
})

const wall = z.strictObject({
  id: objectId,
  type: z.literal("wall"),
  levelId: id,
  a: vec2,
  b: vec2,
  height: num,
  thickness: nonNeg,
  material,
})

const door = z.strictObject({
  id,
  type: z.literal("door"),
  levelId: id,
  wallId: objectId,
  offset: num,
  width: nonNeg,
  height: num,
  leaves: z.enum(["single", "double"]),
  hinge: z.enum(["start", "end"]),
  swing: z.union([z.literal(1), z.literal(-1)]),
  state: z.enum(["open", "closed"]),
  style: z.enum(["wood", "iron", "portcullis", "bars"]),
})

const window_ = z.strictObject({
  id,
  type: z.literal("window"),
  levelId: id,
  wallId: objectId,
  offset: num,
  width: nonNeg,
  sillHeight: num,
  height: num,
})

const connector = z.strictObject({
  id,
  type: z.literal("connector"),
  levelId: id,
  style: z.enum(["stairs", "ladder", "ramp"]),
  toLevelId: id,
  rect,
  direction: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  material,
})

const pillar = z.strictObject({
  id,
  type: z.literal("pillar"),
  levelId: id,
  position: vec2,
  shape: z.enum(["round", "square"]),
  size: nonNeg,
  height: num.nullable(),
  material,
})

const prop = z.strictObject({
  id,
  type: z.literal("prop"),
  levelId: id,
  kind: z.enum(["table", "chair", "crate", "barrel", "chest", "bookshelf", "bed", "altar", "statue", "tree", "bush", "rock", "well", "cart"]),
  position: vec3,
  rotationY: num,
  scale: vec3,
  color: color.nullable(),
  blocksSight: z.boolean(),
  castsShadows: z.boolean(),
})

const light = z.strictObject({
  id,
  type: z.literal("light"),
  levelId: id,
  position: vec3,
  color,
  intensity: nonNeg,
  brightRadius: nonNeg,
  dimRadius: nonNeg,
  flicker: z.strictObject({ enabled: z.boolean(), speed: num, amount: num }),
  on: z.boolean(),
  castsShadows: z.boolean(),
  emitting: z.boolean(),
})

export const playerObjectSchema = z.discriminatedUnion("type", [floor, wall, door, window_, connector, pillar, prop, light])

/** Max mask cells (matches the scene schema: 800×800). */
const MAX_MASK_CELLS = 800 * 800

/** A floor mask as kept in HOST memory (never on the wire): exact bitset length, bounded size. */
const floorMask = z
  .strictObject({
    spacing: z.number().gt(0).max(100),
    cols: z.int().min(1).max(4096),
    rows: z.int().min(1).max(4096),
    b64: base64.max(Math.ceil(MAX_MASK_CELLS / 8 / 3) * 4 + 4),
  })
  .refine((m) => m.cols * m.rows <= MAX_MASK_CELLS, "floor mask too large")
  .refine((m) => {
    const bytes = Math.ceil((m.cols * m.rows) / 8)
    return m.b64.length === 4 * Math.ceil(bytes / 3)
  }, "floor mask length does not match cols × rows")

/** A remembered floor: the wire fields plus its coverage mask (sanitize.ts MemoryFloor). */
const memoryFloor = z.strictObject({
  id: objectId,
  type: z.literal("floor"),
  levelId: id,
  rect,
  material,
  thickness: nonNeg.optional(),
  mask: floorMask.optional(),
})

/**
 * Remembered objects in GameState.memory (HOST side only, e.g. a persisted session_state): the wire
 * allowlist, except that floors may keep their `mask` (the filter clips it and never sends it). Use
 * this — not playerObjectSchema — to validate stored memory.
 */
export const memoryObjectSchema = z.discriminatedUnion("type", [memoryFloor, wall, door, window_, connector, pillar, prop, light])

const vision = z.strictObject({ darkvision: nonNeg, blindsight: nonNeg, blind: z.boolean() })

export const playerTokenSchema = z.strictObject({
  id,
  levelId: id,
  position: vec2,
  size: z.enum(["tiny", "small", "medium", "large", "huge", "gargantuan"]),
  height: nonNeg,
  color,
  imageUrl: text.nullable(),
  model: z.string().regex(TOKEN_MODEL_REF_RE).optional(),
  label: text.nullable(),
  name: text.optional(),
  eyeHeight: num.optional(),
  vision: vision.optional(),
  speed: nonNeg.optional(),
})

const level = z.strictObject({
  id,
  known: z.boolean(),
  name: text.nullable(),
  elevation: num,
  height: num,
  floorThickness: num,
  terrainResolution: z.union([z.literal(1), z.literal(2), z.literal(4), z.null()]),
})

const grid = z.strictObject({
  cellSize: z.number().gt(0),
  width: z.int().min(1),
  depth: z.int().min(1),
  diagonalRule: z.enum(["5-5-5", "5-10-5", "euclidean"]),
})

const ambient = z.enum(["bright", "dim", "dark"])
const environment = z.strictObject({
  skyLevel: ambient,
  ambientLevel: ambient,
  ambientColor: color,
  ambientIntensity: nonNeg,
  directional: z.strictObject({
    enabled: z.boolean(),
    kind: z.enum(["sun", "moon"]),
    azimuth: num,
    elevation: num,
    color,
    intensity: nonNeg,
    grants: z.enum(["bright", "dim"]),
  }),
  backgroundColor: color,
})

/** Backdrop placement only: an asset id, name, mask or pixels never fit (strict). */
const backdrop = z.strictObject({
  rect,
  opacity: z.number().min(0).max(1),
  tintWalls: z.boolean(),
  tilePx: z.int().min(1).max(1024),
})

const encodedMask = z.strictObject({ width: z.int().min(1), depth: z.int().min(1), b64: base64, partial: base64.optional() })

/** Record whose keys must equal each value's `id`. */
function keyedRecord<T extends z.ZodType<{ id: string }>>(key: z.ZodString | z.ZodType<string>, value: T) {
  return z.record(key, value).refine((rec) => Object.entries(rec).every(([k, v]) => (v as { id: string }).id === k), "record key must equal the entry id")
}

export const playerViewSchema = z.strictObject({
  viewVersion: z.literal(PLAYER_VIEW_VERSION),
  sessionId: text,
  userId: text,
  scene: z.strictObject({
    name: text,
    grid,
    environment,
    levels: keyedRecord(id, level),
  }),
  objects: keyedRecord(objectId, playerObjectSchema),
  tokens: keyedRecord(id, playerTokenSchema),
  terrain: z.record(id, z.record(z.string().regex(/^(0|[1-9]\d*),(0|[1-9]\d*)$/), base64)),
  masks: z.record(id, z.strictObject({ perception: encodedMask, explored: encodedMask, sunlit: encodedMask })),
  backdrops: z.record(id, backdrop).optional(),
  controlledTokenIds: z.array(id),
  visionTokenIds: z.array(id),
  flags: z.strictObject({ movementLocked: z.boolean(), sharedVision: z.boolean(), enforceSpeed: z.boolean() }),
})

/** Validate an untrusted PlayerView (e.g. a player_views row). null when it does not match exactly. */
export function parsePlayerView(json: unknown): PlayerView | null {
  const res = playerViewSchema.safeParse(json)
  return res.success ? (res.data as PlayerView) : null
}
