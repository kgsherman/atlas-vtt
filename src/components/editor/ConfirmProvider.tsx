import * as React from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

import { cn } from "@/lib/utils"

import { ConfirmContext, type ConfirmFn, type ConfirmOptions } from "./context"

interface Pending extends ConfirmOptions {
  resolve(ok: boolean): void
}

/** Provides useConfirm(): one app-styled confirmation dialog at a time. */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Pending | null>(null)
  const [open, setOpen] = React.useState(false)

  const confirm = React.useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        setPending((prev) => {
          prev?.resolve(false)
          return { ...opts, resolve }
        })
        setOpen(true)
      }),
    []
  )

  const settle = (ok: boolean) => {
    pending?.resolve(ok)
    setOpen(false)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) settle(false)
        }}
        onOpenChangeComplete={(next) => {
          if (!next) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            {pending?.description ? <AlertDialogDescription>{pending.description}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          {/* The choices read like an event's options: the decision first, then backing out. */}
          <div className="mt-1 flex flex-col gap-1.5">
            <AlertDialogAction
              variant="decision"
              className={cn(pending?.destructive && "text-destructive hover:text-destructive")}
              onClick={() => settle(true)}
              autoFocus
            >
              {pending?.confirmLabel ?? "Continue"}
            </AlertDialogAction>
            <AlertDialogCancel variant="decision">{pending?.cancelLabel ?? "Cancel"}</AlertDialogCancel>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}
