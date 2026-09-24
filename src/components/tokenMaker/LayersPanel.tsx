/**
 * The Token Maker's layer stack (top of the list = drawn last), with the add menu: uploads by role,
 * the free token parts, and a solid backdrop.
 */
import * as React from "react"
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  Frame,
  ImagePlus,
  Layers,
  MoreHorizontal,
  PaintBucket,
  Plus,
  Sparkles,
  Trash2,
  UserRound,
  Wallpaper,
} from "lucide-react"
import { toast } from "sonner"

import { useServices } from "@/app/services"
import { PanelSection } from "@/components/editor/fields"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { moveLayer, removeLayer, updateLayer } from "@/core/tokenMaker/design"
import type { TokenLayer } from "@/core/tokenMaker/types"
import { cn } from "@/lib/utils"
import type { FreeTokenPart } from "@/net/freeAssets"
import { addFreePart, DEFAULT_FILL, insertIndex } from "@/tokenMaker/actions"

import { objectUrl, useMaker, useTokenMaker } from "./context"

function maskSummary(l: TokenLayer): string {
  if (l.source.type === "fill" && l.mask.shape === "disc") return "Solid colour · disc"
  if (l.mask.shape === "none") return l.mask.strokes.length ? "Whole canvas · painted" : "Whole canvas"
  const parts = ["Disc"]
  if (l.mask.popOut) parts.push("pops out")
  if (l.mask.strokes.length) parts.push("painted")
  return parts.join(" · ")
}

function LayerThumb({ layer }: { layer: TokenLayer }) {
  const blob = useMaker((s) => (layer.source.type === "image" ? s.images[layer.source.imageId]?.blob : undefined))
  const url = objectUrl(blob)
  if (layer.source.type === "fill")
    return <span aria-hidden className="size-8 shrink-0 rounded-md ring-1 ring-border" style={{ backgroundColor: layer.source.color }} />
  return (
    <span aria-hidden className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md atlas-checkerboard ring-1 ring-border">
      {url ? <img src={url} alt="" className="size-full object-contain" /> : null}
    </span>
  )
}

export function LayersPanel({ className }: { className?: string }) {
  const { store, cache, pickFile } = useTokenMaker()
  const services = useServices()
  const design = useMaker((s) => s.design)
  const selectedId = useMaker((s) => s.selectedId)
  const working = useMaker((s) => s.working)
  const parts = React.useMemo(() => services.freeAssets.tokenParts(), [services.freeAssets])
  const [adding, setAdding] = React.useState<string | null>(null)

  const addPart = async (part: FreeTokenPart) => {
    setAdding(part.id)
    try {
      await addFreePart(store, cache, part)
    } catch (err) {
      toast.error("Couldn't add that part", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setAdding(null)
    }
  }

  const edit = (next: typeof design) => store.getState().commit(next)
  const top = design.layers.length - 1
  const full = design.layers.length >= 12

  return (
    <PanelSection
      className={cn("min-h-0", className)}
      title={
        <span className="flex items-center gap-1.5">
          <Layers className="size-3.5" /> Layers
        </span>
      }
      action={
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={full || adding !== null} />}>
            {adding ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />} Add
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Upload an image</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => pickFile("subject")}>
                <UserRound /> Character art…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => pickFile("background")}>
                <Wallpaper /> Background…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => pickFile("frame")}>
                <Frame /> Frame or ring…
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {parts.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Free</DropdownMenuLabel>
                  {parts.map((p) => (
                    <DropdownMenuItem key={p.id} onClick={() => void addPart(p)}>
                      {p.role === "frame" ? <Frame /> : <Wallpaper />} {p.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => store.getState().addFillLayer(DEFAULT_FILL, "Solid backdrop", "background", insertIndex(store.getState().design, "background"))}
            >
              <PaintBucket /> Solid colour backdrop
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {design.layers.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">No layers yet.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Layers, top first">
          {[...design.layers].reverse().map((l) => {
            const index = design.layers.indexOf(l)
            const isSel = l.id === selectedId
            const busy = working[l.id]
            return (
              <li key={l.id}>
                <div
                  className={cn(
                    "group flex items-center gap-2 rounded-lg p-1.5 ring-1 ring-transparent transition-colors",
                    isSel ? "bg-muted ring-border" : "hover:bg-muted/50",
                    !l.visible && "opacity-60"
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    aria-pressed={isSel}
                    onClick={() => store.getState().select(l.id)}
                  >
                    <LayerThumb layer={l} />
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate text-xs font-medium">{l.name || "Layer"}</span>
                      <span className="flex items-center gap-1 truncate text-[0.6875rem] text-muted-foreground">
                        {busy ? (
                          <>
                            <Sparkles className="size-3 text-primary" /> {busy}
                          </>
                        ) : (
                          maskSummary(l)
                        )}
                      </span>
                    </span>
                  </button>
                  {busy ? <Spinner className="size-3.5" /> : null}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
                          onClick={() => edit(updateLayer(design, l.id, (x) => ({ ...x, visible: !x.visible })))}
                        />
                      }
                    >
                      {l.visible ? <Eye /> : <EyeOff />}
                    </TooltipTrigger>
                    <TooltipContent>{l.visible ? "Hide layer" : "Show layer"}</TooltipContent>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`More actions for ${l.name}`} />}>
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem disabled={index === top} onClick={() => edit(moveLayer(design, l.id, index + 1))}>
                        <ArrowUp /> Bring forward
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={index === 0} onClick={() => edit(moveLayer(design, l.id, index - 1))}>
                        <ArrowDown /> Send backward
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => edit(removeLayer(design, l.id))}>
                        <Trash2 /> Delete layer
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <p className="flex items-center gap-1.5 pt-1 text-[0.6875rem] text-muted-foreground">
        <ImagePlus className="size-3" /> Drop images anywhere to add character art.
      </p>
    </PanelSection>
  )
}
