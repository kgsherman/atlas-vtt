/**
 * The card floating at the target of a move that found no path (PlayController "stranded" moves):
 * explains why and offers a jump there. Rendered inside EngineCanvas; follows the target on screen by
 * writing its transform every frame (camera pans and zooms), no React render per frame.
 */
import * as React from "react"
import { MoveUpRight, Route } from "lucide-react"

import { useEngine } from "@/components/canvas/engineContext"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { groundY, type PlayController } from "@/play"

/** Gap between the target point and the card (CSS px). */
const GAP = 22
const MARGIN = 8
/** Room left for the ruler's label above the target when the card has to go above it (CSS px). */
const LABEL_CLEARANCE = 30

export function StrandedMove({ controller }: { controller: PlayController }) {
  const { engine, canvas } = useEngine()
  const subscribe = React.useCallback(
    (cb: () => void) => controller.subscribe(cb),
    [controller]
  )
  const stranded = React.useSyncExternalStore(subscribe, () =>
    controller.getStranded()
  )
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!engine || !canvas || !stranded) return
    const scene = controller.getScene()
    const y = scene ? groundY(scene, stranded.levelId, stranded.position) : 0
    const place = () => {
      const el = ref.current
      if (!el) return
      const p = engine.project({
        x: stranded.position.x,
        y,
        z: stranded.position.z,
      })
      if (!p.visible) {
        el.style.visibility = "hidden"
        return
      }
      const w = el.offsetWidth
      const h = el.offsetHeight
      // Below the target, centred (the ruler's label is above it); above it near the bottom edge.
      let top = p.y + GAP
      if (top + h > canvas.clientHeight - MARGIN) top = p.y - GAP - h - LABEL_CLEARANCE
      const left = Math.min(
        Math.max(MARGIN, p.x - w / 2),
        canvas.clientWidth - MARGIN - w
      )
      el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
      el.style.visibility = "visible"
    }
    place()
    return engine.onFrame(place)
  }, [engine, canvas, controller, stranded])

  if (!stranded) return null
  return (
    <div
      ref={ref}
      className="pointer-events-auto absolute top-0 left-0 z-20"
      style={{ visibility: "hidden" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Card size="sm" className="w-64 shadow-lg ring-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <Route className="size-3.5 text-destructive" />
            {stranded.blocked
              ? "Something's in the way"
              : stranded.reason === "no-ground"
                ? "No floor there"
                : "Can't find a path"}
          </CardTitle>
          <CardDescription>
            {stranded.blocked
              ? "There's no room to stand there."
              : stranded.reason === "no-ground"
                ? "As far as you know there's nothing to stand on. The DM decides if a jump lands."
                : "Nothing you know of leads there. You can jump instead of walking."}
          </CardDescription>
        </CardHeader>
        <CardFooter className="gap-2">
          {stranded.blocked ? null : (
            <Button size="sm" onClick={() => controller.jumpStranded()}>
              <MoveUpRight data-icon="inline-start" />
              Jump there
            </Button>
          )}
          <Button
            size="sm"
            variant={stranded.blocked ? "outline" : "ghost"}
            onClick={() => controller.dismissStranded()}
          >
            {stranded.blocked ? "OK" : "Cancel"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
