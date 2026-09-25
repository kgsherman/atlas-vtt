/**
 * The Token Maker's floating toolbar over the stage: Move, then the Mask group (Reveal / Hide brushes
 * and the brush size, which `[` / `]` change like the terrain brush: the editor's remappable keys).
 */
import { Eraser, Move, Paintbrush } from "lucide-react"

import { CommandKbd } from "@/components/keybindings/CommandKbd"
import { SliderInput } from "@/components/editor/fields"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { GAME_TOKEN_SIZE, TOKEN_LIMITS } from "@/core/tokenMaker/design"
import { cn } from "@/lib/utils"
import type { MakerTool } from "@/tokenMaker/store"

import { useMaker, useTokenMaker } from "./context"

/** Floating panel look (the play HUD's glass). */
export const floating = "rounded-lg border bg-card/85 shadow-lg shadow-black/25 backdrop-blur-md"

const MASK_TOOLS: ReadonlyArray<{ value: Exclude<MakerTool, "move">; label: string; icon: React.ReactNode; tip: string; key: string }> = [
  { value: "reveal", label: "Reveal", icon: <Paintbrush />, tip: "Paint the selected layer back in, in front of the frame", key: "B" },
  { value: "hide", label: "Hide", icon: <Eraser />, tip: "Paint the selected layer away", key: "E" },
]

/** Brush diameter as pixels of a game token (512 px). */
const brushPx = (v: number) => `${Math.round(v * GAME_TOKEN_SIZE)} px`

export function StageToolbar({ className }: { className?: string }) {
  const { store } = useTokenMaker()
  const tool = useMaker((s) => s.tool)
  const brush = useMaker((s) => s.brush)
  const setTool = (t: MakerTool) => store.getState().setTool(t)
  return (
    <div role="toolbar" aria-label="Tools" className={cn("pointer-events-auto flex items-center gap-1 p-1", floating, className)}>
      <Tooltip>
        <TooltipTrigger
          render={<Toggle size="sm" className="h-7 gap-1.5 px-2 text-xs" pressed={tool === "move"} onPressedChange={() => setTool("move")} aria-label="Move" />}
        >
          <Move />
          <span className="hidden sm:inline">Move</span>
        </TooltipTrigger>
        <TooltipContent>
          Move, scale and rotate the selected layer <Kbd>V</Kbd>
        </TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="mx-1 h-5 self-center" />

      <div role="group" aria-labelledby="token-maker-mask-label" className="flex items-center gap-1">
        <span id="token-maker-mask-label" className="px-1 atlas-rubric text-[0.625rem] uppercase">
          Mask
        </span>
        <ToggleGroup size="sm" spacing={0} value={tool === "move" ? [] : [tool]} onValueChange={(v) => setTool((v[0] as MakerTool | undefined) ?? "move")}>
          {MASK_TOOLS.map((t) => (
            <Tooltip key={t.value}>
              <TooltipTrigger render={<ToggleGroupItem value={t.value} aria-label={t.label} className="h-7 gap-1.5 px-2 text-xs" />}>
                {t.icon}
                <span className="hidden sm:inline">{t.label}</span>
              </TooltipTrigger>
              <TooltipContent>
                {t.tip} <Kbd>{t.key}</Kbd>
              </TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger render={<div className="flex items-center gap-1.5 pr-1 pl-2" />}>
            <span className="hidden text-[0.6875rem] text-muted-foreground sm:inline">Size</span>
            <SliderInput
              aria-label="Brush size"
              className="w-24 sm:w-28"
              value={brush}
              min={TOKEN_LIMITS.minBrush}
              max={0.25}
              step={0.005}
              format={brushPx}
              onChange={(v) => store.getState().setBrush(v)}
            />
          </TooltipTrigger>
          <TooltipContent>
            Brush size (on a {GAME_TOKEN_SIZE} px token) <CommandKbd scope="editor" command="brush.smaller" />{" "}
            <CommandKbd scope="editor" command="brush.larger" />
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
