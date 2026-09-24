/**
 * Strict zod schema of a RollResult (dice.ts), for views and saved games read back from storage.
 * Bounds follow DICE_LIMITS; every die is checked against its term's sides and the dropped indices
 * against its rolls.
 */
import { z } from "zod"

import { DICE_LIMITS, type RollResult } from "./dice"

const MAX_ROLLS = DICE_LIMITS.maxDice + DICE_LIMITS.maxExplosions
const sign = z.union([z.literal(1), z.literal(-1)])

const diceTerm = z
  .strictObject({
    kind: z.literal("dice"),
    sign,
    count: z.int().min(1).max(DICE_LIMITS.maxDice),
    sides: z.int().min(1).max(DICE_LIMITS.maxSides),
    explode: z.boolean(),
    keep: z.strictObject({ mode: z.enum(["kh", "kl", "dh", "dl"]), n: z.int().min(1).max(DICE_LIMITS.maxDice) }).nullable(),
    rolls: z.array(z.int().min(1).max(DICE_LIMITS.maxSides)).min(1).max(MAX_ROLLS),
    dropped: z.array(z.int().min(0).max(MAX_ROLLS - 1)).max(MAX_ROLLS),
  })
  .refine((t) => t.rolls.every((v) => v <= t.sides) && t.dropped.every((k) => k < t.rolls.length), "dice out of range")

const constTerm = z.strictObject({ kind: z.literal("const"), sign, value: z.int().min(0).max(DICE_LIMITS.maxConstant) })

/** Totals stay far inside this (100 dice of 1000 plus 12 constants of 10 000 is ~220 000). */
const MAX_TOTAL = 10_000_000

export const rollResultSchema: z.ZodType<RollResult> = z.strictObject({
  formula: z.string().max(400),
  total: z.int().min(-MAX_TOTAL).max(MAX_TOTAL),
  terms: z.array(z.discriminatedUnion("kind", [diceTerm, constTerm])).min(1).max(DICE_LIMITS.maxTerms),
})
