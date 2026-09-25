/**
 * Floating HUD building blocks shared by the player view and the DM's live view: glass panels, icon
 * buttons with tooltips + shortcuts, the camera dock (rotate, zoom, grid, recentre, render quality), the tool
 * switch (move / measure / area of effect) and the keyboard help popover.
 */
import * as React from "react"
import {
  Crosshair,
  Gauge,
  Grid3x3,
  Keyboard,
  Minus,
  MousePointer2,
  Plus,
  Radius,
  RotateCcw,
  RotateCw,
  Ruler,
  Settings2,
} from "lucide-react"

import { QualitySelect } from "@/components/canvas/QualitySelect"
import type { QualityChoice } from "@/components/canvas/qualityChoice"
import { CommandKbd } from "@/components/keybindings/CommandKbd"
import { KeybindingsDialog } from "@/components/keybindings/KeybindingsDialog"
import { useKeyOverrides } from "@/components/keybindings/keymapStore"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { hotkeyLabel } from "@/lib/hotkeys"
import { cn } from "@/lib/utils"
import { keysOf } from "@/lib/keymap"
import { PLAY_COMMANDS, PLAY_POINTER_HELP, type PlayTool } from "@/play"
import type { Quality } from "@/render/contracts"

/** Gilt-framed, frosted panel look for everything floating over the map. */
export const glass = "atlas-gilt-frame atlas-sheen bg-card/88 backdrop-blur-md"

export function HudPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("pointer-events-auto rounded-lg", glass, className)}
      {...props}
    />
  )
}

export interface HudButtonProps extends Omit<
  React.ComponentProps<typeof Button>,
  "children"
> {
  label: string
  shortcut?: string
  icon: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
  active?: boolean
}

/** Icon button with a tooltip showing its name and shortcut. */
export function HudButton({
  label,
  shortcut,
  icon,
  side = "top",
  active,
  className,
  variant,
  size,
  ...props
}: HudButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={variant ?? (active ? "secondary" : "ghost")}
            size={size ?? "icon-sm"}
            aria-label={label}
            aria-pressed={active}
            className={cn(active && "text-sidebar-primary", className)}
            {...props}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  )
}

export interface CameraDockProps {
  onRotate(quarterTurns: 1 | -1): void
  onZoom(direction: 1 | -1): void
  onRecenter?(): void
  recenterLabel?: string
  grid: boolean
  onGrid(show: boolean): void
  /** Render-quality picker (Auto or a fixed tier); omitted = no picker. */
  quality?: {
    value: QualityChoice
    onChange(q: QualityChoice): void
    /** The tier the engine runs at now (shown after "Auto"). */
    current?: Quality | null
  }
  className?: string
  side?: "top" | "bottom"
}

/** Camera controls: rotate, zoom, grid and recentre. */
export function CameraDock({
  onRotate,
  onZoom,
  onRecenter,
  recenterLabel = "Centre on the selected token",
  grid,
  onGrid,
  quality,
  className,
  side = "top",
}: CameraDockProps) {
  return (
    <HudPanel className={cn("flex items-center gap-0.5 p-1", className)}>
      <HudButton
        label="Rotate left"
        shortcut="Q"
        icon={<RotateCcw />}
        side={side}
        onClick={() => onRotate(-1)}
      />
      <HudButton
        label="Rotate right"
        shortcut="E"
        icon={<RotateCw />}
        side={side}
        onClick={() => onRotate(1)}
      />
      <Separator orientation="vertical" className="mx-0.5 h-4 self-center" />
      <HudButton
        label="Zoom out"
        shortcut="−"
        icon={<Minus />}
        side={side}
        onClick={() => onZoom(-1)}
      />
      <HudButton
        label="Zoom in"
        shortcut="+"
        icon={<Plus />}
        side={side}
        onClick={() => onZoom(1)}
      />
      <Separator orientation="vertical" className="mx-0.5 h-4 self-center" />
      <HudButton
        label={grid ? "Hide grid" : "Show grid"}
        shortcut="G"
        icon={<Grid3x3 />}
        side={side}
        active={grid}
        onClick={() => onGrid(!grid)}
      />
      {quality ? (
        <Popover>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Render quality"
                    />
                  }
                />
              }
            >
              <Gauge />
            </TooltipTrigger>
            <TooltipContent side={side}>
              Render quality ·{" "}
              {quality.value === "auto"
                ? `Auto${quality.current ? ` (${quality.current})` : ""}`
                : quality.value}
            </TooltipContent>
          </Tooltip>
          <PopoverContent side={side} className="w-60 gap-3">
            <PopoverHeader>
              <PopoverTitle>Render quality</PopoverTitle>
              <PopoverDescription>
                Auto picks a tier for this device and steps down when frames get
                slow.
              </PopoverDescription>
            </PopoverHeader>
            <QualitySelect
              value={quality.value}
              onValueChange={quality.onChange}
              current={quality.current}
              side={side}
              align="start"
              size="default"
              className="w-full"
            />
          </PopoverContent>
        </Popover>
      ) : null}
      {onRecenter ? (
        <HudButton
          label={recenterLabel}
          shortcut="Space"
          icon={<Crosshair />}
          side={side}
          onClick={onRecenter}
        />
      ) : null}
    </HudPanel>
  )
}

/** Move / Measure / Area switch. */
export function ToolSwitch({
  tool,
  onTool,
  side = "top",
  disabledMove,
}: {
  tool: PlayTool
  onTool(t: PlayTool): void
  side?: "top" | "bottom"
  disabledMove?: boolean
}) {
  return (
    <ToggleGroup
      value={[tool]}
      onValueChange={(v) => {
        const next = v[0] as PlayTool | undefined
        if (next) onTool(next)
      }}
      spacing={1}
      className="gap-0.5"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ToggleGroupItem
              value="move"
              aria-label="Select and move"
              disabled={disabledMove}
              className="h-7 gap-1.5 px-2 text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground data-[pressed]:bg-primary data-[pressed]:text-primary-foreground"
            />
          }
        >
          <MousePointer2 className="size-3.5" /> Move
        </TooltipTrigger>
        <TooltipContent side={side}>
          Select a token and drag it to move
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <ToggleGroupItem
              value="measure"
              aria-label="Measure"
              className="h-7 gap-1.5 px-2 text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground data-[pressed]:bg-primary data-[pressed]:text-primary-foreground"
            />
          }
        >
          <Ruler className="size-3.5" /> Measure
        </TooltipTrigger>
        <TooltipContent side={side}>
          Drag to measure; Shift-drag adds a leg{" "}
          <CommandKbd scope="play" command="measure" />
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <ToggleGroupItem
              value="template"
              aria-label="Area of effect"
              className="h-7 gap-1.5 px-2 text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground data-[pressed]:bg-primary data-[pressed]:text-primary-foreground"
            />
          }
        >
          <Radius className="size-3.5" /> Area
        </TooltipTrigger>
        <TooltipContent side={side}>
          Place a spell's area of effect: see who it catches{" "}
          <CommandKbd scope="play" command="template" />
        </TooltipContent>
      </Tooltip>
    </ToggleGroup>
  )
}

/** Keyboard/mouse help (current keys, after remaps), with a way into the key-bindings dialog. */
export function ShortcutsButton({
  side = "top",
  host = false,
}: {
  side?: "top" | "bottom"
  /** Include the DM-only keys, and the editor keymap in the dialog. */
  host?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [customizing, setCustomizing] = React.useState(false)
  const overrides = useKeyOverrides("play")
  const rows = [
    ...PLAY_POINTER_HELP.filter((h) => host || !h.hostOnly),
    ...PLAY_COMMANDS.filter((c) => host || !c.hostOnly).map((c) => ({
      keys: keysOf(c, overrides).map(hotkeyLabel).join(" / ") || "—",
      label: c.label,
    })),
  ]
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Keyboard shortcuts"
                  />
                }
              />
            }
          >
            <Keyboard />
          </TooltipTrigger>
          <TooltipContent side={side}>Keyboard shortcuts</TooltipContent>
        </Tooltip>
        <PopoverContent side={side} align="end" className="w-72 gap-2">
          <PopoverHeader>
            <PopoverTitle>Controls</PopoverTitle>
          </PopoverHeader>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
            {rows.map((s) => (
              <React.Fragment key={s.label}>
                <dt>
                  <Kbd>{s.keys}</Kbd>
                </dt>
                <dd className="text-muted-foreground">{s.label}</dd>
              </React.Fragment>
            ))}
          </dl>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false)
              setCustomizing(true)
            }}
          >
            <Settings2 data-icon="inline-start" />
            Customize keys…
          </Button>
        </PopoverContent>
      </Popover>
      <KeybindingsDialog
        open={customizing}
        onOpenChange={setCustomizing}
        scopes={host ? ["play", "editor"] : ["play"]}
        host={host}
      />
    </>
  )
}

/** Small coloured status dot. */
export function StatusDot({
  tone,
  pulse,
  className,
}: {
  tone: "ok" | "warn" | "off" | "bad"
  pulse?: boolean
  className?: string
}) {
  const color =
    tone === "ok"
      ? "bg-primary"
      : tone === "warn"
        ? "bg-muted-foreground"
        : tone === "bad"
          ? "bg-destructive"
          : "bg-muted-foreground/50"
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse ? (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-60",
            color
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", color)} />
    </span>
  )
}
