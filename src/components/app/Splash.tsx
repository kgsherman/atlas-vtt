import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

import { AppLogoMark } from "./AppLogo"

/** Full-screen loading state (app start, lazy pages). Fades in after a short delay so fast loads never flash. */
export function Splash({ label, className }: { label?: string; className?: string }) {
  return (
    <div
      className={cn("flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-6 text-foreground", className)}
      role="status"
      aria-live="polite"
    >
      <div className="flex animate-in flex-col items-center gap-5 delay-150 duration-500 fade-in-0 fill-mode-both zoom-in-95">
        <div className="relative">
          <div className="absolute inset-0 -m-6 animate-pulse rounded-full bg-primary/25 blur-2xl" />
          <AppLogoMark className="relative size-14" />
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <div className="font-heading text-lg font-semibold tracking-tight">Atlas VTT</div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            <span>{label ?? "Loading…"}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/** In-page loading state (Suspense fallback for lazy routes). */
export function PageLoader({ label }: { label?: string }) {
  return <Splash label={label ?? "Loading…"} />
}
