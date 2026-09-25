/**
 * Restore points of the map screen (ARCHITECTURE §6.2, §6.8): HostRunner.saveMapToLibrary writes the
 * live map (as it is now: token positions, hidden tokens, doors and lights included) as a new version of
 * its library scene — the game's origin, exposed as HostSnapshot.library. Ctrl+S saves one; closing the
 * table, leaving, changing maps and sharing save one when the map changed since the last. Earlier
 * versions stay in version history.
 *
 * The origin records the library version the live map is based on, so a version saved meanwhile
 * elsewhere is a version_conflict; the conflict toast offers "Overwrite" (force), only while the table
 * still holds that map. Games saved before the origin was recorded have no base version: their first
 * save treats a library scene updated after the table started as changed elsewhere and asks first.
 * "Dirty" (the map changed since it was loaded or last saved: edits and play alike) is the origin's
 * flag, stored with the game, so it survives reloads and devices.
 */
import * as React from "react"
import { toast } from "sonner"

import { useServices } from "@/app/services"
import { userMessage } from "@/app/library"
import type { HostRunner, HostSnapshot } from "@/net/host"
import { isNetError } from "@/net/supabase"

export type LibraryLink =
  | { status: "loading" }
  | { status: "linked"; sceneId: string; name: string }
  /** The live map's library scene was deleted (or the map has none). */
  | { status: "deleted" }
  | { status: "unavailable"; error: string }

export interface SaveMap {
  library: LibraryLink
  saving: boolean
  /** The map changed (edits or play) since it was loaded or last saved to the library. */
  dirty: boolean
  /**
   * Save a restore point. `force` overwrites a library scene changed elsewhere; `quiet` skips the
   * success toast (restore points saved on the way: closing, leaving). Resolves true when saved.
   */
  save(opts?: { force?: boolean; quiet?: boolean }): Promise<boolean>
}

export type SaveMapRunner = Pick<HostRunner, "saveMapToLibrary">

/** Why there is nothing to save restore points to (the live map's library scene is gone). */
export const LIBRARY_SCENE_DELETED = "This map was deleted from your library."

/** The version-conflict toast (one at a time; dismissed when the game moves to another map). */
const CONFLICT_TOAST = "save-map-conflict"

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
  // A conflict about the previous map is moot once the game plays another one.
  React.useEffect(
    () => () => {
      toast.dismiss(CONFLICT_TOAST)
    },
    [sceneId]
  )

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
  /** The restore point being saved: a second save asked for meanwhile (closing, then leaving) joins it. */
  const inFlight = React.useRef<Promise<boolean> | null>(null)
  const saveOnce = React.useCallback<SaveMap["save"]>(
    async (opts = {}) => {
      if (library.status !== "linked") {
        toast.error("There is no library entry to save to", {
          description:
            library.status === "deleted"
              ? LIBRARY_SCENE_DELETED
              : library.status === "unavailable"
                ? library.error
                : "Still looking up the library scene. Try again in a moment.",
        })
        return false
      }
      const target = library.sceneId
      const conflict = () => {
        toast.error("Another restore point of this map was saved elsewhere", {
          id: CONFLICT_TOAST,
          description:
            "Save the map as it is here anyway, or keep that one. Either way, earlier versions stay in version history.",
          duration: 12_000,
          action: {
            label: "Save anyway",
            onClick: () => {
              // The table may have moved to another map since: never write that one over this row.
              if (originRef.current?.sceneId !== target) return
              void saveRef.current({ force: true })
            },
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
        if (!opts.quiet)
          toast.success("Restore point saved", {
            description: `Version ${version} of “${library.name}”.`,
          })
        return true
      } catch (err) {
        if (isNetError(err, "version_conflict")) conflict()
        else if (isNetError(err, "not_found")) {
          setLookup({ sceneId: library.sceneId, link: { status: "deleted" } })
          toast.error("This map was deleted from your library", {
            description: "There is nothing to save restore points to.",
          })
        } else
          toast.error("Couldn't save a restore point", {
            description: userMessage(err),
          })
        return false
      } finally {
        setSaving(false)
      }
    },
    [library, services, runner, snap.sessionId]
  )
  const save = React.useCallback<SaveMap["save"]>(
    (opts = {}) => {
      if (inFlight.current && !opts.force) return inFlight.current
      const p = saveOnce(opts).finally(() => {
        if (inFlight.current === p) inFlight.current = null
      })
      inFlight.current = p
      return p
    },
    [saveOnce]
  )
  React.useEffect(() => {
    saveRef.current = save
  }, [save])

  return { library, saving, dirty: origin?.dirty ?? false, save }
}
