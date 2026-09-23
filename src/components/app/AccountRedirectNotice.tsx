/**
 * Reports how an OAuth round trip ended (app/account.ts) once services are up: a toast for success,
 * cancel or failure. When linking failed because the Discord account already has an Atlas account, it
 * switches to that account straight away. A guest that made something takes a merge ticket along, so
 * the account takes over its scenes and games (net/guestMerge.ts); only if no ticket can be made does
 * it ask first, because the guest's work would then stay behind.
 */
import * as React from "react"
import { ArrowRightLeftIcon } from "lucide-react"
import { toast } from "sonner"

import { providerLabel, type AuthRedirectOutcome, type GuestMergeOutcome } from "@/app/account"
import { userMessage } from "@/app/library"
import { useServices, type AppServices } from "@/app/services"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Spinner } from "@/components/ui/spinner"
import type { GuestMergeResult } from "@/net/guestMerge"
import { NetError } from "@/net/supabase"

// Each outcome is reported once, although StrictMode runs effects twice.
const reported = new WeakSet<AuthRedirectOutcome>()

interface GuestData {
  scenes: number
  sessions: number
}

export function AccountRedirectNotice({ outcome }: { outcome: AuthRedirectOutcome }) {
  const services = useServices()
  const [confirm, setConfirm] = React.useState<GuestData | null>(null)
  const [switching, setSwitching] = React.useState(false)
  const provider = providerLabel(outcome.provider)

  /** Leave for the provider's sign-in. With bringGuest, failures (no merge ticket) are thrown. */
  const switchAccount = React.useCallback(
    async (opts: { silent: boolean; bringGuest: boolean }) => {
      setSwitching(true)
      try {
        await services.signIn(outcome.provider, { intent: "sign_in", ...opts })
      } catch (err) {
        setSwitching(false)
        if (opts.bringGuest) throw err
        setConfirm(null)
        toast.error(`Couldn't sign in with ${provider}`, { description: userMessage(err) })
      }
    },
    [services, outcome.provider, provider]
  )

  React.useEffect(() => {
    if (reported.has(outcome)) return
    reported.add(outcome)
    if (outcome.kind === "linked") {
      toast.success("Account created", { description: `You're signed in with ${provider}. Your scenes and games now follow you to any browser.` })
      return
    }
    if (outcome.kind === "signed_in") {
      reportSignIn(services, provider, outcome.merge)
      return
    }
    const { error, intent } = outcome
    if (error.code === "identity_exists" && intent === "link") {
      void (async () => {
        const data = await guestData(services).catch(() => null)
        if (data && data.scenes === 0 && data.sessions === 0) {
          void switchAccount({ silent: true, bringGuest: false })
          return
        }
        try {
          // Unknown counts count as "has data": take the guest's scenes and games along.
          await switchAccount({ silent: true, bringGuest: true })
        } catch (err) {
          // No merge ticket: ask before leaving the guest's work behind.
          console.warn("[atlas] guest merge unavailable:", err)
          setConfirm(data ?? { scenes: -1, sessions: 0 })
        }
      })()
      return
    }
    if (error.code === "auth_cancelled") {
      toast(`${provider} sign-in cancelled`)
      return
    }
    toast.error(`Couldn't sign in with ${provider}`, {
      description: userMessage(error),
      // A silent (no consent screen) sign-in can be refused by the provider: retry with the screen.
      action: intent === "sign_in" ? { label: "Try again", onClick: () => void switchAccount({ silent: false, bringGuest: false }) } : undefined,
    })
  }, [outcome, provider, services, switchAccount])

  return (
    <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && !switching && setConfirm(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <ArrowRightLeftIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>Switch to your {provider} account?</AlertDialogTitle>
          <AlertDialogDescription>
            That {provider} account already has an Atlas account, and your guest work can't be moved into it right now. If you switch,{" "}
            {describeGuestData(confirm)} will stay with this browser's guest account and won't be available any more. To keep a scene, stay, export it from its
            menu, then switch and import it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={switching}>Stay as guest</AlertDialogCancel>
          <AlertDialogAction onClick={() => void switchAccount({ silent: true, bringGuest: false })} disabled={switching}>
            {switching ? <Spinner className="size-3.5" data-icon="inline-start" /> : null}
            Switch account
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function reportSignIn(services: AppServices, provider: string, merge: GuestMergeOutcome | undefined): void {
  if (!merge) {
    toast.success(`Signed in with ${provider}`)
    return
  }
  if (merge.ok) {
    const moved = describeMerge(merge.result)
    toast.success(`Signed in with ${provider}`, { description: moved ? `Moved ${moved} from your guest account.` : undefined })
    return
  }
  const retry = async () => {
    const id = toast.loading("Moving your guest scenes…")
    try {
      await services.mergeGuest(merge.ticket)
      toast.dismiss(id)
      // The library and sessions were loaded before the merge: start over to show them.
      window.location.reload()
    } catch (err) {
      toast.dismiss(id)
      reportSignIn(services, provider, { ok: false, error: err instanceof NetError ? err : merge.error, ticket: merge.ticket })
    }
  }
  // Unknown / used / expired tickets and refused merges won't succeed on a retry.
  const retryable = merge.error.code !== "not_found" && merge.error.code !== "forbidden"
  toast.error("Signed in, but your guest scenes weren't moved", {
    description: userMessage(merge.error),
    duration: Infinity,
    action: retryable ? { label: "Retry", onClick: () => void retry() } : undefined,
  })
}

/** "2 scenes and 1 game" (empty when nothing moved). */
function describeMerge(result: GuestMergeResult): string {
  const parts: string[] = []
  if (result.scenes > 0) parts.push(result.scenes === 1 ? "1 scene" : `${result.scenes} scenes`)
  if (result.sessions > 0) parts.push(result.sessions === 1 ? "1 game" : `${result.sessions} games`)
  return parts.join(" and ")
}

async function guestData(services: AppServices): Promise<GuestData> {
  const [scenes, sessions] = await Promise.all([services.scenes.list(), services.sessions.listMySessions()])
  return { scenes: scenes.length, sessions: sessions.filter((s) => s.status === "active").length }
}

/** "your 3 scenes and 1 hosted game" */
function describeGuestData(data: GuestData | null): string {
  const parts: string[] = []
  if (data && data.scenes > 0) parts.push(data.scenes === 1 ? "1 scene" : `${data.scenes} scenes`)
  if (data && data.sessions > 0) parts.push(data.sessions === 1 ? "1 hosted game" : `${data.sessions} hosted games`)
  return parts.length > 0 ? `your ${parts.join(" and ")}` : "your scenes and games"
}
