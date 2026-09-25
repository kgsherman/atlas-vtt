/**
 * Add or change a world character (ARCHITECTURE §6.9): its name, colour and portrait. Who plays it is
 * chosen in the Characters and Players lists.
 */
import * as React from "react"
import { CheckIcon } from "lucide-react"

import { useLastNonNull } from "@/app/useAsync"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { TOKEN_COLORS } from "@/core/scene/defaults"
import { CHARACTER_NAME_MAX, DEFAULT_CHARACTER_COLOR, normalizeCharacterName, type CharacterInput, type WorldCharacter } from "@/net/worldsRepo"
import { cn } from "@/lib/utils"

import { CharacterAvatar } from "./CharacterAvatar"

export type CharacterDialogTarget = { kind: "new"; initial?: Partial<CharacterInput> } | { kind: "edit"; character: WorldCharacter }

export function CharacterDialog({
  target,
  onClose,
  onSave,
}: {
  target: CharacterDialogTarget | null
  onClose(): void
  /** Resolves true when saved (the dialog then closes). */
  onSave(input: CharacterInput, target: CharacterDialogTarget): Promise<boolean>
}) {
  const shown = useLastNonNull(target)
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {shown && <CharacterForm key={shown.kind === "edit" ? shown.character.id : "new"} target={shown} onClose={onClose} onSave={onSave} />}
      </DialogContent>
    </Dialog>
  )
}

const IMAGE_URL_RE = /^(https?:\/\/|\/(?!\/))/i

function CharacterForm({
  target,
  onClose,
  onSave,
}: {
  target: CharacterDialogTarget
  onClose(): void
  onSave(input: CharacterInput, target: CharacterDialogTarget): Promise<boolean>
}) {
  const start = target.kind === "edit" ? target.character : target.initial
  const [name, setName] = React.useState(start?.name ?? "")
  const [color, setColor] = React.useState(start?.color ?? DEFAULT_CHARACTER_COLOR)
  const [imageUrl, setImageUrl] = React.useState(start?.imageUrl ?? "")
  const [saving, setSaving] = React.useState(false)
  const nameId = React.useId()
  const imageId = React.useId()
  const normalized = normalizeCharacterName(name)
  const image = imageUrl.trim()
  const imageOk = image === "" || IMAGE_URL_RE.test(image)
  const palette = TOKEN_COLORS.includes(color) ? TOKEN_COLORS : [...TOKEN_COLORS, color]

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!normalized || !imageOk || saving) return
    setSaving(true)
    const ok = await onSave({ name: normalized, color, imageUrl: image || null }, target)
    setSaving(false)
    if (ok) onClose()
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{target.kind === "edit" ? `Edit ${target.character.name}` : "New character"}</DialogTitle>
        <DialogDescription>
          A player character of this world. Link a token to it in any scene (the token's Character field), and whoever plays the character controls that token.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <div className="flex items-end gap-3">
          <CharacterAvatar character={{ name: normalized ?? "?", color, imageUrl: imageOk && image ? image : null }} size="lg" className="mb-0.5" />
          <Field className="flex-1">
            <FieldLabel htmlFor={nameId}>Name</FieldLabel>
            <Input id={nameId} autoFocus value={name} maxLength={CHARACTER_NAME_MAX} placeholder="Aria Vey" onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Field>
          <FieldLabel>Colour</FieldLabel>
          <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-1.5">
            {palette.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === color}
                aria-label={c}
                onClick={() => setColor(c)}
                className={cn(
                  "flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  c === color && "ring-2 ring-foreground/70"
                )}
                style={{ backgroundColor: c }}
              >
                {c === color ? <CheckIcon className="size-3.5 text-background" /> : null}
              </button>
            ))}
          </div>
        </Field>
        <Field data-invalid={!imageOk || undefined}>
          <FieldLabel htmlFor={imageId}>Portrait (optional)</FieldLabel>
          <Input id={imageId} value={imageUrl} placeholder="https://…" aria-invalid={!imageOk || undefined} onChange={(e) => setImageUrl(e.target.value)} />
          <FieldDescription>{imageOk ? "An image link. Tokens made from the character use it." : "Use an http(s) link."}</FieldDescription>
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!normalized || !imageOk || saving}>
          {saving && <Spinner className="size-3.5" data-icon="inline-start" />}
          {target.kind === "edit" ? "Save" : "Add character"}
        </Button>
      </DialogFooter>
    </form>
  )
}
