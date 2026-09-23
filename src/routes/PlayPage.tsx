/**
 * /play/:sessionId — a player's live view of a session (ARCHITECTURE §6.3, §8): fog of war, own
 * characters, drag-to-move with path previews, measuring, doors and ladders.
 */
import { useParams } from "wouter"

import { PlayerSession } from "@/components/play/player/PlayerSession"

export default function PlayPage() {
  const params = useParams<{ sessionId: string }>()
  const sessionId = params.sessionId ?? ""
  return <PlayerSession key={sessionId} sessionId={sessionId} />
}
