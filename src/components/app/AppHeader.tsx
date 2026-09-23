import * as React from "react"
import { Link } from "wouter"

import { cn } from "@/lib/utils"

import { AppLogo } from "./AppLogo"
import { IdentityChip } from "./IdentityChip"
import { LogInButton } from "./LogInButton"
import { ModeBadge } from "./ModeBadge"
import { ThemeToggle } from "./ThemeToggle"

/** Top bar for the app's document-style pages (home, join, shared). */
export function AppHeader({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <header
      className={cn("sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/60", className)}
    >
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40" aria-label="Atlas VTT home">
          <AppLogo />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
        <div className="flex items-center gap-1 sm:gap-2">
          <ModeBadge />
          <ThemeToggle />
          <LogInButton />
          <IdentityChip />
        </div>
      </div>
    </header>
  )
}
