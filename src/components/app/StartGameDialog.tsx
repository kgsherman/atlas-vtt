/**
 * "Start a game": confirms starting a session for a scene and chooses which free asset categories the
 * game loads (GameState.freeAssets; the host console's asset pickers offer those). The choice is
 * remembered per browser for the next game.
 */
import * as React from "react"
import { PlayIcon } from "lucide-react"

import { assetsOf, readStartFreeAssets, useFreeAssets, writeStartFreeAssets } from "@/app/freeAssets"
import { useServices } from "@/app/services"
import { useLastNonNull } from "@/app/useAsync"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { FREE_ASSET_CATEGORIES, type FreeAssetCategory } from "@/core/session/freeAssets"

export interface StartGameTarget {
  name: string
}

export function StartGameDialog({
  target,
  onClose,
  onStart,
}: {
  /** The scene to start (null = closed). */
  target: StartGameTarget | null
  onClose(): void
  /** Start the game; the dialog stays open (busy) until it settles. */
  onStart(opts: { freeAssets: FreeAssetCategory[] }): Promise<void>
}) {
  const shown = useLastNonNull(target)
  const [busy, setBusy] = React.useState(false)
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        {shown && <StartForm target={shown} busy={busy} setBusy={setBusy} onClose={onClose} onStart={onStart} />}
      </DialogContent>
    </Dialog>
  )
}

function StartForm({
  target,
  busy,
  setBusy,
  onClose,
  onStart,
}: {
  target: StartGameTarget
  busy: boolean
  setBusy(busy: boolean): void
  onClose(): void
  onStart(opts: { freeAssets: FreeAssetCategory[] }): Promise<void>
}) {
  const { freeAssets } = useServices()
  const catalog = useFreeAssets()
  const [selected, setSelected] = React.useState<FreeAssetCategory[]>(readStartFreeAssets)
  const baseId = React.useId()
  const available = freeAssets.available

  const toggle = (id: FreeAssetCategory, on: boolean) => setSelected((cur) => (on ? [...new Set([...cur, id])] : cur.filter((c) => c !== id)))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const chosen = available ? selected : []
    if (available) writeStartFreeAssets(chosen)
    setBusy(true)
    try {
      await onStart({ freeAssets: chosen })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>Start a game</DialogTitle>
        <DialogDescription>“{target.name}” opens in the host console with a room code to share with your players.</DialogDescription>
      </DialogHeader>
      <FieldSet>
        <FieldLegend variant="label">Free assets</FieldLegend>
        <FieldDescription className="-mt-2 text-xs">
          {available
            ? "Libraries anyone can use, offered in this game's asset pickers. You can change them during the game."
            : "Free assets need Atlas Cloud; this browser runs in local mode."}
        </FieldDescription>
        <FieldGroup data-slot="checkbox-group" className="gap-3">
          {FREE_ASSET_CATEGORIES.map((c) => {
            const id = `${baseId}-${c.id}`
            const items = assetsOf(catalog.data, c.id)
            const count = catalog.loading ? "Loading…" : catalog.error ? "Couldn't load the list" : `${items.length} available`
            return (
              <Field key={c.id} orientation="horizontal" data-disabled={!available || undefined}>
                <Checkbox
                  id={id}
                  checked={available && selected.includes(c.id)}
                  disabled={!available || busy}
                  onCheckedChange={(on) => toggle(c.id, on === true)}
                />
                <FieldContent>
                  <FieldLabel htmlFor={id}>{c.label}</FieldLabel>
                  <FieldDescription className="text-xs">
                    {c.description}
                    {available ? ` ${count}.` : ""}
                  </FieldDescription>
                  {items.some((a) => a.thumbnailUrl) ? (
                    <div className="mt-1 flex gap-1.5" aria-hidden>
                      {items
                        .slice(0, 6)
                        .map((a) =>
                          a.thumbnailUrl ? (
                            <img
                              key={a.id}
                              src={a.thumbnailUrl}
                              alt=""
                              title={a.name}
                              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                              className="size-10 rounded-md bg-muted/60 object-contain"
                            />
                          ) : null
                        )}
                    </div>
                  ) : null}
                </FieldContent>
              </Field>
            )
          })}
        </FieldGroup>
      </FieldSet>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Spinner className="size-3.5" data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
          Start game
        </Button>
      </DialogFooter>
    </form>
  )
}
