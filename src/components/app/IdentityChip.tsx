import * as React from "react"
import { CheckIcon, LogOutIcon, UserRoundIcon } from "lucide-react"
import { toast } from "sonner"

import { providerLabel } from "@/app/account"
import { initials } from "@/app/format"
import { userMessage } from "@/app/library"
import { useServices } from "@/app/services"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { DISPLAY_NAME_MAX, normalizeDisplayName } from "@/net/auth"
import { cn } from "@/lib/utils"

import { ProviderIcon, SignInButtons } from "./SignInButtons"

/**
 * Avatar + display name; opens an inline editor for the name players see and, in Cloud mode, the
 * account: a guest can create a permanent account, a signed-in user can sign out.
 */
export function IdentityChip({ className }: { className?: string }) {
  const { identity } = useServices()
  const [open, setOpen] = React.useState(false)
  const name = identity.displayName
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "inline-flex h-8 max-w-48 items-center gap-2 rounded-full py-1 pr-3 pl-1 text-xs font-medium transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 data-popup-open:bg-muted",
          className
        )}
      >
        <Avatar size="sm">
          {identity.account?.avatarUrl && <AvatarImage src={identity.account.avatarUrl} alt="" referrerPolicy="no-referrer" />}
          <AvatarFallback className="bg-primary/15 text-[0.6rem] font-semibold text-foreground">
            {name ? initials(name) : <UserRoundIcon className="size-3" />}
          </AvatarFallback>
        </Avatar>
        <span className={cn("truncate", !name && "text-muted-foreground")}>{name ?? "Set your name"}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {open && (
          <>
            <DisplayNameForm onDone={() => setOpen(false)} />
            <Separator />
            <AccountSection />
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

function DisplayNameForm({ onDone }: { onDone: () => void }) {
  const services = useServices()
  const [value, setValue] = React.useState(services.identity.displayName ?? "")
  const [saving, setSaving] = React.useState(false)
  const [touched, setTouched] = React.useState(false)
  const normalized = normalizeDisplayName(value)
  const invalid = touched && !normalized
  const id = React.useId()
  const account = services.identity.account

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (!normalized) return
    if (normalized === services.identity.displayName) {
      onDone()
      return
    }
    setSaving(true)
    try {
      const stored = await services.setDisplayName(normalized)
      toast.success(`You're now “${stored}”`)
      onDone()
    } catch (err) {
      toast.error("Couldn't save your name", { description: userMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field data-invalid={invalid || undefined}>
        <FieldLabel htmlFor={id}>Display name</FieldLabel>
        <Input
          id={id}
          autoFocus
          value={value}
          maxLength={DISPLAY_NAME_MAX + 8}
          placeholder="e.g. Morgana"
          aria-invalid={invalid || undefined}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
          autoComplete="nickname"
        />
        {invalid ? (
          <FieldError>Use 1 to {DISPLAY_NAME_MAX} characters.</FieldError>
        ) : (
          <FieldDescription>
            Shown to your party when you host or join a game.
            {account && ` Only used in Atlas: your ${providerLabel(account.provider)} name stays as it is.`}
          </FieldDescription>
        )}
      </Field>
      <Button type="submit" size="sm" disabled={saving} className="self-end">
        {saving ? <Spinner className="size-3" data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
        Save
      </Button>
    </form>
  )
}

function AccountSection() {
  const services = useServices()
  const [busy, setBusy] = React.useState(false)
  const { identity } = services

  if (services.mode !== "supabase") {
    return <p className="text-[0.7rem] text-muted-foreground">Local user · this tab. Accounts need Cloud mode.</p>
  }

  const signOut = async () => {
    setBusy(true)
    try {
      // The app restarts as a new guest (ServicesProvider watches the auth state).
      await services.signOut()
    } catch (err) {
      setBusy(false)
      toast.error("Couldn't sign out", { description: userMessage(err) })
    }
  }

  if (identity.isAnonymous || !identity.account) {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium">Guest in this browser</p>
          <p className="text-xs/relaxed text-muted-foreground">
            Your scenes and games live in this browser only. Create an account to keep them and use them anywhere. Already have one? Continue the same way to
            sign in.
          </p>
        </div>
        <SignInButtons />
      </div>
    )
  }

  const provider = providerLabel(identity.account.provider)
  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[0.7rem] text-muted-foreground">Signed in with {provider}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
          <ProviderIcon provider={identity.account.provider} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{identity.account.name ?? provider}</span>
        </span>
      </div>
      <Button variant="ghost" size="sm" onClick={signOut} disabled={busy}>
        {busy ? <Spinner data-icon="inline-start" /> : <LogOutIcon data-icon="inline-start" />}
        Sign out
      </Button>
    </div>
  )
}
