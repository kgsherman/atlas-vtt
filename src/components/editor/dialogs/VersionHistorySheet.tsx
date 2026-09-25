/**
 * A map's restore points (library versions): restoring one puts the live map back as it was then, as one
 * edit (undoable), for everyone at the table.
 */
import * as React from "react"
import { History, RotateCcw } from "lucide-react"

import { userMessage } from "@/app/library"
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

type LoadState = { status: "loading" } | { status: "ready"; versions: SceneVersionInfo[] } | { status: "error"; message: string }

/** The map's library entry, as version history needs it. */
export interface VersionsDocument {
  libraryId: string | null
  /** The restore point the live map is based on (its last one). */
  baseVersion: number | null
  busy: string | null
  listVersions(): Promise<SceneVersionInfo[]>
  /** Put the live map back as it was at `v`. */
  restoreVersion(v: SceneVersionInfo): Promise<void>
}

export function VersionHistorySheet({ open, onOpenChange, doc }: { open: boolean; onOpenChange(open: boolean): void; doc: VersionsDocument }) {
  const saveKey = useCommandLabel("editor", "save")
  const [state, setState] = React.useState<LoadState>({ status: "loading" })
  const { listVersions, libraryId, baseVersion } = doc

  React.useEffect(() => {
    if (!open) return
    let alive = true
    listVersions().then(
      (versions) => alive && setState({ status: "ready", versions }),
      (err: unknown) => alive && setState({ status: "error", message: userMessage(err) })
    )
    return () => {
      alive = false
      setState({ status: "loading" })
    }
  }, [open, listVersions, libraryId, baseVersion])

  const latest = state.status === "ready" ? (state.versions[0]?.version ?? null) : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-96 gap-0 p-0 sm:max-w-96">
        <SheetHeader className="border-b p-4">
          <SheetTitle className="flex items-center gap-2">
            <History className="size-4" /> Version history
          </SheetTitle>
          <SheetDescription>
            Changes save by themselves. A restore point is kept when you press {saveKey || "Save"}, close the table, change maps or leave (the newest 50).
            Restoring one puts the map back as it was then, for everyone at the table; you can undo it.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-2">
            {state.status === "loading" ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14 w-full" />) : null}
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
                  <EmptyTitle>No restore points yet</EmptyTitle>
                  <EmptyDescription>Save one{saveKey ? ` (${saveKey})` : ""} to keep the map as it is now.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {state.status === "ready"
              ? state.versions.map((v) => {
                  const isLatest = v.version === latest
                  const isBase = v.version === baseVersion
                  const supported = v.schemaVersion <= SCENE_SCHEMA_VERSION
                  return (
                    <div
                      key={v.version}
                      className={cn("flex items-center gap-3 rounded-md border border-transparent px-3 py-2", isBase && "border-primary/30 bg-primary/10")}
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex items-center gap-1.5 text-xs font-medium">
                          Version {v.version}
                          {isLatest ? (
                            <Badge variant="secondary" className="h-4 px-1.5 text-[0.625rem]">
                              Latest
                            </Badge>
                          ) : null}
                          {isBase ? (
                            <Badge variant="outline" className="h-4 px-1.5 text-[0.625rem]">
                              Current map's base
                            </Badge>
                          ) : null}
                        </div>
                        <span className="text-[0.6875rem] text-muted-foreground" title={new Date(v.createdAt).toLocaleString()}>
                          {relativeTime(v.createdAt)} · {new Date(v.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                          {!supported ? " · needs a newer Atlas" : ""}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="xs"
                        className="shrink-0"
                        disabled={!supported || doc.busy !== null}
                        onClick={() => void doc.restoreVersion(v).then(() => onOpenChange(false))}
                      >
                        <RotateCcw data-icon="inline-start" /> Restore
                      </Button>
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
