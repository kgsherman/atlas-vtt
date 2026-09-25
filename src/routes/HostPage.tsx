/**
 * /host/:sessionId — the map screen (ARCHITECTURE §6.8, §7, §8): a map's table, run by the authoritative
 * host runner, in Edit or Play, with its doors open or closed.
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
