import * as React from "react"
import { CheckIcon, UserRoundIcon } from "lucide-react"
import { toast } from "sonner"

import { initials } from "@/app/format"
import { userMessage } from "@/app/library"
import { useServices } from "@/app/services"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { DISPLAY_NAME_MAX, normalizeDisplayName } from "@/net/auth"
import { cn } from "@/lib/utils"

/** Avatar + display name; opens an inline editor for the name players see. */
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
          <AvatarFallback className="bg-primary/15 text-[0.6rem] font-semibold text-foreground">
            {name ? initials(name) : <UserRoundIcon className="size-3" />}
          </AvatarFallback>
        </Avatar>
        <span className={cn("truncate", !name && "text-muted-foreground")}>{name ?? "Set your name"}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        {open && <DisplayNameForm onDone={() => setOpen(false)} />}
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
          <FieldDescription>Shown to your party when you host or join a game.</FieldDescription>
        )}
      </Field>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.65rem] text-muted-foreground">
          {services.mode === "supabase" ? "Anonymous account · this browser" : "Local user · this tab"}
        </span>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? <Spinner className="size-3" data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
          Save
        </Button>
      </div>
    </form>
  )
}
