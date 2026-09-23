import { CompassIcon, HomeIcon } from "lucide-react"
import { Link } from "wouter"

import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

import { AppHeader } from "./AppHeader"

export function NotFoundPage() {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <AppHeader />
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <Empty className="max-w-md">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CompassIcon />
            </EmptyMedia>
            <EmptyTitle className="text-lg">Off the edge of the map</EmptyTitle>
            <EmptyDescription>This page doesn't exist. The link may be mistyped, or the scene or game has moved.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="lg" nativeButton={false} render={<Link href="/" />}>
              <HomeIcon data-icon="inline-start" />
              Back to your scenes
            </Button>
          </EmptyContent>
        </Empty>
      </main>
    </div>
  )
}
