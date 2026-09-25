/**
 * Join a game: forgiving room-code entry ("/join" or "/join/:code"), display name, then
 * sessions.joinSession → /play/:sid. Failures (wrong code, ended, kicked, you're the DM…) are
 * explained in place.
 */
import * as React from "react"
import { ArrowRightIcon, CastIcon, DoorOpenIcon, TriangleAlertIcon } from "lucide-react"
import { Link, useLocation, useParams } from "wouter"

import { formatRelativeTime } from "@/app/format"
import { describeJoinError, type JoinFailure } from "@/app/joinErrors"
import { parseRoomCodeInput } from "@/app/roomCodeInput"
import { paths, preloadRoute } from "@/app/routes"
import { useServices } from "@/app/services"
import { useAsync, useNow } from "@/app/useAsync"
import { AppHeader } from "@/components/app/AppHeader"
import { RoomCodeInput } from "@/components/app/RoomCodeInput"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { DISPLAY_NAME_MAX, normalizeDisplayName } from "@/net/auth"
import { formatRoomCode, ROOM_CODE_RE, type DmSession } from "@/net/sessionsRepo"

export default function JoinPage() {
  const services = useServices()
  const params = useParams<{ code?: string }>()
  const [, navigate] = useLocation()
  const initialCode = React.useMemo(() => parseRoomCodeInput(params.code ? decodeURIComponent(params.code) : "").code, [params.code])

  const [code, setCode] = React.useState(initialCode)
  const [name, setName] = React.useState(services.identity.displayName ?? "")
  const [codeHint, setCodeHint] = React.useState<string | null>(null)
  const [submitted, setSubmitted] = React.useState(false)
  const [joining, setJoining] = React.useState(false)
  const [failure, setFailure] = React.useState<(JoinFailure & { hosted: DmSession | null }) | null>(null)
  const nameId = React.useId()
  const codeId = React.useId()

  React.useEffect(() => preloadRoute("play"), [])

  const normalizedName = normalizeDisplayName(name)
  const codeValid = ROOM_CODE_RE.test(code)
  const codeError = (submitted && !codeValid) || failure?.field === "code"
  const nameError = (submitted && !normalizedName) || failure?.field === "name"

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (!codeValid || !normalizedName || joining) return
    setJoining(true)
    setFailure(null)
    try {
      const sid = await services.sessions.joinSession(code, normalizedName)
      if (normalizedName !== services.identity.displayName) void services.setDisplayName(normalizedName).catch(() => {})
      navigate(paths.play(sid))
    } catch (err) {
      const f = describeJoinError(err, services.mode)
      let hosted: DmSession | null = null
      if (f.isDm) {
        const mine = await services.sessions.listMySessions().catch(() => [] as DmSession[])
        hosted = mine.find((s) => s.roomCode === code && s.status !== "ended") ?? null
      }
      setFailure({ ...f, hosted })
      setJoining(false)
    }
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <AppHeader />
      <main className="relative isolate flex flex-1 flex-col items-center px-4 py-10 sm:py-16">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <div className="absolute -top-32 left-1/2 h-96 w-[40rem] -translate-x-1/2 rounded-full bg-primary/12 blur-3xl" />
          <div className="absolute inset-0 atlas-grid-backdrop opacity-50" />
        </div>

        <div className="flex w-full max-w-md flex-col gap-6">
          <Card className="animate-in gap-5 shadow-2xl duration-300 fade-in-0 [--card-spacing:--spacing(5)] slide-in-from-bottom-2">
            <CardHeader>
              <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
                <DoorOpenIcon className="size-5" />
              </div>
              <CardTitle className="text-lg">Join a game</CardTitle>
              <CardDescription>Enter the room code your DM shared. You'll see only what your character can see.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} noValidate>
                <FieldGroup className="gap-5">
                  <Field data-invalid={codeError || undefined}>
                    <FieldLabel htmlFor={codeId}>Room code</FieldLabel>
                    <RoomCodeInput
                      id={codeId}
                      size="lg"
                      value={code}
                      autoFocus={!initialCode}
                      invalid={codeError}
                      onChange={(next, info) => {
                        setCode(next)
                        if (failure?.field === "code") setFailure(null)
                        const bad = info.rejected.filter((c) => /\S/u.test(c))
                        setCodeHint(bad.length > 0 ? `“${bad[0]}” isn't used in room codes (no I, L, O or U).` : null)
                      }}
                    />
                    {submitted && !codeValid ? (
                      <FieldError>Room codes have 8 characters, like ABCD-1234.</FieldError>
                    ) : (
                      <FieldDescription>{codeHint ?? "Letters and digits. Pasting an invite link works too."}</FieldDescription>
                    )}
                  </Field>
                  <Field data-invalid={nameError || undefined}>
                    <FieldLabel htmlFor={nameId}>Your name</FieldLabel>
                    <Input
                      id={nameId}
                      value={name}
                      autoFocus={!!initialCode && !name}
                      maxLength={DISPLAY_NAME_MAX + 8}
                      placeholder="e.g. Morgana"
                      autoComplete="nickname"
                      aria-invalid={nameError || undefined}
                      className="h-9 text-sm md:text-sm"
                      onChange={(e) => {
                        setName(e.target.value)
                        if (failure?.field === "name") setFailure(null)
                      }}
                    />
                    {submitted && !normalizedName ? (
                      <FieldError>Use 1 to {DISPLAY_NAME_MAX} characters.</FieldError>
                    ) : (
                      <FieldDescription>How the DM and the party see you.</FieldDescription>
                    )}
                  </Field>

                  {failure && (
                    <Alert variant={failure.isDm ? "default" : "destructive"} className="animate-in duration-200 fade-in-0">
                      {failure.isDm ? <CastIcon /> : <TriangleAlertIcon />}
                      <AlertTitle>{failure.title}</AlertTitle>
                      <AlertDescription>
                        <p>{failure.description}</p>
                        {failure.hosted && (
                          <Button size="sm" className="mt-2" onClick={() => navigate(paths.host(failure.hosted!.id))} type="button">
                            <CastIcon data-icon="inline-start" />
                            Open this map
                          </Button>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}

                  <Button type="submit" size="lg" className="h-9 w-full text-sm" disabled={joining}>
                    {joining ? <Spinner className="size-4" data-icon="inline-start" /> : null}
                    {joining ? "Joining…" : "Join game"}
                    {!joining && <ArrowRightIcon data-icon="inline-end" />}
                  </Button>
                </FieldGroup>
              </form>
            </CardContent>
            <CardFooter className="flex-col items-stretch gap-3">
              <Separator />
              <p className="text-center text-xs text-muted-foreground">
                Running the game?{" "}
                <Link href="/" className="font-medium text-foreground underline-offset-4 hover:underline">
                  Start a session from your scenes
                </Link>
              </p>
            </CardFooter>
          </Card>

          <RecentGames />
        </div>
      </main>
    </div>
  )
}

/** Games this user joined before whose table is open. */
function RecentGames() {
  const { sessions, identity, mode } = useServices()
  const [, navigate] = useLocation()
  const now = useNow()
  const q = useAsync(`recent-games:${mode}:${identity.userId}`, async () => {
    const memberships = (await sessions.listMyMemberships(identity.userId)).filter((m) => m.status === "active").slice(0, 5)
    const infos = await Promise.all(memberships.map((m) => sessions.sessionInfo(m.sessionId).catch(() => null)))
    return memberships.flatMap((m, i) => {
      const info = infos[i]
      return info && info.status === "active" && info.memberStatus !== "kicked" ? [{ m, info }] : []
    })
  })
  const games = q.data ?? []
  if (games.length === 0) return null
  return (
    <section className="flex animate-in flex-col gap-2 duration-300 fade-in-0">
      <h2 className="px-1 text-xs font-medium text-muted-foreground">Jump back in</h2>
      <ItemGroup className="gap-2">
        {games.slice(0, 3).map(({ m, info }) => (
          <Item key={m.sessionId} variant="outline" size="sm" className="bg-card/60 backdrop-blur-sm">
            <ItemContent className="min-w-0">
              <ItemTitle className="font-mono tracking-wider">{formatRoomCode(info.roomCode)}</ItemTitle>
              <ItemDescription className="truncate">
                {info.dmDisplayName ? `${info.dmDisplayName}'s table` : "DM's table"} · as {m.displayName} · joined {formatRelativeTime(m.joinedAt, now)}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button size="sm" variant="secondary" onClick={() => navigate(paths.play(m.sessionId))}>
                Rejoin
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </section>
  )
}
