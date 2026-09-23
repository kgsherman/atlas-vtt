/**
 * Reports how an OAuth round trip ended (app/account.ts) once services are up: a toast for success,
 * cancel or failure. When linking failed because the Discord account already has an Atlas account, it
 * switches to that account straight away if the guest owns nothing, and otherwise asks first: the
 * guest's scenes and games stay with the guest and are not reachable after switching.
 */
import * as React from "react"
import { ArrowRightLeftIcon } from "lucide-react"
import { toast } from "sonner"

import { providerLabel, type AuthRedirectOutcome } from "@/app/account"
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

  const switchAccount = React.useCallback(
    async (silent: boolean) => {
      setSwitching(true)
      try {
        await services.signIn(outcome.provider, { intent: "sign_in", silent })
      } catch (err) {
        setSwitching(false)
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
      toast.success(`Signed in with ${provider}`)
      return
    }
    const { error, intent } = outcome
    if (error.code === "identity_exists" && intent === "link") {
      void (async () => {
        const data = await guestData(services).catch(() => null)
        // Unknown counts are treated as "has data": never drop a guest's work without asking.
        if (data && data.scenes === 0 && data.sessions === 0) void switchAccount(true)
        else setConfirm(data ?? { scenes: -1, sessions: 0 })
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
      action: intent === "sign_in" ? { label: "Try again", onClick: () => void switchAccount(false) } : undefined,
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
            That {provider} account already has an Atlas account, so it can't be added to this guest. If you switch, {describeGuestData(confirm)} will stay with
            this browser's guest account and won't be available any more. To keep a scene, stay, export it from its menu, then switch and import it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={switching}>Stay as guest</AlertDialogCancel>
          <AlertDialogAction onClick={() => void switchAccount(true)} disabled={switching}>
            {switching ? <Spinner className="size-3.5" data-icon="inline-start" /> : null}
            Switch account
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
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
