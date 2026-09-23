import * as React from "react"
import { Globe2, Layers, Lightbulb, SlidersHorizontal } from "lucide-react"

import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { useEditorContext } from "./context"
import { InspectorPanel } from "./panels/InspectorPanel"
import { LevelsPanel } from "./panels/LevelsPanel"
import { LightsPanel } from "./panels/LightsPanel"
import { ScenePanel } from "./panels/ScenePanel"

export type SidebarTab = "levels" | "inspector" | "scene" | "lights"

const TABS: { value: SidebarTab; label: string; icon: React.ReactNode }[] = [
  { value: "levels", label: "Levels", icon: <Layers /> },
  { value: "inspector", label: "Inspector", icon: <SlidersHorizontal /> },
  { value: "scene", label: "Scene", icon: <Globe2 /> },
  { value: "lights", label: "Lights", icon: <Lightbulb /> },
]

export function Sidebar() {
  const { store } = useEditorContext()
  const [tab, setTab] = React.useState<SidebarTab>("levels")

  // Selecting something (from nothing) brings up the inspector, unless the lights list is in use.
  React.useEffect(
    () =>
      store.subscribe((s, prev) => {
        if (s.selection.length > 0 && prev.selection.length === 0) setTab((t) => (t === "lights" ? t : "inspector"))
      }),
    [store]
  )

  return (
    <aside aria-label="Properties" className="flex w-80 shrink-0 flex-col border-l bg-card/40">
      <Tabs value={tab} onValueChange={(v) => setTab(v as SidebarTab)} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="shrink-0 border-b px-2 py-2">
          <TabsList className="w-full">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="gap-1 text-[0.6875rem]">
                {t.icon}
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {TABS.map((t) => (
          <TabsContent key={t.value} value={t.value} className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              {t.value === "levels" ? <LevelsPanel /> : t.value === "inspector" ? <InspectorPanel /> : t.value === "scene" ? <ScenePanel /> : <LightsPanel />}
            </ScrollArea>
          </TabsContent>
        ))}
      </Tabs>
    </aside>
  )
}
