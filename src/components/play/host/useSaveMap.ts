/**
 * "Save map to library" for the DM's host console: writes the live session's map (as it is now:
 * token positions, hidden tokens, doors and lights included) as a new version of the library scene
 * the session was started from. Earlier versions stay in version history.
 *
 * The library scene is found through the DM's session list (sessions.scene_id). Conflicts: after a
 * save here, later saves pass `baseVersion`; the first save treats a library scene updated after the
 * session started as changed elsewhere and asks before overwriting. "Dirty" (the map was edited in
 * Edit map since the last save) is remembered per session on this device.
 */
import * as React from "react"
import { toast } from "sonner"

import { useServices } from "@/app/services"
import { userMessage } from "@/app/library"
import { useConfirm } from "@/components/editor/context"
import type { Scene } from "@/core/scene/types"
import { isNetError } from "@/net/supabase"

export type LibraryLink =
  | { status: "loading" }
  | { status: "linked"; sceneId: string; name: string }
  /** The session's library scene was deleted (or the session has none). */
  | { status: "deleted" }
  | { status: "unavailable"; error: string }

export interface SaveMap {
  library: LibraryLink
  saving: boolean
  /** The map was edited (Edit map) since the session started or the last save to the library. */
  dirty: boolean
  markDirty(): void
  /**
   * Save to the library. `confirm` (default true) asks first; `force` overwrites a library scene
   * changed elsewhere. Resolves true when saved.
   */
  save(opts?: { confirm?: boolean; force?: boolean }): Promise<boolean>
}

interface Persisted {
  dirty: boolean
  savedVersion: number | null
}

const storageKey = (sessionId: string) => `atlas-host:library:${sessionId}`

function readPersisted(sessionId: string): Persisted {
  try {
    const raw = localStorage.getItem(storageKey(sessionId))
    const v = raw ? (JSON.parse(raw) as Partial<Persisted>) : null
    return {
      dirty: v?.dirty === true,
      savedVersion: typeof v?.savedVersion === "number" ? v.savedVersion : null,
    }
  } catch {
    return { dirty: false, savedVersion: null }
  }
}

function writePersisted(sessionId: string, p: Persisted): void {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(p))
  } catch {
    // Storage blocked: the flag lasts for this page only.
  }
}

/** Whether the library scene changed after the session started (by its row's update time). */
export function changedSinceStart(
  summaryUpdatedAt: string,
  sessionCreatedAt: string
): boolean {
  const u = Date.parse(summaryUpdatedAt)
  const c = Date.parse(sessionCreatedAt)
  return Number.isFinite(u) && Number.isFinite(c) && u > c
}

export function useSaveMap(
  sessionId: string,
  liveScene: () => Scene | null
): SaveMap {
  const services = useServices()
  const confirm = useConfirm()
  const [library, setLibrary] = React.useState<LibraryLink>({
    status: "loading",
  })
  const [persisted, setPersisted] = React.useState(() =>
    readPersisted(sessionId)
  )
  const [saving, setSaving] = React.useState(false)
  const sessionStart = React.useRef<string | null>(null)
  const persistedRef = React.useRef(persisted)
  const liveRef = React.useRef(liveScene)
  React.useEffect(() => {
    persistedRef.current = persisted
    liveRef.current = liveScene
  })

  const update = React.useCallback(
    (p: Persisted) => {
      persistedRef.current = p
      writePersisted(sessionId, p)
      setPersisted(p)
    },
    [sessionId]
  )

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const session = (await services.sessions.listMySessions()).find(
          (s) => s.id === sessionId
        )
        sessionStart.current = session?.createdAt ?? null
        const summary = session?.sceneId
          ? await services.scenes.get(session.sceneId)
          : null
        if (cancelled) return
        setLibrary(
          summary
            ? { status: "linked", sceneId: summary.id, name: summary.name }
            : { status: "deleted" }
        )
      } catch (err) {
        if (!cancelled)
          setLibrary({ status: "unavailable", error: userMessage(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [services, sessionId])

  const markDirty = React.useCallback(() => {
    if (!persistedRef.current.dirty)
      update({ ...persistedRef.current, dirty: true })
  }, [update])

  const saveRef = React.useRef<SaveMap["save"]>(async () => false)
  const save = React.useCallback<SaveMap["save"]>(
    async (opts = {}) => {
      if (library.status !== "linked") {
        toast.error("There is no library scene to save to", {
          description:
            library.status === "deleted"
              ? "The scene this session was started from was deleted from your library."
              : library.status === "unavailable"
                ? library.error
                : "Still looking up the library scene. Try again in a moment.",
        })
        return false
      }
      if (opts.confirm !== false) {
        const ok = await confirm({
          title: "Save the live map to your library?",
          description: `Saves a new version of “${library.name}”. Token positions, hidden tokens, doors and lights are saved as they are now. Earlier versions stay in version history.`,
          confirmLabel: "Save map",
        })
        if (!ok) return false
      }
      const scene = liveRef.current()
      if (!scene) return false
      setSaving(true)
      const conflict = () => {
        toast.error("The library map was changed since this session started", {
          description:
            "Overwrite it with the live map, or keep the library version. Either way, earlier versions stay in version history.",
          duration: 12_000,
          action: {
            label: "Overwrite",
            onClick: () =>
              void saveRef.current({ confirm: false, force: true }),
          },
        })
      }
      try {
        const summary = await services.scenes.get(library.sceneId)
        if (!summary) {
          setLibrary({ status: "deleted" })
          toast.error("The library scene was deleted", {
            description: "There is nothing to save the map to.",
          })
          return false
        }
        let baseVersion: number | undefined
        if (!opts.force) {
          const saved = persistedRef.current.savedVersion
          if (saved !== null) baseVersion = saved
          else if (
            sessionStart.current &&
            changedSinceStart(summary.updatedAt, sessionStart.current)
          ) {
            conflict()
            return false
          } else baseVersion = summary.latestVersion
        }
        const doc: Scene = {
          ...scene,
          name: summary.name,
          updatedAt: new Date().toISOString(),
        }
        const version = await services.scenes.saveVersion(
          library.sceneId,
          doc,
          {
            baseVersion,
            name: summary.name,
          }
        )
        update({ dirty: false, savedVersion: version })
        toast.success(`Saved version ${version}`, {
          description: `“${summary.name}” in your library now has the live map.`,
        })
        return true
      } catch (err) {
        if (isNetError(err, "version_conflict")) conflict()
        else
          toast.error("Couldn't save the map", {
            description: userMessage(err),
          })
        return false
      } finally {
        setSaving(false)
      }
    },
    [library, confirm, services, update]
  )
  React.useEffect(() => {
    saveRef.current = save
  }, [save])

  return { library, saving, dirty: persisted.dirty, markDirty, save }
}
