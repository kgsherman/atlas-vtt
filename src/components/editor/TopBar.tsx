import * as React from "react"
import { CircleDot, Cloud, Eye, HardDrive, Pencil, Play, Redo2, Share2, Undo2 } from "lucide-react"

import { AppLogoMark } from "@/components/app/AppLogo"
import { CommandKbd } from "@/components/keybindings/CommandKbd"
import { useCommandLabel } from "@/components/keybindings/keymapStore"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SCENE_LIMITS } from "@/core/scene/schema"
import type { CameraKind } from "@/render/contracts"
import { cn } from "@/lib/utils"

import { useEditorActions, useEditorContext, useEditorShallow, useEditorState } from "./context"
import { Segmented } from "./fields"
import { clockTime, formatElevation, relativeTime } from "./lib/format"
import { levelsTopDown } from "./lib/levelOps"
import { activeLevelShapes, runEditorCommand, selectionCount } from "./lib/terrainMode"
import type { SceneDocument } from "./useSceneDocument"

function SceneName({ disabled }: { disabled: boolean }) {
  const { store } = useEditorContext()
  const name = useEditorState((s) => s.scene.name)
  const [draft, setDraft] = React.useState<string | null>(null)
  const commit = (value: string) => {
    setDraft(null)
    const next = value.replace(/\s+/g, " ").trim() || "Untitled Scene"
    if (next !== name) store.getState().updateSceneInfo({ name: next })
  }
  return (
    <input
      aria-label="Scene name"
      className="h-7 w-full max-w-64 min-w-24 truncate rounded-md border border-transparent bg-transparent px-2 font-heading text-sm font-medium transition-colors outline-none hover:border-input focus:border-ring focus:bg-input/30 focus:ring-2 focus:ring-ring/30 disabled:hover:border-transparent"
      value={draft ?? name}
      maxLength={200}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur()
        if (e.key === "Escape") {
          setDraft(null)
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
        }
      }}
    />
  )
}

function SaveState({ doc }: { doc: SceneDocument }) {
  const { dirty, readOnly } = useEditorShallow((s) => ({ dirty: s.dirty, readOnly: s.readOnly }))
  const saveKey = useCommandLabel("editor", "save") || "File › Save"
  const [, force] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    const t = setInterval(force, 30_000)
    return () => clearInterval(t)
  }, [])

  if (doc.viewingVersion) {
    return (
      <Badge variant="outline" className="gap-1 border-primary/40 text-primary">
        Version {doc.viewingVersion.version} · read-only
      </Badge>
    )
  }
  if (readOnly) return <Badge variant="outline">Read-only</Badge>
  if (doc.saving) {
    return (
      <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
        <Spinner className="size-3" /> Saving…
      </span>
    )
  }
  const StorageIcon = doc.storage === "remote" ? Cloud : HardDrive
  let label: string
  let tip: string
  let tone = "text-muted-foreground"
  if (!doc.libraryId) {
    label = "Not saved yet"
    tip = doc.draftSavedAt ? `Draft kept on this device at ${clockTime(doc.draftSavedAt)}. Press ${saveKey} to add it to your library.` : `Press ${saveKey} to add this scene to your library.`
    tone = "text-foreground/80"
  } else if (dirty) {
    label = "Unsaved changes"
    tip = doc.draftSavedAt ? `Draft kept on this device at ${clockTime(doc.draftSavedAt)}. ${saveKey} saves a new version.` : `${saveKey} saves a new version.`
    tone = "text-foreground/80"
  } else {
    label = doc.baseVersion ? `Saved · v${doc.baseVersion}` : "Saved"
    tip = doc.lastSavedAt ? `Saved ${relativeTime(doc.lastSavedAt)} (${clockTime(doc.lastSavedAt)}) to your ${doc.storage === "remote" ? "cloud" : "local"} library.` : "Saved"
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("flex cursor-default items-center gap-1.5 text-[0.6875rem] whitespace-nowrap", tone)} />}>
        {dirty || !doc.libraryId ? <CircleDot className="size-3 text-primary" /> : <StorageIcon className="size-3" />}
        {label}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

function UndoRedo({ disabled }: { disabled: boolean }) {
  const { store, controller } = useEditorContext()
  const h = useEditorShallow((s) => ({ canUndo: s.history.canUndo, canRedo: s.history.canRedo, undoLabel: s.history.undoLabel, redoLabel: s.history.redoLabel }))
  return (
    <div className="flex items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Undo"
              disabled={disabled || !h.canUndo}
              onClick={() => {
                controller.cancelGesture()
                store.getState().undo()
              }}
            />
          }
        >
          <Undo2 />
        </TooltipTrigger>
        <TooltipContent>
          {h.undoLabel ? `Undo ${h.undoLabel}` : "Undo"} <CommandKbd scope="editor" command="undo" />
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Redo"
              disabled={disabled || !h.canRedo}
              onClick={() => {
                controller.cancelGesture()
                store.getState().redo()
              }}
            />
          }
        >
          <Redo2 />
        </TooltipTrigger>
        <TooltipContent>
          {h.redoLabel ? `Redo ${h.redoLabel}` : "Redo"} <CommandKbd scope="editor" command="redo" />
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function EditorMenus({ doc, previewing }: { doc: SceneDocument; previewing: boolean }) {
  const { store, controller } = useEditorContext()
  const actions = useEditorActions()
  const s = useEditorShallow((st) => ({
    readOnly: st.readOnly,
    canUndo: st.history.canUndo,
    canRedo: st.history.canRedo,
    undoLabel: st.history.undoLabel,
    redoLabel: st.history.redoLabel,
    // Terrain mode: the terrain tool's shapes are the selection (the object selection is hidden).
    terrain: st.tool === "terrain",
    selection: selectionCount(st),
    shapes: Object.keys(activeLevelShapes(st)).length,
    hasClipboard: st.clipboard !== null,
    showGrid: st.view.showGrid,
    showHelpers: st.view.showHelpers,
    darkVision: st.view.darkVision,
    ghost: st.view.ghostAdjacent,
    camera: st.view.camera,
    activeLevelId: st.activeLevelId,
    levels: st.scene.levels,
    tokens: Object.keys(st.scene.tokens).length,
  }))
  const levels = levelsTopDown({ levels: s.levels })
  const editable = !s.readOnly && !previewing
  const run = (fn: () => void) => () => {
    controller.cancelGesture()
    fn()
  }
  // Selection commands in the terrain mode go to the terrain tool (its shapes), like their shortcuts.
  const command = (action: Parameters<typeof runEditorCommand>[1], objects: () => void) =>
    run(() => (s.terrain ? void runEditorCommand(controller, action) : objects()))
  const trigger = "h-7 px-2 text-xs font-normal text-muted-foreground aria-expanded:text-foreground hover:text-foreground"

  return (
    <Menubar className="h-8 gap-0 border-none bg-transparent p-0">
      <MenubarMenu>
        <MenubarTrigger className={trigger}>File</MenubarTrigger>
        <MenubarContent className="min-w-60">
          <MenubarGroup>
            <MenubarItem onClick={actions.newScene}>New scene</MenubarItem>
            <MenubarItem onClick={actions.newFromImages}>New scene from map images…</MenubarItem>
          </MenubarGroup>
          <MenubarSeparator />
          <MenubarGroup>
            <MenubarItem disabled={!editable} onClick={actions.save}>
              Save
              <CommandShortcut id="save" />
            </MenubarItem>
            <MenubarItem disabled={!doc.libraryId} onClick={actions.openVersions}>
              Version history…
            </MenubarItem>
          </MenubarGroup>
          <MenubarSeparator />
          <MenubarGroup>
            <MenubarItem disabled={!editable} onClick={() => actions.openMapImport()}>
              Import map images…
            </MenubarItem>
            <MenubarItem onClick={actions.importFile}>Import .atlas.json…</MenubarItem>
            <MenubarItem onClick={actions.exportFile}>Export .atlas.json</MenubarItem>
          </MenubarGroup>
          <MenubarSeparator />
          <MenubarGroup>
            <MenubarItem disabled={doc.storage !== "remote"} onClick={actions.openShare}>
              Share link…
              {doc.storage !== "remote" ? <MenubarShortcut>Online only</MenubarShortcut> : null}
            </MenubarItem>
            <MenubarItem disabled={s.readOnly} onClick={actions.startSession}>
              Start session
            </MenubarItem>
          </MenubarGroup>
          <MenubarSeparator />
          <MenubarItem onClick={actions.goHome}>Back to library</MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger className={trigger}>Edit</MenubarTrigger>
        <MenubarContent className="min-w-56">
          <MenubarItem disabled={!editable || !s.canUndo} onClick={run(() => store.getState().undo())}>
            {s.undoLabel ? `Undo ${s.undoLabel}` : "Undo"}
            <CommandShortcut id="undo" />
          </MenubarItem>
          <MenubarItem disabled={!editable || !s.canRedo} onClick={run(() => store.getState().redo())}>
            {s.redoLabel ? `Redo ${s.redoLabel}` : "Redo"}
            <CommandShortcut id="redo" />
          </MenubarItem>
          <MenubarSeparator />
          {/* Terrain shapes are not on the clipboard. */}
          <MenubarItem disabled={!editable || s.terrain || s.selection === 0} onClick={run(() => store.getState().cutSelection())}>
            Cut
            <CommandShortcut id="cut" />
          </MenubarItem>
          <MenubarItem disabled={s.terrain || s.selection === 0} onClick={() => store.getState().copySelection()}>
            Copy
            <CommandShortcut id="copy" />
          </MenubarItem>
          <MenubarItem
            disabled={!editable || s.terrain}
            onClick={run(() => {
              void store.getState().pasteFromSystem(controller.pasteTarget())
            })}
          >
            Paste
            <CommandShortcut id="paste" />
          </MenubarItem>
          <MenubarItem disabled={!editable || s.selection === 0} onClick={command({ type: "duplicate" }, () => store.getState().duplicateSelection())}>
            Duplicate
            <CommandShortcut id="duplicate" />
          </MenubarItem>
          <MenubarItem variant="destructive" disabled={!editable || s.selection === 0} onClick={actions.deleteSelection}>
            Delete
            <CommandShortcut id="delete" />
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem disabled={previewing || (s.terrain && s.shapes === 0)} onClick={command({ type: "select-all" }, () => store.getState().selectAll())}>
            {s.terrain ? "Select all shapes on level" : "Select all on level"}
            <CommandShortcut id="select-all" />
          </MenubarItem>
          <MenubarItem
            disabled={s.selection === 0}
            onClick={() => (s.terrain ? store.getState().setTerrainSelection(null) : store.getState().clearSelection())}
          >
            Deselect
            <CommandShortcut id="escape" />
          </MenubarItem>
          <MenubarItem disabled={!editable || s.selection === 0} onClick={command({ type: "rotate", turns: 1 }, () => store.getState().rotateSelection(1))}>
            Rotate 90°
            <CommandShortcut id="rotate.cw" />
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger className={trigger}>View</MenubarTrigger>
        <MenubarContent className="min-w-56">
          <MenubarCheckboxItem checked={s.showGrid} onCheckedChange={() => store.getState().toggleGrid()}>
            Grid
            <CommandShortcut id="toggle-grid" />
          </MenubarCheckboxItem>
          <MenubarCheckboxItem checked={s.showHelpers} onCheckedChange={() => store.getState().toggleHelpers()}>
            Helpers (light radii, arrows)
            <CommandShortcut id="toggle-helpers" />
          </MenubarCheckboxItem>
          <MenubarCheckboxItem checked={s.darkVision} onCheckedChange={() => store.getState().toggleDarkVision()}>
            Dark vision
            <CommandShortcut id="toggle-dark-vision" />
          </MenubarCheckboxItem>
          <MenubarCheckboxItem checked={s.ghost} onCheckedChange={() => store.getState().toggleGhostAdjacent()}>
            Ghost adjacent levels
          </MenubarCheckboxItem>
          <MenubarSeparator />
          <MenubarGroup>
            <MenubarLabel>Camera</MenubarLabel>
            <MenubarRadioGroup value={s.camera} onValueChange={(v) => store.getState().setView({ camera: v as CameraKind })}>
              <MenubarRadioItem value="orbit">3D orbit</MenubarRadioItem>
              <MenubarRadioItem value="topdown">Top-down</MenubarRadioItem>
            </MenubarRadioGroup>
          </MenubarGroup>
          <MenubarItem onClick={actions.frameScene}>Frame scene</MenubarItem>
          <MenubarItem disabled={s.selection === 0} onClick={actions.focusSelection}>
            Focus selection
          </MenubarItem>
          <MenubarSeparator />
          {previewing ? (
            <MenubarItem onClick={actions.exitPreview}>
              Exit player preview
              <MenubarShortcut>Esc</MenubarShortcut>
            </MenubarItem>
          ) : (
            <MenubarItem disabled={s.tokens === 0} onClick={() => actions.enterPreview()}>
              Preview player view…
            </MenubarItem>
          )}
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger className={trigger}>Level</MenubarTrigger>
        <MenubarContent className="min-w-60">
          <MenubarGroup>
            <MenubarLabel>Active level</MenubarLabel>
            <MenubarRadioGroup value={s.activeLevelId} onValueChange={(v) => store.getState().setActiveLevel(String(v))}>
              {levels.map((l) => (
                <MenubarRadioItem key={l.id} value={l.id}>
                  <span className="truncate">{l.name}</span>
                  <MenubarShortcut>{formatElevation(l.elevation)}</MenubarShortcut>
                </MenubarRadioItem>
              ))}
            </MenubarRadioGroup>
          </MenubarGroup>
          <MenubarSeparator />
          <MenubarItem onClick={run(() => store.getState().stepActiveLevel(1))}>
            Level above
            <CommandShortcut id="level.up" />
          </MenubarItem>
          <MenubarItem onClick={run(() => store.getState().stepActiveLevel(-1))}>
            Level below
            <CommandShortcut id="level.down" />
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem disabled={!editable || levels.length >= SCENE_LIMITS.maxLevels} onClick={actions.addLevel}>
            Add level on top
          </MenubarItem>
          <MenubarItem disabled={!editable || levels.length >= SCENE_LIMITS.maxLevels} onClick={() => actions.duplicateLevel()}>
            Duplicate active level
          </MenubarItem>
          <MenubarItem variant="destructive" disabled={!editable || levels.length <= 1} onClick={() => actions.deleteLevel(s.activeLevelId)}>
            Delete active level…
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger className={trigger}>Help</MenubarTrigger>
        <MenubarContent className="min-w-56">
          <MenubarItem onClick={actions.openShortcuts}>
            Keyboard shortcuts
            <CommandShortcut id="help" />
          </MenubarItem>
          <MenubarSeparator />
          {/* A plain hint, not a MenubarLabel: Base UI group labels must sit inside a MenubarGroup
              (outside one they throw and crash the editor) and are aria-hidden. */}
          <div className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
            Right-drag orbits · middle-drag pans · wheel zooms.
            <br />
            Hold Alt for free placement.
          </div>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  )
}

export function TopBar({ doc, previewing, onModeChange }: { doc: SceneDocument; previewing: boolean; onModeChange(mode: "edit" | "preview"): void }) {
  const actions = useEditorActions()
  const readOnly = useEditorState((s) => s.readOnly)
  const hasTokens = useEditorState((s) => Object.keys(s.scene.tokens).length > 0)

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-card/70 px-2 backdrop-blur">
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-lg" aria-label="Back to library" onClick={actions.goHome} />}>
          <AppLogoMark className="size-5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">Back to library</TooltipContent>
      </Tooltip>
      <EditorMenus doc={doc} previewing={previewing} />
      <Separator orientation="vertical" className="mx-1 h-5 self-center" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <SceneName disabled={readOnly} />
        <SaveState doc={doc} />
      </div>
      <UndoRedo disabled={readOnly || previewing} />
      <Separator orientation="vertical" className="mx-1 h-5 self-center" />
      <Segmented
        aria-label="Mode"
        value={previewing ? "preview" : "edit"}
        onValueChange={onModeChange}
        options={[
          { value: "edit", label: "Edit", icon: <Pencil className="size-3" /> },
          {
            value: "preview",
            label: "Player view",
            icon: <Eye className="size-3" />,
            disabled: !hasTokens,
            tooltip: hasTokens ? "Preview what a token can see" : "Place a token to preview its view",
          },
        ]}
      />
      <Separator orientation="vertical" className="mx-1 h-5 self-center" />
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="sm" disabled={doc.storage !== "remote"} onClick={actions.openShare} />}>
          <Share2 data-icon="inline-start" />
          Share
        </TooltipTrigger>
        <TooltipContent side="bottom">{doc.storage === "remote" ? "Share a read-only link" : "Sharing needs the online library"}</TooltipContent>
      </Tooltip>
      <Button size="sm" disabled={readOnly || doc.busy !== null} onClick={actions.startSession} className="gap-1.5">
        {doc.busy === "Starting the session…" ? <Spinner className="size-3.5" /> : <Play data-icon="inline-start" className="fill-current" />}
        Start session
      </Button>
    </header>
  )
}

/** A menu item's shortcut, following the user's key remaps. */
function CommandShortcut({ id }: { id: string }) {
  const label = useCommandLabel("editor", id)
  return label ? <MenubarShortcut>{label}</MenubarShortcut> : null
}
