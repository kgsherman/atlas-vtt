/**
 * Ending a live session from the host console. When the live map has edits that are not in the
 * library yet, the DM chooses: save the map and end, end without saving, or keep playing.
 */
import * as React from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Spinner } from "@/components/ui/spinner"

export function EndSessionDialog({
  open,
  onOpenChange,
  dirty,
  canSave,
  sceneName,
  onEnd,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** The live map has edits the library scene does not have. */
  dirty: boolean
  /** A library scene exists to save to. */
  canSave: boolean
  sceneName: string
  /** End the session, saving the map to the library first when `save`. Resolves false to stay open. */
  onEnd(save: boolean): Promise<boolean>
}) {
  const [busy, setBusy] = React.useState<"save" | "end" | null>(null)
  const run = async (save: boolean) => {
    setBusy(save ? "save" : "end")
    try {
      if (await onEnd(save)) onOpenChange(false)
    } finally {
      setBusy(null)
    }
  }
  const offerSave = dirty && canSave
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>End the session for everyone?</AlertDialogTitle>
          <AlertDialogDescription>
            Players are disconnected and the room code stops working.{" "}
            {offerSave
              ? `You edited the map during this session. Save it to “${sceneName}” in your library first, or those edits are discarded.`
              : dirty
                ? "Map edits made during this session are discarded: the library scene was deleted."
                : "You haven't changed the map during this session."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy !== null}>
            Keep playing
          </AlertDialogCancel>
          {offerSave ? (
            <>
              <AlertDialogAction
                variant="destructive"
                disabled={busy !== null}
                onClick={() => void run(false)}
              >
                {busy === "end" ? <Spinner data-icon="inline-start" /> : null}
                End without saving
              </AlertDialogAction>
              <AlertDialogAction
                disabled={busy !== null}
                onClick={() => void run(true)}
              >
                {busy === "save" ? <Spinner data-icon="inline-start" /> : null}
                Save map & end
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction
              variant="destructive"
              disabled={busy !== null}
              onClick={() => void run(false)}
            >
              {busy === "end" ? <Spinner data-icon="inline-start" /> : null}
              End session
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
