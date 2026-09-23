import * as React from "react"

import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ToolId } from "@/editor/tools/types"

import { useEditorContext, useEditorState } from "./context"
import { TOOL_GROUP_ENDS, TOOLS } from "./toolMeta"

/** Vertical tool palette (left edge). Tooltips show the tool name, shortcut and a usage hint. */
export function ToolRail({ disabled }: { disabled?: boolean }) {
  const { store } = useEditorContext()
  const tool = useEditorState((s) => s.tool)
  const readOnly = useEditorState((s) => s.readOnly)

  return (
    <nav aria-label="Tools" className="flex w-11 shrink-0 flex-col items-center border-r bg-card/40 py-2">
      <ToggleGroup
        orientation="vertical"
        spacing={1}
        value={[tool]}
        disabled={disabled}
        onValueChange={(v) => {
          const next = v[0] as ToolId | undefined
          if (next) store.getState().setTool(next)
        }}
        className="gap-0.5"
      >
        {TOOLS.map((t) => {
          const Icon = t.icon
          const editing = t.id !== "select" && t.id !== "measure"
          return (
            <React.Fragment key={t.id}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ToggleGroupItem
                      value={t.id}
                      aria-label={t.label}
                      disabled={readOnly && editing}
                      className="size-8 p-0 text-muted-foreground data-[pressed]:bg-primary/15 data-[pressed]:text-primary aria-pressed:bg-primary/15 aria-pressed:text-primary"
                    />
                  }
                >
                  <Icon className="size-4" />
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8} className="max-w-64 flex-col items-start gap-1 py-2">
                  <span className="flex w-full items-center justify-between gap-3 font-medium">
                    {t.label}
                    {t.key ? <Kbd>{t.key}</Kbd> : null}
                  </span>
                  <span className="text-[0.6875rem] leading-snug opacity-80">{t.hint}</span>
                </TooltipContent>
              </Tooltip>
              {TOOL_GROUP_ENDS.has(t.id) ? <Separator className="my-1 w-6 self-center" /> : null}
            </React.Fragment>
          )
        })}
      </ToggleGroup>
    </nav>
  )
}
