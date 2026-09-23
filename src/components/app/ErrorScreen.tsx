import * as React from "react"
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

import { AppLogo } from "./AppLogo"

export interface ErrorScreenProps {
  title: string
  description?: React.ReactNode
  /** Numbered steps (e.g. how to fix a configuration problem). */
  steps?: React.ReactNode[]
  /** Technical details, collapsed by default. */
  details?: string
  icon?: React.ReactNode
  actions?: React.ReactNode
  /** Render inside a page (no full-screen chrome). */
  inline?: boolean
}

/** A calm, actionable error state. */
export function ErrorScreen({ title, description, steps, details, icon, actions, inline = false }: ErrorScreenProps) {
  const body = (
    <div className="flex w-full max-w-md animate-in flex-col gap-5 duration-300 fade-in-0 slide-in-from-bottom-2">
      <div className="flex flex-col gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive ring-1 ring-destructive/20">
          {icon ?? <TriangleAlertIcon className="size-5" />}
        </div>
        <h1 className="font-heading text-xl font-semibold tracking-tight text-balance">{title}</h1>
        {description && <div className="text-sm/relaxed text-pretty text-muted-foreground">{description}</div>}
      </div>
      {steps && steps.length > 0 && (
        <ol className="flex flex-col gap-2 rounded-lg bg-card p-3 text-xs/relaxed ring-1 ring-foreground/10">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground tabular-nums">
                {i + 1}
              </span>
              <span className="pt-0.5">{step}</span>
            </li>
          ))}
        </ol>
      )}
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      {details && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground">
            Technical details
            <ChevronDownIcon className="size-3.5 transition-transform group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2.5 font-mono text-[0.7rem]/relaxed whitespace-pre-wrap text-muted-foreground">
              {details}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
  if (inline) return <div className="flex w-full justify-center px-4 py-16">{body}</div>
  return (
    <div className={cn("flex min-h-svh flex-col bg-background text-foreground")}>
      <header className="flex h-14 items-center px-5">
        <a href="/" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          <AppLogo />
        </a>
      </header>
      <main className="flex flex-1 items-center justify-center px-5 pb-20">{body}</main>
    </div>
  )
}

/** Primary/secondary action buttons shaped for ErrorScreen. */
export function ErrorAction(props: React.ComponentProps<typeof Button>) {
  return <Button size="lg" {...props} />
}
