import { cn } from "@/lib/utils"

/** The Atlas mark: three stacked storeys, the top one lit. */
export function AppLogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-6 shrink-0", className)}>
      <path d="M16 20.5 28 26 16 31.5 4 26Z" className="fill-foreground/5 stroke-foreground/35" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M16 12.5 28 18 16 23.5 4 18Z" className="fill-foreground/10 stroke-foreground/60" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M16 4.5 28 10 16 15.5 4 10Z" className="fill-primary stroke-primary" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="19.5" cy="9.6" r="1.7" className="fill-primary-foreground" />
    </svg>
  )
}

/** Mark + wordmark. */
export function AppLogo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <AppLogoMark />
      {!compact && (
        <span className="font-heading text-base leading-none font-semibold tracking-tight">
          Atlas<span className="ml-1 text-[0.65rem] font-medium tracking-[0.2em] text-muted-foreground">VTT</span>
        </span>
      )}
    </span>
  )
}
