import * as React from "react"
import { CheckIcon, CopyIcon, Link2Icon, RefreshCwIcon, ShieldAlertIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { copyText } from "@/app/clipboard"
import { deleteScene, userMessage } from "@/app/library"
import { paths } from "@/app/routes"
import { useServices } from "@/app/services"
import { useLastNonNull } from "@/app/useAsync"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { normalizeSceneName, SCENE_NAME_MAX, type SceneSummary } from "@/net/scenesRepo"

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export function RenameSceneDialog({ scene, onClose, onRenamed }: { scene: SceneSummary | null; onClose(): void; onRenamed(summary: SceneSummary): void }) {
  const shown = useLastNonNull(scene)
  return (
    <Dialog open={scene !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">{shown && <RenameForm key={shown.id} scene={shown} onClose={onClose} onRenamed={onRenamed} />}</DialogContent>
    </Dialog>
  )
}

function RenameForm({ scene, onClose, onRenamed }: { scene: SceneSummary; onClose(): void; onRenamed(summary: SceneSummary): void }) {
  const { scenes } = useServices()
  const [name, setName] = React.useState(scene.name)
  const [saving, setSaving] = React.useState(false)
  const id = React.useId()
  const unchanged = normalizeSceneName(name) === scene.name

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (unchanged) return onClose()
    setSaving(true)
    try {
      const summary = await scenes.rename(scene.id, name)
      onRenamed(summary)
      onClose()
    } catch (err) {
      toast.error("Couldn't rename the scene", { description: userMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Rename scene</DialogTitle>
        <DialogDescription>The name appears in its world, to players at its table and on exported files.</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={id}>Name</FieldLabel>
        <Input id={id} autoFocus value={name} maxLength={SCENE_NAME_MAX} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !name.trim()}>
          {saving && <Spinner className="size-3.5" data-icon="inline-start" />}
          Save
        </Button>
      </DialogFooter>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export function DeleteSceneDialog({ scene, onClose, onDeleted }: { scene: SceneSummary | null; onClose(): void; onDeleted(scene: SceneSummary): void }) {
  const services = useServices()
  const [deleting, setDeleting] = React.useState(false)
  // Keep the last scene on screen during the closing animation.
  const shown = useLastNonNull(scene)

  const confirm = async () => {
    if (!scene) return
    setDeleting(true)
    try {
      // Also removes the scene's map images (unless another table still uses them) and ends its table.
      const { warnings } = await deleteScene(services, scene)
      onDeleted(scene)
      onClose()
      if (warnings.length > 0) toast.warning("Scene deleted", { description: warnings.join(" ") })
    } catch (err) {
      toast.error("Couldn't delete the scene", { description: userMessage(err) })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog open={scene !== null} onOpenChange={(open) => !open && !deleting && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>Delete “{shown?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the scene{shown && shown.latestVersion > 1 ? " and its version history" : ""}. Its table ends: players there are
            disconnected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirm} disabled={deleting}>
            {deleting ? <Spinner className="size-3.5" data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
            Delete scene
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

export function ShareSceneDialog({ scene, onClose, onChanged }: { scene: SceneSummary | null; onClose(): void; onChanged(scene: SceneSummary): void }) {
  const shown = useLastNonNull(scene)
  return (
    <Dialog open={scene !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">{shown && <SharePanel key={shown.id} scene={shown} onChanged={onChanged} />}</DialogContent>
    </Dialog>
  )
}

function SharePanel({ scene, onChanged }: { scene: SceneSummary; onChanged(scene: SceneSummary): void }) {
  const { scenes, mode } = useServices()
  const [current, setCurrent] = React.useState(scene)
  const [busy, setBusy] = React.useState<"toggle" | "rotate" | null>(null)
  const [copied, setCopied] = React.useState(false)
  const shared = current.visibility === "link" && current.shareSlug !== null
  const url = shared ? `${window.location.origin}${paths.shared(current.shareSlug!)}` : ""
  const switchId = React.useId()

  const update = async (visibility: "private" | "link", rotate = false) => {
    setBusy(rotate ? "rotate" : "toggle")
    try {
      const slug = await scenes.setVisibility(current.id, visibility, { rotate })
      const next: SceneSummary = { ...current, visibility, shareSlug: slug }
      setCurrent(next)
      onChanged(next)
      if (rotate) toast.success("New link created", { description: "The previous link no longer works." })
    } catch (err) {
      toast.error("Couldn't change sharing", { description: userMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const copy = async () => {
    // copyText reports its own failure (toast) and never rejects; the guard keeps it that way.
    const ok = await copyText(url).catch(() => false)
    if (!ok) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  if (mode !== "supabase") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Share “{scene.name}”</DialogTitle>
          <DialogDescription>
            Share links need Cloud mode. In local mode your scenes live only in this browser — use Export .atlas.json to send a scene file instead.
          </DialogDescription>
        </DialogHeader>
      </>
    )
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Share “{scene.name}”</DialogTitle>
        <DialogDescription>Anyone with the link can view this scene and copy it into one of their own worlds.</DialogDescription>
      </DialogHeader>

      <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/50 p-3 ring-1 ring-foreground/5">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-md bg-background text-muted-foreground ring-1 ring-foreground/10">
            <Link2Icon className="size-4" />
          </div>
          <div className="grid gap-0.5">
            <Label htmlFor={switchId} className="text-xs">
              Share with a link
            </Label>
            <span className="text-[0.7rem] text-muted-foreground">{shared ? "Anyone with the link" : "Only you"}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {busy === "toggle" && <Spinner className="size-3.5 text-muted-foreground" />}
          <Switch id={switchId} checked={shared} disabled={busy !== null} onCheckedChange={(on) => void update(on ? "link" : "private")} />
        </div>
      </div>

      {shared && (
        <Field>
          <FieldLabel>Link</FieldLabel>
          <InputGroup>
            <InputGroupInput readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[0.7rem]" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => void copy()} aria-label="Copy link">
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? "Copied" : "Copy"}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>
            <button
              type="button"
              className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void update("link", true)}
            >
              {busy === "rotate" ? <Spinner className="size-3" /> : <RefreshCwIcon className="size-3" />}
              Reset link
            </button>{" "}
            — the old link stops working.
          </FieldDescription>
        </Field>
      )}

      <Alert>
        <ShieldAlertIcon />
        <AlertTitle>This shares the full DM document</AlertTitle>
        <AlertDescription>
          Hidden tokens, secret doors and DM notes are included. Players never need this link — they join games with a room code.
        </AlertDescription>
      </Alert>
    </div>
  )
}
