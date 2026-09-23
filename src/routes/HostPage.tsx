/**
 * /host/:sessionId — the DM's host console (ARCHITECTURE §6.2, §8): the authoritative host runner,
 * the live map with direct manipulation and vision previews, the session panel and live map editing.
 */
import { useParams } from "wouter"

import { ConfirmProvider } from "@/components/editor/ConfirmProvider"
import { HostSession } from "@/components/play/host/HostSession"

export default function HostPage() {
  const params = useParams<{ sessionId: string }>()
  const sessionId = params.sessionId ?? ""
  return (
    <ConfirmProvider>
      <HostSession key={sessionId} sessionId={sessionId} />
    </ConfirmProvider>
  )
}
