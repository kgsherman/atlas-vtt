/**
 * Validation of untrusted player → host messages (docs/ARCHITECTURE.md §6.2: "zod-validate (strict,
 * limits)"). Anything that does not match exactly is dropped: parseClientMessage returns null and the
 * host ignores the message. The sender is never a payload field (it is the {uid} of the topic).
 */
import { z } from "zod"

import { MAX_PATH_STEPS } from "../movement"
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

/** The URL is only shape-checked here; the host allows the player's own token images only. */
const tokenImageSchema = z.strictObject({
  t: z.literal("token-image"),
  reqId: tokenSchema,
  tokenId: idSchema,
  imageUrl: z.string().min(1).max(MAX_TOKEN_IMAGE_URL).nullable(),
})

export const clientMessageSchema = z.discriminatedUnion("t", [helloSchema, moveSchema, jumpSchema, doorSchema, tokenImageSchema])

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
