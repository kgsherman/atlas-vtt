/**
 * zod schema + parsing for the scene document (docs/ARCHITECTURE.md §3).
 *
 * Every object schema is STRICT (unknown keys are rejected) and bounded, because scene documents
 * come from files, share links and the database. Numbers must be finite (zod 4 rejects NaN and
 * ±Infinity). Geometric checks that need the grid (coordinates within the extent ± margin,
 * connector cell alignment, heightmap chunk ranges) run in a scene-level refinement; reference
 * checks (ids pointing at existing things) run in integrity.validateReferences.
 */
import { z } from "zod"

import { base64ToBytes, chunkSamples, parseChunkKey, sampleCounts } from "./heightmap"
import { MAX_TERRAIN_HEIGHT } from "./heightmapBrush"
import { validateReferences } from "./integrity"
import { migrateToCurrent } from "./migrations"
import { SCENE_SCHEMA_VERSION, type Scene } from "./types"

export const SCENE_LIMITS = {
  /** Max grid width / depth in cells. */
  maxGridCells: 200,
  minCellSize: 0.5,
  maxCellSize: 100,
  maxLevels: 32,
  maxObjects: 20_000,
  maxTokens: 1_000,
  /** Free-text strings (names, notes, descriptions, URLs). */
  maxString: 2_000,
  maxIdLength: 64,
  maxTags: 32,
  /** Points and rects must lie within [−margin, extent + margin] on X and Z (feet). */
  coordMargin: 50,
  /** |elevation| and |y offsets| (feet). */
  maxAbsY: 1_000,
  /** Heights, thicknesses, sizes, radii (feet). */
  maxLength: 1_000,
  /** Darkvision / blindsight / speed (feet). */
  maxRange: 10_000,
  maxScale: 100,
  maxIntensity: 100,
  /** Stored heights of a heightmap chunk (feet). */
  maxTerrainHeight: MAX_TERRAIN_HEIGHT,
} as const

/** Max issues reported by parseScene (a garbage document could otherwise yield thousands). */
const MAX_ISSUES = 50

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const num = z.number()
const nonNeg = (max: number) => z.number().min(0).max(max)
const positive = (max: number) => z.number().gt(0).max(max)
const ycoord = z.number().min(-SCENE_LIMITS.maxAbsY).max(SCENE_LIMITS.maxAbsY)

/** Ids: nanoid alphabet, and never "__proto__" (ids are record keys). */
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "invalid id")
  .min(1)
  .max(SCENE_LIMITS.maxIdLength)
  .refine((s) => s !== "__proto__", "invalid id")

const text = z.string().max(SCENE_LIMITS.maxString)
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected a #rrggbb colour")
/** Absolute http(s) URL or a same-origin absolute path (never javascript:, data:, protocol-relative…). */
const imageUrlSchema = z
  .string()
  .max(SCENE_LIMITS.maxString)
  .regex(/^(https?:\/\/|\/(?!\/))/i, "expected an http(s) URL or an absolute path")

const vec2Schema = z.strictObject({ x: num, z: num })
const vec3Schema = z.strictObject({ x: num, y: ycoord, z: num })
const rectSchema = z.strictObject({ x: num, z: num, w: positive(SCENE_LIMITS.maxCellSize * SCENE_LIMITS.maxGridCells), d: positive(SCENE_LIMITS.maxCellSize * SCENE_LIMITS.maxGridCells) })

const materialSchema = z.enum(["stone", "brick", "wood", "plaster", "dirt", "grass", "sand", "water", "metal", "marble", "tile", "cobble"])

// ---------------------------------------------------------------------------
// Grid, environment
// ---------------------------------------------------------------------------

const gridSchema = z.strictObject({
  cellSize: z.number().min(SCENE_LIMITS.minCellSize).max(SCENE_LIMITS.maxCellSize),
  width: z.int().min(1).max(SCENE_LIMITS.maxGridCells),
  depth: z.int().min(1).max(SCENE_LIMITS.maxGridCells),
  diagonalRule: z.enum(["5-5-5", "5-10-5", "euclidean"]),
})

const ambientLevelSchema = z.enum(["bright", "dim", "dark"])

const environmentSchema = z.strictObject({
  skyLevel: ambientLevelSchema,
  ambientLevel: ambientLevelSchema,
  ambientColor: colorSchema,
  ambientIntensity: nonNeg(SCENE_LIMITS.maxIntensity),
  directional: z.strictObject({
    enabled: z.boolean(),
    kind: z.enum(["sun", "moon"]),
    azimuth: z.number().min(-4 * Math.PI).max(4 * Math.PI),
    elevation: z.number().min(0).max(Math.PI / 2),
    color: colorSchema,
    intensity: nonNeg(SCENE_LIMITS.maxIntensity),
    grants: z.enum(["bright", "dim"]),
  }),
  backgroundColor: colorSchema,
})

// ---------------------------------------------------------------------------
// Levels & heightmaps
// ---------------------------------------------------------------------------

/** Canonical chunk keys "ci,cj" (no sign, no leading zeros, so each chunk has exactly one key). */
const CHUNK_KEY = /^(0|[1-9]\d*),(0|[1-9]\d*)$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** Base64 length of n bytes (with padding). */
const base64Length = (bytes: number) => 4 * Math.ceil(bytes / 3)

const heightmapSchema = z
  .strictObject({
    resolution: z.union([z.literal(1), z.literal(2), z.literal(4)]),
    chunks: z.record(z.string().regex(CHUNK_KEY, "invalid chunk key"), z.string().max(base64Length(chunkSamples(4) ** 2 * 4)).regex(BASE64, "invalid base64")),
  })
  .superRefine((hm, ctx) => {
    const n = chunkSamples(hm.resolution)
    const bytes = n * n * 4
    const entries = Object.entries(hm.chunks)
    // More chunks than a 200×200 grid can have at this resolution: reject before decoding anything.
    const maxPerAxis = Math.ceil((SCENE_LIMITS.maxGridCells * hm.resolution + 1) / n)
    if (entries.length > maxPerAxis * maxPerAxis) {
      ctx.addIssue({ code: "custom", message: `too many heightmap chunks (${entries.length})`, path: ["chunks"] })
      return
    }
    for (const [key, b64] of entries) {
      if (b64.length !== base64Length(bytes)) {
        ctx.addIssue({ code: "custom", message: `chunk must decode to exactly ${bytes} bytes`, path: ["chunks", key] })
        continue
      }
      let raw: Uint8Array
      try {
        raw = base64ToBytes(b64)
      } catch {
        ctx.addIssue({ code: "custom", message: "invalid base64", path: ["chunks", key] })
        continue
      }
      if (raw.byteLength !== bytes) {
        ctx.addIssue({ code: "custom", message: `chunk must decode to exactly ${bytes} bytes`, path: ["chunks", key] })
        continue
      }
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
      for (let k = 0; k < n * n; k++) {
        const h = view.getFloat32(k * 4, true)
        if (!Number.isFinite(h) || Math.abs(h) > MAX_TERRAIN_HEIGHT) {
          ctx.addIssue({ code: "custom", message: `chunk sample ${k} is not a finite height within ±${MAX_TERRAIN_HEIGHT} ft`, path: ["chunks", key] })
          break
        }
      }
    }
  })

const backdropSchema = z.strictObject({
  assetId: idSchema,
  rect: rectSchema,
  opacity: z.number().min(0).max(1),
  tintWalls: z.boolean(),
})

const levelSchema = z.strictObject({
  id: idSchema,
  name: text,
  elevation: ycoord,
  height: positive(SCENE_LIMITS.maxLength),
  floorThickness: positive(SCENE_LIMITS.maxLength),
  heightmap: heightmapSchema.nullable(),
  backdrop: backdropSchema.nullable().optional(),
})

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

const baseFields = {
  id: idSchema,
  levelId: idSchema,
  name: text.optional(),
  dmNotes: text.optional(),
  editorLocked: z.boolean().optional(),
  hidden: z.boolean().optional(),
}

/** Max mask cells per floor (e.g. a 200×200-cell map at 4 mask cells per grid cell = 640k). */
const MAX_FLOOR_MASK_CELLS = 800 * 800

const floorMaskSchema = z
  .strictObject({
    spacing: positive(SCENE_LIMITS.maxCellSize),
    cols: z.number().int().min(1).max(4096),
    rows: z.number().int().min(1).max(4096),
    b64: z.string().max(Math.ceil(MAX_FLOOR_MASK_CELLS / 8 / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, "expected base64"),
  })
  .superRefine((m, ctx) => {
    if (m.cols * m.rows > MAX_FLOOR_MASK_CELLS) ctx.addIssue({ code: "custom", message: "floor mask too large" })
    const expected = Math.ceil((m.cols * m.rows) / 8)
    const decoded = Math.floor((m.b64.length * 3) / 4) - (m.b64.endsWith("==") ? 2 : m.b64.endsWith("=") ? 1 : 0)
    if (decoded !== expected) ctx.addIssue({ code: "custom", message: `floor mask must decode to ${expected} bytes` })
  })

const floorSchema = z
  .strictObject({
    ...baseFields,
    type: z.literal("floor"),
    rect: rectSchema,
    mask: floorMaskSchema.optional(),
    material: materialSchema,
    thickness: positive(SCENE_LIMITS.maxLength).optional(),
  })
  .superRefine((f, ctx) => {
    if (!f.mask) return
    const s = f.mask.spacing
    if (Math.abs(f.mask.cols * s - f.rect.w) > s + 1e-6 || Math.abs(f.mask.rows * s - f.rect.d) > s + 1e-6) {
      ctx.addIssue({ code: "custom", message: "floor mask dimensions must cover the floor rect", path: ["mask"] })
    }
  })

const assetSchema = z.strictObject({
  id: idSchema,
  kind: z.literal("image"),
  name: text,
  mime: z.enum(["image/webp", "image/png", "image/jpeg"]),
  width: z.number().int().min(1).max(32768),
  height: z.number().int().min(1).max(32768),
  bytes: z.number().int().min(0).max(512 * 1024 * 1024),
})

const wallSchema = z
  .strictObject({
    ...baseFields,
    type: z.literal("wall"),
    a: vec2Schema,
    b: vec2Schema,
    height: positive(SCENE_LIMITS.maxLength),
    thickness: positive(SCENE_LIMITS.maxLength),
    material: materialSchema,
  })
  .refine((w) => Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z) >= 0.01, { message: "wall must be at least 0.01 ft long", path: ["b"] })

const doorSchema = z.strictObject({
  ...baseFields,
  type: z.literal("door"),
  wallId: idSchema,
  offset: num,
  width: positive(SCENE_LIMITS.maxLength),
  height: positive(SCENE_LIMITS.maxLength),
  state: z.enum(["open", "closed", "locked"]),
  style: z.enum(["wood", "iron", "portcullis", "bars", "secret"]),
  leaves: z.enum(["single", "double"]),
  hinge: z.enum(["start", "end"]),
  swing: z.union([z.literal(1), z.literal(-1)]),
})

const windowSchema = z.strictObject({
  ...baseFields,
  type: z.literal("window"),
  wallId: idSchema,
  offset: num,
  width: positive(SCENE_LIMITS.maxLength),
  sillHeight: nonNeg(SCENE_LIMITS.maxLength),
  height: positive(SCENE_LIMITS.maxLength),
})

const connectorSchema = z.strictObject({
  ...baseFields,
  type: z.literal("connector"),
  style: z.enum(["stairs", "ladder", "ramp"]),
  toLevelId: idSchema,
  rect: rectSchema,
  direction: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  material: materialSchema,
})

const pillarSchema = z.strictObject({
  ...baseFields,
  type: z.literal("pillar"),
  position: vec2Schema,
  shape: z.enum(["round", "square"]),
  size: positive(SCENE_LIMITS.maxLength),
  height: positive(SCENE_LIMITS.maxLength).nullable(),
  material: materialSchema,
})

const propSchema = z.strictObject({
  ...baseFields,
  type: z.literal("prop"),
  kind: z.enum(["table", "chair", "crate", "barrel", "chest", "bookshelf", "bed", "altar", "statue", "tree", "bush", "rock", "well", "cart"]),
  position: vec3Schema,
  rotationY: z.number().min(-4 * Math.PI).max(4 * Math.PI),
  scale: z.strictObject({ x: positive(SCENE_LIMITS.maxScale), y: positive(SCENE_LIMITS.maxScale), z: positive(SCENE_LIMITS.maxScale) }),
  color: colorSchema.nullable(),
  blocksMovement: z.boolean(),
  blocksSight: z.boolean(),
  castsShadows: z.boolean(),
})

const lightSchema = z
  .strictObject({
    ...baseFields,
    type: z.literal("light"),
    preset: z.enum(["torch", "lantern", "brazier", "candle", "magical", "custom"]),
    position: vec3Schema,
    color: colorSchema,
    intensity: nonNeg(SCENE_LIMITS.maxIntensity),
    brightRadius: nonNeg(SCENE_LIMITS.maxLength),
    dimRadius: nonNeg(SCENE_LIMITS.maxLength),
    flicker: z.strictObject({ enabled: z.boolean(), speed: nonNeg(100), amount: z.number().min(0).max(1) }),
    on: z.boolean(),
    castsShadows: z.boolean(),
    attachedTokenId: idSchema.nullable(),
  })
  .refine((l) => l.dimRadius >= l.brightRadius, { message: "dimRadius must be ≥ brightRadius", path: ["dimRadius"] })

const objectSchema = z.discriminatedUnion("type", [floorSchema, wallSchema, doorSchema, windowSchema, connectorSchema, pillarSchema, propSchema, lightSchema])

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const tokenSchema = z.strictObject({
  id: idSchema,
  name: text,
  label: text.nullable(),
  kind: z.enum(["pc", "npc", "monster"]),
  levelId: idSchema,
  position: vec2Schema,
  size: z.enum(["tiny", "small", "medium", "large", "huge", "gargantuan"]),
  eyeHeight: nonNeg(SCENE_LIMITS.maxLength),
  height: positive(SCENE_LIMITS.maxLength),
  vision: z.strictObject({
    darkvision: nonNeg(SCENE_LIMITS.maxRange),
    blindsight: nonNeg(SCENE_LIMITS.maxRange),
    blind: z.boolean(),
  }),
  speed: nonNeg(SCENE_LIMITS.maxRange),
  color: colorSchema,
  imageUrl: imageUrlSchema.nullable(),
  hidden: z.boolean(),
  dmNotes: text.optional(),
})

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

type Ctx = z.RefinementCtx

/** Extent checks against the grid (points and rects within [−margin, extent + margin]). */
function checkExtent(scene: z.infer<typeof sceneShape>, ctx: Ctx): void {
  const m = SCENE_LIMITS.coordMargin
  const s = scene.grid.cellSize
  const maxX = scene.grid.width * s + m
  const maxZ = scene.grid.depth * s + m
  const inX = (x: number) => x >= -m && x <= maxX
  const inZ = (z: number) => z >= -m && z <= maxZ
  const point = (p: { x: number; z: number }, path: (string | number)[]) => {
    if (!inX(p.x) || !inZ(p.z)) ctx.addIssue({ code: "custom", message: "point lies outside the scene extent", path })
  }
  const rect = (r: { x: number; z: number; w: number; d: number }, path: (string | number)[]) => {
    if (!inX(r.x) || !inZ(r.z) || !inX(r.x + r.w) || !inZ(r.z + r.d)) ctx.addIssue({ code: "custom", message: "rect lies outside the scene extent", path })
  }
  /** Is v a whole multiple of the cell size (within float noise)? */
  const aligned = (v: number) => Math.abs(v / s - Math.round(v / s)) <= 1e-6

  for (const [id, o] of Object.entries(scene.objects)) {
    const path = ["objects", id]
    switch (o.type) {
      case "floor":
        rect(o.rect, [...path, "rect"])
        break
      case "wall":
        point(o.a, [...path, "a"])
        point(o.b, [...path, "b"])
        break
      case "connector":
        rect(o.rect, [...path, "rect"])
        if (![o.rect.x, o.rect.z, o.rect.w, o.rect.d].every(aligned)) {
          ctx.addIssue({ code: "custom", message: "connector rect must be cell-aligned", path: [...path, "rect"] })
        }
        if (o.style === "ladder" && (Math.abs(o.rect.w - s) > 1e-6 || Math.abs(o.rect.d - s) > 1e-6)) {
          ctx.addIssue({ code: "custom", message: "ladders must be exactly 1×1 cell", path: [...path, "rect"] })
        }
        break
      case "pillar":
      case "prop":
        point(o.position, [...path, "position"])
        break
      case "light":
        if (o.attachedTokenId === null) point(o.position, [...path, "position"])
        else if (Math.abs(o.position.x) > m || Math.abs(o.position.z) > m) {
          ctx.addIssue({ code: "custom", message: `attached light offset must be within ±${m} ft`, path: [...path, "position"] })
        }
        break
      default:
        break
    }
  }
  for (const [id, t] of Object.entries(scene.tokens)) point(t.position, ["tokens", id, "position"])

  for (const [id, level] of Object.entries(scene.levels)) {
    const hm = level.heightmap
    if (!hm) continue
    const n = chunkSamples(hm.resolution)
    const { samplesX, samplesZ } = sampleCounts(scene.grid, hm.resolution)
    const chunksX = Math.ceil(samplesX / n)
    const chunksZ = Math.ceil(samplesZ / n)
    for (const key of Object.keys(hm.chunks)) {
      const { ci, cj } = parseChunkKey(key)
      if (ci >= chunksX || cj >= chunksZ) {
        ctx.addIssue({ code: "custom", message: `chunk lies outside the grid (${chunksX}×${chunksZ} chunks)`, path: ["levels", id, "heightmap", "chunks", key] })
      }
    }
  }
}

const sceneShape = z.strictObject({
  schemaVersion: z.literal(SCENE_SCHEMA_VERSION),
  id: idSchema,
  name: text,
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
  grid: gridSchema,
  environment: environmentSchema,
  levels: z.record(idSchema, levelSchema),
  objects: z.record(idSchema, objectSchema),
  tokens: z.record(idSchema, tokenSchema),
  assets: z.record(idSchema, assetSchema).optional(),
  meta: z.strictObject({
    description: text,
    author: text,
    tags: z.array(z.string().max(64)).max(SCENE_LIMITS.maxTags),
  }),
})

/**
 * Collection sizes are checked on the raw input BEFORE the per-entry schemas run, so an oversized
 * document is rejected without validating 10⁶ entries.
 */
function checkSizes(input: unknown, ctx: Ctx): boolean {
  if (typeof input !== "object" || input === null) return true
  const doc = input as Record<string, unknown>
  const limits: [string, number, number][] = [
    ["levels", 1, SCENE_LIMITS.maxLevels],
    ["objects", 0, SCENE_LIMITS.maxObjects],
    ["tokens", 0, SCENE_LIMITS.maxTokens],
  ]
  let ok = true
  for (const [key, min, max] of limits) {
    const v = doc[key]
    if (typeof v !== "object" || v === null) continue
    const count = Object.keys(v).length
    if (count < min || count > max) {
      ctx.addIssue({ code: "custom", message: `${key}: expected ${min}..${max} entries, got ${count}`, path: [key] })
      ok = false
    }
  }
  return ok
}

/** Strict schema of the current (v1) scene document, including grid-dependent geometry checks. */
export const sceneSchema = z
  .unknown()
  .superRefine((input, ctx) => {
    checkSizes(input, ctx)
  })
  .pipe(sceneShape.superRefine(checkExtent))

// Compile-time guarantee that the schema produces the documented Scene type.
type SchemaOutput = z.output<typeof sceneSchema>
const _schemaMatchesScene: (s: SchemaOutput) => Scene = (s) => s
void _schemaMatchesScene

export type ParseSceneResult =
  | { ok: true; scene: Scene; migratedFrom: number | null }
  | { ok: false; error: "too-new" | "invalid"; issues: string[] }

function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  const out = issues.slice(0, MAX_ISSUES).map((i) => {
    const path = i.path.map(String).join(".")
    // Record-key failures ("Invalid key in record") carry the key schema's own issue: surface it.
    const inner = i.code === "invalid_key" && i.issues.length > 0 ? ` (${i.issues[0].message})` : ""
    const message = `${i.message}${inner}`
    return path ? `${path}: ${message}` : message
  })
  if (issues.length > MAX_ISSUES) out.push(`… and ${issues.length - MAX_ISSUES} more issues`)
  return out
}

/** Migrate (if needed), validate strictly, and check references. Accepts parsed JSON (not a string). */
export function parseScene(json: unknown): ParseSceneResult {
  const migrated = migrateToCurrent(json)
  if (!migrated.ok) return migrated
  const parsed = sceneSchema.safeParse(migrated.doc)
  if (!parsed.success) return { ok: false, error: "invalid", issues: formatIssues(parsed.error.issues) }
  const scene: Scene = parsed.data
  const refIssues = validateReferences(scene)
  if (refIssues.length > 0) {
    const issues = refIssues.slice(0, MAX_ISSUES)
    if (refIssues.length > MAX_ISSUES) issues.push(`… and ${refIssues.length - MAX_ISSUES} more issues`)
    return { ok: false, error: "invalid", issues }
  }
  return { ok: true, scene, migratedFrom: migrated.from === SCENE_SCHEMA_VERSION ? null : migrated.from }
}

/** Parse a `.atlas.json` string (JSON syntax errors are reported as "invalid"). */
export function parseSceneJson(text: string): ParseSceneResult {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: "invalid", issues: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }
  return parseScene(json)
}

export function serializeScene(scene: Scene, pretty = false): string {
  return JSON.stringify(scene, null, pretty ? 2 : undefined)
}
