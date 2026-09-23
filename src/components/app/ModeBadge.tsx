import { CloudIcon, HardDriveIcon } from "lucide-react"

import { currentMode, modeSwitchUrl } from "@/app/mode"
import { useServices } from "@/app/services"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/** "Cloud" / "Local" chip with an explanation and a way to switch. */
export function ModeBadge({ className }: { className?: string }) {
  const { mode } = useServices()
  const resolution = currentMode()
  const cloud = mode === "supabase"
  const Icon = cloud ? CloudIcon : HardDriveIcon
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[0.7rem] font-medium transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 data-popup-open:bg-muted sm:px-2.5",
          cloud ? "border-primary/30 text-foreground" : "border-border text-muted-foreground",
          className
        )}
      >
        <span className={cn("size-1.5 rounded-full", cloud ? "bg-primary" : "bg-muted-foreground")} />
        <Icon className="size-3" />
        <span className="hidden sm:inline">{cloud ? "Cloud" : "Local"}</span>
        <span className="sr-only sm:hidden">{cloud ? "Cloud mode" : "Local mode"}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle className="flex items-center gap-2">
            <Icon className="size-4 text-muted-foreground" />
            {cloud ? "Cloud mode" : "Local mode"}
          </PopoverTitle>
          <PopoverDescription className="text-xs/relaxed">
            {cloud
              ? "Scenes are saved to your Atlas account and games run over secure realtime channels. Players join from anywhere with a room code."
              : "Scenes are stored in this browser only. Games work between tabs of this browser — each tab is a separate user. Meant for testing; it is not secure."}
          </PopoverDescription>
        </PopoverHeader>
        {resolution.cloudAvailable ? (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => window.location.assign(modeSwitchUrl(cloud ? "local" : "supabase", window.location.origin + "/"))}
          >
            {cloud ? <HardDriveIcon data-icon="inline-start" /> : <CloudIcon data-icon="inline-start" />}
            {cloud ? "Switch to local mode (this tab)" : "Switch to Cloud mode"}
          </Button>
        ) : (
          <p className="text-xs/relaxed text-muted-foreground">
            Cloud mode needs <code className="rounded bg-muted px-1 font-mono text-[0.65rem]">VITE_SUPABASE_URL</code> and{" "}
            <code className="rounded bg-muted px-1 font-mono text-[0.65rem]">VITE_SUPABASE_PUBLISHABLE_KEY</code> in{" "}
            <code className="font-mono text-[0.65rem]">.env.local</code>.
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
