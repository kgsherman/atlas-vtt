/**
 * Token hit points and conditions during play (docs/ARCHITECTURE.md §6.5): the DM's `set-token-status`
 * and a player's `token-status` request for their own tokens. Both are play actions (like moves): they
 * change GameState.scene without marking the map edited, and change no player's vision.
 */
import { applyConditionChange, applyHpChange, clampHp, normalizeConditions, type TokenCondition, type TokenHp } from "../scene/tokenStatus"
import type { Token } from "../scene/types"
import { emptyDelta, ownsToken, tokenExistsForPlayers, type RequestOutcome } from "./state"
import type { ClientToHost, GameState, RejectReason } from "./types"

const sameHp = (a: TokenHp | undefined, b: TokenHp | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.current === b.current && a.max === b.max && a.temp === b.temp)

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, k) => v === b[k])

/**
 * The token with new hit points (`null`: not tracked any more; undefined: unchanged) and/or conditions
 * (undefined: unchanged; [] removes them), clamped to their rules. The same object when nothing changes.
 */
export function tokenWithStatus(t: Token, hp: TokenHp | null | undefined, conditions: readonly TokenCondition[] | undefined): Token {
  const nextHp = hp === undefined ? t.hp : hp === null ? undefined : clampHp(hp)
  const nextConditions = conditions === undefined ? t.conditions : normalizeConditions(conditions)
  const hpChanged = !sameHp(t.hp, nextHp)
  const conditionsChanged = !sameList(t.conditions ?? [], nextConditions ?? [])
  if (!hpChanged && !conditionsChanged) return t
  const next: Token = { ...t }
  if (nextHp) next.hp = nextHp
  else delete next.hp
  if (nextConditions && nextConditions.length > 0) next.conditions = nextConditions
  else delete next.conditions
  return next
}

type StatusRequest = Extract<ClientToHost, { t: "token-status" }>

function reject(state: GameState, reqId: string, reason: RejectReason): RequestOutcome {
  return { state, delta: emptyDelta(), dirtyPlayers: [], result: { reqId, ok: false, reason }, visited: [], tokenId: null }
}

/**
 * A player changes one of their own tokens: damage, healing or temporary hit points (only when the DM
 * tracks its hit points: max stays the DM's) and/or conditions to add and remove, applied to the token
 * as it is now (never a stale copy from the player's view). Ownership is checked before anything is
 * looked up, like moves.
 */
export function reduceTokenStatus(state: GameState, userId: string, msg: StatusRequest): RequestOutcome {
  if (!ownsToken(state, userId, msg.tokenId)) return reject(state, msg.reqId, "not-owner")
  const t = tokenExistsForPlayers(state, msg.tokenId)
  if (!t) return reject(state, msg.reqId, "unknown-token")
  let hp: TokenHp | undefined
  if (msg.hp) {
    if (!t.hp) return reject(state, msg.reqId, "cannot")
    hp = applyHpChange(t.hp, msg.hp)
  }
  const conditions = msg.conditions ? applyConditionChange(t.conditions ?? [], msg.conditions) : undefined
  const next = tokenWithStatus(t, hp, conditions)
  const result = { reqId: msg.reqId, ok: true }
  if (next === t) return { state, delta: emptyDelta(), dirtyPlayers: [], result, visited: [], tokenId: null }
  return {
    state: { ...state, scene: { ...state.scene, tokens: { ...state.scene.tokens, [t.id]: next } }, seq: state.seq + 1 },
    delta: emptyDelta(),
    dirtyPlayers: "all",
    result,
    visited: [],
    tokenId: null,
  }
}
