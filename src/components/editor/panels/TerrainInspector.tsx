/**
 * The Inspector in the terrain editing mode (DESIGN §3.4): the terrain tool's shape selection
 * (store.terrainSelection) instead of the object selection, which is hidden in this mode. One shape:
 * name, add / carve, top, base, bake order, vertex count, "too small" warning, Apply to terrain, Delete.
 * Several: count, add / carve, Apply to terrain, Delete. Every edit is one store.applyTerrainEdit (number
 * fields coalesce in history, like object fields).
 */
import * as React from "react"
import { ArrowDown, ArrowUp, Layers2, Mountain, Scan, Stamp, Trash2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import { useCommandLabel } from "@/components/keybindings/keymapStore"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { compareShapeOrder, topVertexCount, type TerrainEdit } from "@/core/scene/terrainShapes"
import type { Id, TerrainShape, TerrainShapeOp } from "@/core/scene/types"

import { useEditorActions, useEditorContext, useEditorShallow, useEditorState } from "../context"
import { FieldRow, Hint, NumberInput, PanelSection, Segmented, TextInput, type Option } from "../fields"
import { trimNumber } from "../lib/format"
import {
  alsoAppliedShapes,
  applyInspectorTerrainEdit,
  MIN_SHAPE_SAMPLES,
  offsetShapeTop,
  reorderShapes,
  shapeSampleCount,
  shapeTopStats,
  SHAPE_KIND_LABELS,
} from "../lib/terrainInspect"
import { activeLevelShapes, activeTerrainSelection, editedTerrainElements, selectedShapes } from "../lib/terrainMode"

const OP_OPTIONS: Option<TerrainShapeOp>[] = [
  { value: "add", label: "Add", tooltip: "Raises the terrain up to the shape's top" },
  { value: "carve", label: "Carve", tooltip: "Cuts the terrain down to the shape's top" },
]

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const shapeTitle = (s: TerrainShape) => s.name?.trim() || SHAPE_KIND_LABELS[s.kind]

/**
 * Terrain edits from the Inspector. A refusal the store already reported (validateEdit → the page's
 * "Can't …" toast) is not repeated, an edit that changes nothing is silent, and one the terrain writer
 * refused (invalid shape) gets its own toast.
 */
function useTerrainEdit(levelId: Id) {
  const { store } = useEditorContext()
  return React.useCallback(
    (edit: TerrainEdit, label: string, coalesceKey?: string) => {
      const { ok, refused } = applyInspectorTerrainEdit(store, levelId, edit, label, coalesceKey)
      if (refused)
        toast.error(`Can't ${label.charAt(0).toLowerCase()}${label.slice(1)}`, {
          id: "edit-rejected",
          description: "The shape would not be valid (heights stay within ±500 ft).",
        })
      return ok
    },
    [store, levelId]
  )
}

const names = (shapes: readonly TerrainShape[]) =>
  shapes
    .slice(0, 3)
    .map((s) => `“${shapeTitle(s)}”`)
    .join(", ") + (shapes.length > 3 ? ", …" : "")

function ShapeActions({ levelId, ids }: { levelId: Id; ids: Id[] }) {
  const { store } = useEditorContext()
  const readOnly = useEditorState((s) => s.readOnly)
  const level = useEditorState((s) => s.scene.levels[levelId])
  const edit = useTerrainEdit(levelId)
  const n = ids.length
  const it = n === 1 ? "it" : "them"
  // Older shapes under the selection are applied with it, or the terrain would change (applyShapesClosure).
  const also = alsoAppliedShapes(level, ids)
  const apply = () => {
    const s = store.getState()
    const extra = alsoAppliedShapes(s.scene.levels[levelId], ids)
    if (!s.applyTerrainShapes(levelId, ids) || extra.length === 0) return
    const one = extra.length === 1
    toast.success(`Applied ${plural(n + extra.length, "shape")} to terrain`, {
      description: `${one ? names(extra) : plural(extra.length, "older shape")} under the selection ${one ? "was" : "were"} applied too, so the terrain stays the same. Undo brings the shapes back.`,
    })
  }
  return (
    <PanelSection title="Terrain">
      <div className="grid grid-cols-2 gap-1.5">
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="sm" disabled={readOnly} onClick={apply} />}>
            <Stamp data-icon="inline-start" /> Apply to terrain
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            Bakes {n === 1 ? "the shape" : "the shapes"} into the painted ground and deletes {it}, so the brush can sculpt the result.
          </TooltipContent>
        </Tooltip>
        <Button
          variant="destructive"
          size="sm"
          disabled={readOnly}
          onClick={() => edit({ remove: ids }, n === 1 ? "Delete shape" : `Delete ${plural(n, "shape")}`)}
        >
          <Trash2 data-icon="inline-start" /> Delete
        </Button>
      </div>
      {also.length > 0 ? (
        <Hint>
          Apply also bakes {also.length === 1 ? "the older shape" : plural(also.length, "older shape")} under {it} ({names(also)}), so the terrain stays the
          same.
        </Hint>
      ) : null}
    </PanelSection>
  )
}

function ShapeHeader({ title, subtitle, levelId, ids }: { title: React.ReactNode; subtitle: React.ReactNode; levelId: Id; ids: Id[] }) {
  const actions = useEditorActions()
  const readOnly = useEditorState((s) => s.readOnly)
  const edit = useTerrainEdit(levelId)
  return (
    <div className="flex items-start justify-between gap-2 border-b border-border/60 px-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="truncate font-heading text-sm font-medium">{title}</div>
        <div className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground">{subtitle}</div>
      </div>
      <div className="flex shrink-0 items-center">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Focus" onClick={actions.focusSelection} />}>
            <Scan />
          </TooltipTrigger>
          <TooltipContent>Focus the camera on it</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete"
                className="hover:text-destructive"
                disabled={readOnly}
                onClick={() => edit({ remove: ids }, ids.length === 1 ? "Delete shape" : `Delete ${plural(ids.length, "shape")}`)}
              />
            }
          >
            <Trash2 />
          </TooltipTrigger>
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

function OpBadge({ op }: { op: TerrainShapeOp }) {
  return (
    <Badge variant={op === "add" ? "secondary" : "outline"} className="h-4 px-1.5 text-[0.625rem] uppercase">
      {op === "add" ? "Add" : "Carve"}
    </Badge>
  )
}

function SingleShape({ shape, levelId }: { shape: TerrainShape; levelId: Id }) {
  const readOnly = useEditorState((s) => s.readOnly)
  const level = useEditorState((s) => s.scene.levels[levelId])
  const grid = useEditorState((s) => s.scene.grid)
  const all = useEditorState((s) => activeLevelShapes(s))
  const heightStep = useEditorState((s) => s.toolSettings.terrain.heightStep)
  // Only the Select sub-tool edits elements: elsewhere Delete removes the whole shape, so no element hint.
  const elements = useEditorState(editedTerrainElements)
  const element = useEditorState((s) => s.toolSettings.terrain.element)
  const edit = useTerrainEdit(levelId)

  const top = shapeTopStats(shape)
  const samples = level ? shapeSampleCount(shape, level, grid) : null
  const sorted = React.useMemo(() => Object.values(all).sort(compareShapeOrder), [all])
  const rank = sorted.findIndex((s) => s.id === shape.id)
  const reorder = (dir: 1 | -1) => {
    const upsert = reorderShapes(sorted, shape.id, dir)
    if (upsert) edit({ upsert }, dir > 0 ? "Bring shape forward" : "Send shape backward")
  }
  const key = (field: string) => `terrain-shape:${levelId}:${shape.id}:${field}`
  const step = heightStep > 0 ? heightStep : 0.5

  return (
    <>
      <ShapeHeader
        title={shapeTitle(shape)}
        levelId={levelId}
        ids={[shape.id]}
        subtitle={
          <>
            <Badge variant="secondary" className="h-4 px-1.5 text-[0.625rem] uppercase">
              {SHAPE_KIND_LABELS[shape.kind]}
            </Badge>
            <OpBadge op={shape.op} />
            {plural(topVertexCount(shape), "vertex", "vertices")}
            {shape.innerEdges?.length ? ` · ${plural(shape.innerEdges.length, "inner edge")}` : ""}
          </>
        }
      />
      <PanelSection title="Shape">
        <FieldRow label="Name" hint="DM-facing label, never sent to players.">
          <TextInput
            value={shape.name ?? ""}
            placeholder={SHAPE_KIND_LABELS[shape.kind]}
            disabled={readOnly}
            onCommit={(raw) => {
              const name = raw.trim() || undefined
              if (name !== shape.name) edit({ upsert: [{ ...shape, name }] }, "Rename shape")
            }}
          />
        </FieldRow>
        <FieldRow label="Operation">
          <Segmented
            value={shape.op}
            disabled={readOnly}
            options={OP_OPTIONS}
            onValueChange={(op) => edit({ upsert: [{ ...shape, op }] }, op === "add" ? "Make shape add" : "Make shape carve")}
          />
        </FieldRow>
        <FieldRow label="Top" hint="Height of the top above the level's elevation (the average when it slopes). Changing it moves the whole top.">
          <NumberInput
            value={top.mean}
            min={-500}
            max={500}
            step={step}
            unit="ft"
            disabled={readOnly}
            onCommit={(v) => edit({ upsert: [offsetShapeTop(shape, v - top.mean)] }, "Move shape top", key("top"))}
          />
        </FieldRow>
        {top.max - top.min > 1e-6 ? (
          <Hint>
            The top slopes from {trimNumber(top.min, 2)} to {trimNumber(top.max, 2)} ft.
          </Hint>
        ) : null}
        <FieldRow label="Base" hint="Where the shape's sides end in the terrain tool (display only: the terrain is shaped by the top).">
          <NumberInput
            value={shape.base}
            min={-500}
            max={500}
            step={step}
            unit="ft"
            disabled={readOnly}
            onCommit={(base) => edit({ upsert: [{ ...shape, base }] }, "Move shape base", key("base"))}
          />
        </FieldRow>
        <FieldRow label="Order" hint="Shapes are applied in order; a later shape wins where shapes overlap.">
          <span className="min-w-0 flex-1 text-xs text-muted-foreground tabular-nums">
            {rank + 1} of {sorted.length}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="Send backward" disabled={readOnly || rank <= 0} onClick={() => reorder(-1)} />}
            >
              <ArrowDown />
            </TooltipTrigger>
            <TooltipContent>Send backward: applied before the previous shape</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Bring forward"
                  disabled={readOnly || rank < 0 || rank >= sorted.length - 1}
                  onClick={() => reorder(1)}
                />
              }
            >
              <ArrowUp />
            </TooltipTrigger>
            <TooltipContent>Bring forward: applied after the next shape</TooltipContent>
          </Tooltip>
        </FieldRow>
        {samples !== null && samples < MIN_SHAPE_SAMPLES ? (
          <Alert>
            <TriangleAlert />
            <AlertTitle>Too small for the terrain resolution</AlertTitle>
            <AlertDescription>
              It covers {plural(samples, "height sample")}, so it barely shows in the terrain. Enlarge it or raise the level's resolution (Levels panel).
            </AlertDescription>
          </Alert>
        ) : null}
        {elements > 0 ? (
          <Hint>
            {element === "vertex" ? plural(elements, "vertex", "vertices") : plural(elements, element)} selected: drag {elements === 1 ? "it" : "them"} in the
            viewport; Delete{" "}
            {element === "face"
              ? "works on whole shapes (Esc: object mode)"
              : element === "edge"
                ? "collapses edges (removes loop cuts; a side edge removes its corner)"
                : "dissolves vertices"}
            .
          </Hint>
        ) : null}
      </PanelSection>
      <ShapeActions levelId={levelId} ids={[shape.id]} />
    </>
  )
}

function MultiShape({ shapes, levelId }: { shapes: readonly TerrainShape[]; levelId: Id }) {
  const { store } = useEditorContext()
  const readOnly = useEditorState((s) => s.readOnly)
  const edit = useTerrainEdit(levelId)
  const ids = shapes.map((s) => s.id)
  const ops = new Set(shapes.map((s) => s.op))
  const op = ops.size === 1 ? shapes[0].op : null
  const kinds = (["block", "ramp", "cylinder", "polygon"] as const)
    .map((k) => [k, shapes.filter((s) => s.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => plural(n, SHAPE_KIND_LABELS[k].toLowerCase()))
    .join(", ")
  const setOp = (next: TerrainShapeOp) => {
    const upsert = shapes.filter((s) => s.op !== next).map((s) => ({ ...s, op: next }))
    if (upsert.length > 0) edit({ upsert }, next === "add" ? `Make ${plural(upsert.length, "shape")} add` : `Make ${plural(upsert.length, "shape")} carve`)
  }
  return (
    <>
      <ShapeHeader title={`${shapes.length} shapes selected`} subtitle={kinds} levelId={levelId} ids={ids} />
      <PanelSection title="Shapes">
        <FieldRow label="Operation" hint={op ? undefined : "Mixed: some add, some carve"}>
          <Segmented<TerrainShapeOp | "mixed">
            value={op ?? "mixed"}
            disabled={readOnly}
            options={OP_OPTIONS}
            onValueChange={(v) => v !== "mixed" && setOp(v)}
          />
        </FieldRow>
        <div className="flex flex-col gap-0.5">
          {shapes.slice(0, 50).map((s) => (
            <button
              key={s.id}
              type="button"
              className="flex items-center justify-between rounded-md px-2 py-1 text-left text-xs text-foreground/80 hover:bg-muted"
              onClick={() => store.getState().setTerrainSelection({ levelId, shapeIds: [s.id], elements: [] })}
            >
              <span className="truncate">{shapeTitle(s)}</span>
              <span className="text-[0.625rem] text-muted-foreground">{s.op === "add" ? "Add" : "Carve"}</span>
            </button>
          ))}
          {shapes.length > 50 ? <Hint className="px-2">…and {shapes.length - 50} more</Hint> : null}
        </div>
      </PanelSection>
      <ShapeActions levelId={levelId} ids={ids} />
    </>
  )
}

function NoShapeSelected() {
  const count = useEditorState((s) => Object.keys(activeLevelShapes(s)).length)
  const selecting = useEditorState((s) => s.toolSettings.terrain.sub === "select")
  const selectKey = useCommandLabel("editor", "terrain.select")
  const createKey = useCommandLabel("editor", "terrain.create")
  return (
    <Empty className="mt-6 gap-3 p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">{count > 0 ? <Layers2 /> : <Mountain />}</EmptyMedia>
        <EmptyTitle>No shape selected</EmptyTitle>
        <EmptyDescription>
          {count > 0
            ? selecting
              ? `This level has ${plural(count, "terrain shape")}. Click one to edit it, or drag a box around several.`
              : `This level has ${plural(count, "terrain shape")}. Pick “Select shapes”${selectKey ? ` (${selectKey})` : ""} in the options bar and click one to edit it.`
            : `Draw a block, ramp, cylinder or polygon${createKey ? ` (${createKey})` : ""}: drag its base (polygon: click its corners), then click at the height. Shapes stay editable while the terrain tool is active.`}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** Inspector body while the terrain tool is active. */
export function TerrainInspector() {
  const levelId = useEditorState((s) => activeTerrainSelection(s)?.levelId ?? null)
  const shapes = useEditorShallow((s) => selectedShapes(s))
  if (!levelId || shapes.length === 0) return <NoShapeSelected />
  if (shapes.length === 1) return <SingleShape key={shapes[0].id} shape={shapes[0]} levelId={levelId} />
  return <MultiShape shapes={shapes} levelId={levelId} />
}
