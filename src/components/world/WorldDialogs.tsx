/**
 * Worlds (ARCHITECTURE §6.9): create, rename and delete one, and move a scene to another.
 */
import * as React from "react"
import { GlobeIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { deleteWorld, userMessage } from "@/app/library"
import { useServices } from "@/app/services"
import { useLastNonNull } from "@/app/useAsync"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import type { SceneSummary } from "@/net/scenesRepo"
import { normalizeWorldName, WORLD_NAME_MAX, type WorldSummary } from "@/net/worldsRepo"

// ---------------------------------------------------------------------------
// New / rename
// ---------------------------------------------------------------------------

/** Name a new world (`world` null) or rename one. */
export function WorldNameDialog({
  open,
  world,
  onClose,
  onDone,
}: {
  open: boolean
  world: WorldSummary | null
  onClose(): void
  onDone(world: WorldSummary): void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        {open && <WorldNameForm key={world?.id ?? "new"} world={world} onClose={onClose} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  )
}

function WorldNameForm({ world, onClose, onDone }: { world: WorldSummary | null; onClose(): void; onDone(world: WorldSummary): void }) {
  const { worlds } = useServices()
  const [name, setName] = React.useState(world?.name ?? "")
  const [saving, setSaving] = React.useState(false)
  const id = React.useId()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || saving) return
    if (world && normalizeWorldName(name) === world.name) return onClose()
    setSaving(true)
    try {
      const done = world ? await worlds.rename(world.id, name) : await worlds.create(name)
      onDone(done)
      onClose()
    } catch (err) {
      toast.error(world ? "Couldn't rename the world" : "Couldn't create the world", { description: userMessage(err) })
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{world ? "Rename world" : "New world"}</DialogTitle>
        <DialogDescription>
          {world
            ? "Players see the name when they join."
            : "A world is one campaign: its scenes, its characters and the players who join it with its room code."}
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={id}>Name</FieldLabel>
        <Input
          id={id}
          autoFocus
          value={name}
          maxLength={WORLD_NAME_MAX}
          placeholder="Tyranny of Dragons"
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !name.trim()}>
          {saving && <Spinner className="size-3.5" data-icon="inline-start" />}
          {world ? "Save" : "Create world"}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export function DeleteWorldDialog({
  world,
  sceneCount,
  onClose,
  onDeleted,
}: {
  world: WorldSummary | null
  sceneCount: number
  onClose(): void
  onDeleted(world: WorldSummary): void
}) {
  const services = useServices()
  const shown = useLastNonNull(world)
  const [busy, setBusy] = React.useState(false)

  const run = async () => {
    if (!world) return
    setBusy(true)
    try {
      const { warnings } = await deleteWorld(services, world)
      for (const w of warnings) toast.warning(w)
      onDeleted(world)
      onClose()
    } catch (err) {
      toast.error("Couldn't delete the world", { description: userMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={world !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>Delete “{shown?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {sceneCount > 0
              ? `Its ${sceneCount === 1 ? "scene" : `${sceneCount} scenes`} (with their restore points and map images), its characters and its players go with it. Players at an open table are disconnected. This can't be undone.`
              : "Its characters and players go with it. This can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={(e) => (e.preventDefault(), void run())}>
            {busy && <Spinner className="size-3.5" data-icon="inline-start" />}
            Delete world
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------------------------------------------------------------------------
// Move a scene
// ---------------------------------------------------------------------------

export function MoveSceneDialog({
  scene,
  worlds,
  onClose,
  onMoved,
}: {
  scene: SceneSummary | null
  worlds: WorldSummary[]
  onClose(): void
  onMoved(scene: SceneSummary, to: WorldSummary): void
}) {
  const shown = useLastNonNull(scene)
  return (
    <Dialog open={scene !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {shown && <MoveForm key={shown.id} scene={shown} worlds={worlds} onClose={onClose} onMoved={onMoved} />}
      </DialogContent>
    </Dialog>
  )
}

function MoveForm({
  scene,
  worlds,
  onClose,
  onMoved,
}: {
  scene: SceneSummary
  worlds: WorldSummary[]
  onClose(): void
  onMoved(scene: SceneSummary, to: WorldSummary): void
}) {
  const services = useServices()
  const others = worlds.filter((w) => w.id !== scene.worldId)
  const [target, setTarget] = React.useState<string | null>(others[0]?.id ?? null)
  const [saving, setSaving] = React.useState(false)
  const to = others.find((w) => w.id === target) ?? null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!to || saving) return
    setSaving(true)
    try {
      await services.scenes.moveToWorld(scene.id, to.id)
      onMoved({ ...scene, worldId: to.id }, to)
      onClose()
    } catch (err) {
      toast.error("Couldn't move the scene", { description: userMessage(err) })
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Move “{scene.name}”</DialogTitle>
        <DialogDescription>The scene joins another of your worlds, with its restore points. Its table must be closed.</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel>World</FieldLabel>
        <Select value={target} onValueChange={(v) => v && setTarget(String(v))}>
          <SelectTrigger aria-label="World" className="w-full">
            <SelectValue>{() => to?.name ?? "Choose a world"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {others.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                <GlobeIcon />
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>Tokens linked to this world's characters stay in the scene, but nobody controls them there.</FieldDescription>
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!to || saving}>
          {saving && <Spinner className="size-3.5" data-icon="inline-start" />}
          Move scene
        </Button>
      </DialogFooter>
    </form>
  )
}
