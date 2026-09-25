/**
 * World characters at the table (docs/ARCHITECTURE.md §6.9). The DM hands characters to players in the
 * world, once, for every scene of it; a token linked to a character (Token.characterId) is controlled by
 * that character's players. The host keeps the world's roster in GameState.characters, and the owners of
 * character tokens are derived from it here, the one place: `owners[token]` = the character's players who
 * are players of this game (sorted). A character token whose character is not in the roster (deleted) has
 * no owners. Without a roster (`characters` absent) nothing is derived.
 */
import type { Id, Scene, Token } from "../scene/types"
import type { GameState, TableCharacter } from "./types"
import { own } from "./util"

/** Whether owners of this token come from the world's roster (and not from the table). */
export function isCharacterToken(state: Pick<GameState, "characters" | "scene">, tokenId: Id): boolean {
  return state.characters !== undefined && !!own(state.scene.tokens, tokenId)?.characterId
}

/** The derived owners of a character token (null: not a character token, or no roster). */
export function characterOwners(state: Pick<GameState, "characters" | "players">, token: Pick<Token, "characterId">): string[] | null {
  if (state.characters === undefined || !token.characterId) return null
  const players = own(state.characters, token.characterId)?.players ?? []
  return [...new Set(players.filter((uid) => Object.hasOwn(state.players, uid)))].sort()
}

/** A roster with sorted, unique players and no empty names (the host's input is the database's). */
export function normalizeCharacters(characters: Readonly<Record<Id, TableCharacter>>): Record<Id, TableCharacter> {
  const out: Record<Id, TableCharacter> = {}
  for (const id of Object.keys(characters).sort()) {
    const c = characters[id]
    out[id] = { name: c.name, players: [...new Set(c.players)].sort() }
  }
  return out
}

/** Two rosters are the same (names and players; both normalised). */
export function sameCharacters(a: Readonly<Record<Id, TableCharacter>> | undefined, b: Readonly<Record<Id, TableCharacter>> | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const id of ka) {
    const y = own(b, id)
    const x = a[id]
    if (!y || x.name !== y.name || x.players.length !== y.players.length || x.players.some((u, i) => u !== y.players[i])) return false
  }
  return true
}

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((u, i) => u === b?.[i])

/**
 * Tokens that stopped being characters between two scene revisions (unlinked, e.g. an undone link). With a
 * roster their owners were the character's players: they lose them (the token is the table's now, handed
 * out there if at all), so undoing a link to the wrong character never leaves its players in control.
 */
export function withoutUnlinkedOwners(state: GameState, prev: Pick<Scene, "tokens">): GameState {
  if (state.characters === undefined) return state
  let owners: GameState["owners"] | null = null
  for (const [id, before] of Object.entries(prev.tokens)) {
    if (!before.characterId || !Object.hasOwn(state.owners, id)) continue
    const now = own(state.scene.tokens, id)
    if (!now || now.characterId) continue
    owners ??= { ...state.owners }
    delete owners[id]
  }
  return owners ? { ...state, owners } : state
}

/**
 * The state with every character token's owners derived from the roster. `changed`: the user ids whose
 * control changed (they gained or lost a token). Returns the same state object when nothing changes.
 */
export function syncCharacterOwners(state: GameState): { state: GameState; changed: string[] } {
  if (state.characters === undefined) return { state, changed: [] }
  let owners: GameState["owners"] | null = null
  const changed = new Set<string>()
  for (const id of Object.keys(state.scene.tokens).sort()) {
    const want = characterOwners(state, state.scene.tokens[id])
    if (want === null) continue
    const have = own(state.owners, id)
    if (sameList(have, want)) continue
    owners ??= { ...state.owners }
    for (const uid of have ?? []) if (!want.includes(uid)) changed.add(uid)
    for (const uid of want) if (!(have ?? []).includes(uid)) changed.add(uid)
    if (want.length > 0) owners[id] = want
    else delete owners[id]
  }
  if (!owners) return { state, changed: [] }
  return { state: { ...state, owners }, changed: [...changed].sort() }
}
