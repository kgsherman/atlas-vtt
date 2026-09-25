/** Two-letter initials for avatars (players, world characters). */

/** "Aria Vey" → "AV", "Borin" → "BO". */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/u).filter(Boolean)
  const letters = words.length > 1 ? [words[0], words[words.length - 1]].map((w) => [...w][0]) : [...(words[0] ?? "?")].slice(0, 2)
  return letters.join("").toUpperCase()
}
