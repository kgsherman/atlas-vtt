import * as React from "react"
import { CircleUserRound, LibraryBig } from "lucide-react"
import { Link, useLocation } from "wouter"

import { paths, preloadRoute } from "@/app/routes"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { AppLogo } from "./AppLogo"
import { IdentityChip } from "./IdentityChip"
import { LogInButton } from "./LogInButton"
import { ModeBadge } from "./ModeBadge"
import { ThemeToggle } from "./ThemeToggle"

/** The app's own tabs: the library (home) and the Token Maker. */
function AppNav() {
  const [location] = useLocation()
  const tabs = [
    { href: paths.home(), label: "Library", icon: <LibraryBig data-icon="inline-start" />, active: location === "/" },
    { href: paths.tokens(), label: "Token maker", icon: <CircleUserRound data-icon="inline-start" />, active: location.startsWith("/tokens") },
  ]
  return (
    <nav aria-label="Atlas" className="flex items-center gap-1">
      {tabs.map((t) => (
        <Button
          key={t.href}
          variant={t.active ? "secondary" : "ghost"}
          size="sm"
          nativeButton={false}
          aria-current={t.active ? "page" : undefined}
          onPointerEnter={t.href === paths.tokens() ? () => preloadRoute("tokens") : undefined}
          render={<Link href={t.href} />}
        >
          {t.icon}
          <span className="hidden sm:inline">{t.label}</span>
        </Button>
      ))}
    </nav>
  )
}

/** Top bar for the app's document-style pages (home, join, shared, token maker). */
export function AppHeader({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <header
      className={cn("sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/60", className)}
    >
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40" aria-label="Atlas VTT home">
          <AppLogo />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-1">{children ?? <AppNav />}</div>
        <div className="flex items-center gap-1 sm:gap-2">
          <ModeBadge />
          <ThemeToggle />
          <IdentityChip />
          <LogInButton />
        </div>
      </div>
    </header>
  )
}
