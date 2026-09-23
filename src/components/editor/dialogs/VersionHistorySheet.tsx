import * as React from "react"
import { Eye, History, RotateCcw } from "lucide-react"

import { useCommandLabel } from "@/components/keybindings/keymapStore"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { SCENE_SCHEMA_VERSION } from "@/core/scene/types"
import type { SceneVersionInfo } from "@/net/scenesRepo"
import { cn } from "@/lib/utils"

import { relativeTime } from "../lib/format"
import { errorText, type SceneDocument } from "../useSceneDocument"

type LoadState = { status: "loading" } | { status: "ready"; versions: SceneVersionInfo[] } | { status: "error"; message: string }

export function VersionHistorySheet({ open, onOpenChange, doc }: { open: boolean; onOpenChange(open: boolean): void; doc: SceneDocument }) {
  const saveKey = useCommandLabel("editor", "save")
  const [state, setState] = React.useState<LoadState>({ status: "loading" })
  const { listVersions, libraryId, baseVersion } = doc

  React.useEffect(() => {
    if (!open) return
    let alive = true
    listVersions().then(
      (versions) => alive && setState({ status: "ready", versions }),
      (err: unknown) => alive && setState({ status: "error", message: errorText(err) })
    )
    return () => {
      alive = false
      setState({ status: "loading" })
    }
  }, [open, listVersions, libraryId, baseVersion])

  const latest = state.status === "ready" ? (state.versions[0]?.version ?? null) : null
  const viewing = doc.viewingVersion?.version ?? null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-96 gap-0 p-0 sm:max-w-96">
        <SheetHeader className="border-b p-4">
          <SheetTitle className="flex items-center gap-2">
            <History className="size-4" /> Version history
          </SheetTitle>
          <SheetDescription>Every save is kept as a version (the newest 50). Open one read-only, or restore it as a new version.</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-2">
            {state.status === "loading"
              ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14 w-full" />)
              : null}
            {state.status === "error" ? (
              <Empty className="p-6">
                <EmptyHeader>
                  <EmptyTitle>Could not load versions</EmptyTitle>
                  <EmptyDescription>{state.message}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {state.status === "ready" && state.versions.length === 0 ? (
              <Empty className="p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <History />
                  </EmptyMedia>
                  <EmptyTitle>No versions yet</EmptyTitle>
                  <EmptyDescription>Save the scene{saveKey ? ` (${saveKey})` : ""} to create the first version.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {state.status === "ready"
              ? state.versions.map((v) => {
                  const isLatest = v.version === latest
                  const isViewing = viewing === v.version || (viewing === null && isLatest)
                  const supported = v.schemaVersion <= SCENE_SCHEMA_VERSION
                  return (
                    <div key={v.version} className={cn("flex items-center gap-3 rounded-md border border-transparent px-3 py-2", isViewing && "border-primary/30 bg-primary/10")}>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex items-center gap-1.5 text-xs font-medium">
                          Version {v.version}
                          {isLatest ? (
                            <Badge variant="secondary" className="h-4 px-1.5 text-[0.625rem]">
                              Latest
                            </Badge>
                          ) : null}
                          {isViewing ? (
                            <Badge variant="outline" className="h-4 px-1.5 text-[0.625rem]">
                              Open
                            </Badge>
                          ) : null}
                        </div>
                        <span className="text-[0.6875rem] text-muted-foreground" title={new Date(v.createdAt).toLocaleString()}>
                          {relativeTime(v.createdAt)} · {new Date(v.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                          {!supported ? " · needs a newer Atlas" : ""}
                        </span>
                      </div>
                      {isLatest ? (
                        viewing !== null ? (
                          <Button variant="outline" size="xs" onClick={() => void doc.backToLatest().then(() => onOpenChange(false))}>
                            Open
                          </Button>
                        ) : null
                      ) : (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button variant="ghost" size="xs" disabled={!supported || doc.busy !== null} onClick={() => void doc.openVersion(v).then(() => onOpenChange(false))}>
                            <Eye data-icon="inline-start" /> View
                          </Button>
                          <Button variant="outline" size="xs" disabled={!supported || doc.busy !== null} onClick={() => void doc.restoreVersion(v).then(() => onOpenChange(false))}>
                            <RotateCcw data-icon="inline-start" /> Restore
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })
              : null}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
