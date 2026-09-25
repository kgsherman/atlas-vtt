/** Friendly copy for join failures (JoinPage and the home page's quick join). */
import { isNetError } from "@/net/supabase"

import { userMessage } from "./library"
import type { AppMode } from "./mode"

export interface JoinFailure {
  title: string
  description: string
  /** The field to highlight, if the problem is with the input. */
  field: "code" | "name" | null
  /** The caller is this game's DM (offer to host it instead). */
  isDm: boolean
}

export function describeJoinError(err: unknown, mode: AppMode): JoinFailure {
  const f = (title: string, description: string, field: JoinFailure["field"] = null, isDm = false): JoinFailure => ({ title, description, field, isDm })
  if (!isNetError(err)) return f("Couldn't join the game", userMessage(err))
  switch (err.code) {
    case "invalid_room_code":
      return f("That code doesn't look right", "Room codes are 8 letters and digits, like ABCD-1234.", "code")
    case "session_not_found":
    case "not_found":
      return f("No world with that code", "Check the code with your DM — it may have a typo, or the world may have been deleted.", "code")
    case "session_ended":
      return f("This game has ended", "Ask your DM for the code of their next game.", "code")
    case "table_closed":
      return f("The table isn't open", "You're in the world, but your DM hasn't opened a table yet. You'll be let in once they do.")
    case "kicked":
      return f("You can't rejoin this world", "The DM removed you from this world. Ask them if you think that was a mistake.")
    case "is_dm":
      return f(
        "You're the DM of this world",
        mode === "local"
          ? "In local mode every browser tab is a separate user. Open the invite link in a new tab to join as a player, or run the world from here."
          : "You can't join your own world as a player. Run it from here, or join from another browser or device.",
        null,
        true
      )
    case "invalid_display_name":
      return f("Pick a display name", "Names are 1 to 32 characters.", "name")
    case "name_taken":
      return f("That name is taken", "Another player of this world (or the DM) uses it. Pick another one.", "name")
    case "session_full":
      return f("This world is full", "The world has reached its player limit. Ask your DM to make room.")
    case "rate_limited":
      return f("Slow down a little", "Too many attempts. Wait a moment and try again.")
    case "network":
      return f("You're offline", "Couldn't reach the server. Check your connection and try again.")
    default:
      return f("Couldn't join the game", userMessage(err))
  }
}
