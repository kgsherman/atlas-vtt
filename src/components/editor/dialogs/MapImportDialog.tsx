/**
 * Map image import (ARCHITECTURE §9): drop one or more battlemaps, choose a level for each, calibrate
 * the grid (prefilled from "…-27x47-…" names), optionally trace a floor from the image alpha and walls
 * from its outline, then decode/normalise/store each image and attach it as the level's backdrop.
 * "New scene from map images" builds a fresh scene sized to the images, one level per image.
 */
import * as React from "react"
import { AlertTriangle, Check, FileImage, ImagePlus, Upload, X } from "lucide-react"
import { toast } from "sonner"

import { useServices } from "@/app/services"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { createScene } from "@/core/scene/factory"
import type { Id } from "@/core/scene/types"
import { addBackdrop, floorFromImage, wallsFromImage } from "@/editor/imageOps"
import { createEditorStore, type EditorStore } from "@/editor/store"
import { decodeImageBlob, guessGridFromName, importMapImage, probeImageSize, type ImageSize } from "@/net/assets"
import { cn } from "@/lib/utils"

import { useEditorContext, useEditorEngine, useEditorState } from "../context"
import { FieldPair, NumberInput, SelectInput, TextInput, type Option } from "../fields"
import { formatBytes, formatElevation, trimNumber } from "../lib/format"
import { clampCells, defaultCalibration, floorPlanForLevel, importRect, pxPerCell, requiredGrid, sceneNameFromFiles, type ImportEntrySettings } from "../lib/importPlan"
import { seedLevelImage } from "../lib/levelImages"
import { ENV_PRESETS, presetForFileNames, withPreset, type EnvPresetId } from "../lib/environmentPresets"
import { levelsTopDown, suggestLevelForImage } from "../lib/levelOps"
import type { SceneDocument } from "../useSceneDocument"

type EntryStatus = { kind: "idle" } | { kind: "working"; stage: string } | { kind: "done"; summary: string } | { kind: "error"; message: string }

interface Entry {
  key: string
  file: File
  size: ImageSize | null
  thumb: ImageBitmap | null
  settings: ImportEntrySettings
  status: EntryStatus
}

const ACCEPT = "image/png,image/jpeg,image/webp"
const isImageFile = (f: File) => /^image\/(png|jpeg|webp)$/.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name)
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

export interface MapImportRequest {
  mode: "new" | "existing"
  /** Pre-selected level for the first image (existing scenes). */
  levelId?: Id | null
  /** Files to start with (e.g. dropped on the viewport). */
  files?: File[]
}

function Thumb({ entry }: { entry: Entry }) {
  const ref = React.useRef<HTMLCanvasElement | null>(null)
  const { thumb, settings } = entry
  React.useEffect(() => {
    const c = ref.current
    if (!c || !thumb) return
    c.width = thumb.width
    c.height = thumb.height
    c.getContext("2d")?.drawImage(thumb, 0, 0)
  }, [thumb])
  const aspect = entry.size ? entry.size.width / entry.size.height : 0.75
  const lines = (n: number) => Array.from({ length: Math.max(0, Math.min(n, 200) - 1) }, (_, i) => ((i + 1) / n) * 100)
  return (
    <div className="relative w-32 self-start overflow-hidden rounded-md border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:10px_10px]" style={{ aspectRatio: `${Math.max(0.25, Math.min(4, aspect))}` }}>
      {thumb ? <canvas ref={ref} className="absolute inset-0 size-full" /> : <Skeleton className="absolute inset-0 rounded-none" />}
      {thumb ? (
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {lines(settings.cellsX).map((x) => (
            <line key={`x${x}`} x1={x} x2={x} y1={0} y2={100} className="stroke-foreground/35" strokeWidth={0.35} vectorEffect="non-scaling-stroke" />
          ))}
          {lines(settings.cellsZ).map((y) => (
            <line key={`z${y}`} y1={y} y2={y} x1={0} x2={100} className="stroke-foreground/35" strokeWidth={0.35} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      ) : null}
    </div>
  )
}

function EntryCard({
  entry,
  mode,
  levelOptions,
  disabled,
  onChange,
  onRemove,
}: {
  entry: Entry
  mode: "new" | "existing"
  levelOptions: Option<string>[]
  disabled: boolean
  onChange(settings: Partial<ImportEntrySettings>): void
  onRemove(): void
}) {
  const s = entry.settings
  const ppc = entry.size ? pxPerCell(entry.size, s.cellsX, s.cellsZ) : null
  const target = s.target
  const stored = ppc ? Math.min(140, Math.floor(Math.min(ppc.x, ppc.z))) : null
  const id = entry.key
  const floorNote = useEditorState((st) => {
    if (target.kind !== "existing") return ""
    const plan = floorPlanForLevel(st.scene, target.levelId, importRect(s, st.scene.grid.cellSize))
    if (!plan.hasFloors) return ""
    return plan.replace ? " (replaces the level's floors)" : plan.coverage < 0.98 ? " (adds floor where the level has none)" : " (adds a floor)"
  })
  return (
    <div className={cn("grid grid-cols-[8rem_minmax(0,1fr)] gap-4 rounded-lg border bg-card/50 p-3", entry.status.kind === "error" && "border-destructive/50")}>
      <Thumb entry={entry} />
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium" title={entry.file.name}>
              {entry.file.name}
            </div>
            <div className="text-[0.6875rem] text-muted-foreground">
              {entry.size ? `${entry.size.width}×${entry.size.height} px · ${entry.size.format.toUpperCase()}` : "Reading…"} · {formatBytes(entry.file.size)}
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Remove image" disabled={disabled} onClick={onRemove}>
            <X />
          </Button>
        </div>

        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
          <span className="text-xs text-muted-foreground">Level</span>
          <div className="flex min-w-0 items-center gap-1.5">
            {mode === "existing" ? (
              <SelectInput
                className="w-40 shrink-0"
                value={target.kind === "existing" ? target.levelId : "new"}
                options={levelOptions}
                disabled={disabled}
                onValueChange={(v) => onChange({ target: v === "new" ? { kind: "new", name: target.kind === "new" ? target.name : "New level", elevation: target.kind === "new" ? target.elevation : 0 } : { kind: "existing", levelId: v } })}
                aria-label="Target level"
              />
            ) : null}
            {target.kind === "new" ? (
              <>
                <TextInput className="min-w-0 flex-1" value={target.name} disabled={disabled} onCommit={(name) => onChange({ target: { ...target, name: name.trim() || target.name } })} />
                <NumberInput className="w-24 shrink-0" value={target.elevation} step={10} min={-1000} max={1000} unit="ft" disabled={disabled} onCommit={(elevation) => onChange({ target: { ...target, elevation } })} aria-label="Elevation" />
              </>
            ) : null}
          </div>

          <span className="text-xs text-muted-foreground">Grid</span>
          <div className="flex min-w-0 items-center gap-1.5">
            <FieldPair>
              <NumberInput prefix="W" value={s.cellsX} min={1} max={200} precision={0} unit="cells" disabled={disabled} onCommit={(v) => onChange({ cellsX: clampCells(v) })} aria-label="Cells across" />
              <NumberInput prefix="H" value={s.cellsZ} min={1} max={200} precision={0} unit="cells" disabled={disabled} onCommit={(v) => onChange({ cellsZ: clampCells(v) })} aria-label="Cells down" />
            </FieldPair>
          </div>

          <span className="text-xs text-muted-foreground">Offset</span>
          <FieldPair>
            <NumberInput prefix="X" value={s.offsetX} step={5} unit="ft" disabled={disabled} onCommit={(offsetX) => onChange({ offsetX })} aria-label="Offset X" />
            <NumberInput prefix="Z" value={s.offsetZ} step={5} unit="ft" disabled={disabled} onCommit={(offsetZ) => onChange({ offsetZ })} aria-label="Offset Z" />
          </FieldPair>
        </div>

        {ppc ? (
          <div className={cn("flex items-center gap-1.5 text-[0.6875rem]", ppc.square ? "text-muted-foreground" : "text-destructive")}>
            {ppc.square ? null : <AlertTriangle className="size-3" />}
            {ppc.square ? `${trimNumber(ppc.x, 1)} px per cell` : `Cells come out ${trimNumber(ppc.x, 0)}×${trimNumber(ppc.z, 0)} px — check the grid size`}
            {stored ? ` · stored at ${stored} px/cell` : ""}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <Label className="gap-2 text-xs font-normal" htmlFor={`${id}-floor`}>
            <Checkbox id={`${id}-floor`} checked={s.floor} disabled={disabled} onCheckedChange={(c) => onChange({ floor: c === true })} />
            Floor from image alpha{floorNote}
          </Label>
          <Label className="gap-2 text-xs font-normal" htmlFor={`${id}-walls`}>
            <Checkbox id={`${id}-walls`} checked={s.walls} disabled={disabled} onCheckedChange={(c) => onChange({ walls: c === true })} />
            Walls from image outline
          </Label>
        </div>

        {entry.status.kind !== "idle" ? (
          <div
            className={cn(
              "flex items-center gap-1.5 text-[0.6875rem]",
              entry.status.kind === "error" ? "text-destructive" : entry.status.kind === "done" ? "text-primary" : "text-muted-foreground"
            )}
          >
            {entry.status.kind === "working" ? <Spinner className="size-3" /> : entry.status.kind === "done" ? <Check className="size-3" /> : <AlertTriangle className="size-3" />}
            {entry.status.kind === "working" ? entry.status.stage : entry.status.kind === "done" ? entry.status.summary : entry.status.message}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function MapImportDialog({ request, onClose, doc }: { request: MapImportRequest | null; onClose(): void; doc: SceneDocument }) {
  const open = request !== null
  const mode = request?.mode ?? "existing"
  const { store } = useEditorContext()
  const engine = useEditorEngine()
  const { assets } = useServices()
  const levels = useEditorState((s) => s.scene.levels)
  const grid = useEditorState((s) => s.scene.grid)
  const [entries, setEntries] = React.useState<Entry[]>([])
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState(0)
  const [dragging, setDragging] = React.useState(false)
  /** New scenes: lighting preset (null = picked from the file names). */
  const [lighting, setLighting] = React.useState<EnvPresetId | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const requestRef = React.useRef(request)
  React.useEffect(() => {
    requestRef.current = request
  })

  // Files handed over with the request (dropped on the viewport) are added once per request.
  const addFilesRef = React.useRef<(files: File[]) => Promise<void>>(async () => {})
  const seeded = React.useRef<MapImportRequest | null>(null)
  React.useEffect(() => {
    if (!request?.files?.length || seeded.current === request) return
    seeded.current = request
    void addFilesRef.current(request.files)
  }, [request])

  const levelOptions: Option<string>[] = React.useMemo(
    () => [{ value: "new", label: "New level" }, ...levelsTopDown({ levels }).map((l) => ({ value: l.id, label: `${l.name} (${formatElevation(l.elevation)})` }))],
    [levels]
  )

  const update = (key: string, fn: (e: Entry) => Entry) => setEntries((list) => list.map((e) => (e.key === key ? fn(e) : e)))

  const addFiles = async (files: File[]) => {
    const images = files.filter(isImageFile)
    if (images.length < files.length) toast.warning("Some files were skipped", { description: "Only PNG, JPEG and WebP images can be imported." })
    const sceneLevels = mode === "new" ? {} : store.getState().scene.levels
    const taken = new Set<Id>()
    for (const e of entries) if (e.settings.target.kind === "existing") taken.add(e.settings.target.levelId)
    const added: Entry[] = []
    for (const file of images) {
      const size = await probeImageSize(file).catch(() => null)
      const calib = defaultCalibration(guessGridFromName(file.name), size, mode === "new" ? { width: 40, depth: 30 } : grid)
      const pre = requestRef.current?.levelId && entries.length + added.length === 0 && Object.hasOwn(sceneLevels, requestRef.current.levelId) ? requestRef.current.levelId : null
      const guess = suggestLevelForImage({ levels: sceneLevels }, file.name, taken)
      const levelId = pre ?? guess.levelId
      if (levelId) taken.add(levelId)
      // The image only shows on floors: trace one by default unless the level's floors already cover it.
      const plan = levelId !== null ? floorPlanForLevel(store.getState().scene, levelId, importRect({ ...calib, offsetX: 0, offsetZ: 0 }, grid.cellSize)) : null
      const entry: Entry = {
        key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        size,
        thumb: null,
        settings: {
          ...calib,
          offsetX: 0,
          offsetZ: 0,
          target: levelId ? { kind: "existing", levelId } : { kind: "new", name: guess.name, elevation: guess.elevation },
          floor: !plan || plan.coverage < 0.98,
          walls: size ? size.format === "png" || size.format === "webp" : false,
        },
        status: { kind: "idle" },
      }
      added.push(entry)
      if (size) {
        const w = 256
        const h = Math.max(1, Math.round((w * size.height) / size.width))
        createImageBitmap(file, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" })
          .then((thumb) => update(entry.key, (e) => ({ ...e, thumb })))
          .catch(() => update(entry.key, (e) => ({ ...e, status: { kind: "error", message: "This image could not be decoded." } })))
      }
    }
    setEntries((list) => [...list, ...added])
  }

  const lightingValue = lighting ?? presetForFileNames(entries.map((e) => e.file.name))

  React.useEffect(() => {
    addFilesRef.current = addFiles
  })

  const reset = () => {
    setLighting(null)
    setEntries([])
    setProgress(0)
    setRunning(false)
  }

  const needed = requiredGrid(
    entries.map((e) => e.settings),
    grid.cellSize,
    mode === "new" ? { width: 1, depth: 1 } : { width: grid.width, depth: grid.depth }
  )
  const grows = mode === "existing" && (needed.width > grid.width || needed.depth > grid.depth)

  const run = async () => {
    if (entries.length === 0) return
    setRunning(true)
    setProgress(0)
    const list = entries
    const stages = list.reduce((n, e) => n + 2 + (e.settings.floor ? 1 : 0) + (e.settings.walls ? 1 : 0), 0)
    let done = 0
    const step = () => setProgress(Math.round((++done / stages) * 100))
    const setStatus = (key: string, status: EntryStatus) => update(key, (e) => ({ ...e, status }))

    let target: EditorStore
    const cellSize = store.getState().scene.grid.cellSize
    if (mode === "new") {
      const size = requiredGrid(list.map((e) => e.settings), cellSize)
      const scene = createScene({ name: sceneNameFromFiles(list.map((e) => e.file.name)), width: size.width, depth: size.depth, groundFloor: false })
      scene.environment = withPreset(scene.environment, lightingValue)
      target = createEditorStore({ scene, systemClipboard: null })
    } else {
      target = store
      target.getState().beginTransaction(`Import ${list.length} map image${list.length === 1 ? "" : "s"}`)
      if (grows) target.getState().updateGrid({ width: needed.width, depth: needed.depth })
    }
    const sceneId = target.getState().scene.id

    // Resolve target levels (new ones are created up front, in elevation order).
    const levelFor = new Map<string, Id>()
    const initial = mode === "new" ? Object.keys(target.getState().scene.levels)[0] : null
    let reuseInitial = initial
    for (const e of [...list].sort((a, b) => elevationOf(a) - elevationOf(b))) {
      const t = e.settings.target
      if (t.kind === "existing") {
        levelFor.set(e.key, t.levelId)
      } else if (reuseInitial) {
        target.getState().updateLevel(reuseInitial, { name: t.name, elevation: t.elevation })
        levelFor.set(e.key, reuseInitial)
        reuseInitial = null
      } else {
        const id = target.getState().addLevel({ name: t.name, elevation: t.elevation }, { activate: false })
        if (id) levelFor.set(e.key, id)
      }
    }

    let ok = 0
    let walls = 0
    for (const e of list) {
      const levelId = levelFor.get(e.key)
      const s = e.settings
      if (!levelId) {
        setStatus(e.key, { kind: "error", message: "Could not create the level (too many levels?)" })
        continue
      }
      try {
        setStatus(e.key, { kind: "working", stage: e.size && e.size.width * e.size.height > 50e6 ? "Decoding a large image…" : "Decoding and resampling…" })
        await tick()
        const imported = await importMapImage(e.file, { cellsX: s.cellsX, cellsZ: s.cellsZ, origin: { x: s.offsetX, z: s.offsetZ } }, cellSize, { skipPixels: !(s.floor || s.walls) })
        step()
        setStatus(e.key, { kind: "working", stage: "Saving the image…" })
        const meta = await assets.putImage(sceneId, imported.blob, { kind: "image", name: e.file.name, mime: imported.mime, width: imported.width, height: imported.height })
        const decoded = decodeImageBlob(imported.blob).then((b) => {
          if (!b) throw new Error("could not decode the stored image")
          return b
        })
        decoded.catch(() => {})
        seedLevelImage(sceneId, meta.id, decoded)
        if (!addBackdrop(target, levelId, imported, meta)) throw new Error(target.getState().lastRejected?.issues[0] ?? "the backdrop was refused")
        step()
        const notes: string[] = [`${imported.width}×${imported.height} px`]
        if (s.floor) {
          setStatus(e.key, { kind: "working", stage: "Tracing the floor…" })
          await tick()
          const replace = floorPlanForLevel(target.getState().scene, levelId, imported.rect).replace
          const id = floorFromImage(target, levelId, imported.pixels, imported, { replace, material: target.getState().toolSettings.floor.material })
          notes.push(id ? "floor traced" : `no floor (${target.getState().lastRejected?.issues[0] ?? "nothing opaque"})`)
          step()
        }
        if (s.walls) {
          setStatus(e.key, { kind: "working", stage: "Tracing walls along the outline…" })
          await tick()
          const ids = wallsFromImage(target, levelId, imported.pixels, imported, { material: target.getState().toolSettings.wall.material })
          notes.push(ids.length > 0 ? `${ids.length} walls` : "no outline walls (the image has no transparent edge)")
          walls += ids.length
          step()
        }
        setStatus(e.key, { kind: "done", summary: notes.join(" · ") })
        ok++
      } catch (err) {
        console.error("[atlas] map import failed", err)
        setStatus(e.key, { kind: "error", message: err instanceof Error ? err.message : String(err) })
      }
    }

    if (mode === "new") {
      if (ok > 0) {
        doc.adoptNewScene(target.getState().scene)
        // Battlemaps read best from above: switch to the top-down camera and frame the new map.
        store.getState().setView({ camera: "topdown" })
        requestAnimationFrame(() => engine?.frameScene())
      }
    } else if (ok > 0) {
      target.getState().commitTransaction()
      const first = levelFor.get(list[0].key)
      if (first) target.getState().setActiveLevel(first)
    } else {
      target.getState().cancelTransaction()
    }
    setRunning(false)
    if (ok === list.length) {
      toast.success(ok === 1 ? "Map image imported" : `${ok} map images imported`, { description: walls > 0 ? `${walls} walls traced from the outlines.` : undefined })
      reset()
      onClose()
    } else if (ok > 0) {
      toast.warning(`${ok} of ${list.length} images imported`, { description: "See the dialog for the ones that failed." })
    } else {
      toast.error("No image could be imported")
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !running) {
          reset()
          onClose()
        }
      }}
    >
      <DialogContent className={cn("flex max-h-[90vh] flex-col gap-4 sm:max-w-3xl", entries.length > 2 && "h-[min(90vh,60rem)]")} showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImagePlus className="size-4" /> {mode === "new" ? "New scene from map images" : "Import map images"}
          </DialogTitle>
          <DialogDescription>
            {mode === "new"
              ? "One level per image, with the grid sized from the images. Battlemaps named like “…-27x47-…” are calibrated automatically."
              : "Drape battlemaps over levels. Lighting, shadows and fog of war apply to them; players only ever receive the parts they have explored."}
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn("flex min-h-0 flex-1 flex-col gap-3", dragging && "rounded-lg ring-2 ring-primary/50")}
          onDragOver={(e) => {
            if (running) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            setDragging(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            if (!running) void addFiles([...e.dataTransfer.files])
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            data-testid="map-import-input"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ""
              void addFiles(files)
            }}
          />
          {entries.length === 0 ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-14 text-center transition-colors outline-none hover:border-primary/50 hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <span className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                <Upload className="size-5" />
              </span>
              <span className="text-sm font-medium">Drop battlemap images here</span>
              <span className="max-w-sm text-xs text-muted-foreground">PNG, JPEG or WebP — huge maps are fine. Transparent areas (caves, upper storeys) can become floors and walls automatically.</span>
              <span className="mt-1 inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs">
                <FileImage className="size-3.5" /> Choose files
              </span>
            </button>
          ) : (
            <>
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-2 pr-3">
                  {entries.map((e) => (
                    <EntryCard
                      key={e.key}
                      entry={e}
                      mode={mode}
                      levelOptions={levelOptions}
                      disabled={running}
                      onChange={(partial) => update(e.key, (x) => ({ ...x, settings: { ...x.settings, ...partial } }))}
                      onRemove={() => setEntries((list) => list.filter((x) => x.key !== e.key))}
                    />
                  ))}
                </div>
              </ScrollArea>
              <div className="flex items-center justify-between gap-2">
                <Button variant="outline" size="sm" disabled={running} onClick={() => inputRef.current?.click()}>
                  <ImagePlus data-icon="inline-start" /> Add images
                </Button>
                <div className="flex items-center gap-3 text-[0.6875rem] text-muted-foreground">
                  {mode === "new" ? (
                    <>
                      <span className="flex items-center gap-1.5">
                        Lighting
                        <SelectInput
                          className="w-32"
                          value={lightingValue}
                          disabled={running}
                          options={(Object.keys(ENV_PRESETS) as EnvPresetId[]).map((id) => ({ value: id, label: ENV_PRESETS[id].label }))}
                          onValueChange={(v) => setLighting(v as EnvPresetId)}
                          aria-label="Scene lighting"
                        />
                      </span>
                      <span className="flex items-center gap-1.5">
                        Scene grid
                        <Badge variant="outline" className="font-normal">
                          {needed.width}×{needed.depth} cells
                        </Badge>
                      </span>
                    </>
                  ) : (
                    `Scene grid ${grid.width}×${grid.depth} cells`
                  )}
                </div>
              </div>
            </>
          )}
          {grows ? (
            <Alert>
              <AlertTriangle />
              <AlertTitle>The grid will grow to fit</AlertTitle>
              <AlertDescription>
                The images extend beyond the scene ({grid.width}×{grid.depth} cells). Importing enlarges the grid to {needed.width}×{needed.depth} cells.
              </AlertDescription>
            </Alert>
          ) : null}
          {running ? <Progress value={progress} aria-label="Import progress" /> : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={running}
            onClick={() => {
              reset()
              onClose()
            }}
          >
            Cancel
          </Button>
          <Button disabled={running || entries.length === 0 || entries.some((e) => !e.size)} onClick={() => void run()}>
            {running ? <Spinner className="size-3.5" /> : null}
            {running ? "Importing…" : mode === "new" ? `Create scene from ${entries.length || ""} image${entries.length === 1 ? "" : "s"}` : `Import ${entries.length || ""} image${entries.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function elevationOf(e: Entry): number {
  return e.settings.target.kind === "new" ? e.settings.target.elevation : 0
}
