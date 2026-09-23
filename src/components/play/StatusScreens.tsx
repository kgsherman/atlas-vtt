/**
 * Full-viewport states over the map: joining, removed from the session, session ended, errors.
 */
import * as React from "react"
import { Ban, DoorClosed, Home, RotateCcw, TriangleAlert } from "lucide-react"
import { useLocation } from "wouter"

import { paths } from "@/app/routes"
import { AppLogoMark } from "@/components/app/AppLogo"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

import { glass } from "./hud"

export function CenterCard({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center p-6">
      <div
        className={cn(
          "pointer-events-auto w-full max-w-sm rounded-xl",
          glass,
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}

/** Blocking screen (the map underneath is meaningless): dims everything. */
export function BlockingScreen({
  icon,
  title,
  description,
  actions,
}: {
  icon: React.ReactNode
  title: string
  description: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-background/80 p-6 backdrop-blur-sm">
      <Empty className={cn("max-w-md rounded-xl", glass)}>
        <EmptyHeader>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {actions ? (
          <EmptyContent className="flex-row justify-center">
            {actions}
          </EmptyContent>
        ) : null}
      </Empty>
    </div>
  )
}

export function JoiningScreen({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <AppLogoMark className="size-10 animate-pulse" />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> {label}
        </div>
      </div>
    </div>
  )
}

export function HomeButton({
  variant = "default",
}: {
  variant?: "default" | "outline"
}) {
  const [, navigate] = useLocation()
  return (
    <Button variant={variant} onClick={() => navigate(paths.home())}>
      <Home data-icon="inline-start" /> Back to home
    </Button>
  )
}

export function KickedScreen() {
  return (
    <BlockingScreen
      icon={<Ban />}
      title="You were removed from this session"
      description="The DM removed you from the table. Ask them for a new invitation if this was a mistake."
      actions={<HomeButton />}
    />
  )
}

export function EndedScreen({ who = "The DM" }: { who?: string }) {
  return (
    <BlockingScreen
      icon={<DoorClosed />}
      title="This session has ended"
      description={`${who} closed the table. Thanks for playing!`}
      actions={<HomeButton />}
    />
  )
}

export function ErrorScreenOverlay({
  title,
  message,
  onRetry,
}: {
  title: string
  message: string | null
  onRetry?: () => void
}) {
  return (
    <BlockingScreen
      icon={<TriangleAlert />}
      title={title}
      description={message ?? "Something went wrong."}
      actions={
        <>
          {onRetry ? (
            <Button onClick={onRetry}>
              <RotateCcw data-icon="inline-start" /> Try again
            </Button>
          ) : null}
          <HomeButton variant={onRetry ? "outline" : "default"} />
        </>
      }
    />
  )
}
