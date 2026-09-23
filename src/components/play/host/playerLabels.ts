/**
 * Names the DM sees for players. Display names are free text, so two players can both be "Theron":
 * the later ones get a discriminator ("Theron (2)") in join order, so the DM can tell who to assign.
 */
export interface NamedPlayer {
  userId: string
  displayName: string
}

const nameKey = (name: string) => name.trim().toLocaleLowerCase()

/** userId → label, in the given (join) order; unique names are unchanged. */
export function playerLabels(
  players: Iterable<NamedPlayer>
): Map<string, string> {
  const seen = new Map<string, number>()
  const out = new Map<string, string>()
  for (const p of players) {
    if (out.has(p.userId)) continue
    const key = nameKey(p.displayName)
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    out.set(
      p.userId,
      n === 1 ? p.displayName : `${p.displayName.trim()} (${n})`
    )
  }
  return out
}

/** Display names shared by more than one player (for a warning), in first-seen spelling. */
export function duplicateNames(players: Iterable<NamedPlayer>): string[] {
  const first = new Map<string, string>()
  const count = new Map<string, number>()
  for (const p of players) {
    const key = nameKey(p.displayName)
    if (!first.has(key)) first.set(key, p.displayName)
    count.set(key, (count.get(key) ?? 0) + 1)
  }
  return [...count].filter(([, n]) => n > 1).map(([k]) => first.get(k)!)
}
