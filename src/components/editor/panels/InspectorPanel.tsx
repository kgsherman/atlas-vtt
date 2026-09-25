import * as React from "react"
import { Copy, EyeOff, Lock, LockOpen, MousePointerClick, RotateCw, Scan, Trash2, TriangleAlert, UserRoundPlus, UsersRound } from "lucide-react"

import { CommandKbd } from "@/components/keybindings/CommandKbd"
import { useCommandLabel } from "@/components/keybindings/keymapStore"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DOOR_STYLES, LIGHT_PRESETS, PROP_LIBRARY, SIZE_BODY, SIZE_FOOTPRINT } from "@/core/scene/defaults"
import { sortedLevels, wallLength, wallOpenings } from "@/core/scene/queries"
import type {
  ConnectorObject,
  CreatureSize,
  DoorObject,
  DoorStyle,
  FloorObject,
  Id,
  LightObject,
  LightPreset,
  PillarObject,
  PropObject,
  SceneObject,
  Token,
  TokenKind,
  Vec2,
  WallObject,
  WindowObject,
} from "@/core/scene/types"
import type { ObjectUpdate, TokenUpdate } from "@/editor/store"
import { normalizeAngle } from "@/editor/transform"

import { tokenModelAsset, tokenModelChoices, useFreeAssets } from "@/app/freeAssets"
import { ConditionChips, ConditionMenu } from "@/components/play/table/health"
import { freeTokenModelRef } from "@/core/scene/tokenModel"
import { HP_LIMITS, withMaxHp, type TokenHp, type TokenStatusChange } from "@/core/scene/tokenStatus"

import { FreeAssetScopeContext, useCharacterLinks, useEditorActions, useEditorContext, useEditorShallow, useEditorState } from "../context"
import { ColorInput, FieldPair, FieldRow, Hint, NotesInput, NumberInput, PanelSection, Segmented, SelectInput, SliderInput, SwitchField, TextInput, type Option } from "../fields"
import { degrees, formatFeet, itemLabel, LIGHT_PRESET_LABELS, objectKindLabel, OBJECT_TYPE_LABELS, radians, selectionSummary, tokenLabel, trimNumber } from "../lib/format"
import { wallTerrainWarning } from "../lib/terrainInspect"
import { DirectionPicker, MaterialSelect, PropPicker } from "../pickers"
import { TerrainInspector } from "./TerrainInspector"

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function useUpdateObject(id: Id) {
  const { store } = useEditorContext()
  return React.useCallback((partial: ObjectUpdate) => store.getState().updateObject(id, partial), [store, id])
}

function useUpdateToken(id: Id) {
  const { store } = useEditorContext()
  return React.useCallback((partial: TokenUpdate) => store.getState().updateToken(id, partial), [store, id])
}

function PointField({ label, value, onCommit, disabled }: { label: string; value: Vec2; onCommit(p: Vec2): void; disabled?: boolean }) {
  return (
    <FieldRow label={label}>
      <FieldPair>
        <NumberInput prefix="X" value={value.x} step={0.5} unit="ft" disabled={disabled} onCommit={(x) => onCommit({ x, z: value.z })} aria-label={`${label} X`} />
        <NumberInput prefix="Z" value={value.z} step={0.5} unit="ft" disabled={disabled} onCommit={(z) => onCommit({ x: value.x, z })} aria-label={`${label} Z`} />
      </FieldPair>
    </FieldRow>
  )
}

function Header({ title, subtitle, id }: { title: React.ReactNode; subtitle: React.ReactNode; id: Id }) {
  const { store } = useEditorContext()
  const actions = useEditorActions()
  const readOnly = useEditorState((s) => s.readOnly)
  return (
    <div className="flex items-start justify-between gap-2 border-b border-border/60 px-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="truncate font-heading text-sm font-medium">{title}</div>
        <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">{subtitle}</div>
      </div>
      <div className="flex shrink-0 items-center">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Focus" onClick={actions.focusSelection} />}>
            <Scan />
          </TooltipTrigger>
          <TooltipContent>Focus the camera on it</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Duplicate" disabled={readOnly} onClick={() => store.getState().duplicateSelection()} />}>
            <Copy />
          </TooltipTrigger>
          <TooltipContent>
            Duplicate <CommandKbd scope="editor" command="duplicate" />
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Delete" className="hover:text-destructive" disabled={readOnly} onClick={() => store.getState().deleteIds([id])} />}
          >
            <Trash2 />
          </TooltipTrigger>
          <TooltipContent>Delete (Del)</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

function CommonObjectFields({ o }: { o: SceneObject }) {
  const update = useUpdateObject(o.id)
  const readOnly = useEditorState((s) => s.readOnly)
  return (
    <PanelSection title="Visibility & notes">
      {o.type !== "light" || !o.attachedTokenId ? (
        <SwitchField
          label="Hidden from players"
          description="Never sent to players; still blocks sight and movement on the host."
          checked={o.hidden ?? false}
          disabled={readOnly}
          onCheckedChange={(hidden) => update({ hidden })}
        />
      ) : (
        <Hint>Carried lights are hidden together with their token.</Hint>
      )}
      <SwitchField label="Lock in editor" description="Can't be selected or moved on the canvas." checked={o.editorLocked ?? false} disabled={readOnly} onCheckedChange={(editorLocked) => update({ editorLocked })} />
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">DM notes</span>
        <NotesInput value={o.dmNotes ?? ""} placeholder="Only you can see these notes." onCommit={(dmNotes) => update({ dmNotes })} />
      </div>
    </PanelSection>
  )
}

function NameField({ o }: { o: SceneObject }) {
  const update = useUpdateObject(o.id)
  const readOnly = useEditorState((s) => s.readOnly)
  return (
    <FieldRow label="Name" hint="DM-facing label, never sent to players.">
      <TextInput value={o.name ?? ""} placeholder={objectKindLabel(o)} disabled={readOnly} onCommit={(name) => update({ name: name.trim() || undefined })} />
    </FieldRow>
  )
}

// ---------------------------------------------------------------------------
// Per type
// ---------------------------------------------------------------------------

function FloorFields({ o }: { o: FloorObject }) {
  const update = useUpdateObject(o.id)
  const readOnly = useEditorState((s) => s.readOnly)
  const levelThickness = useEditorState((s) => s.scene.levels[o.levelId]?.floorThickness ?? 1)
  const r = o.rect
  return (
    <PanelSection title="Floor">
      <NameField o={o} />
      <FieldRow label="Material">
        <MaterialSelect value={o.material} onValueChange={(material) => update({ material })} />
      </FieldRow>
      <FieldRow label="Thickness" hint="Overrides the level's floor thickness.">
        <NumberInput value={o.thickness ?? null} placeholder={`Level (${trimNumber(levelThickness)} ft)`} min={0.1} max={100} step={0.25} unit="ft" disabled={readOnly} onCommit={(thickness) => update({ thickness })} />
        {o.thickness !== undefined ? (
          <Button variant="ghost" size="xs" disabled={readOnly} onClick={() => update({ thickness: undefined })}>
            Reset
          </Button>
        ) : null}
      </FieldRow>
      {o.mask ? (
        <Hint>
          Traced from an image: {o.mask.cols}×{o.mask.rows} mask cells of {trimNumber(o.mask.spacing)} ft, bounds {trimNumber(r.w)}×{trimNumber(r.d)} ft.
        </Hint>
      ) : (
        <>
          <PointField label="Corner" value={{ x: r.x, z: r.z }} disabled={readOnly} onCommit={(p) => update({ rect: { ...r, x: p.x, z: p.z } })} />
          <FieldRow label="Size">
            <FieldPair>
              <NumberInput prefix="W" value={r.w} min={0.5} step={0.5} unit="ft" disabled={readOnly} onCommit={(w) => update({ rect: { ...r, w } })} aria-label="Width" />
              <NumberInput prefix="D" value={r.d} min={0.5} step={0.5} unit="ft" disabled={readOnly} onCommit={(d) => update({ rect: { ...r, d } })} aria-label="Depth" />
            </FieldPair>
          </FieldRow>
        </>
      )}
    </PanelSection>
  )
}

/** The wall's problems on terrain (DESIGN §3.6), recomputed when the wall or the levels change. */
function WallTerrainWarning({ o }: { o: WallObject }) {
  const levels = useEditorState((s) => s.scene.levels)
  const grid = useEditorState((s) => s.scene.grid)
  const warning = React.useMemo(() => wallTerrainWarning({ levels, grid }, o), [levels, grid, o])
  if (!warning) return null
  return (
    <Alert>
      <TriangleAlert />
      <AlertDescription>
        {warning.kind === "buried"
          ? warning.whole
            ? `Buried where the terrain is higher: the ground rises ${formatFeet(warning.depth, 1)} above its base, over its full height. Turn on Follow terrain to stand it on the ground.`
            : `Buried where the terrain is higher: the ground rises up to ${formatFeet(warning.depth, 1)} above its base. Turn on Follow terrain to stand it on the ground.`
          : `Pokes through the level above (“${warning.above}”) by up to ${formatFeet(warning.by, 1)} where the terrain is high. Lower the wall or the terrain under it.`}
      </AlertDescription>
    </Alert>
  )
}

function WallFields({ o }: { o: WallObject }) {
  const update = useUpdateObject(o.id)
  const { store } = useEditorContext()
  const readOnly = useEditorState((s) => s.readOnly)
  const openings = useEditorShallow((s) => wallOpenings(s.scene, o.id))
  return (
    <PanelSection title="Wall">
      <NameField o={o} />
      <FieldRow label="Height">
        <NumberInput value={o.height} min={0.1} max={1000} step={0.5} unit="ft" disabled={readOnly} onCommit={(height) => update({ height })} />
      </FieldRow>
      <FieldRow label="Thickness">
        <NumberInput value={o.thickness} min={0.05} max={100} step={0.25} unit="ft" disabled={readOnly} onCommit={(thickness) => update({ thickness })} />
      </FieldRow>
      <FieldRow label="Material">
        <MaterialSelect value={o.material} onValueChange={(material) => update({ material })} />
      </FieldRow>
      <SwitchField
        label="Follow terrain"
        description="The base sits on the terrain along the wall; off: it stands at the level's elevation."
        checked={o.followTerrain}
        disabled={readOnly}
        onCheckedChange={(followTerrain) => update({ followTerrain })}
      />
      <WallTerrainWarning o={o} />
      <PointField label="Start" value={o.a} disabled={readOnly} onCommit={(a) => update({ a })} />
      <PointField label="End" value={o.b} disabled={readOnly} onCommit={(b) => update({ b })} />
      <Hint>Length {formatFeet(wallLength(o), 2)}</Hint>
      {openings.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {openings.map((op) => (
            <Button key={op.id} variant="outline" size="xs" onClick={() => store.getState().select([op.id])}>
              {op.type === "door" ? DOOR_STYLES[op.style].label : "Window"} · {formatFeet(op.offset)}
            </Button>
          ))}
        </div>
      ) : null}
    </PanelSection>
  )
}

const DOOR_STYLE_OPTIONS: Option<DoorStyle>[] = (Object.keys(DOOR_STYLES) as DoorStyle[]).map((k) => ({ value: k, label: DOOR_STYLES[k].label }))

function DoorFields({ o }: { o: DoorObject }) {
  const update = useUpdateObject(o.id)
  const { store } = useEditorContext()
  const readOnly = useEditorState((s) => s.readOnly)
  return (
    <PanelSection title="Door">
      <NameField o={o} />
      <FieldRow label="State" hint="Initial state for sessions. Locked doors can only be unlocked by the DM.">
        <Segmented
          value={o.state}
          disabled={readOnly}
          onValueChange={(state) => store.getState().setDoorState(o.id, state)}
          options={[
            { value: "closed", label: "Closed" },
            { value: "open", label: "Open" },
            { value: "locked", label: "Locked" },
          ]}
        />
      </FieldRow>
      <FieldRow label="Style">
        <SelectInput value={o.style} options={DOOR_STYLE_OPTIONS} disabled={readOnly} onValueChange={(style) => update({ style })} />
      </FieldRow>
      {o.style === "secret" ? <Hint>Players only see a secret door once it is revealed or seen open.</Hint> : null}
      <FieldRow label="Leaves">
        <Segmented
          value={o.leaves}
          disabled={readOnly}
          onValueChange={(leaves) => update({ leaves })}
          options={[
            { value: "single", label: "Single" },
            { value: "double", label: "Double" },
          ]}
        />
      </FieldRow>
      <FieldRow label="Hinge">
        <Segmented
          value={o.hinge}
          disabled={readOnly}
          onValueChange={(hinge) => update({ hinge })}
          options={[
            { value: "start", label: "Start" },
            { value: "end", label: "End" },
          ]}
        />
      </FieldRow>
      <FieldRow label="Swings">
        <Segmented
          value={o.swing === 1 ? "left" : "right"}
          disabled={readOnly}
          onValueChange={(v) => update({ swing: v === "left" ? 1 : -1 })}
          options={[
            { value: "left", label: "Left" },
            { value: "right", label: "Right" },
          ]}
        />
      </FieldRow>
      <FieldRow label="Width">
        <NumberInput value={o.width} min={0.5} max={100} step={0.5} unit="ft" disabled={readOnly} onCommit={(width) => update({ width })} />
      </FieldRow>
      <FieldRow label="Height">
        <NumberInput value={o.height} min={0.5} max={100} step={0.5} unit="ft" disabled={readOnly} onCommit={(height) => update({ height })} />
      </FieldRow>
      <FieldRow label="Offset" hint="Centre of the opening along its wall, from the wall's start.">
        <NumberInput value={o.offset} min={0} step={0.5} unit="ft" disabled={readOnly} onCommit={(offset) => update({ offset })} />
      </FieldRow>
      <Button variant="ghost" size="xs" className="self-start" onClick={() => store.getState().select([o.wallId])}>
        Select host wall
      </Button>
    </PanelSection>
  )
}

function WindowFields({ o }: { o: WindowObject }) {
  const update = useUpdateObject(o.id)
  const { store } = useEditorContext()
  const readOnly = useEditorState((s) => s.readOnly)
  return (
    <PanelSection title="Window">
      <NameField o={o} />
      <FieldRow label="Width">
        <NumberInput value={o.width} min={0.5} max={100} step={0.5} unit="ft" disabled={readOnly} onCommit={(width) => update({ width })} />
      </FieldRow>
      <FieldRow label="Height">
        <NumberInput value={o.height} min={0.25} max={100} step={0.5} unit="ft" disabled={readOnly} onCommit={(height) => update({ height })} />
      </FieldRow>
      <FieldRow label="Sill height">
        <NumberInput value={o.sillHeight} min={0} max={100} step={0.5} unit="ft" disabled={readOnly} onCommit={(sillHeight) => update({ sillHeight })} />
      </FieldRow>
      <FieldRow label="Offset" hint="Centre of the opening along its wall, from the wall's start.">
        <NumberInput value={o.offset} min={0} step={0.5} unit="ft" disabled={readOnly} onCommit={(offset) => update({ offset })} />
      </FieldRow>
      <Hint>Windows block movement; players see through them between sill and lintel.</Hint>
      <Button variant="ghost" size="xs" className="self-start" onClick={() => store.getState().select([o.wallId])}>
        Select host wall
      </Button>
    </PanelSection>
  )
}

function ConnectorFields({ o }: { o: ConnectorObject }) {
  const update = useUpdateObject(o.id)
  const readOnly = useEditorState((s) => s.readOnly)
  const cellSize = useEditorState((s) => s.scene.grid.cellSize)
  const levels = useEditorState((s) => s.scene.levels)
  const from = levels[o.levelId]
  const above: Option<string>[] = sortedLevels({ levels })
    .filter((l) => from && l.elevation > from.elevation)
    .map((l) => ({ value: l.id, label: `${l.name} (${trimNumber(l.elevation - from.elevation)} ft up)` }))
  return (
    <PanelSection title="Connector">
      <NameField o={o} />
      <FieldRow label="Type">
        <Segmented
          value={o.style}
          disabled={readOnly}
          onValueChange={(style) => update({ style })}
          options={[
            { value: "stairs", label: "Stairs" },
            { value: "ladder", label: "Ladder" },
            { value: "ramp", label: "Ramp" },
          ]}
        />
      </FieldRow>
      {o.style !== "ladder" ? (
        <FieldRow label="Climbs">
          <DirectionPicker value={o.direction} onValueChange={(d) => d !== "auto" && update({ direction: d })} />
        </FieldRow>
      ) : null}
      <FieldRow label="Leads to">
        <SelectInput value={o.toLevelId} options={above} disabled={readOnly || above.length === 0} onValueChange={(toLevelId) => update({ toLevelId })} />
      </FieldRow>
      <FieldRow label="Material">
        <MaterialSelect value={o.material} onValueChange={(material) => update({ material })} />
      </FieldRow>
      <Hint>
        {trimNumber(o.rect.w / cellSize)}×{trimNumber(o.rect.d / cellSize)} cells at ({trimNumber(o.rect.x)}, {trimNumber(o.rect.z)}) ft. Its footprint is cut out of the floors it rises through.
      </Hint>
    </PanelSection>
  )
}

function PillarFields({ o }: { o: PillarObject }) {
  const update = useUpdateObject(o.id)
  const readOnly = useEditorState((s) => s.readOnly)
  return (
    <PanelSection title="Pillar">
      <NameField o={o} />
      <FieldRow label="Shape">
        <Segmented
          value={o.shape}
          disabled={readOnly}
          onValueChange={(shape) => update({ shape })}
          options={[
            { value: "round", label: "Round" },
            { value: "square", label: "Square" },
          ]}
        />
      </FieldRow>
      <FieldRow label="Size">
        <NumberInput value={o.size} min={0.1} max={100} step={0.25} unit="ft" disabled={readOnly} onCommit={(size) => update({ size })} />
      </FieldRow>
      <SwitchField label="Full storey height" checked={o.height === null} disabled={readOnly} onCheckedChange={(full) => update({ height: full ? null : 8 })} />
      {o.height !== null ? (
        <FieldRow label="Height">
          <NumberInput value={o.height} min={0.1} max={1000} step={0.5} unit="ft" disabled={readOnly} onCommit={(height) => update({ height })} />
        </FieldRow>
      ) : null}
      <FieldRow label="Material">
        <MaterialSelect value={o.material} onValueChange={(material) => update({ material })} />
      </FieldRow>
      <PointField label="Position" value={o.position} disabled={readOnly} onCommit={(position) => update({ position })} />
    </PanelSection>
  )
}

function PropFields({ o }: { o: PropObject }) {
  const update = useUpdateObject(o.id)
  const readOnly = useEditorState((s) => s.readOnly)
  const rot = ((degrees(o.rotationY) % 360) + 360) % 360
  return (
    <PanelSection title="Prop">
      <NameField o={o} />
      <FieldRow label="Kind">
        <PropPicker className="w-full" value={o.kind} onValueChange={(kind) => update({ kind })} />
      </FieldRow>
      <FieldRow label="Rotation">
        <NumberInput value={Number(rot.toFixed(1))} min={-360} max={720} step={15} unit="°" disabled={readOnly} onCommit={(deg) => update({ rotationY: normalizeAngle(radians(deg)) })} />
        <Button variant="ghost" size="icon-sm" aria-label="Rotate 90°" disabled={readOnly} onClick={() => update({ rotationY: normalizeAngle(o.rotationY + Math.PI / 2) })}>
          <RotateCw />
        </Button>
      </FieldRow>
      <FieldRow label="Scale">
        <div className="grid min-w-0 flex-1 grid-cols-3 gap-1">
          {(["x", "y", "z"] as const).map((axis) => (
            <NumberInput key={axis} prefix={axis.toUpperCase()} value={o.scale[axis]} min={0.05} max={100} step={0.1} disabled={readOnly} onCommit={(v) => update({ scale: { ...o.scale, [axis]: v } })} aria-label={`Scale ${axis}`} />
          ))}
        </div>
      </FieldRow>
      <FieldRow label="Raised by" hint="Height above the ground (e.g. a crate on a table).">
        <NumberInput value={o.position.y} min={-100} max={1000} step={0.5} unit="ft" disabled={readOnly} onCommit={(y) => update({ position: { ...o.position, y } })} />
      </FieldRow>
      <FieldRow label="Colour">
        <ColorInput className="flex-1" value={o.color ?? PROP_LIBRARY[o.kind].defaultColor} disabled={readOnly} onChange={(color) => update({ color })} />
        {o.color ? (
          <Button variant="ghost" size="xs" disabled={readOnly} onClick={() => update({ color: null })}>
            Default
          </Button>
        ) : null}
      </FieldRow>
      <PointField label="Position" value={{ x: o.position.x, z: o.position.z }} disabled={readOnly} onCommit={(p) => update({ position: { ...o.position, x: p.x, z: p.z } })} />
      <Separator className="my-1" />
      <SwitchField label="Blocks movement" checked={o.blocksMovement} disabled={readOnly} onCheckedChange={(blocksMovement) => update({ blocksMovement })} />
      <SwitchField label="Blocks sight" checked={o.blocksSight} disabled={readOnly} onCheckedChange={(blocksSight) => update({ blocksSight })} />
      <SwitchField label="Casts shadows" checked={o.castsShadows} disabled={readOnly} onCheckedChange={(castsShadows) => update({ castsShadows })} />
    </PanelSection>
  )
}

const PRESET_OPTIONS: Option<LightPreset>[] = (Object.keys(LIGHT_PRESETS) as LightPreset[]).map((k) => ({ value: k, label: LIGHT_PRESET_LABELS[k] }))

function LightFields({ o }: { o: LightObject }) {
  const update = useUpdateObject(o.id)
  const { store } = useEditorContext()
  const readOnly = useEditorState((s) => s.readOnly)
  const tokens = useEditorState((s) => s.scene.tokens)
  const carriers: Option<string>[] = [{ value: "none", label: "Nobody (fixed)" }, ...Object.values(tokens).map((t) => ({ value: t.id, label: tokenLabel(t) }))]
  const applyPreset = (preset: LightPreset) => {
    const def = LIGHT_PRESETS[preset]
    update({ preset, color: def.color, intensity: def.intensity, brightRadius: def.brightRadius, dimRadius: def.dimRadius, flicker: { ...def.flicker } })
  }
  return (
    <PanelSection title="Light">
      <NameField o={o} />
      <SwitchField label="On" description="Initial state for sessions." checked={o.on} disabled={readOnly} onCheckedChange={(on) => store.getState().setLightOn(o.id, on)} />
      <FieldRow label="Preset">
        <SelectInput value={o.preset} options={PRESET_OPTIONS} disabled={readOnly} onValueChange={applyPreset} />
      </FieldRow>
      <FieldRow label="Colour">
        <ColorInput className="flex-1" value={o.color} disabled={readOnly} onChange={(color) => update({ color, preset: "custom" })} />
      </FieldRow>
      <FieldRow label="Intensity">
        <SliderInput value={o.intensity} min={0} max={5} step={0.05} disabled={readOnly} onChange={(intensity) => update({ intensity })} />
      </FieldRow>
      <FieldRow label="Bright radius">
        <NumberInput value={o.brightRadius} min={0} max={1000} step={5} unit="ft" disabled={readOnly} onCommit={(brightRadius) => update({ brightRadius, dimRadius: Math.max(o.dimRadius, brightRadius) })} />
      </FieldRow>
      <FieldRow label="Dim radius">
        <NumberInput value={o.dimRadius} min={0} max={1000} step={5} unit="ft" disabled={readOnly} onCommit={(dimRadius) => update({ dimRadius: Math.max(dimRadius, o.brightRadius) })} />
      </FieldRow>
      <FieldRow label="Height" hint={o.attachedTokenId ? "Height above the carrier's ground." : "Height above the ground. Below it, the light would sit inside the floor (it then shines from just above it)."}>
        {/* A free-standing light below its ground is inside the floor slab: not offered. */}
        <NumberInput value={o.position.y} min={o.attachedTokenId ? -100 : 0} max={1000} step={0.5} unit="ft" disabled={readOnly} onCommit={(y) => update({ position: { ...o.position, y } })} />
      </FieldRow>
      <SwitchField label="Casts shadows" description="Off: the light shines through walls (for vision too)." checked={o.castsShadows} disabled={readOnly} onCheckedChange={(castsShadows) => update({ castsShadows })} />
      <Separator className="my-1" />
      <SwitchField label="Flicker" checked={o.flicker.enabled} disabled={readOnly} onCheckedChange={(enabled) => update({ flicker: { ...o.flicker, enabled } })} />
      {o.flicker.enabled ? (
        <>
          <FieldRow label="Speed">
            <SliderInput value={o.flicker.speed} min={0.1} max={20} step={0.1} disabled={readOnly} onChange={(speed) => update({ flicker: { ...o.flicker, speed } })} />
          </FieldRow>
          <FieldRow label="Amount">
            <SliderInput value={o.flicker.amount} min={0} max={1} step={0.01} disabled={readOnly} format={(v) => `${Math.round(v * 100)}%`} onChange={(amount) => update({ flicker: { ...o.flicker, amount } })} />
          </FieldRow>
        </>
      ) : null}
      <Separator className="my-1" />
      <FieldRow label="Carried by" hint="A carried light follows its token between levels.">
        <SelectInput value={o.attachedTokenId ?? "none"} options={carriers} disabled={readOnly} onValueChange={(v) => update({ attachedTokenId: v === "none" ? null : v })} />
      </FieldRow>
      {!o.attachedTokenId ? <PointField label="Position" value={{ x: o.position.x, z: o.position.z }} disabled={readOnly} onCommit={(p) => update({ position: { ...o.position, x: p.x, z: p.z } })} /> : null}
    </PanelSection>
  )
}

const SIZE_OPTIONS: Option<CreatureSize>[] = (["tiny", "small", "medium", "large", "huge", "gargantuan"] as CreatureSize[]).map((k) => ({
  value: k,
  label: `${k[0].toUpperCase()}${k.slice(1)} (${SIZE_FOOTPRINT[k] < 1 ? "½" : SIZE_FOOTPRINT[k]} cell${SIZE_FOOTPRINT[k] > 1 ? "s" : ""})`,
}))

function TokenFields({ t }: { t: Token }) {
  const update = useUpdateToken(t.id)
  const readOnly = useEditorState((s) => s.readOnly)
  const levels = useEditorState((s) => s.scene.levels)
  const levelOptions: Option<string>[] = sortedLevels({ levels })
    .reverse()
    .map((l) => ({ value: l.id, label: l.name }))
  const changeSize = (size: CreatureSize) => {
    const before = SIZE_BODY[t.size]
    const after = SIZE_BODY[size]
    const partial: TokenUpdate = { size }
    // Follow the size's typical body/eye height unless the DM customised them.
    if (Math.abs(t.height - before.height) < 1e-6) partial.height = after.height
    if (Math.abs(t.eyeHeight - before.eyeHeight) < 1e-6) partial.eyeHeight = after.eyeHeight
    update(partial)
  }
  const v = t.vision
  return (
    <>
      <PanelSection title="Token">
        <TokenCharacterField t={t} readOnly={readOnly} />
        <FieldRow label="Name" hint="Seen by the DM and by players who control or share vision with this token.">
          <TextInput value={t.name} disabled={readOnly} onCommit={(name) => update({ name: name.trim() || t.name })} />
        </FieldRow>
        <FieldRow label="Nameplate" hint="Public label other players see (empty = none).">
          <TextInput value={t.label ?? ""} placeholder="None" disabled={readOnly} onCommit={(label) => update({ label: label.trim() || null })} />
        </FieldRow>
        <FieldRow label="Kind">
          <Segmented
            value={t.kind}
            disabled={readOnly}
            onValueChange={(kind: TokenKind) => update({ kind })}
            options={[
              { value: "pc", label: "PC" },
              { value: "npc", label: "NPC" },
              { value: "monster", label: "Monster" },
            ]}
          />
        </FieldRow>
        <FieldRow label="Size">
          <SelectInput value={t.size} options={SIZE_OPTIONS} disabled={readOnly} onValueChange={changeSize} />
        </FieldRow>
        <FieldRow label="Colour">
          <ColorInput className="flex-1" value={t.color} disabled={readOnly} onChange={(color) => update({ color })} />
        </FieldRow>
        <TokenModelField t={t} readOnly={readOnly} onChange={(model) => update({ model })} />
        <FieldRow label="Level">
          <SelectInput value={t.levelId} options={levelOptions} disabled={readOnly} onValueChange={(levelId) => update({ levelId })} />
        </FieldRow>
        <PointField label="Position" value={t.position} disabled={readOnly} onCommit={(position) => update({ position })} />
        <FieldRow label="Eye height" hint="Line of sight starts here (clamped below ceilings).">
          <NumberInput value={t.eyeHeight} min={0.1} max={1000} step={0.5} unit="ft" disabled={readOnly} onCommit={(eyeHeight) => update({ eyeHeight })} />
        </FieldRow>
        <FieldRow label="Body height" hint="Used to decide whether others can see it over low walls.">
          <NumberInput value={t.height} min={0.1} max={1000} step={0.5} unit="ft" disabled={readOnly} onCommit={(height) => update({ height })} />
        </FieldRow>
        <FieldRow label="Speed">
          <NumberInput value={t.speed} min={0} max={10000} step={5} unit="ft" disabled={readOnly} onCommit={(speed) => update({ speed })} />
        </FieldRow>
      </PanelSection>
      <TokenHealthFields t={t} readOnly={readOnly} />
      <PanelSection title="Senses">
        <FieldRow label="Darkvision" hint="Sees in darkness (in greyscale) within this range.">
          <NumberInput value={v.darkvision} min={0} max={10000} step={5} unit="ft" disabled={readOnly} onCommit={(darkvision) => update({ vision: { ...v, darkvision } })} />
        </FieldRow>
        <FieldRow label="Blindsight" hint="Perceives surroundings without sight within this range.">
          <NumberInput value={v.blindsight} min={0} max={10000} step={5} unit="ft" disabled={readOnly} onCommit={(blindsight) => update({ vision: { ...v, blindsight } })} />
        </FieldRow>
        <SwitchField label="Blind" description="Sees nothing beyond its blindsight." checked={v.blind} disabled={readOnly} onCheckedChange={(blind) => update({ vision: { ...v, blind } })} />
        <Hint>{describeVision(v)}</Hint>
      </PanelSection>
      <PanelSection title="Visibility & notes">
        <SwitchField label="Hidden from players" description="The token and the lights it carries don't exist for players." checked={t.hidden} disabled={readOnly} onCheckedChange={(hidden) => update({ hidden })} />
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">DM notes</span>
          <NotesInput value={t.dmNotes ?? ""} placeholder="Only you can see these notes." onCommit={(dmNotes) => update({ dmNotes })} />
        </div>
      </PanelSection>
    </>
  )
}

const NO_CHARACTER = "none"

/**
 * The world character the token is (ARCHITECTURE §6.9): whoever plays the character controls it, in every
 * scene of the world. Only at a table that knows its world's roster.
 */
function TokenCharacterField({ t, readOnly }: { t: Token; readOnly: boolean }) {
  const links = useCharacterLinks()
  const update = useUpdateToken(t.id)
  const [making, setMaking] = React.useState(false)
  if (!links) return null
  const linked = t.characterId ? links.characters.find((c) => c.id === t.characterId) : undefined
  const options: Option<string>[] = [
    { value: NO_CHARACTER, label: "None (this scene's token)" },
    ...links.characters.map((c) => ({ value: c.id, label: c.name })),
    ...(t.characterId && !linked ? [{ value: t.characterId, label: "A deleted character", disabled: true }] : []),
  ]
  const players = linked?.players.map(links.playerName) ?? []
  return (
    <>
      <FieldRow label="Character" hint="A character of the world: whoever plays it controls this token, in every scene.">
        <SelectInput
          value={t.characterId ?? NO_CHARACTER}
          options={options}
          disabled={readOnly}
          onValueChange={(id) => (id === NO_CHARACTER ? update({ characterId: undefined }) : update({ characterId: id, kind: "pc" }))}
        />
      </FieldRow>
      <div className="flex flex-wrap items-center gap-1.5">
        {linked ? (
          <Hint className="flex-1">{players.length > 0 ? `Played by ${players.join(", ")}.` : "Nobody plays this character yet."}</Hint>
        ) : t.characterId ? (
          <Hint className="flex-1">Its character was deleted: nobody controls it.</Hint>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly || making}
            onClick={() => {
              setMaking(true)
              void links.makeCharacter(t.id).finally(() => setMaking(false))
            }}
          >
            <UserRoundPlus data-icon="inline-start" /> Make it a character
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={links.openRoster}>
          <UsersRound data-icon="inline-start" /> Who plays whom…
        </Button>
      </div>
    </>
  )
}

/**
 * Hit points (empty max: not tracked) and conditions. During a live session these are play actions
 * (store.changeTokenStatus / setTokenHp): applied by the host to the token as it holds it, with no undo
 * entry, so they never overwrite what players changed meanwhile.
 */
function TokenHealthFields({ t, readOnly }: { t: Token; readOnly: boolean }) {
  const { store } = useEditorContext()
  const hp = t.hp
  const conditions = t.conditions ?? []
  const change = (c: TokenStatusChange) => store.getState().changeTokenStatus(t.id, c)
  const setHp = (next: TokenHp | null) => store.getState().setTokenHp(t.id, next)
  return (
    <PanelSection
      title="Health"
      action={
        hp && !readOnly ? (
          <Button size="xs" variant="ghost" onClick={() => setHp(null)}>
            Stop tracking
          </Button>
        ) : null
      }
    >
      <FieldRow label="Max HP" hint="Hit points at full health. Setting it starts tracking them; Stop tracking removes them.">
        <NumberInput
          value={hp?.max ?? null}
          min={1}
          max={HP_LIMITS.max}
          precision={0}
          placeholder="Not tracked"
          disabled={readOnly}
          onCommit={(max) => (hp ? change({ hp: { kind: "max", max } }) : setHp(withMaxHp(null, max)))}
        />
      </FieldRow>
      {hp ? (
        <FieldRow label="Current / temp" hint="Current hit points, and temporary hit points (spent first).">
          <FieldPair>
            <NumberInput value={hp.current} min={0} max={hp.max} precision={0} disabled={readOnly} onCommit={(current) => change({ hp: { kind: "set", current } })} aria-label="Current hit points" />
            <NumberInput prefix="+" value={hp.temp} min={0} max={HP_LIMITS.max} precision={0} disabled={readOnly} onCommit={(temp) => change({ hp: { kind: "set", temp } })} aria-label="Temporary hit points" />
          </FieldPair>
        </FieldRow>
      ) : null}
      <FieldRow label="Conditions">
        <div className="flex flex-col items-start gap-1.5">
          <ConditionChips conditions={conditions} onRemove={readOnly ? undefined : (c) => change({ conditions: { remove: [c] } })} />
          <ConditionMenu conditions={conditions} disabled={readOnly} onChange={(c) => change({ conditions: c })} />
        </div>
      </FieldRow>
    </PanelSection>
  )
}

const DEFAULT_BODY = "default"

/** Token.model from the free token models (only when there is something to choose or show). */
function TokenModelField({ t, readOnly, onChange }: { t: Token; readOnly: boolean; onChange(model: string | undefined): void }) {
  const catalog = useFreeAssets()
  const scope = React.useContext(FreeAssetScopeContext)
  const choices = tokenModelChoices(catalog.data, scope)
  if (choices.length === 0 && !t.model) return null
  const options: Option<string>[] = [{ value: DEFAULT_BODY, label: "Default body" }]
  for (const a of choices) {
    const ref = freeTokenModelRef(a.id)
    if (ref) options.push({ value: ref, label: a.name })
  }
  // A model the picker does not offer (not loaded in this game, or unknown) still shows as chosen.
  if (t.model && !options.some((o) => o.value === t.model)) options.push({ value: t.model, label: tokenModelAsset(catalog.data, t.model)?.name ?? t.model })
  return (
    <FieldRow label="Model" hint="A 3D figure on the token's base, seen by everyone who sees the token.">
      <SelectInput value={t.model ?? DEFAULT_BODY} options={options} disabled={readOnly} onValueChange={(v) => onChange(v === DEFAULT_BODY ? undefined : v)} />
    </FieldRow>
  )
}

function describeVision(v: Token["vision"]): string {
  const parts: string[] = []
  if (v.blind) parts.push("blind")
  else parts.push(v.darkvision > 0 ? `darkvision ${v.darkvision} ft` : "normal vision")
  if (v.blindsight > 0) parts.push(`blindsight ${v.blindsight} ft`)
  return parts.join(" · ").replace(/^./, (c) => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// Selection states
// ---------------------------------------------------------------------------

function SingleInspector({ id }: { id: Id }) {
  const item = useEditorState((s) => (Object.hasOwn(s.scene.objects, id) ? s.scene.objects[id] : Object.hasOwn(s.scene.tokens, id) ? s.scene.tokens[id] : null))
  const levelName = useEditorState((s) => {
    const levelId = item ? ("type" in item ? item.levelId : item.levelId) : null
    return levelId && Object.hasOwn(s.scene.levels, levelId) ? s.scene.levels[levelId].name : null
  })
  if (!item) return null
  if (!("type" in item)) {
    return (
      <>
        <Header
          id={id}
          title={tokenLabel(item)}
          subtitle={
            <>
              <Badge variant="secondary" className="h-4 px-1.5 text-[0.625rem] uppercase">
                {item.kind}
              </Badge>
              {levelName}
              {item.hidden ? <EyeOff className="size-3" aria-label="Hidden" /> : null}
            </>
          }
        />
        <TokenFields t={item} />
      </>
    )
  }
  const o = item
  let body: React.ReactNode
  switch (o.type) {
    case "floor":
      body = <FloorFields o={o} />
      break
    case "wall":
      body = <WallFields o={o} />
      break
    case "door":
      body = <DoorFields o={o} />
      break
    case "window":
      body = <WindowFields o={o} />
      break
    case "connector":
      body = <ConnectorFields o={o} />
      break
    case "pillar":
      body = <PillarFields o={o} />
      break
    case "prop":
      body = <PropFields o={o} />
      break
    case "light":
      body = <LightFields o={o} />
      break
  }
  return (
    <>
      <Header
        id={id}
        title={o.name?.trim() || objectKindLabel(o)}
        subtitle={
          <>
            <Badge variant="secondary" className="h-4 px-1.5 text-[0.625rem] uppercase">
              {OBJECT_TYPE_LABELS[o.type]}
            </Badge>
            {levelName}
            {o.hidden ? <EyeOff className="size-3" aria-label="Hidden" /> : null}
            {o.editorLocked ? <Lock className="size-3" aria-label="Locked" /> : null}
          </>
        }
      />
      {body}
      <CommonObjectFields o={o} />
    </>
  )
}

function MultiInspector({ ids }: { ids: Id[] }) {
  const { store } = useEditorContext()
  const actions = useEditorActions()
  const readOnly = useEditorState((s) => s.readOnly)
  const scene = useEditorState((s) => s.scene)
  const items = ids.map((id) => (Object.hasOwn(scene.objects, id) ? scene.objects[id] : Object.hasOwn(scene.tokens, id) ? scene.tokens[id] : null)).filter((x) => x !== null)
  const lights = items.filter((x): x is LightObject => "type" in x && x.type === "light")
  const doors = items.filter((x): x is DoorObject => "type" in x && x.type === "door")
  const walls = items.filter((x): x is WallObject => "type" in x && x.type === "wall")
  const allFollow = walls.every((w) => w.followTerrain)
  const someFollow = walls.some((w) => w.followTerrain)
  const allHidden = items.every((x) => x.hidden === true)
  const objects = items.filter((x): x is SceneObject => "type" in x)
  const allLocked = objects.length > 0 && objects.every((o) => o.editorLocked === true)
  const n = ids.length

  const setAll = (label: string, fn: (item: SceneObject | Token) => void) =>
    store.getState().apply((d) => {
      for (const id of ids) {
        const it = Object.hasOwn(d.objects, id) ? d.objects[id] : Object.hasOwn(d.tokens, id) ? d.tokens[id] : null
        if (it) fn(it)
      }
    }, label)

  return (
    <>
      <div className="flex flex-col gap-1 border-b border-border/60 px-3 py-3">
        <div className="font-heading text-sm font-medium">{n} items selected</div>
        <div className="text-[0.6875rem] text-muted-foreground">{selectionSummary(scene, ids)}</div>
      </div>
      <PanelSection title="Selection">
        <div className="grid grid-cols-2 gap-1.5">
          <Button variant="outline" size="sm" disabled={readOnly} onClick={() => store.getState().duplicateSelection()}>
            <Copy data-icon="inline-start" /> Duplicate
          </Button>
          <Button variant="outline" size="sm" disabled={readOnly} onClick={() => store.getState().rotateSelection(1)}>
            <RotateCw data-icon="inline-start" /> Rotate 90°
          </Button>
          <Button variant="outline" size="sm" disabled={readOnly} onClick={() => setAll(allHidden ? `Show ${n} items` : `Hide ${n} items`, (it) => void (it.hidden = !allHidden))}>
            <EyeOff data-icon="inline-start" /> {allHidden ? "Show to players" : "Hide from players"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly || objects.length === 0}
            onClick={() => setAll(allLocked ? "Unlock" : "Lock in editor", (it) => void ("type" in it && (it.editorLocked = !allLocked)))}
          >
            {allLocked ? <LockOpen data-icon="inline-start" /> : <Lock data-icon="inline-start" />} {allLocked ? "Unlock" : "Lock"}
          </Button>
          <Button variant="outline" size="sm" onClick={actions.focusSelection}>
            <Scan data-icon="inline-start" /> Focus
          </Button>
          <Button variant="destructive" size="sm" disabled={readOnly} onClick={actions.deleteSelection}>
            <Trash2 data-icon="inline-start" /> Delete
          </Button>
        </div>
      </PanelSection>
      {lights.length > 0 ? (
        <PanelSection title={`${lights.length} light${lights.length === 1 ? "" : "s"}`}>
          <div className="grid grid-cols-2 gap-1.5">
            <Button variant="outline" size="sm" disabled={readOnly} onClick={() => lights.forEach((l) => store.getState().setLightOn(l.id, true))}>
              Turn on
            </Button>
            <Button variant="outline" size="sm" disabled={readOnly} onClick={() => lights.forEach((l) => store.getState().setLightOn(l.id, false))}>
              Turn off
            </Button>
          </div>
        </PanelSection>
      ) : null}
      {doors.length > 0 ? (
        <PanelSection title={`${doors.length} door${doors.length === 1 ? "" : "s"}`}>
          <div className="grid grid-cols-3 gap-1.5">
            {(["closed", "open", "locked"] as const).map((state) => (
              <Button key={state} variant="outline" size="sm" disabled={readOnly} onClick={() => setAll(`Set ${doors.length} doors ${state}`, (it) => void ("type" in it && it.type === "door" && (it.state = state)))}>
                {state[0].toUpperCase() + state.slice(1)}
              </Button>
            ))}
          </div>
        </PanelSection>
      ) : null}
      {walls.length > 0 ? (
        <PanelSection title={`${walls.length} wall${walls.length === 1 ? "" : "s"}`}>
          <SwitchField
            label="Follow terrain"
            description={
              allFollow || !someFollow
                ? "The bases sit on the terrain along the walls; off: at the level's elevation."
                : "Mixed: some follow the terrain. Switch on to make them all follow it."
            }
            checked={allFollow}
            disabled={readOnly}
            onCheckedChange={(on) =>
              setAll(
                on ? `Walls follow the terrain` : `Walls stand at the level elevation`,
                (it) => void ("type" in it && it.type === "wall" && (it.followTerrain = on))
              )
            }
          />
        </PanelSection>
      ) : null}
      <PanelSection title="Items">
        <div className="flex flex-col gap-0.5">
          {ids.slice(0, 50).map((id) => (
            <button key={id} type="button" className="flex items-center justify-between rounded-md px-2 py-1 text-left text-xs text-foreground/80 hover:bg-muted" onClick={() => store.getState().select([id])}>
              <span className="truncate">{itemLabel(scene, id)}</span>
              <span className="text-[0.625rem] text-muted-foreground">{Object.hasOwn(scene.tokens, id) ? "Token" : OBJECT_TYPE_LABELS[scene.objects[id]?.type ?? "floor"]}</span>
            </button>
          ))}
          {ids.length > 50 ? <Hint className="px-2">…and {ids.length - 50} more</Hint> : null}
        </div>
      </PanelSection>
    </>
  )
}

export function InspectorPanel() {
  const selection = useEditorState((s) => s.selection)
  const tool = useEditorState((s) => s.tool)
  const selectKey = useCommandLabel("editor", "tool.select")
  // Terrain mode: the terrain tool's shapes are the selection; objects stay hidden (and uneditable) here.
  if (tool === "terrain") return <TerrainInspector />
  if (selection.length === 0) {
    return (
      <Empty className="mt-6 gap-3 p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MousePointerClick />
          </EmptyMedia>
          <EmptyTitle>Nothing selected</EmptyTitle>
          <EmptyDescription>
            {tool === "select" ? "Click an object or token to edit it. Drag on empty ground to box-select; Shift-click adds to the selection." : `Switch to the Select tool${selectKey ? ` (${selectKey})` : ""} and click something to edit its properties.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (selection.length > 1) return <MultiInspector ids={selection} />
  return <SingleInspector key={selection[0]} id={selection[0]} />
}
