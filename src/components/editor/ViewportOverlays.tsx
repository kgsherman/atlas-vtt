/**
 * HTML chrome floating over the viewport: level switcher, camera controls, document banners
 * (read-only version, recoverable draft), the player-preview bar and a first-steps hint.
 */
import * as React from "react"
import { Box, ChevronDown, ChevronUp, Eye, History, ImagePlus, Keyboard, LifeBuoy, Map as MapIcon, Maximize, RotateCcw, Undo2, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { adjacentLevels } from "@/core/scene/queries"
import type { Id } from "@/core/scene/types"
import { cn } from "@/lib/utils"

import { useEditorActions, useEditorContext, useEditorShallow, useEditorState } from "./context"
import { SelectInput } from "./fields"
import { clockTime, formatElevation, relativeTime, tokenLabel } from "./lib/format"
import { previewCandidates, type PreviewResult } from "./lib/preview"
import type { SceneDocument } from "./useSceneDocument"

const glass = "border bg-card/85 shadow-lg shadow-black/20 backdrop-blur-md"

/** Record has at most n own keys (stops counting early: cheap on 20k-object scenes). */
function atMost(record: object, n: number): boolean {
  let k = 0
  for (const key in record) {
    if (Object.hasOwn(record, key) && ++k > n) return false
  }
  return true
}

export function LevelSwitcher() {
  const { store } = useEditorContext()
  const { level, above, below } = useEditorShallow((s) => {
    const level = Object.hasOwn(s.scene.levels, s.activeLevelId) ? s.scene.levels[s.activeLevelId] : null
    const adj = level ? adjacentLevels(s.scene, level.id) : {}
    return { level, above: adj.above ?? null, below: adj.below ?? null }
  })
  if (!level) return null
  return (
    <div className={cn("pointer-events-auto flex items-center gap-1 rounded-lg p-1 pl-2.5", glass)}>
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="max-w-48 truncate text-xs font-medium">{level.name}</span>
        <span className="text-[0.625rem] text-muted-foreground">{formatElevation(level.elevation)}</span>
      </div>
      <ButtonGroup orientation="vertical" className="ml-1">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Level above" disabled={!above} onClick={() => store.getState().stepActiveLevel(1)} />}>
            <ChevronUp />
          </TooltipTrigger>
          <TooltipContent side="right">
            {above ? `Up to ${above.name}` : "No level above"} <Kbd>PgUp</Kbd>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Level below" disabled={!below} onClick={() => store.getState().stepActiveLevel(-1)} />}>
            <ChevronDown />
          </TooltipTrigger>
          <TooltipContent side="right">
            {below ? `Down to ${below.name}` : "No level below"} <Kbd>PgDn</Kbd>
          </TooltipContent>
        </Tooltip>
      </ButtonGroup>
    </div>
  )
}

export function CameraControls() {
  const { store } = useEditorContext()
  const actions = useEditorActions()
  const camera = useEditorState((s) => s.view.camera)
  return (
    <div className={cn("pointer-events-auto flex items-center gap-0.5 rounded-lg p-1", glass)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant={camera === "orbit" ? "secondary" : "ghost"} size="icon-sm" aria-label="3D orbit camera" onClick={() => store.getState().setView({ camera: "orbit" })} />
          }
        >
          <Box />
        </TooltipTrigger>
        <TooltipContent side="bottom">3D orbit (right-drag orbits, middle-drag pans)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant={camera === "topdown" ? "secondary" : "ghost"} size="icon-sm" aria-label="Top-down camera" onClick={() => store.getState().setView({ camera: "topdown" })} />
          }
        >
          <MapIcon />
        </TooltipTrigger>
        <TooltipContent side="bottom">Top-down</TooltipContent>
      </Tooltip>
      <div className="mx-0.5 h-4 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Frame the scene" onClick={actions.frameScene} />}>
          <Maximize />
        </TooltipTrigger>
        <TooltipContent side="bottom">Frame the scene</TooltipContent>
      </Tooltip>
    </div>
  )
}

export function DocumentBanners({ doc }: { doc: SceneDocument }) {
  const v = doc.viewingVersion
  return (
    <div className="pointer-events-none flex flex-col items-center gap-2">
      {v ? (
        <div className={cn("pointer-events-auto flex items-center gap-3 rounded-lg px-3 py-2 text-xs", glass)}>
          <History className="size-4 text-primary" />
          <span>
            Viewing <span className="font-medium">version {v.version}</span> from {relativeTime(v.createdAt)} — read-only
          </span>
          <Button size="xs" variant="outline" disabled={doc.busy !== null} onClick={() => void doc.restoreVersion(v)}>
            <RotateCcw data-icon="inline-start" /> Restore this version
          </Button>
          <Button size="xs" variant="ghost" disabled={doc.busy !== null} onClick={() => void doc.backToLatest()}>
            Back to latest
          </Button>
        </div>
      ) : null}
      {doc.recoverable ? (
        <div className={cn("pointer-events-auto flex items-center gap-3 rounded-lg px-3 py-2 text-xs", glass)}>
          <LifeBuoy className="size-4 text-primary" />
          <span>
            Unsaved changes from {clockTime(doc.recoverable.savedAt)} ({relativeTime(doc.recoverable.savedAt)}) were found on this device.
          </span>
          <Button size="xs" variant="outline" onClick={doc.restoreDraft}>
            <Undo2 data-icon="inline-start" /> Restore
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void doc.discardDraft()}>
            Discard
          </Button>
        </div>
      ) : null}
      {doc.busy ? (
        <div className={cn("pointer-events-auto flex items-center gap-2 rounded-full px-3 py-1.5 text-xs", glass)}>
          <Spinner className="size-3.5" /> {doc.busy}
        </div>
      ) : null}
    </div>
  )
}

/** First steps for a (nearly) empty scene. */
export function GettingStarted() {
  const actions = useEditorActions()
  const { store } = useEditorContext()
  const empty = useEditorState((s) => atMost(s.scene.objects, 1) && atMost(s.scene.tokens, 0) && !Object.values(s.scene.levels).some((l) => l.backdrop))
  const readOnly = useEditorState((s) => s.readOnly)
  const [dismissed, setDismissed] = React.useState(false)
  if (!empty || dismissed || readOnly) return null
  return (
    <div className={cn("pointer-events-auto flex w-80 flex-col gap-2 rounded-lg p-3", glass)}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium">Start building</div>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setDismissed(true)}>
          <X />
        </Button>
      </div>
      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
        Draw walls with <Kbd>W</Kbd>, add doors <Kbd>D</Kbd> and windows <Kbd>N</Kbd>, light the place <Kbd>L</Kbd> and drop tokens <Kbd>K</Kbd>. Or start from a battlemap image.
      </p>
      <div className="flex gap-1.5">
        <Button size="xs" onClick={() => actions.openMapImport()}>
          <ImagePlus data-icon="inline-start" /> Import map image
        </Button>
        <Button size="xs" variant="outline" onClick={() => store.getState().setTool("wall")}>
          Draw walls
        </Button>
        <Button size="xs" variant="ghost" onClick={actions.openShortcuts}>
          <Keyboard data-icon="inline-start" /> Shortcuts
        </Button>
      </div>
    </div>
  )
}

export function PreviewBar({ tokenId, result, onTokenChange }: { tokenId: Id; result: PreviewResult | null; onTokenChange(id: Id): void }) {
  const actions = useEditorActions()
  const tokens = useEditorState((s) => s.scene.tokens)
  const levelName = useEditorState((s) => {
    const t = Object.hasOwn(s.scene.tokens, tokenId) ? s.scene.tokens[tokenId] : null
    return t && Object.hasOwn(s.scene.levels, t.levelId) ? s.scene.levels[t.levelId].name : null
  })
  const options = previewCandidates({ tokens }).map((id) => ({ value: id, label: `${tokenLabel(tokens[id])}${tokens[id].hidden ? " (hidden)" : ""}` }))
  const t = Object.hasOwn(tokens, tokenId) ? tokens[tokenId] : null
  const senses = t ? [t.vision.blind ? "blind" : t.vision.darkvision > 0 ? `darkvision ${t.vision.darkvision} ft` : "normal vision", t.vision.blindsight > 0 ? `blindsight ${t.vision.blindsight} ft` : null].filter(Boolean).join(" · ") : ""
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b bg-primary/10 px-3">
      <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap text-primary">
        <Eye className="size-3.5" /> Player view preview
      </div>
      <div className="h-5 w-px shrink-0 bg-border" />
      <span className="shrink-0 text-[0.6875rem] whitespace-nowrap text-muted-foreground">Seeing as</span>
      <SelectInput className="w-44 shrink-0" value={tokenId} options={options} onValueChange={onTokenChange} aria-label="Previewed token" />
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 cursor-default truncate text-[0.6875rem] whitespace-nowrap text-muted-foreground" />}>
          {levelName ? `${levelName} · ` : ""}
          {senses}
        </TooltipTrigger>
        <TooltipContent>
          {levelName ? `${levelName} · ` : ""}
          {senses}
        </TooltipContent>
      </Tooltip>
      <div className="flex-1" />
      {result ? (
        <Tooltip>
          <TooltipTrigger render={<Badge variant="outline" className="shrink-0 cursor-default font-normal tabular-nums" />}>
            {result.visibleTokenIds.length} other token{result.visibleTokenIds.length === 1 ? "" : "s"} visible · {Math.round(result.ms)} ms
          </TooltipTrigger>
          <TooltipContent>Computed locally by the vision engine; explored = what is perceived right now. Click another token to switch.</TooltipContent>
        </Tooltip>
      ) : (
        <Spinner className="size-3.5" />
      )}
      <Button size="sm" variant="outline" className="shrink-0" onClick={actions.exitPreview}>
        <X data-icon="inline-start" /> Exit preview <Kbd className="ml-1">Esc</Kbd>
      </Button>
    </div>
  )
}
