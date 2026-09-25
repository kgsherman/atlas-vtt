import * as React from "react"
import { CopyPlusIcon, SparklesIcon } from "lucide-react"

import { plural } from "@/app/format"
import { sceneDigest } from "@/app/sceneDigest"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import type { SampleScene } from "@/core/scene/samples"

import { SceneThumbnail } from "./SceneThumbnail"

export function SampleSceneCard({
  sample,
  busy,
  disabled,
  onOpenCopy,
  onIntent,
  actionLabel = "Open a copy",
}: {
  sample: SampleScene
  busy: boolean
  disabled: boolean
  onOpenCopy(): void
  onIntent?(): void
  /** The button's label (it always makes a library copy first). */
  actionLabel?: string
}) {
  const digest = React.useMemo(() => sceneDigest(sample.build()), [sample])
  return (
    <Card className="group/sample flex-row gap-0 py-0">
      <div className="relative w-32 shrink-0 overflow-hidden bg-muted/40 sm:w-40">
        <SceneThumbnail
          level={digest.primary}
          palette={digest.palette}
          cellSize={digest.grid.cellSize}
          mood="night"
          className="transition-transform duration-500 group-hover/sample:scale-105"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-center gap-2">
          <h3 className="truncate font-heading text-sm font-medium">{sample.name}</h3>
          <Badge variant="secondary" className="shrink-0">
            <SparklesIcon data-icon="inline-start" />
            Sample
          </Badge>
        </div>
        <p className="line-clamp-2 text-xs/relaxed text-muted-foreground">{sample.description}</p>
        <p className="text-[0.7rem] text-muted-foreground">
          {plural(digest.levels.length, "level")} · {plural(digest.counts.lights, "light")} · {plural(digest.counts.tokens, "token")}
        </p>
        <div className="mt-auto pt-1">
          <Button variant="outline" size="sm" onClick={onOpenCopy} onPointerEnter={onIntent} disabled={disabled}>
            {busy ? <Spinner className="size-3" data-icon="inline-start" /> : <CopyPlusIcon data-icon="inline-start" />}
            {actionLabel}
          </Button>
        </div>
      </div>
    </Card>
  )
}
