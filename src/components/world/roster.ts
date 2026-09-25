/**
 * A world's roster (ARCHITECTURE §6.9): its players and characters, loaded together, with the edits the
 * world page and the scene screen make (who plays whom, new / changed / deleted characters, removing a
 * player). Every edit updates the list at once and is then written; a failed write reloads and says so.
 */
import * as React from "react"
import { toast } from "sonner"

import { userMessage } from "@/app/library"
import { useServices } from "@/app/services"
import { useAsync, useOnFocus, type AsyncState } from "@/app/useAsync"
import type { MemberStatus } from "@/net/sessionsRepo"
import type { CharacterInput, WorldCharacter, WorldMember } from "@/net/worldsRepo"

export interface WorldRoster {
  members: WorldMember[]
  characters: WorldCharacter[]
}

export interface RosterActions {
  createCharacter(input: CharacterInput): Promise<WorldCharacter | null>
  /** Whether it was saved. */
  updateCharacter(id: string, patch: Partial<CharacterInput>): Promise<boolean>
  removeCharacter(id: string): Promise<void>
  /** Who plays a character (replaces the list). */
  setPlayers(character: WorldCharacter, userIds: string[]): Promise<void>
  /** Give a player a character, or take it from them. */
  togglePlayer(character: WorldCharacter, userId: string, plays: boolean): Promise<void>
  setMemberStatus(userId: string, status: MemberStatus): Promise<void>
}

/**
 * The roster of a world, reloaded when the window regains focus. `onChanged` runs after every successful
 * write (the scene screen re-reads the table's roster then, so owners follow at once).
 */
export function useWorldRoster(worldId: string | null, onChanged?: () => void): AsyncState<WorldRoster> & { actions: RosterActions } {
  const { worlds, mode, identity } = useServices()
  const q = useAsync<WorldRoster>(worldId ? `roster:${mode}:${identity.userId}:${worldId}` : null, async () => {
    const [members, characters] = await Promise.all([worlds.listMembers(worldId!), worlds.listCharacters(worldId!)])
    return { members, characters }
  })
  useOnFocus(q.reload)
  const changed = React.useRef(onChanged)
  React.useEffect(() => {
    changed.current = onChanged
  })
  const { mutate, reload } = q
  // "Played by": the list last wanted per character (ahead of the rendered data while writes are on their
  // way), and one write at a time per character, each sending the latest list.
  const wanted = React.useRef(new Map<string, string[]>())
  const writes = React.useRef(new Map<string, Promise<void>>())

  const actions = React.useMemo<RosterActions>(() => {
    const write = async <T>(what: string, run: () => Promise<T>): Promise<T | null> => {
      try {
        const out = await run()
        changed.current?.()
        return out
      } catch (err) {
        toast.error(`Couldn't ${what}`, { description: userMessage(err) })
        reload()
        return null
      }
    }
    const patchCharacter = (id: string, f: (c: WorldCharacter) => WorldCharacter) =>
      mutate((r) => r && { ...r, characters: r.characters.map((c) => (c.id === id ? f(c) : c)) })
    const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((u, i) => u === b[i])
    const setPlayers = (character: WorldCharacter, userIds: string[]) => {
      const playerIds = [...new Set(userIds)].sort()
      wanted.current.set(character.id, playerIds)
      patchCharacter(character.id, (c) => ({ ...c, playerIds }))
      const next = (writes.current.get(character.id) ?? Promise.resolve()).then(async () => {
        const latest = wanted.current.get(character.id)
        if (!latest) return
        const ok = await write("change who plays the character", () => worlds.setCharacterPlayers(character, latest))
        // Written (or failed and reloaded): the rendered data is the truth again, unless more was wanted meanwhile.
        const now = wanted.current.get(character.id)
        if (ok === null || (now && same(now, latest))) wanted.current.delete(character.id)
      })
      writes.current.set(character.id, next)
      return next
    }
    return {
      async createCharacter(input) {
        const created = await write("add the character", () => worlds.createCharacter(worldId!, input))
        if (created) mutate((r) => r && { ...r, characters: [...r.characters, created] })
        return created
      },
      async updateCharacter(id, patch) {
        const updated = await write("change the character", () => worlds.updateCharacter(id, patch))
        if (!updated) return false
        patchCharacter(id, (c) => ({ ...updated, playerIds: c.playerIds }))
        return true
      },
      async removeCharacter(id) {
        mutate((r) => r && { ...r, characters: r.characters.filter((c) => c.id !== id) })
        await write("delete the character", () => worlds.removeCharacter(id))
      },
      setPlayers,
      togglePlayer: (character, userId, plays) => {
        const base = wanted.current.get(character.id) ?? character.playerIds
        return setPlayers(character, plays ? [...base, userId] : base.filter((u) => u !== userId))
      },
      async setMemberStatus(userId, status) {
        mutate((r) => r && { ...r, members: r.members.map((m) => (m.userId === userId ? { ...m, status } : m)) })
        await write(status === "kicked" ? "remove the player" : "let the player back", () => worlds.setMemberStatus(worldId!, userId, status))
      },
    }
  }, [worlds, worldId, mutate, reload])

  return { ...q, actions }
}
