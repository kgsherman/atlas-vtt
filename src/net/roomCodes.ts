/**
 * Room codes (8 characters of Crockford base32: a world's, ARCHITECTURE §6.9) and the display-name rule
 * players join under. Mirrors the SQL helpers so local mode and the join form behave like the server.
 */

export const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
export const ROOM_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/

/** Mirrors private.normalize_room_code(): case-insensitive, separators ignored, I/L → 1, O → 0. */
export function normalizeRoomCode(input: string): string {
  return input
    .replace(/[\s_-]/gu, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
}

export function isValidRoomCode(input: string): boolean {
  return ROOM_CODE_RE.test(normalizeRoomCode(input))
}

/** "ABCD1234" → "ABCD-1234" for display. */
export function formatRoomCode(code: string): string {
  const c = normalizeRoomCode(code)
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

/** Names that pose as the DM (join_world refuses them; mirrors private.world_display_name_taken). */
export const RESERVED_DISPLAY_NAMES = ["dm", "gm", "the dm", "the gm", "dungeon master", "game master", "the dungeon master", "the game master"]

/** Whether `name` is unavailable to `uid` among a world's players (case-insensitive). */
export function displayNameTaken(name: string, uid: string, members: Readonly<Record<string, { displayName: string }>>, dmName: string | null = null): boolean {
  const lower = name.toLowerCase()
  if (RESERVED_DISPLAY_NAMES.includes(lower)) return true
  if (dmName !== null && dmName.toLowerCase() === lower) return true
  return Object.entries(members).some(([id, m]) => id !== uid && m.displayName.toLowerCase() === lower)
}

/** 40 random bits (byte & 31 is uniform: 256 is a multiple of 32). Server codes come from SQL. */
export function generateRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return [...bytes].map((b) => ROOM_CODE_ALPHABET[b & 31]).join("")
}
