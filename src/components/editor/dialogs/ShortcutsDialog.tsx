import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SHORTCUTS } from "@/editor/shortcuts"

const EXTRA: { keys: string; description: string }[] = [
  { keys: "Ctrl+S", description: "Save a new version" },
  { keys: "?", description: "Show this list" },
  { keys: "Alt (hold)", description: "Free placement (no snapping)" },
  { keys: "Shift (wall tool)", description: "Constrain to 45°" },
  { keys: "Enter / Double-click", description: "Finish a wall chain or ruler" },
]

const MOUSE: { keys: string; description: string }[] = [
  { keys: "Right-drag", description: "Orbit the camera" },
  { keys: "Middle-drag", description: "Pan" },
  { keys: "Wheel", description: "Zoom toward the cursor" },
  { keys: "Right-click", description: "Finish walls / rulers" },
]

function Keys({ keys }: { keys: string }) {
  const alternatives = keys.split(" / ")
  return (
    <span className="flex flex-wrap items-center justify-end gap-1">
      {alternatives.map((alt, i) => (
        <KbdGroup key={alt}>
          {i > 0 ? <span className="text-[0.625rem] text-muted-foreground">or</span> : null}
          {alt.split("+").map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </KbdGroup>
      ))}
    </span>
  )
}

function Group({ title, rows }: { title: string; rows: { keys: string; description: string }[] }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-1 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">{title}</h3>
      <div className="flex flex-col">
        {rows.map((r) => (
          <div key={r.keys + r.description} className="flex items-center justify-between gap-4 rounded-md px-1 py-1 text-xs hover:bg-muted/40">
            <span className="text-foreground/85">{r.description}</span>
            <Keys keys={r.keys} />
          </div>
        ))}
      </div>
    </section>
  )
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const tools = SHORTCUTS.filter((s) => s.action.type === "tool")
  const editing = SHORTCUTS.filter((s) => s.action.type !== "tool")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts work while the pointer or focus is on the map (not inside text fields). Cmd works as Ctrl on macOS.</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <div className="grid gap-6 pr-3 sm:grid-cols-2">
            <div className="flex flex-col gap-5">
              <Group title="Tools" rows={tools} />
              <Group title="Mouse" rows={MOUSE} />
            </div>
            <div className="flex flex-col gap-5">
              <Group title="Editing" rows={editing} />
              <Group title="Also" rows={EXTRA} />
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
