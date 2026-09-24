/**
 * The chat dock's model, shared by the DM and players: log entries built from the host state (DM) or
 * the player's view, who a message goes to, and what the input box means (chat, a roll, a whisper).
 */
import { isFormula, parseRoll, type RollResult } from "@/core/dice/dice"
import type {
  GameState,
  PlayerView,
  TableMessage,
  TableMessageKind,
} from "@/core/session/types"

/** Who hears a message: everyone, the DM only (players), only the DM themselves (DM), or one player (DM). */
export type Audience =
  | { kind: "all" }
  | { kind: "dm" }
  | { kind: "self" }
  | { kind: "player"; userId: string }

export interface AudienceOption {
  key: string
  label: string
  audience: Audience
}

export const audienceKey = (a: Audience): string =>
  a.kind === "player" ? `player:${a.userId}` : a.kind

export interface ChatEntry {
  id: string
  at: number
  kind: TableMessageKind
  name: string
  color: string
  mine: boolean
  fromDm: boolean
  /** Not public; `privacy` says how ("to DM", "from DM", "secret", "to Alice"). */
  whisper: boolean
  privacy: string | null
  text: string
  roll?: RollResult
}

export function playerAudiences(): AudienceOption[] {
  return [
    { key: "all", label: "Everyone", audience: { kind: "all" } },
    { key: "dm", label: "DM only", audience: { kind: "dm" } },
  ]
}

export function dmAudiences(
  players: readonly { userId: string; name: string }[]
): AudienceOption[] {
  return [
    { key: "all", label: "Everyone", audience: { kind: "all" } },
    { key: "self", label: "Only me (secret)", audience: { kind: "self" } },
    ...players.map((p) => ({
      key: `player:${p.userId}`,
      label: `Whisper to ${p.name}`,
      audience: { kind: "player", userId: p.userId } as Audience,
    })),
  ]
}

/** The player's view of the log, oldest first. */
export function entriesFromView(view: PlayerView | null): ChatEntry[] {
  const log = view?.table?.log
  if (!log) return []
  return Object.values(log)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((m) => ({
      id: m.id,
      at: m.at,
      kind: m.kind,
      name: m.name,
      color: m.color,
      mine: m.mine,
      fromDm: m.dm,
      whisper: m.whisper,
      privacy: m.whisper ? (m.mine ? "to DM" : "from DM") : null,
      text: m.text,
      ...(m.roll ? { roll: m.roll } : {}),
    }))
}

function dmPrivacy(
  m: TableMessage,
  names: (uid: string) => string
): string | null {
  if (m.to === "all") return null
  if (m.from !== null) return "to DM"
  if (m.to.length === 0) return "secret"
  return `to ${m.to.map(names).join(", ")}`
}

/** The DM's log (everything), oldest first. */
export function entriesFromState(state: GameState | null): ChatEntry[] {
  const log = state?.table?.log
  if (!log) return []
  const names = (uid: string) =>
    Object.hasOwn(state!.players, uid)
      ? state!.players[uid].displayName
      : "a player who left"
  return log.map((m) => ({
    id: m.id,
    at: m.at,
    kind: m.kind,
    name: m.name,
    color: m.color,
    mine: m.from === null && m.kind !== "system",
    fromDm: m.from === null && m.kind !== "system",
    whisper: m.to !== "all",
    privacy: dmPrivacy(m, names),
    text: m.text,
    ...(m.roll ? { roll: m.roll } : {}),
  }))
}

export type ChatCommand =
  | { kind: "say"; text: string; audience: Audience }
  | { kind: "roll"; formula: string; audience: Audience }
  | { kind: "error"; message: string }
  | { kind: "none" }

/** A bare formula with dice in it ("d20", "2d6+3"), rolled without typing /r. Plain numbers stay chat. */
function bareDice(text: string): boolean {
  return /\d*d(\d|%)|^\s*(adv|dis)\b/i.test(text) && isFormula(text)
}

/**
 * What the input box means:
 *   /r (or /roll) formula [label]  roll for `audience`
 *   /gr formula [label]            roll privately (players: to the DM; the DM: only themselves)
 *   /w text                        players: whisper to the DM
 *   /w name text                   DM: whisper to the player whose name starts with `name`
 *   /dm text                       players: whisper to the DM
 *   2d6+3                          a bare dice formula is rolled too
 * Anything else is chat for `audience`.
 */
export function parseChatInput(
  input: string,
  role: "player" | "dm",
  audience: Audience,
  players: readonly { userId: string; name: string }[] = []
): ChatCommand {
  const text = input.trim()
  if (!text) return { kind: "none" }
  const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!m)
    return bareDice(text)
      ? { kind: "roll", formula: text, audience }
      : { kind: "say", text, audience }
  const cmd = m[1].toLowerCase()
  const rest = (m[2] ?? "").trim()
  const privately: Audience = role === "dm" ? { kind: "self" } : { kind: "dm" }
  switch (cmd) {
    case "r":
    case "roll":
    case "gr":
    case "sr": {
      if (!rest)
        return {
          kind: "error",
          message: "Add dice after the command, like /r 1d20+5.",
        }
      const p = parseRoll(rest)
      if (!p.ok) return { kind: "error", message: p.error }
      return {
        kind: "roll",
        formula: rest,
        audience: cmd === "r" || cmd === "roll" ? audience : privately,
      }
    }
    case "dm":
      if (role === "dm")
        return {
          kind: "error",
          message: "You are the DM: pick “Only me” to keep a note.",
        }
      if (!rest) return { kind: "error", message: "Type a message after /dm." }
      return { kind: "say", text: rest, audience: { kind: "dm" } }
    case "w":
    case "whisper": {
      if (!rest)
        return {
          kind: "error",
          message:
            role === "dm"
              ? "Type a name and a message, like /w Alice hello."
              : "Type a message after /w.",
        }
      if (role === "player")
        return { kind: "say", text: rest, audience: { kind: "dm" } }
      const lower = rest.toLowerCase()
      // The longest name the text starts with (names may have spaces).
      const match = [...players]
        .sort((a, b) => b.name.length - a.name.length)
        .find(
          (p) =>
            lower.startsWith(p.name.toLowerCase()) &&
            (rest.length === p.name.length || /\s/.test(rest[p.name.length]))
        )
      if (!match) return { kind: "error", message: "No player by that name." }
      const body = rest.slice(match.name.length).trim()
      if (!body)
        return { kind: "error", message: `Type a message for ${match.name}.` }
      return {
        kind: "say",
        text: body,
        audience: { kind: "player", userId: match.userId },
      }
    }
    default:
      return {
        kind: "error",
        message: `Unknown command /${cmd}. Try /r, /gr or /w.`,
      }
  }
}

/** Short clock time of a message ("21:07"). */
export function formatTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}
