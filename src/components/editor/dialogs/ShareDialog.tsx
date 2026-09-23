import * as React from "react"
import { Check, Copy, Link2, RefreshCw, ShieldAlert } from "lucide-react"
import { toast } from "sonner"

import { paths } from "@/app/routes"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"

import { errorText, type SceneDocument } from "../useSceneDocument"

function shareUrl(slug: string): string {
  return `${location.origin}${paths.shared(slug)}`
}

export function ShareDialog({ open, onOpenChange, doc }: { open: boolean; onOpenChange(open: boolean): void; doc: SceneDocument }) {
  const [busy, setBusy] = React.useState<"on" | "off" | "rotate" | null>(null)
  const [copied, setCopied] = React.useState(false)
  const slug = doc.summary?.visibility === "link" ? doc.summary.shareSlug : null
  const url = slug ? shareUrl(slug) : null

  const run = async (kind: "on" | "off" | "rotate") => {
    setBusy(kind)
    try {
      const next = await doc.setSharing(kind === "off" ? "private" : "link", { rotate: kind === "rotate" })
      if (kind === "off") toast.success("Link sharing is off", { description: "The old link no longer works." })
      else if (next) {
        await copy(shareUrl(next), true)
        if (kind === "rotate") toast.success("New link created", { description: "The previous link stopped working." })
      }
    } catch (err) {
      toast.error("Could not change sharing", { description: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  const copy = async (text: string, quiet = false) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      if (!quiet) toast.success("Link copied")
      else toast.success("Share link copied to the clipboard")
    } catch {
      if (!quiet) toast.error("Could not copy — select the link and copy it manually")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="size-4" /> Share “{doc.summary?.name ?? "this scene"}”
          </DialogTitle>
          <DialogDescription>Anyone with the link can open a read-only copy of the latest saved version.</DialogDescription>
        </DialogHeader>
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertTitle>The link publishes the full DM document</AlertTitle>
          <AlertDescription>
            Hidden objects and tokens, secret doors, DM notes and every level are visible to whoever has the link. Share it with co-DMs, not with players — players see the map through a
            session.
          </AlertDescription>
        </Alert>
        {url ? (
          <InputGroup className="h-8">
            <InputGroupInput readOnly value={url} className="font-mono text-[0.6875rem]" onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="xs" onClick={() => void copy(url)}>
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy"}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        ) : !doc.libraryId ? (
          <p className="text-xs text-muted-foreground">The scene is saved to your library first.</p>
        ) : null}
        <DialogFooter className="gap-2 sm:justify-between">
          {url ? (
            <>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run("rotate")}>
                {busy === "rotate" ? <Spinner className="size-3.5" /> : <RefreshCw data-icon="inline-start" />}
                New link
              </Button>
              <Button variant="destructive" size="sm" disabled={busy !== null} onClick={() => void run("off")}>
                {busy === "off" ? <Spinner className="size-3.5" /> : null}
                Stop sharing
              </Button>
            </>
          ) : (
            <Button size="sm" className="ml-auto" disabled={busy !== null || doc.storage !== "remote"} onClick={() => void run("on")}>
              {busy === "on" ? <Spinner className="size-3.5" /> : <Link2 data-icon="inline-start" />}
              Create link and copy
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
