/** Auto/Low/Medium/High/Ultra render-quality picker (editor status bar, host status bar, player settings). */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Quality } from "@/render/contracts"
import { cn } from "@/lib/utils"

import {
  QUALITY_ITEMS,
  isQualityChoice,
  type QualityChoice,
} from "./qualityChoice"

export function QualitySelect({
  value,
  onValueChange,
  current,
  className,
  itemClassName,
  side = "top",
  align = "end",
  size = "sm",
  "aria-label": ariaLabel = "Render quality",
  id,
}: {
  value: QualityChoice
  onValueChange(q: QualityChoice): void
  /** The tier the engine runs at now; shown after "Auto". */
  current?: Quality | null
  className?: string
  itemClassName?: string
  side?: "top" | "bottom"
  align?: "start" | "end"
  size?: "sm" | "default"
  "aria-label"?: string
  id?: string
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (isQualityChoice(v)) onValueChange(v)
      }}
    >
      <SelectTrigger
        id={id}
        size={size}
        aria-label={ariaLabel}
        className={cn(className)}
      >
        <SelectValue>
          {(v: QualityChoice) =>
            v === "auto"
              ? `Auto${current ? ` (${current})` : ""}`
              : QUALITY_ITEMS.find((q) => q.value === v)?.label
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent side={side} align={align} alignItemWithTrigger={false}>
        {QUALITY_ITEMS.map((q) => (
          <SelectItem key={q.value} value={q.value} className={itemClassName}>
            {q.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
