/**
 * Forgiving room-code entry: accepts pasted links (".../join/ABCD-1234"), any case, separators and
 * the Crockford look-alikes (I/L → 1, O → 0), and formats the result as "ABCD-1234" while typing.
 */
import { ROOM_CODE_ALPHABET } from "@/net/sessionsRepo"

export const ROOM_CODE_LENGTH = 8

export interface RoomCodeInput {
  /** Normalised characters so far (≤ 8, Crockford alphabet only). */
  code: string
  /** What the input shows: "ABCD", "ABCD-12", "ABCD-1234". */
  display: string
  /** Characters that were dropped because they can never appear in a room code (e.g. "U"). */
  rejected: string[]
  complete: boolean
}

const ALPHABET = new Set(ROOM_CODE_ALPHABET)

/** Pull the code out of a pasted invite link, or return the text unchanged. */
export function extractCodeFromText(text: string): string {
  const m = /\/join\/([^/?#\s]+)/iu.exec(text)
  return m ? decodeURIComponent(m[1]) : text
}

export function parseRoomCodeInput(raw: string): RoomCodeInput {
  const text = extractCodeFromText(raw)
  const rejected: string[] = []
  let code = ""
  for (const ch of text.toUpperCase()) {
    if (/[\s_\-–—.]/u.test(ch)) continue
    const mapped = ch === "I" || ch === "L" ? "1" : ch === "O" ? "0" : ch
    if (!ALPHABET.has(mapped)) {
      rejected.push(ch)
      continue
    }
    if (code.length < ROOM_CODE_LENGTH) code += mapped
  }
  return { code, display: formatPartialCode(code), rejected, complete: code.length === ROOM_CODE_LENGTH }
}

export function formatPartialCode(code: string): string {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

/** Absolute invite link for a room code. */
export function inviteLink(origin: string, roomCode: string, extraQuery = ""): string {
  return `${origin}/join/${formatPartialCode(parseRoomCodeInput(roomCode).code)}${extraQuery}`
}
