/**
 * HTML chrome floating over the DM's live map: the level rail (cutaway level), the vision preview
 * banner, the selected token card with quick actions, and the camera/tool docks.
 */
import {
  Box,
  Eye,
  EyeOff,
  Layers,
  Lock,
  Map as MapIcon,
  Maximize,
  ScanEye,
  UserRound,
  X,
} from "lucide-react"

import { formatElevation } from "@/components/editor/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CommandKbd } from "@/components/keybindings/CommandKbd"
import { Kbd } from "@/components/ui/kbd"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { sortedLevels } from "@/core/scene/queries"
import type { Id, Scene } from "@/core/scene/types"
import type { GameState } from "@/core/session/types"
import { cn } from "@/lib/utils"
import { describeSenses, TOKEN_KIND_LABELS, tokenDisplayName } from "@/play"
import type { CameraKind } from "@/render/contracts"

import { HudButton, HudPanel } from "../hud"
import { TokenHealth } from "../table/health"
import { TokenAvatar } from "../TokenAvatar"
import type { HostActions } from "./hostActions"
import type { PreviewInfo } from "./HostViewport"
import { playerLabels } from "./playerLabels"

/** Vertical level list (top storey first); the active level is the cutaway level. */
export function LevelRail({
  scene,
  activeLevelId,
  onLevel,
}: {
  scene: Scene
  activeLevelId: Id | null
  onLevel(id: Id): void
}) {
  const levels = sortedLevels(scene).reverse()
  const counts = new Map<Id, number>()
  for (const t of Object.values(scene.tokens))
    counts.set(t.levelId, (counts.get(t.levelId) ?? 0) + 1)
  if (levels.length <= 1) return null
  return (
    <HudPanel className="flex w-48 flex-col gap-0.5 p-1">
      <div className="flex items-center justify-between px-2 pt-1 pb-0.5">
        <span className="atlas-rubric flex items-center gap-1.5 text-[0.6875rem] uppercase">
          <Layers className="size-3" /> Levels
        </span>
        <span className="flex gap-0.5">
          <CommandKbd scope="play" command="level.up" />
          <CommandKbd scope="play" command="level.down" />
        </span>
      </div>
      <ToggleGroup
        orientation="vertical"
        value={activeLevelId ? [activeLevelId] : []}
        onValueChange={(v) => {
          const next = v[0] as Id | undefined
          if (next) onLevel(next)
        }}
        className="w-full gap-0.5"
        spacing={1}
      >
        {levels.map((l) => (
          <ToggleGroupItem
            key={l.id}
            value={l.id}
            aria-label={l.name}
            className="h-auto w-full justify-between px-2 py-1 text-left aria-pressed:bg-primary aria-pressed:text-primary-foreground data-[pressed]:bg-primary data-[pressed]:text-primary-foreground"
          >
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-xs font-medium">{l.name}</span>
              <span className="text-[0.625rem] opacity-70">
                {formatElevation(l.elevation)}
              </span>
            </span>
            {counts.get(l.id) ? (
              <span className="flex items-center gap-0.5 text-[0.625rem] tabular-nums opacity-70">
                <UserRound className="size-3" />
                {counts.get(l.id)}
              </span>
            ) : null}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </HudPanel>
  )
}

/** "Previewing vision of …" banner with a token switcher. */
export function PreviewBanner({
  scene,
  info,
  tokenIds,
  onChange,
  onExit,
}: {
  scene: Scene
  info: PreviewInfo | null
  tokenIds: Id[]
  onChange(ids: Id[]): void
  onExit(): void
}) {
  const tokens = Object.values(scene.tokens).sort((a, b) =>
    a.kind === b.kind
      ? tokenDisplayName(a).localeCompare(tokenDisplayName(b))
      : a.kind === "pc"
        ? -1
        : b.kind === "pc"
          ? 1
          : 0
  )
  const current = tokenIds[0] ?? ""
  const t = Object.hasOwn(scene.tokens, current) ? scene.tokens[current] : null
  const senses = t
    ? describeSenses(t.vision)
        .map((s) => s.label)
        .join(" · ")
    : ""
  return (
    <HudPanel className="flex items-center gap-2 py-1 pr-1 pl-3 text-xs">
      <ScanEye className="size-4 text-sidebar-primary" />
      <span className="font-medium whitespace-nowrap text-sidebar-primary">
        Vision preview
      </span>
      <Select value={current} onValueChange={(v) => v && onChange([v as Id])}>
        <SelectTrigger
          size="sm"
          className="h-7 w-44"
          aria-label="Previewed token"
        >
          <SelectValue>
            {() => (t ? tokenDisplayName(t) : "Choose a token")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {tokens.map((tok) => (
            <SelectItem key={tok.id} value={tok.id} className="text-xs">
              {tokenDisplayName(tok)}
              {tok.hidden ? " (hidden)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="w-40 shrink-0 cursor-default truncate text-[0.6875rem] whitespace-nowrap text-muted-foreground" />
          }
        >
          {senses}
        </TooltipTrigger>
        <TooltipContent>{senses || "No token"}</TooltipContent>
      </Tooltip>
      <Badge
        variant="outline"
        className="w-28 shrink-0 justify-center font-normal tabular-nums"
      >
        {!info || info.pending ? (
          <Spinner className="size-3" />
        ) : (
          `${info.visible} token${info.visible === 1 ? "" : "s"} seen · ${Math.round(info.ms)} ms`
        )}
      </Badge>
      <Button size="sm" variant="ghost" onClick={onExit}>
        <X data-icon="inline-start" /> Exit <Kbd className="ml-1">Esc</Kbd>
      </Button>
    </HudPanel>
  )
}

/** Card for the selected token: owners, senses, health and conditions, and quick actions. */
export function SelectedTokenCard({
  state,
  tokenId,
  actions,
  onPreview,
  onClose,
}: {
  state: GameState
  tokenId: Id
  actions: HostActions
  onPreview(id: Id): void
  onClose(): void
}) {
  const scene = state.scene
  const t = Object.hasOwn(scene.tokens, tokenId) ? scene.tokens[tokenId] : null
  if (!t) return null
  const labels = playerLabels(Object.values(state.players))
  const owners = (state.owners[t.id] ?? []).map(
    (uid) => labels.get(uid) ?? "Player"
  )
  const level = Object.hasOwn(scene.levels, t.levelId)
    ? scene.levels[t.levelId]
    : null
  return (
    <HudPanel className="flex w-72 flex-col gap-2 p-2.5">
      <div className="flex items-center gap-2.5">
        <TokenAvatar token={t} dimmed={t.hidden} />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate font-heading text-sm font-medium">
            {tokenDisplayName(t)}
          </span>
          <span className="truncate text-[0.6875rem] text-muted-foreground">
            {TOKEN_KIND_LABELS[t.kind]} · {level?.name ?? "?"}
          </span>
        </div>
        <HudButton
          label="Deselect"
          shortcut="Esc"
          side="top"
          icon={<X />}
          onClick={onClose}
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {describeSenses(t.vision).map((s) => (
          <Badge
            key={s.label}
            variant={s.kind === "normal" ? "outline" : "secondary"}
          >
            {s.label}
          </Badge>
        ))}
        <Badge variant="outline">{t.speed} ft</Badge>
        {t.hidden ? (
          <Badge variant="secondary" className="gap-1">
            <EyeOff /> Hidden
          </Badge>
        ) : null}
      </div>
      <div className="text-[0.6875rem] text-muted-foreground">
        {owners.length > 0
          ? `Controlled by ${owners.join(", ")}`
          : "Not assigned to a player"}
      </div>
      <TokenHealth
        key={t.id}
        hp={t.hp ?? null}
        conditions={t.conditions ?? []}
        onChange={(change) => actions.changeTokenStatus(t.id, change)}
        onTrack={(max) =>
          actions.setTokenStatus(t.id, {
            hp: max === null ? null : { current: max, max, temp: 0 },
          })
        }
      />
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => onPreview(t.id)}
        >
          <ScanEye data-icon="inline-start" /> Preview vision
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => actions.setTokensHidden([t.id], !t.hidden)}
        >
          {t.hidden ? (
            <Eye data-icon="inline-start" />
          ) : (
            <EyeOff data-icon="inline-start" />
          )}{" "}
          {t.hidden ? "Reveal" : "Hide"}
        </Button>
      </div>
      <p className="text-[0.625rem] text-muted-foreground">
        Drag to move · right-click for more
      </p>
    </HudPanel>
  )
}

/** Camera kind + frame buttons (the rotate/zoom/tilt dock sits next to it). */
export function CameraKindSwitch({
  camera,
  onCamera,
  onFrame,
}: {
  camera: CameraKind
  onCamera(c: CameraKind): void
  onFrame(): void
}) {
  return (
    <HudPanel className="flex items-center gap-0.5 p-1">
      <HudButton
        label="Top-down (2.5D) camera"
        icon={<MapIcon />}
        active={camera === "topdown"}
        onClick={() => onCamera("topdown")}
      />
      <HudButton
        label="3D orbit camera (right-drag orbits)"
        icon={<Box />}
        active={camera === "orbit"}
        onClick={() => onCamera("orbit")}
      />
      <HudButton
        label="Frame the whole map"
        icon={<Maximize />}
        onClick={onFrame}
      />
    </HudPanel>
  )
}

/** Small pill shown while all movement is locked. */
export function LockedPill({ className }: { className?: string }) {
  return (
    <HudPanel
      className={cn(
        "flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.6875rem] font-medium",
        className
      )}
    >
      <Lock className="size-3 text-sidebar-primary" /> Player movement locked
    </HudPanel>
  )
}
