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
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            {pending?.description ? <AlertDialogDescription>{pending.description}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{pending?.cancelLabel ?? "Cancel"}</AlertDialogCancel>
            <AlertDialogAction variant={pending?.destructive ? "destructive" : "default"} onClick={() => settle(true)} autoFocus>
              {pending?.confirmLabel ?? "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}
