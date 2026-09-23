/**
 * "Save map to library" for the DM's host console (ARCHITECTURE §6.2): HostRunner.saveMapToLibrary
 * writes the live session's map (as it is now: token positions, hidden tokens, doors and lights
 * included) as a new version of the library scene the session was started from — the game's origin,
 * exposed as HostSnapshot.library. Earlier versions stay in version history.
 *
 * The origin records the library version the live map is based on, so a version saved meanwhile
 * elsewhere (e.g. in the editor) is a version_conflict; the conflict toast offers "Overwrite" (force).
 * Games saved before the origin was recorded have no base version: their first save treats a library
 * scene updated after the session started as changed elsewhere and asks first. "Dirty" (the map was
 * edited in Edit map since the session started or the last save) is the origin's flag, stored with the
 * game, so it survives reloads and devices.
 */
import * as React from "react"
import { toast } from "sonner"

import { useServices } from "@/app/services"
import { userMessage } from "@/app/library"
import { useConfirm } from "@/components/editor/context"
import type { HostRunner, HostSnapshot } from "@/net/host"
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
  /**
   * Save to the library. `confirm` (default true) asks first; `force` overwrites a library scene
   * changed elsewhere. Resolves true when saved.
   */
  save(opts?: { confirm?: boolean; force?: boolean }): Promise<boolean>
}

export type SaveMapRunner = Pick<HostRunner, "saveMapToLibrary">

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
  runner: SaveMapRunner,
  snap: Pick<HostSnapshot, "sessionId" | "library">
): SaveMap {
  const services = useServices()
  const confirm = useConfirm()
  const origin = snap.library
  const sceneId = origin?.sceneId ?? null
  const [lookup, setLookup] = React.useState<{
    sceneId: string
    link: LibraryLink
  } | null>(null)
  const [saving, setSaving] = React.useState(false)
  const originRef = React.useRef(origin)
  React.useEffect(() => {
    originRef.current = origin
  })

  // The library entry's name (and whether it still exists).
  React.useEffect(() => {
    if (!sceneId) return
    let cancelled = false
    services.scenes.get(sceneId).then(
      (summary) => {
        if (cancelled) return
        setLookup({
          sceneId,
          link: summary
            ? { status: "linked", sceneId, name: summary.name }
            : { status: "deleted" },
        })
      },
      (err: unknown) => {
        if (!cancelled)
          setLookup({
            sceneId,
            link: { status: "unavailable", error: userMessage(err) },
          })
      }
    )
    return () => {
      cancelled = true
    }
  }, [services, sceneId])
  const library = React.useMemo<LibraryLink>(
    () =>
      !sceneId
        ? { status: "deleted" }
        : lookup && lookup.sceneId === sceneId
          ? lookup.link
          : { status: "loading" },
    [sceneId, lookup]
  )

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
      setSaving(true)
      try {
        if (!opts.force && originRef.current?.version === null) {
          // No base version recorded (a game saved before the origin existed): compare update times.
          const [summary, session] = await Promise.all([
            services.scenes.get(library.sceneId),
            services.sessions
              .listMySessions()
              .then((l) => l.find((s) => s.id === snap.sessionId) ?? null),
          ])
          if (
            summary &&
            session &&
            changedSinceStart(summary.updatedAt, session.createdAt)
          ) {
            conflict()
            return false
          }
        }
        const version = await runner.saveMapToLibrary({ force: opts.force })
        toast.success(`Saved version ${version}`, {
          description: `“${library.name}” in your library now has the live map.`,
        })
        return true
      } catch (err) {
        if (isNetError(err, "version_conflict")) conflict()
        else if (isNetError(err, "not_found")) {
          setLookup({ sceneId: library.sceneId, link: { status: "deleted" } })
          toast.error("The library scene was deleted", {
            description: "There is nothing to save the map to.",
          })
        } else
          toast.error("Couldn't save the map", {
            description: userMessage(err),
          })
        return false
      } finally {
        setSaving(false)
      }
    },
    [library, confirm, services, runner, snap.sessionId]
  )
  React.useEffect(() => {
    saveRef.current = save
  }, [save])

  return { library, saving, dirty: origin?.dirty ?? false, save }
}
