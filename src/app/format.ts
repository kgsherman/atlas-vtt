/** Small UI formatting helpers (pure). */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", "Mar 4", "Mar 4, 2025". */
export function formatRelativeTime(iso: string, now: number, locale?: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const diff = now - t
  if (diff < 45_000) return "just now"
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))} min ago`
  if (diff < DAY) return `${Math.round(diff / HOUR)} h ago`
  const days = Math.floor(startOfDay(now) / DAY) - Math.floor(startOfDay(t) / DAY)
  if (days <= 1) return "yesterday"
  if (days < 7) return `${days} days ago`
  const date = new Date(t)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(locale, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" })
}

function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime() - d.getTimezoneOffset() * MINUTE
}

/** Full timestamp for tooltips. */
export function formatDateTime(iso: string, locale?: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  return new Date(t).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
}

/** "1 level", "4 levels", "1,204 objects". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? singular : pluralForm}`
}

/** Up to two initials for an avatar ("Ser Brienne" → "SB", null → "?"). */
export function initials(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return "?"
  const letters = words.length === 1 ? [...words[0]].slice(0, 2) : [[...words[0]][0], [...words[words.length - 1]][0]]
  return letters.join("").toUpperCase()
}
