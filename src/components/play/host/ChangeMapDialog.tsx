/**
 * "Change map" (ARCHITECTURE §6.7): the DM moves the live game to another map of the library and
 * brings the party along. Three steps: pick the map (a library scene, or a library copy of a sample
 * made on the spot), choose who comes along and where they arrive (a level, and a point clicked on
 * its thumbnail), then confirm — with what stays behind and the live map's unsaved-edits guard (save
 * it to its library scene first, change without saving, or keep playing). The host console makes the
 * change (onChange → HostRunner.changeMap); a refusal is shown here and the dialog stays open.
 *
 * The library is listed only while the dialog is open (its steps unmount when it closes). The guard
 * follows `saveMap` as it is when the DM confirms: the map may be saved while the dialog is open.
 */
import * as React from "react"
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Crosshair,
  EyeOff,
  LibraryBig,
  Map as MapIcon,
  MapPin,
  MessagesSquare,
  Search,
  Swords,
  TriangleAlert,
  Users,
  X,
} from "lucide-react"

import { useSceneDigest, useSeenOnce } from "@/app/digestCache"
import { plural } from "@/app/format"
import {
  createFromSample,
  loadLibraryScene,
  userMessage,
  type PlayableScene,
} from "@/app/library"
import { levelDigest, primaryLevel, type LevelDigest } from "@/app/sceneDigest"
import { useServices } from "@/app/services"
import { useAsync } from "@/app/useAsync"
import { SampleSceneCard } from "@/components/app/SampleSceneCard"
import { SceneCardPreview } from "@/components/app/SceneCard"
import { SceneThumbnail } from "@/components/app/SceneThumbnail"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemHeader,
  ItemTitle,
} from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { sortedLevels } from "@/core/scene/queries"
import { SAMPLE_SCENES } from "@/core/scene/samples"
import type { Id, Scene, Vec2 } from "@/core/scene/types"
import type { GameState } from "@/core/session/types"
import { cn } from "@/lib/utils"
import type { SceneSummary } from "@/net/scenesRepo"
import { TOKEN_KIND_LABELS, tokenDisplayName } from "@/play"

import { TokenAvatar } from "../TokenAvatar"
import {
  changeMapErrorText,
  clampToGrid,
  defaultParty,
  frameCentre,
  partyRows,
  saveChoice,
  saveChoiceText,
  type ChangeMapOutcome,
  type ChangeMapRequest,
  type PartyRow,
} from "./changeMapModel"
import type { SaveMap } from "./useSaveMap"

/** The samples Home offers (a library copy is made first, so "Save map to library" works). */
const SAMPLES = SAMPLE_SCENES.filter(
  (s) => s.id === "crooked-lantern" || s.id === "stress-test"
)

type Busy = "load" | "save" | "change"
type Step = "map" | "party" | "confirm"
/** What the confirm step says comes along and stays behind. */
interface Summary {
  rows: PartyRow[]
  tokenIds: Id[]
  oldName: string
}

export interface ChangeMapDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** The live game: its map's tokens make the party list. */
  state: Pick<GameState, "scene" | "owners" | "players">
  /** The live map's library row (GameState.origin): listed as the current map, not selectable. */
  currentSceneId: string | null
  saveMap: Pick<SaveMap, "library" | "dirty" | "saving">
  /** Change the map (see ChangeMapOutcome); the dialog closes on true. */
  onChange(req: ChangeMapRequest): Promise<ChangeMapOutcome>
}

export function ChangeMapDialog(props: ChangeMapDialogProps) {
  const { open, onOpenChange } = props
  const [busy, setBusy] = React.useState<Busy | null>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Never close under a load, a save or the change itself.
        if (!busy) onOpenChange(o)
      }}
    >
      <DialogContent className="gap-3 sm:max-w-3xl">
        <ChangeMapSteps {...props} busy={busy} setBusy={setBusy} />
      </DialogContent>
    </Dialog>
  )
}

function ChangeMapSteps({
  onOpenChange,
  state,
  currentSceneId,
  saveMap,
  onChange,
  busy,
  setBusy,
}: ChangeMapDialogProps & {
  busy: Busy | null
  setBusy(b: Busy | null): void
}) {
  const [step, setStep] = React.useState<Step>("map")
  const [picked, setPicked] = React.useState<PlayableScene | null>(null)
  const rows = React.useMemo(
    () =>
      partyRows({
        scene: state.scene,
        owners: state.owners,
        players: state.players,
      }),
    [state.scene, state.owners, state.players]
  )
  const [party, setParty] = React.useState<ReadonlySet<Id>>(
    () => new Set(defaultParty(rows))
  )
  const [levelId, setLevelId] = React.useState<Id | null>(null)
  const [point, setPoint] = React.useState<Vec2 | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  // The summary as the DM confirmed it: once the swap is dispatched, `state` is the new map's.
  const [confirmed, setConfirmed] = React.useState<Summary | null>(null)
  // The live map's id when a load settles (the prop in that closure may be a render old).
  const liveSceneId = React.useRef(state.scene.id)
  React.useEffect(() => {
    liveSceneId.current = state.scene.id
  })

  const choose = (next: PlayableScene): string | null => {
    if (next.scene.id === liveSceneId.current)
      return changeMapErrorText("same-map")
    setPicked(next)
    setLevelId(primaryLevel(next.scene).id)
    setPoint(null)
    setError(null)
    setStep("party")
    return null
  }

  const level =
    picked && levelId && Object.hasOwn(picked.scene.levels, levelId)
      ? levelId
      : null
  const digest = React.useMemo(
    () => (picked && level ? levelDigest(picked.scene, level) : null),
    [picked, level]
  )
  const arrival =
    picked && level && digest
      ? {
          levelId: level,
          ...(point ?? frameCentre(digest.bounds, picked.scene.grid)),
        }
      : null
  // Tokens removed from the live map while the dialog is open drop out.
  const tokenIds = rows
    .filter((r) => party.has(r.token.id))
    .map((r) => r.token.id)

  const confirm = async (save: boolean) => {
    if (busy || !picked || !arrival) return
    // Read the guard now: the map may have been saved (or be saving) since this step opened.
    const choice = saveChoice(saveMap)
    if (saveMap.saving) {
      setError("The map is being saved to your library. Try again in a moment.")
      return
    }
    if (save && choice.kind !== "offer") return
    setBusy(save ? "save" : "change")
    setError(null)
    setConfirmed({ rows, tokenIds, oldName: state.scene.name })
    let changed = false
    try {
      const outcome = await onChange({
        scene: picked.scene,
        origin: picked.origin,
        name: picked.name,
        tokenIds,
        arrival,
        save,
      })
      changed = outcome === true
      if (changed) onOpenChange(false)
      else if (typeof outcome === "string") setError(outcome)
    } catch (err) {
      setError(userMessage(err))
    } finally {
      setBusy(null)
      // Changed: the dialog closes on what was confirmed.
      if (!changed) setConfirmed(null)
    }
  }

  if (step === "map" || !picked || !level || !digest || !arrival)
    return (
      <MapStep
        currentSceneId={currentSceneId}
        busy={busy}
        setBusy={setBusy}
        onChosen={choose}
        onCancel={() => onOpenChange(false)}
      />
    )

  const header = (
    <DialogHeader>
      <DialogTitle>Change map</DialogTitle>
      <DialogDescription>
        {step === "party"
          ? `Step 2 of 3 · Who comes along to “${picked.name}”, and where they arrive.`
          : `Step 3 of 3 · Move the game to “${picked.name}”?`}
      </DialogDescription>
    </DialogHeader>
  )

  if (step === "party")
    return (
      <>
        {header}
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <PartyPicker
            rows={rows}
            party={party}
            onParty={setParty}
            disabled={busy !== null}
          />
          <ArrivalPicker
            scene={picked.scene}
            levelId={level}
            digest={digest}
            point={arrival}
            onLevel={(id) => {
              setLevelId(id)
              setPoint(null)
            }}
            onPoint={setPoint}
            onReset={point ? () => setPoint(null) : undefined}
          />
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            className="sm:mr-auto"
            onClick={() => setStep("map")}
          >
            <ArrowLeft data-icon="inline-start" /> Another map
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setError(null)
              setStep("confirm")
            }}
          >
            Review <ArrowRight data-icon="inline-end" />
          </Button>
        </DialogFooter>
      </>
    )

  const choice = saveChoice(saveMap)
  const guard = saveChoiceText(choice)
  const blocked = busy !== null || saveMap.saving
  const summary = confirmed ?? { rows, tokenIds, oldName: state.scene.name }
  return (
    <>
      {header}
      <ConfirmSummary
        scene={picked.scene}
        name={picked.name}
        digest={digest}
        arrival={arrival}
        {...summary}
      />
      {guard ? (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Unsaved map edits</AlertTitle>
          <AlertDescription>{guard}</AlertDescription>
        </Alert>
      ) : null}
      {saveMap.saving ? (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Spinner className="size-3" /> Saving the map to your library…
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>The map didn't change</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button
          variant="ghost"
          className="sm:mr-auto"
          disabled={busy !== null}
          onClick={() => setStep("party")}
        >
          <ArrowLeft data-icon="inline-start" /> Back
        </Button>
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => onOpenChange(false)}
        >
          Keep playing here
        </Button>
        {choice.kind === "clean" ? (
          <Button disabled={blocked} onClick={() => void confirm(false)}>
            {busy === "change" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <MapIcon data-icon="inline-start" />
            )}
            Change map
          </Button>
        ) : (
          <>
            <Button
              variant="destructive"
              disabled={blocked}
              onClick={() => void confirm(false)}
            >
              {busy === "change" ? <Spinner data-icon="inline-start" /> : null}
              Change without saving
            </Button>
            {choice.kind === "offer" || choice.kind === "looking-up" ? (
              <Button
                disabled={blocked || choice.kind !== "offer"}
                onClick={() => void confirm(true)}
              >
                {busy === "save" || choice.kind === "looking-up" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <LibraryBig data-icon="inline-start" />
                )}
                Save map & change
              </Button>
            ) : null}
          </>
        )}
      </DialogFooter>
    </>
  )
}

// ---- step 1: the map ------------------------------------------------------------------------------

function MapStep({
  currentSceneId,
  busy,
  setBusy,
  onChosen,
  onCancel,
}: {
  currentSceneId: string | null
  busy: Busy | null
  setBusy(b: Busy | null): void
  /** A loaded map was chosen; returns why it can't be used (or null). */
  onChosen(next: PlayableScene): string | null
  onCancel(): void
}) {
  const services = useServices()
  const q = useAsync(
    `scenes:${services.mode}:${services.identity.userId}`,
    () => services.scenes.list()
  )
  const [query, setQuery] = React.useState("")
  /** The row (or `sample:<id>`) being loaded. */
  const [pending, setPending] = React.useState<string | null>(null)
  const [pickError, setPickError] = React.useState<string | null>(null)

  const scenes = q.data ?? []
  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? scenes.filter((s) => s.name.toLowerCase().includes(needle))
    : scenes

  const load = async (key: string, get: () => Promise<PlayableScene>) => {
    if (busy) return
    setBusy("load")
    setPending(key)
    setPickError(null)
    try {
      const why = onChosen(await get())
      if (why) setPickError(why)
    } catch (err) {
      setPickError(userMessage(err))
    } finally {
      setBusy(null)
      setPending(null)
    }
  }
  const pickRow = (s: SceneSummary) =>
    void load(s.id, () => loadLibraryScene(services, s.id))
  const pickSample = (id: string) =>
    void load(`sample:${id}`, async () => {
      // A library copy first, so the new map can be saved back like any other.
      const { summary } = await createFromSample(services, id)
      q.reload()
      return loadLibraryScene(services, summary.id)
    })

  return (
    <>
      <DialogHeader>
        <DialogTitle>Change map</DialogTitle>
        <DialogDescription>
          Step 1 of 3 · Pick the map to move the game to. You choose who comes
          along next.
        </DialogDescription>
      </DialogHeader>
      <InputGroup className="h-7">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your maps"
          aria-label="Search your maps"
        />
        {query ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      <ScrollArea className="-mx-1 h-[min(26rem,55vh)]">
        <div className="flex flex-col gap-4 px-1 pb-1">
          {q.error !== undefined && !q.data ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Couldn't load your maps</AlertTitle>
              <AlertDescription>{userMessage(q.error)}</AlertDescription>
              <AlertAction>
                <Button size="xs" variant="outline" onClick={q.reload}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : q.loading && !q.data ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="aspect-[16/13] w-full" />
              ))}
            </div>
          ) : scenes.length === 0 ? (
            <Empty className="border py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <LibraryBig />
                </EmptyMedia>
                <EmptyTitle>Your library is empty</EmptyTitle>
                <EmptyDescription>
                  Use a copy of a sample map below, or build a map in the editor
                  from the home page.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : filtered.length === 0 ? (
            <Empty className="border py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search />
                </EmptyMedia>
                <EmptyTitle>No maps match “{query.trim()}”</EmptyTitle>
              </EmptyHeader>
              <Button variant="outline" onClick={() => setQuery("")}>
                Clear search
              </Button>
            </Empty>
          ) : (
            <div
              role="list"
              aria-label="Your maps"
              className="grid gap-3 sm:grid-cols-3"
            >
              {filtered.map((s) => (
                <div key={s.id} role="listitem" className="flex min-w-0">
                  <MapPickCard
                    summary={s}
                    current={s.id === currentSceneId}
                    loading={pending === s.id}
                    disabled={busy !== null}
                    onPick={() => pickRow(s)}
                  />
                </div>
              ))}
            </div>
          )}
          <Collapsible>
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="group/samples -ml-1 text-muted-foreground"
                />
              }
            >
              <ChevronRight
                data-icon="inline-start"
                className="transition-transform group-data-[panel-open]/samples:rotate-90"
              />
              Sample maps
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-2 pt-2">
              <p className="text-muted-foreground">
                Using a sample adds a copy of it to your library first.
              </p>
              {SAMPLES.map((sample) => (
                <SampleSceneCard
                  key={sample.id}
                  sample={sample}
                  actionLabel="Use a copy"
                  busy={pending === `sample:${sample.id}`}
                  disabled={busy !== null}
                  onOpenCopy={() => pickSample(sample.id)}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </ScrollArea>
      {pickError ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Couldn't use that map</AlertTitle>
          <AlertDescription>{pickError}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button variant="outline" disabled={busy !== null} onClick={onCancel}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  )
}

/** One library map to pick: its thumbnail (the Home cards' digest cache), name and size. */
function MapPickCard({
  summary,
  current,
  loading,
  disabled,
  onPick,
}: {
  summary: SceneSummary
  /** The map being played: marked, never selectable. */
  current: boolean
  loading: boolean
  disabled: boolean
  onPick(): void
}) {
  const services = useServices()
  const [ref, seen] = useSeenOnce<HTMLButtonElement>()
  const { entry, status } = useSceneDigest(services, summary, seen)
  const digest = entry?.digest
  return (
    <Item
      variant="outline"
      size="xs"
      className="w-full items-stretch gap-0 overflow-hidden p-0 text-left not-disabled:hover:bg-muted/50 disabled:opacity-60"
      render={
        <button
          ref={ref}
          type="button"
          disabled={current || disabled}
          onClick={onPick}
          aria-label={
            current
              ? `${summary.name} (the current map)`
              : `Move the game to ${summary.name}`
          }
        />
      }
    >
      <ItemHeader className="relative aspect-[16/10] overflow-hidden bg-muted/40">
        <SceneCardPreview entry={entry} status={status} />
        {current ? (
          <Badge variant="secondary" className="absolute top-2 left-2">
            <MapPin data-icon="inline-start" /> Current map
          </Badge>
        ) : null}
        {loading ? (
          <span className="absolute inset-0 grid place-items-center bg-background/60">
            <Spinner className="size-5" />
          </span>
        ) : null}
      </ItemHeader>
      <ItemContent className="min-w-0 gap-0 px-2.5 py-2">
        <ItemTitle className="w-full truncate">{summary.name}</ItemTitle>
        <ItemDescription className="truncate text-[0.7rem]">
          {digest
            ? `${plural(digest.levels.length, "level")} · ${plural(digest.counts.tokens, "token")}`
            : `Version ${summary.latestVersion}`}
        </ItemDescription>
      </ItemContent>
    </Item>
  )
}

// ---- step 2: the party and the arrival ------------------------------------------------------------

function PartyPicker({
  rows,
  party,
  onParty,
  disabled,
}: {
  rows: PartyRow[]
  party: ReadonlySet<Id>
  onParty(next: ReadonlySet<Id>): void
  disabled: boolean
}) {
  const baseId = React.useId()
  const chosen = rows.filter((r) => party.has(r.token.id)).length
  const toggle = (id: Id, on: boolean) => {
    const next = new Set(party)
    if (on) next.add(id)
    else next.delete(id)
    onParty(next)
  }
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 font-medium">
          <Users className="size-3.5" /> Who comes along
          <span className="font-normal text-muted-foreground tabular-nums">
            {chosen} of {rows.length}
          </span>
        </h3>
        <span className="flex gap-1">
          <Button
            variant="ghost"
            size="xs"
            disabled={disabled || chosen === rows.length}
            onClick={() => onParty(new Set(rows.map((r) => r.token.id)))}
          >
            All
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={disabled || chosen === 0}
            onClick={() => onParty(new Set())}
          >
            None
          </Button>
        </span>
      </div>
      <ScrollArea className="h-[min(20rem,45vh)] rounded-lg border">
        {rows.length === 0 ? (
          <p className="p-3 text-muted-foreground">
            There are no tokens on this map. The game moves on its own.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5 p-1">
            {rows.map((row) => {
              const t = row.token
              const id = `${baseId}-${t.id}`
              return (
                <Field
                  key={t.id}
                  orientation="horizontal"
                  className="rounded-md px-2 py-1.5 hover:bg-muted/50"
                >
                  <Checkbox
                    id={id}
                    checked={party.has(t.id)}
                    disabled={disabled}
                    onCheckedChange={(on) => toggle(t.id, on === true)}
                  />
                  <TokenAvatar token={t} size="sm" dimmed={t.hidden} />
                  <FieldContent className="min-w-0">
                    <FieldLabel htmlFor={id} className="w-full truncate">
                      {tokenDisplayName(t)}
                    </FieldLabel>
                    <FieldDescription className="truncate text-[0.7rem]">
                      {[
                        TOKEN_KIND_LABELS[t.kind],
                        row.owners.length > 0
                          ? `Played by ${row.owners.join(", ")}`
                          : null,
                        t.hidden ? "Hidden" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </FieldDescription>
                  </FieldContent>
                </Field>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </section>
  )
}

function ArrivalPicker({
  scene,
  levelId,
  digest,
  point,
  onLevel,
  onPoint,
  onReset,
}: {
  scene: Scene
  levelId: Id
  digest: LevelDigest & { palette: string[] }
  point: Vec2
  onLevel(id: Id): void
  onPoint(p: Vec2): void
  /** Back to the default point (absent while it is the default). */
  onReset?(): void
}) {
  const levels = sortedLevels(scene).slice().reverse()
  const name = (id: Id) =>
    Object.hasOwn(scene.levels, id) ? scene.levels[id].name || "Level" : ""
  const cs = scene.grid.cellSize
  const place = (e: React.MouseEvent<SVGSVGElement>) => {
    // The overlay shares the thumbnail's viewBox (world feet): screen → map through its matrix.
    const ctm = e.currentTarget.getScreenCTM()
    if (!ctm) return
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    onPoint(clampToGrid({ x: p.x, z: p.y }, scene.grid))
  }
  const nudge = (e: React.KeyboardEvent<SVGSVGElement>) => {
    const d = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[e.key]
    if (!d) return
    e.preventDefault()
    onPoint(
      clampToGrid(
        { x: point.x + d[0] * cs, z: point.z + d[1] * cs },
        scene.grid
      )
    )
  }
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 font-medium">
          <MapPin className="size-3.5" /> Where they arrive
        </h3>
        {levels.length > 1 ? (
          <Select value={levelId} onValueChange={(v) => v && onLevel(v as Id)}>
            <SelectTrigger
              size="sm"
              className="w-40"
              aria-label="Arrival level"
            >
              <SelectValue>{() => name(levelId)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {levels.map((l) => (
                <SelectItem key={l.id} value={l.id} className="text-xs">
                  {l.name || "Level"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="truncate text-muted-foreground">
            {name(levelId)}
          </span>
        )}
      </div>
      <ArrivalMap
        sceneId={scene.id}
        cellSize={cs}
        digest={digest}
        point={point}
        onClick={place}
        onKeyDown={nudge}
        className="aspect-[4/3]"
      />
      <div className="flex min-h-6 items-center justify-between gap-2 text-[0.7rem] text-muted-foreground">
        <span>
          Click the map to choose the spot (arrow keys move it). Everyone stands
          on the nearest free squares.
        </span>
        {onReset ? (
          <Button variant="ghost" size="xs" onClick={onReset}>
            <Crosshair data-icon="inline-start" /> Centre
          </Button>
        ) : null}
      </div>
    </section>
  )
}

/** A level's thumbnail with the arrival marked; clickable when `onClick` is given. */
function ArrivalMap({
  sceneId,
  cellSize,
  digest,
  point,
  onClick,
  onKeyDown,
  className,
}: {
  sceneId: Id
  cellSize: number
  digest: LevelDigest & { palette: string[] }
  point: Vec2
  onClick?(e: React.MouseEvent<SVGSVGElement>): void
  onKeyDown?(e: React.KeyboardEvent<SVGSVGElement>): void
  className?: string
}) {
  const image = useLevelImage(sceneId, digest.backdrop?.assetId ?? null)
  const [bx, bz, bw, bd] = digest.bounds
  const r = Math.max(bw, bd) / 50
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border bg-muted/40",
        className
      )}
    >
      <SceneThumbnail
        level={digest}
        palette={digest.palette}
        cellSize={cellSize}
        image={image}
      />
      <svg
        viewBox={`${bx} ${bz} ${bw} ${bd}`}
        preserveAspectRatio="xMidYMid meet"
        className={cn(
          "absolute inset-0 size-full outline-none",
          onClick &&
            "cursor-crosshair rounded-lg focus-visible:ring-2 focus-visible:ring-ring/50"
        )}
        tabIndex={onClick ? 0 : undefined}
        role={onClick ? "button" : "img"}
        aria-label={
          onClick
            ? "Arrival point: click the map to move it"
            : "The arrival point"
        }
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <circle
          cx={point.x}
          cy={point.z}
          r={r * 1.8}
          className="fill-primary/25 stroke-primary"
          strokeWidth={r * 0.3}
        />
        <circle
          cx={point.x}
          cy={point.z}
          r={r * 0.5}
          className="fill-primary"
        />
      </svg>
    </div>
  )
}

/** A level's map image as an object URL (null without one, while loading, or when it can't be read). */
function useLevelImage(sceneId: Id, assetId: Id | null): string | null {
  const { assets } = useServices()
  const key = assetId ? `${sceneId}/${assetId}` : null
  const [loaded, setLoaded] = React.useState<{
    key: string
    url: string
  } | null>(null)
  React.useEffect(() => {
    if (!key || !assetId) return
    let alive = true
    let url: string | null = null
    assets.getImage(sceneId, assetId).then(
      (blob) => {
        if (!alive || !blob) return
        url = URL.createObjectURL(blob)
        setLoaded({ key, url })
      },
      () => {
        // No picture: the schematic still shows the level.
      }
    )
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [assets, sceneId, assetId, key])
  return loaded && loaded.key === key ? loaded.url : null
}

// ---- step 3: the summary --------------------------------------------------------------------------

function ConfirmSummary({
  scene,
  name,
  digest,
  arrival,
  rows,
  tokenIds,
  oldName,
}: {
  scene: Scene
  name: string
  digest: LevelDigest & { palette: string[] }
  arrival: Vec2 & { levelId: Id }
} & Summary) {
  const ids = new Set(tokenIds)
  const coming = rows.filter((r) => ids.has(r.token.id))
  const left = rows.length - coming.length
  const levelName = scene.levels[arrival.levelId]?.name || "the arrival level"
  const shown = coming.slice(0, 12)
  return (
    <div className="grid gap-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
      <ArrivalMap
        sceneId={scene.id}
        cellSize={scene.grid.cellSize}
        digest={digest}
        point={arrival}
        className="aspect-[4/3]"
      />
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <p className="font-medium">
            {coming.length === 0
              ? "No tokens come along."
              : `${plural(coming.length, "token")} ${coming.length === 1 ? "arrives" : "arrive"} on ${levelName}.`}
          </p>
          {shown.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {shown.map((r) => (
                <TokenAvatar key={r.token.id} token={r.token} size="sm" />
              ))}
              {coming.length > shown.length ? (
                <Badge variant="outline">+{coming.length - shown.length}</Badge>
              ) : null}
            </div>
          ) : null}
        </div>
        <ul className="flex flex-col gap-1.5 text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
          <li className="flex gap-2">
            <Users />
            {left > 0
              ? `The other ${plural(left, "token")} of “${oldName}” stay behind: they are not on the new map.`
              : `Every token of “${oldName}” comes along.`}
          </li>
          <li className="flex gap-2">
            <EyeOff />
            Players' fog of war starts fresh on the new map.
          </li>
          <li className="flex gap-2">
            <Swords />
            Combat ends and areas of effect are cleared.
          </li>
          <li className="flex gap-2">
            <MessagesSquare />
            The room code, the players and the chat stay.
          </li>
          <li className="flex gap-2">
            <MapIcon />
            Players see the new map's name: “{name}”.
          </li>
        </ul>
      </div>
    </div>
  )
}
