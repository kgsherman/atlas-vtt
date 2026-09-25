/**
 * Validation of untrusted player → host messages (docs/ARCHITECTURE.md §6.2: "zod-validate (strict,
 * limits)"). Anything that does not match exactly is dropped: parseClientMessage returns null and the
 * host ignores the message. The sender is never a payload field (it is the {uid} of the topic).
 */
import { z } from "zod"

import { AREA_LIMITS, AREA_SHAPES } from "../area/types"
import { MAX_PATH_STEPS } from "../movement"
import { HP_LIMITS, TOKEN_CONDITIONS } from "../scene/tokenStatus"
import { TABLE_LIMITS } from "./table"
import { MAX_TOKEN_IMAGE_URL } from "./tokenImages"
import type { ClientToHost } from "./types"

export const PROTOCOL_LIMITS = {
  /** Scene ids, request ids and nonces. */
  maxIdLength: 64,
  /** Steps after the start (the path also contains its start, so ≤ maxPathSteps + 1 entries). */
  maxPathSteps: MAX_PATH_STEPS,
  /** |cell coordinate| accepted on the wire (grids are ≤ 200 cells; out-of-bounds is movement's call). */
  maxCellCoord: 1024,
  /** |world coordinate| (feet) accepted on the wire for free points (grids are ≤ 200 cells of ≤ 10 ft). */
  maxWorldCoord: 20_000,
  maxSeq: Number.MAX_SAFE_INTEGER,
} as const

/** Ids: the scene id alphabet, never "__proto__" (ids are record keys). */
const idSchema = z
  .string()
  .min(1)
  .max(PROTOCOL_LIMITS.maxIdLength)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((s) => s !== "__proto__")

/** Opaque client tokens (request ids, nonces, epochs): printable ASCII, bounded. */
const tokenSchema = z
  .string()
  .min(1)
  .max(PROTOCOL_LIMITS.maxIdLength)
  .regex(/^[\x21-\x7e]+$/)

const cellCoord = z.int().min(-PROTOCOL_LIMITS.maxCellCoord).max(PROTOCOL_LIMITS.maxCellCoord)

const pathStepSchema = z.strictObject({
  cell: z.strictObject({ i: cellCoord, j: cellCoord }),
  levelId: idSchema,
})

const worldCoord = z.number().min(-PROTOCOL_LIMITS.maxWorldCoord).max(PROTOCOL_LIMITS.maxWorldCoord)

const helloSchema = z.strictObject({
  t: z.literal("hello"),
  nonce: tokenSchema,
  epoch: tokenSchema.nullable(),
  lastSeq: z.int().min(0).max(PROTOCOL_LIMITS.maxSeq).nullable(),
})

const moveSchema = z.strictObject({
  t: z.literal("move"),
  reqId: tokenSchema,
  tokenId: idSchema,
  path: z
    .array(pathStepSchema)
    .min(1)
    .max(PROTOCOL_LIMITS.maxPathSteps + 1),
  end: z.strictObject({ x: worldCoord, z: worldCoord }).optional(),
})

const jumpSchema = z.strictObject({
  t: z.literal("jump"),
  reqId: tokenSchema,
  tokenId: idSchema,
  levelId: idSchema,
  x: worldCoord,
  z: worldCoord,
})

const doorSchema = z.strictObject({
  t: z.literal("door"),
  reqId: tokenSchema,
  doorId: idSchema,
  action: z.enum(["open", "close"]),
})

/** Raw chat text (the host cleans it and keeps TABLE_LIMITS.maxText characters; emoji count double here). */
const chatText = z
  .string()
  .min(1)
  .max(TABLE_LIMITS.maxText * 2)
const formulaInput = z.string().min(1).max(TABLE_LIMITS.maxFormulaInput)
const audience = z.enum(["all", "dm"])

const saySchema = z.strictObject({ t: z.literal("say"), reqId: tokenSchema, text: chatText, to: audience })
const rollSchema = z.strictObject({ t: z.literal("roll"), reqId: tokenSchema, formula: formulaInput, to: audience })
const initiativeSchema = z.strictObject({
  t: z.literal("initiative"),
  reqId: tokenSchema,
  tokenId: idSchema,
  bonus: z.int().min(-TABLE_LIMITS.maxInitiativeBonus).max(TABLE_LIMITS.maxInitiativeBonus),
})
const endTurnSchema = z.strictObject({ t: z.literal("end-turn"), reqId: tokenSchema, entryId: idSchema })
const pingSchema = z.strictObject({ t: z.literal("ping"), levelId: idSchema, x: worldCoord, z: worldCoord })
const conditionList = z.array(z.enum(TOKEN_CONDITIONS)).max(TOKEN_CONDITIONS.length)
// Relative changes (core/scene/tokenStatus.ts HpChange, ConditionChange): the host applies them to the
// token as it is when they arrive, so concurrent changes never overwrite each other.
const tokenStatusSchema = z
  .strictObject({
    t: z.literal("token-status"),
    reqId: tokenSchema,
    tokenId: idSchema,
    hp: z.strictObject({ kind: z.enum(["damage", "heal", "temp"]), amount: z.int().min(1).max(HP_LIMITS.max) }).optional(),
    conditions: z
      .strictObject({ add: conditionList.optional(), remove: conditionList.optional() })
      .refine((c) => (c.add?.length ?? 0) + (c.remove?.length ?? 0) > 0, "no condition to change")
      .optional(),
  })
  .refine((m) => m.hp !== undefined || m.conditions !== undefined, "nothing to change")

/** The URL is only shape-checked here; the host allows the player's own token images only. */
const tokenImageSchema = z.strictObject({
  t: z.literal("token-image"),
  reqId: tokenSchema,
  tokenId: idSchema,
  imageUrl: z.string().min(1).max(MAX_TOKEN_IMAGE_URL).nullable(),
})

/** An area of effect as a player places it (the host normalises it; core/session/templates.ts). */
const templateInputSchema = z.strictObject({
  shape: z.enum(AREA_SHAPES),
  levelId: idSchema,
  x: worldCoord,
  z: worldCoord,
  elevation: z.number().min(0).max(AREA_LIMITS.maxElevation),
  angle: z.number().min(-10).max(10),
  size: z.number().min(AREA_LIMITS.minSize).max(AREA_LIMITS.maxSize),
  width: z.number().min(AREA_LIMITS.minWidth).max(AREA_LIMITS.maxWidth),
  height: z.number().min(AREA_LIMITS.minHeight).max(AREA_LIMITS.maxHeight),
  label: z.string().max(AREA_LIMITS.maxLabel * 2),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  tokenId: idSchema.nullable(),
})

const templateSchema = z.strictObject({ t: z.literal("template"), reqId: tokenSchema, id: idSchema.optional(), template: templateInputSchema })
const templateRemoveSchema = z.strictObject({ t: z.literal("template-remove"), reqId: tokenSchema, id: idSchema })

export const clientMessageSchema = z.discriminatedUnion("t", [
  helloSchema,
  moveSchema,
  jumpSchema,
  doorSchema,
  saySchema,
  rollSchema,
  initiativeSchema,
  endTurnSchema,
  pingSchema,
  tokenStatusSchema,
  tokenImageSchema,
  templateSchema,
  templateRemoveSchema,
])

/** Strict zod parse of an untrusted player message (limits enforced). null = drop silently. */
export function parseClientMessage(raw: unknown): ClientToHost | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  // Cheap guard before zod walks every element of an oversized path.
  const path = (raw as { path?: unknown }).path
  if (Array.isArray(path) && path.length > PROTOCOL_LIMITS.maxPathSteps + 1) return null
  try {
    const res = clientMessageSchema.safeParse(raw)
    return res.success ? (res.data as ClientToHost) : null
  } catch {
    // Hostile getters / proxies: drop.
    return null
  }
}
