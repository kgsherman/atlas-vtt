/**
 * Token health and conditions (docs/ARCHITECTURE.md §3, §6.5): hit points with temporary hit points,
 * the conditions a token can show, damage and healing, and the coarse health band players see of
 * creatures they do not control ("bloodied": at most half its hit points).
 */
import { z } from "zod"

import type { Token } from "./types"

/** Conditions a token can show: the SRD's, plus concentrating and dead. Order = display order. */
export const TOKEN_CONDITIONS = [
  "blinded",
  "charmed",
  "deafened",
  "frightened",
  "grappled",
  "incapacitated",
  "invisible",
  "paralyzed",
  "petrified",
  "poisoned",
  "prone",
  "restrained",
  "stunned",
  "unconscious",
  "exhaustion",
  "concentrating",
  "dead",
] as const

export type TokenCondition = (typeof TOKEN_CONDITIONS)[number]

export const CONDITION_LABELS: Readonly<Record<TokenCondition, string>> = {
  blinded: "Blinded",
  charmed: "Charmed",
  deafened: "Deafened",
  frightened: "Frightened",
  grappled: "Grappled",
  incapacitated: "Incapacitated",
  invisible: "Invisible",
  paralyzed: "Paralyzed",
  petrified: "Petrified",
  poisoned: "Poisoned",
  prone: "Prone",
  restrained: "Restrained",
  stunned: "Stunned",
  unconscious: "Unconscious",
  exhaustion: "Exhaustion",
  concentrating: "Concentrating",
  dead: "Dead",
}

export interface TokenHp {
  /** 0 … max. */
  current: number
  /** ≥ 1. */
  max: number
  /** Temporary hit points, spent before `current`. ≥ 0. */
  temp: number
}

export const HP_LIMITS = { max: 99_999 } as const

/** What players see of the health of a creature they do not control. */
export type HealthBand = "unhurt" | "wounded" | "bloodied" | "down"

const CONDITION_SET: ReadonlySet<string> = new Set(TOKEN_CONDITIONS)

export function isTokenCondition(v: unknown): v is TokenCondition {
  return typeof v === "string" && CONDITION_SET.has(v)
}

/** Known conditions only, each once, in catalog order. */
export function normalizeConditions(list: readonly unknown[]): TokenCondition[] {
  const have = new Set(list.filter(isTokenCondition))
  return TOKEN_CONDITIONS.filter((c) => have.has(c))
}

const clampInt = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo)

/** Hit points within their rules: integers, 1 ≤ max, 0 ≤ current ≤ max, 0 ≤ temp. */
export function clampHp(hp: { current: number; max: number; temp?: number }): TokenHp {
  const max = clampInt(hp.max, 1, HP_LIMITS.max)
  return { current: clampInt(hp.current, 0, max), max, temp: clampInt(hp.temp ?? 0, 0, HP_LIMITS.max) }
}

/**
 * New max hit points: raising max keeps the damage taken (current rises with it), lowering it caps
 * current. Untracked hit points start full.
 */
export function withMaxHp(hp: TokenHp | null | undefined, max: number): TokenHp {
  const next = clampInt(max, 1, HP_LIMITS.max)
  if (!hp) return { current: next, max: next, temp: 0 }
  return clampHp({ current: hp.current + Math.max(0, next - hp.max), max: next, temp: hp.temp })
}

/** Damage: temporary hit points go first, then current down to 0. */
export function applyDamage(hp: TokenHp, amount: number): TokenHp {
  const dmg = clampInt(amount, 0, 10 * HP_LIMITS.max)
  const fromTemp = Math.min(hp.temp, dmg)
  return { ...hp, temp: hp.temp - fromTemp, current: Math.max(0, hp.current - (dmg - fromTemp)) }
}

/** Healing: current up to max (temporary hit points are not restored by healing). */
export function applyHealing(hp: TokenHp, amount: number): TokenHp {
  const heal = clampInt(amount, 0, 10 * HP_LIMITS.max)
  return { ...hp, current: Math.min(hp.max, hp.current + heal) }
}

/**
 * A change of hit points, applied to the current value when it arrives: concurrent changes (the DM's
 * damage while a player adds temporary hit points, two quick clicks) add up instead of overwriting each
 * other. Temporary hit points don't stack: the higher value is kept. `max` is the DM's alone.
 */
export type HpAmountChange = { kind: "damage" | "heal" | "temp"; amount: number }
export type HpChange = HpAmountChange | { kind: "max"; max: number }

export function applyHpChange(hp: TokenHp, change: HpChange): TokenHp {
  switch (change.kind) {
    case "damage":
      return applyDamage(hp, change.amount)
    case "heal":
      return applyHealing(hp, change.amount)
    case "temp":
      return { ...hp, temp: Math.max(hp.temp, clampInt(change.amount, 0, HP_LIMITS.max)) }
    case "max":
      return withMaxHp(hp, change.max)
  }
}

/** Conditions to add and to remove, applied to the current list (a condition in both is removed). */
export interface ConditionChange {
  add?: readonly TokenCondition[]
  remove?: readonly TokenCondition[]
}

export function applyConditionChange(list: readonly TokenCondition[], change: ConditionChange): TokenCondition[] {
  const remove = new Set<unknown>(change.remove ?? [])
  return normalizeConditions([...list, ...(change.add ?? [])].filter((c) => !remove.has(c)))
}

/** A change to a token's health: hit points and/or conditions. */
export interface TokenStatusChange {
  hp?: HpChange
  conditions?: ConditionChange
}

/** The coarse band: 0 is down, at most half is bloodied, below max is wounded. Temporary hit points don't count. */
export function healthBand(hp: TokenHp): HealthBand {
  if (hp.current <= 0) return "down"
  if (hp.current * 2 <= hp.max) return "bloodied"
  if (hp.current < hp.max) return "wounded"
  return "unhurt"
}

/** A token's hit points as a fraction of max (0 … 1), or null when not tracked. */
export function hpFraction(t: Pick<Token, "hp">): number | null {
  return t.hp ? Math.min(1, Math.max(0, t.hp.current / t.hp.max)) : null
}

const hpValue = z.int().min(0).max(HP_LIMITS.max)

/** Hit points: integers, 1 ≤ max, current ≤ max (clampHp). */
export const tokenHpSchema = z
  .strictObject({ current: hpValue, max: hpValue.min(1), temp: hpValue })
  .refine((hp) => hp.current <= hp.max, "current hit points above max")

/** Conditions: catalog ids, each once, in catalog order (normalizeConditions). */
export const tokenConditionsSchema = z
  .array(z.enum(TOKEN_CONDITIONS))
  .max(TOKEN_CONDITIONS.length)
  .refine((list) => list.every((c, k) => k === 0 || TOKEN_CONDITIONS.indexOf(list[k - 1]) < TOKEN_CONDITIONS.indexOf(c)), "conditions out of order or repeated")
