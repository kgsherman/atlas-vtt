/**
 * The table's doors (ARCHITECTURE §6.8). Closing disconnects the players and keeps the DM on the map
 * (a restore point is saved); leaving the map with the table open asks whether to close it first.
 */
import * as React from "react"
import { DoorClosed } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Spinner } from "@/components/ui/spinner"

export function CloseTableDialog({
  open,
  onOpenChange,
  players,
  onClose,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** Players connected right now. */
  players: number
  /** Close the table. Resolves false to stay open. */
  onClose(): Promise<boolean>
}) {
  const [busy, setBusy] = React.useState(false)
  const run = async () => {
    setBusy(true)
    try {
      if (await onClose()) onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close the table?</AlertDialogTitle>
          <AlertDialogDescription>
            {players === 0
              ? "Nobody can join until you open it again."
              : `${players === 1 ? "The player at the table is" : `The ${players} players at the table are`} disconnected.`}{" "}
            You stay on the map, and players come back with the same room code
            when you open the table again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* Event-style options: the decision first, then backing out. */}
        <div className="mt-1 flex flex-col gap-1.5">
          <AlertDialogAction
            variant="decision"
            disabled={busy}
            onClick={() => void run()}
          >
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <DoorClosed data-icon="inline-start" />
            )}
            Close the table
          </AlertDialogAction>
          <AlertDialogCancel variant="decision" disabled={busy}>
            Keep it open
          </AlertDialogCancel>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export type LeaveChoice = "close" | "keep"

export function LeaveTableDialog({
  open,
  onOpenChange,
  players,
  onLeave,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  players: number
  /** Leave, closing the table first or keeping it open. Resolves false to stay. */
  onLeave(choice: LeaveChoice): Promise<boolean>
}) {
  const [busy, setBusy] = React.useState<LeaveChoice | null>(null)
  const run = async (choice: LeaveChoice) => {
    setBusy(choice)
    try {
      if (await onLeave(choice)) onOpenChange(false)
    } finally {
      setBusy(null)
    }
  }
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>The table is still open</AlertDialogTitle>
          <AlertDialogDescription>
            {players === 0
              ? "Players can still join with the room code while you're away."
              : `${players === 1 ? "A player is" : `${players} players are`} at the table.`}{" "}
            Close it on your way out, or keep it open: players then wait for
            you, and you pick up from the library.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="mt-1 flex flex-col gap-1.5">
          <AlertDialogAction
            variant="decision"
            disabled={busy !== null}
            onClick={() => void run("close")}
          >
            {busy === "close" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <DoorClosed data-icon="inline-start" />
            )}
            Close the table and leave
          </AlertDialogAction>
          <AlertDialogAction
            variant="decision"
            disabled={busy !== null}
            onClick={() => void run("keep")}
          >
            {busy === "keep" ? <Spinner data-icon="inline-start" /> : null}
            Leave it open
          </AlertDialogAction>
          <AlertDialogCancel variant="decision" disabled={busy !== null}>
            Stay
          </AlertDialogCancel>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
