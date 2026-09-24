import * as React from "react"
import { Copy, Eye, EyeOff, ImagePlus, Layers, Mountain, MoreHorizontal, Plus, Trash2, Image as ImageIcon, ArrowDownToLine } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useServices } from "@/app/services"
import { heightRange, maxCellsForResolution, terrainResolutionFits } from "@/core/scene/heightmap"
import { SCENE_LIMITS } from "@/core/scene/schema"
import { hasPaintedBase } from "@/core/scene/terrainShapes"
import { TERRAIN_RESOLUTIONS, type GridSettings, type Id, type Level, type TerrainResolution } from "@/core/scene/types"
import { floorFromImage, removeBackdrop, updateBackdrop, wallsFromImage } from "@/editor/imageOps"
import type { LevelUpdate } from "@/editor/store"
import { cn } from "@/lib/utils"

import { useConfirm, useEditorActions, useEditorContext, useEditorShallow, useEditorState } from "../context"
import { FieldRow, Hint, NumberInput, PanelSection, Segmented, SliderInput, SwitchField, TextInput, type Option } from "../fields"
import { formatBytes, formatElevation, trimNumber } from "../lib/format"
import { imagePixelsForTrace, loadLevelImage } from "../lib/levelImages"
import { levelBelowElevation, levelsTopDown } from "../lib/levelOps"

function LevelRow({ level, active, visible, count, onActivate }: { level: Level; active: boolean; visible: boolean; count: number; onActivate(): void }) {
  const { store } = useEditorContext()
  const actions = useEditorActions()
  const readOnly = useEditorState((s) => s.readOnly)
  const levelCount = useEditorState((s) => Object.keys(s.scene.levels).length)

  // The radio is the name/elevation part only, so the row's buttons are not nested inside it
  // (nested-interactive); a click anywhere on the row still activates the level.
  return (
    <div
      onClick={onActivate}
      className={cn(
        "group flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-transparent pr-1 pl-1 text-xs transition-colors hover:bg-muted/60 has-[[role=radio]:focus-visible]:ring-2 has-[[role=radio]:focus-visible]:ring-ring/40",
        active && "border-primary/30 bg-primary/10 hover:bg-primary/15"
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={visible ? "Hide level" : "Show level"}
              className={cn("text-muted-foreground", !visible && "text-muted-foreground/50")}
              onClick={(e) => {
                e.stopPropagation()
                store.getState().toggleLevelVisibility(level.id)
              }}
            />
          }
        >
          {visible ? <Eye /> : <EyeOff />}
        </TooltipTrigger>
        <TooltipContent side="left">{visible ? "Hide in the editor" : "Show in the editor"}</TooltipContent>
      </Tooltip>
      <span
        role="radio"
        aria-checked={active}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onActivate()
          }
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 outline-none"
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", active ? "bg-primary" : "bg-transparent")} />
        <span className={cn("min-w-0 flex-1 truncate", active ? "font-medium text-foreground" : "text-foreground/80", !visible && "opacity-50")}>{level.name}</span>
        {level.backdrop ? <ImageIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Has a map image" /> : null}
        {level.heightmap ? <Mountain className="size-3 shrink-0 text-muted-foreground" aria-label="Has terrain" /> : null}
        <span className="w-14 shrink-0 text-right text-[0.6875rem] text-muted-foreground tabular-nums">{formatElevation(level.elevation)}</span>
        <span className="w-6 shrink-0 text-right text-[0.625rem] text-muted-foreground tabular-nums" title={`${count} objects`}>
          {count}
        </span>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`${level.name} actions`} className="text-muted-foreground opacity-60 group-hover:opacity-100" onClick={(e) => e.stopPropagation()} />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={onActivate}>
              <Layers /> Make active
            </DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onClick={() => actions.openMapImport(level.id)}>
              <ImagePlus /> {level.backdrop ? "Replace map image…" : "Add map image…"}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly || levelCount >= SCENE_LIMITS.maxLevels} onClick={() => actions.duplicateLevel(level.id)}>
              <Copy /> Duplicate
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={readOnly || levelCount <= 1} onClick={() => actions.deleteLevel(level.id)}>
            <Trash2 /> Delete level…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function LevelList() {
  const { store } = useEditorContext()
  const actions = useEditorActions()
  const { levels, activeLevelId, visibility, ghost, readOnly } = useEditorShallow((s) => ({
    levels: s.scene.levels,
    activeLevelId: s.activeLevelId,
    visibility: s.view.levelVisibility,
    ghost: s.view.ghostAdjacent,
    readOnly: s.readOnly,
  }))
  const ordered = levelsTopDown({ levels })
  const full = ordered.length >= SCENE_LIMITS.maxLevels
  // Objects per level, counted once per document change (not per row per store update).
  const objects = useEditorState((s) => s.scene.objects)
  const counts = React.useMemo(() => {
    const m = new Map<Id, number>()
    for (const o of Object.values(objects)) m.set(o.levelId, (m.get(o.levelId) ?? 0) + 1)
    return m
  }, [objects])

  return (
    <PanelSection
      title="Levels"
      action={
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Add level" disabled={readOnly || full} />} />}>
              <Plus />
            </TooltipTrigger>
            <TooltipContent>Add a level</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onClick={actions.addLevel}>
              <Plus /> Add level on top
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const id = store.getState().addLevel({ name: "Basement", elevation: levelBelowElevation(store.getState().scene) })
                if (!id) toast.error("Could not add a level")
              }}
            >
              <ArrowDownToLine /> Add level below
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <div role="radiogroup" aria-label="Active level" className="flex flex-col gap-0.5">
        {ordered.map((l) => (
          <LevelRow key={l.id} level={l} active={l.id === activeLevelId} visible={visibility[l.id] !== false} count={counts.get(l.id) ?? 0} onActivate={() => store.getState().setActiveLevel(l.id)} />
        ))}
      </div>
      <SwitchField label="Ghost adjacent levels" description="Show the levels above and below the active one as translucent ghosts." checked={ghost} onCheckedChange={() => store.getState().toggleGhostAdjacent()} />
    </PanelSection>
  )
}

function LevelProperties({ level }: { level: Level }) {
  const { store } = useEditorContext()
  const readOnly = useEditorState((s) => s.readOnly)
  // Refused edits surface as toasts through the page's lastRejected listener.
  const update = (partial: LevelUpdate) => store.getState().updateLevel(level.id, partial)
  return (
    <PanelSection title="Level">
      <FieldRow label="Name">
        <TextInput value={level.name} disabled={readOnly} onCommit={(name) => update({ name: name.trim() || level.name })} />
      </FieldRow>
      <FieldRow label="Elevation" hint="World height of this level's ground. Levels are ordered by elevation.">
        <NumberInput value={level.elevation} step={1} min={-1000} max={1000} unit="ft" disabled={readOnly} onCommit={(elevation) => update({ elevation })} />
      </FieldRow>
      <FieldRow label="Storey height" hint="Default wall height, and the storey height used when nothing is above.">
        <NumberInput value={level.height} step={1} min={1} max={1000} unit="ft" disabled={readOnly} onCommit={(height) => update({ height })} />
      </FieldRow>
      <FieldRow label="Floor thickness" hint="Thickness of this level's floor slabs (the ceiling of the level below).">
        <NumberInput value={level.floorThickness} step={0.25} min={0.1} max={100} unit="ft" disabled={readOnly} onCommit={(floorThickness) => update({ floorThickness })} />
      </FieldRow>
    </PanelSection>
  )
}

type ResolutionValue = `${TerrainResolution}`

/** Resolution choices for a grid: finer ones are disabled on grids larger than they support. */
function resolutionOptions(grid: Pick<GridSettings, "width" | "depth" | "cellSize">): Option<ResolutionValue>[] {
  return TERRAIN_RESOLUTIONS.map((r) => {
    const spacing = `${r} sample${r === 1 ? "" : "s"} per cell (${trimNumber(grid.cellSize / r, 4)} ft)`
    const fits = terrainResolutionFits(grid, r)
    const max = maxCellsForResolution(r)
    return {
      value: `${r}`,
      label: `${r}×`,
      tooltip: fits ? spacing : `${spacing}: grids up to ${max}×${max} cells only`,
      disabled: !fits,
    }
  })
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

/**
 * A level's terrain: on / off, resolution, height range, and the painted ground vs the editable shapes
 * (terrain tool). Every write goes through the store's terrain actions (one undo step each).
 */
export function TerrainSection({ level }: { level: Level }) {
  const { store } = useEditorContext()
  const confirm = useConfirm()
  const readOnly = useEditorState((s) => s.readOnly)
  const hm = level.heightmap
  const range = React.useMemo(() => heightRange(hm ?? null), [hm])
  // The baked terrain (painted ground + shapes) is not flat vs the painted ground alone is not flat.
  const raised = hm ? Object.keys(hm.chunks).length > 0 : false
  const terrainEdits = level.terrainEdits
  const painted = React.useMemo(() => hasPaintedBase({ heightmap: hm, terrainEdits }), [hm, terrainEdits])
  const shapes = terrainEdits ? Object.keys(terrainEdits.shapes).length : 0
  const grid = useEditorState((s) => s.scene.grid)
  const options = React.useMemo(() => resolutionOptions(grid), [grid])

  const toggle = async (on: boolean) => {
    if (on) {
      store.getState().enableTerrain(level.id)
      store.getState().setTool("terrain")
      return
    }
    const what =
      shapes > 0
        ? `The painted heights and ${plural(shapes, "terrain shape")} of “${level.name}” will be deleted.`
        : `The painted heights of “${level.name}” will be flattened.`
    if (
      (raised || shapes > 0) &&
      !(await confirm({ title: "Remove the terrain?", description: `${what} You can undo this.`, confirmLabel: "Remove terrain", destructive: true }))
    )
      return
    store.getState().clearTerrain(level.id)
  }

  const deleteShapes = async () => {
    const ok = await confirm({
      title: `Delete ${plural(shapes, "terrain shape")}?`,
      description: `Every block, ramp and cylinder of “${level.name}” is deleted; the painted ground stays. To keep a shape's heights, use "Apply to terrain" on it first. You can undo this.`,
      confirmLabel: "Delete shapes",
      destructive: true,
    })
    if (ok) store.getState().clearTerrainShapes(level.id)
  }

  return (
    <PanelSection title="Terrain">
      <SwitchField
        label="Heightmap terrain"
        description="Sculpt hills, pits, blocks and ramps with the terrain tool (T)."
        checked={hm !== null}
        disabled={readOnly}
        onCheckedChange={(on) => void toggle(on)}
      />
      {hm ? (
        <>
          <FieldRow
            label="Resolution"
            hint={`Height samples per grid cell. Changing it resamples the painted terrain and re-bakes the shapes. 8× needs a grid of at most ${maxCellsForResolution(8)}×${maxCellsForResolution(8)} cells, 16× at most ${maxCellsForResolution(16)}×${maxCellsForResolution(16)}.`}
          >
            <Segmented
              value={`${hm.resolution}` as ResolutionValue}
              disabled={readOnly}
              onValueChange={(v) => void store.getState().setTerrainResolution(level.id, Number(v) as TerrainResolution)}
              options={options}
            />
          </FieldRow>
          <div className="flex items-center justify-between gap-2">
            <Hint>
              {raised
                ? `Heights ${trimNumber(range.min, 1)} to ${trimNumber(range.max, 1)} ft${painted ? "" : " (shapes only)"}`
                : "Flat — pick the terrain tool and paint or draw shapes."}
            </Hint>
            <Tooltip>
              {/* The span keeps the tooltip working while the button is disabled (it says why). */}
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button variant="ghost" size="xs" disabled={readOnly || !painted} onClick={() => store.getState().flattenTerrain(level.id)}>
                  Flatten
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {!painted ? "The painted ground is already flat" : shapes > 0 ? "Flatten the painted ground (the shapes stay)" : "Flatten the painted ground"}
              </TooltipContent>
            </Tooltip>
          </div>
          {shapes > 0 ? (
            <div className="flex items-center justify-between gap-2">
              <Hint>{plural(shapes, "terrain shape")}</Hint>
              <Button variant="ghost" size="xs" className="hover:text-destructive" disabled={readOnly} onClick={() => void deleteShapes()}>
                Delete shapes
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </PanelSection>
  )
}

function BackdropThumb({ sceneId, assetId, aspect }: { sceneId: Id; assetId: Id; aspect: number }) {
  const { assets } = useServices()
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const [state, setState] = React.useState<{ key: string; status: "ready" | "error" } | null>(null)
  const key = `${sceneId}/${assetId}`

  React.useEffect(() => {
    let alive = true
    loadLevelImage(assets, sceneId, assetId)
      .then((bitmap) => {
        const canvas = canvasRef.current
        if (!alive || !canvas) return
        const w = 288
        const h = Math.max(1, Math.round(w / Math.max(0.05, bitmap.width / bitmap.height)))
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext("2d")
        ctx?.clearRect(0, 0, w, h)
        ctx?.drawImage(bitmap, 0, 0, w, h)
        setState({ key, status: "ready" })
      })
      .catch(() => {
        if (alive) setState({ key, status: "error" })
      })
    return () => {
      alive = false
    }
  }, [assets, sceneId, assetId, key])

  const status = state?.key === key ? state.status : "loading"
  return (
    <div className="relative overflow-hidden rounded-md border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:12px_12px]" style={{ aspectRatio: `${Math.max(0.2, Math.min(5, aspect))}` }}>
      <canvas ref={canvasRef} className={cn("block size-full", status !== "ready" && "invisible")} />
      {status === "loading" ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
      {status === "error" ? <div className="absolute inset-0 grid place-items-center text-[0.6875rem] text-muted-foreground">Image unavailable</div> : null}
    </div>
  )
}

function BackdropSection({ level }: { level: Level }) {
  const { store } = useEditorContext()
  const { assets } = useServices()
  const actions = useEditorActions()
  const confirm = useConfirm()
  const readOnly = useEditorState((s) => s.readOnly)
  const sceneId = useEditorState((s) => s.scene.id)
  const cellSize = useEditorState((s) => s.scene.grid.cellSize)
  const asset = useEditorState((s) => (level.backdrop && s.scene.assets && Object.hasOwn(s.scene.assets, level.backdrop.assetId) ? s.scene.assets[level.backdrop.assetId] : null))
  const [tracing, setTracing] = React.useState<"floor" | "walls" | null>(null)
  const [liveOpacity, setLiveOpacity] = React.useState<number | null>(null)
  const lastOpacity = React.useRef(0)
  const b = level.backdrop

  if (!b) {
    return (
      <PanelSection title="Map image">
        <Empty className="gap-2 border border-dashed p-4">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ImagePlus />
            </EmptyMedia>
            <EmptyTitle className="text-xs">No map image</EmptyTitle>
            <EmptyDescription className="text-[0.6875rem]">Drape a battlemap over this level. Lighting, shadows and fog apply to it.</EmptyDescription>
          </EmptyHeader>
          <Button size="sm" variant="outline" disabled={readOnly} onClick={() => actions.openMapImport(level.id)}>
            <ImagePlus data-icon="inline-start" /> Import map image…
          </Button>
        </Empty>
      </PanelSection>
    )
  }

  const setBackdrop = (partial: Partial<Omit<typeof b, "assetId">>) => updateBackdrop(store, level.id, partial)

  const trace = async (kind: "floor" | "walls") => {
    const s = store.getState()
    const floors = Object.values(s.scene.objects).filter((o) => o.levelId === level.id && o.type === "floor").length
    const walls = Object.values(s.scene.objects).filter((o) => o.levelId === level.id && o.type === "wall").length
    if (kind === "floor" && floors > 0) {
      const ok = await confirm({
        title: "Replace the level's floors?",
        description: `“${level.name}” has ${floors} floor${floors === 1 ? "" : "s"}. They are replaced by one floor covering the opaque part of the image. You can undo this.`,
        confirmLabel: "Replace floors",
        destructive: true,
      })
      if (!ok) return
    }
    if (kind === "walls" && walls > 0) {
      const ok = await confirm({
        title: "Add walls along the outline?",
        description: `“${level.name}” already has ${walls} wall${walls === 1 ? "" : "s"}. The traced walls are added to them (run it once per image). You can undo this.`,
        confirmLabel: "Add walls",
      })
      if (!ok) return
    }
    setTracing(kind)
    try {
      const bitmap = await loadLevelImage(assets, sceneId, b.assetId)
      const pixels = imagePixelsForTrace(bitmap, b.rect, cellSize)
      const calib = { rect: b.rect }
      if (kind === "floor") {
        const id = floorFromImage(store, level.id, pixels, calib, { replace: true, material: s.toolSettings.floor.material })
        if (id) toast.success("Floor traced from the image")
        else toast.error("No floor was created", { description: store.getState().lastRejected?.issues[0] ?? "The image has no opaque area." })
      } else {
        const ids = wallsFromImage(store, level.id, pixels, calib, { material: s.toolSettings.wall.material })
        if (ids.length > 0) toast.success(`${ids.length} walls traced from the image outline`)
        else toast.error("No walls were created", { description: store.getState().lastRejected?.issues[0] ?? "The image has no transparent outline to follow." })
      }
    } catch (err) {
      toast.error("Tracing failed", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setTracing(null)
    }
  }

  const pxPerCell = asset ? asset.width / Math.max(1, b.rect.w / cellSize) : null

  return (
    <PanelSection title="Map image" action={asset ? <Badge variant="outline" className="font-normal">{asset.mime.replace("image/", "").toUpperCase()}</Badge> : null}>
      <BackdropThumb sceneId={sceneId} assetId={b.assetId} aspect={b.rect.w / Math.max(0.01, b.rect.d)} />
      {asset ? (
        <Hint className="truncate" >
          <span title={asset.name}>{asset.name}</span> · {asset.width}×{asset.height}px{pxPerCell ? ` · ${trimNumber(pxPerCell, 0)} px/cell` : ""} · {formatBytes(asset.bytes)}
        </Hint>
      ) : null}
      <FieldRow label="Opacity">
        <SliderInput
          value={liveOpacity ?? b.opacity}
          min={0}
          max={1}
          step={0.05}
          disabled={readOnly}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(opacity) => {
            setLiveOpacity(opacity)
            // Throttled live preview; the release commits the final value.
            const now = performance.now()
            if (now - lastOpacity.current > 100) {
              lastOpacity.current = now
              setBackdrop({ opacity })
            }
          }}
          onCommit={(opacity) => {
            setLiveOpacity(null)
            setBackdrop({ opacity })
          }}
        />
      </FieldRow>
      <SwitchField label="Tint walls" description="Colour wall tops and faces with the image under them (extruded-map look)." checked={b.tintWalls} disabled={readOnly} onCheckedChange={(tintWalls) => setBackdrop({ tintWalls })} />
      <div className="grid grid-cols-2 gap-1.5">
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="sm" disabled={readOnly || tracing !== null} onClick={() => void trace("floor")} />}>
            {tracing === "floor" ? <Spinner className="size-3" /> : null}
            Floor from image
          </TooltipTrigger>
          <TooltipContent>Create a floor covering the opaque part of the image</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="sm" disabled={readOnly || tracing !== null} onClick={() => void trace("walls")} />}>
            {tracing === "walls" ? <Spinner className="size-3" /> : null}
            Walls from outline
          </TooltipTrigger>
          <TooltipContent>Create walls along the edge of the opaque area (caves, building outlines)</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="xs" disabled={readOnly} onClick={() => actions.openMapImport(level.id)}>
          <ImagePlus data-icon="inline-start" /> Replace…
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="text-destructive hover:text-destructive"
          disabled={readOnly}
          onClick={() => {
            void (async () => {
              try {
                if (await confirm({ title: "Remove the map image?", description: `The image is removed from “${level.name}”. Traced floors and walls stay. You can undo this.`, confirmLabel: "Remove image", destructive: true })) {
                  removeBackdrop(store, level.id)
                }
              } catch (err) {
                toast.error("Couldn't remove the map image", { description: err instanceof Error ? err.message : String(err) })
              }
            })()
          }}
        >
          <Trash2 data-icon="inline-start" /> Remove
        </Button>
      </div>
    </PanelSection>
  )
}

export function LevelsPanel() {
  const level = useEditorState((s) => (Object.hasOwn(s.scene.levels, s.activeLevelId) ? s.scene.levels[s.activeLevelId] : null))
  return (
    <div className="flex flex-col">
      <LevelList />
      {level ? (
        <React.Fragment key={level.id}>
          <LevelProperties level={level} />
          <BackdropSection level={level} />
          <TerrainSection level={level} />
        </React.Fragment>
      ) : null}
    </div>
  )
}
