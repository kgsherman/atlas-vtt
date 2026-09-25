/**
 * Routes (wouter). The scene screen (host) / play / token maker pages are code-split so three.js is never part
 * of the home bundle. Every route renders inside an error boundary that resets on navigation. Pages read
 * their parameters with wouter's useParams(). /scene/:sceneId (and the old /map/:sceneId and /editor/:sceneId
 * links) finds the scene's table and replaces itself with /host/:sessionId. /world/:worldId is a DM's world,
 * /world/:worldId/play a player's way into it.
 */
import * as React from "react"
import { Route, Switch, useLocation } from "wouter"

import { AppErrorBoundary } from "@/components/app/AppErrorBoundary"
import { NotFoundPage } from "@/components/app/NotFoundPage"
import { PageLoader } from "@/components/app/Splash"
import HomePage from "@/routes/HomePage"
import JoinPage from "@/routes/JoinPage"
import ScenePage from "@/routes/ScenePage"
import SharedScenePage from "@/routes/SharedScenePage"
import WorldPage from "@/routes/WorldPage"
import WorldPlayPage from "@/routes/WorldPlayPage"

import { loaders } from "./routes"

const HostPage = React.lazy(loaders.host)
const PlayPage = React.lazy(loaders.play)
const TokenMakerPage = React.lazy(loaders.tokens)

function Lazy({ children, label }: { children: React.ReactNode; label: string }) {
  return <React.Suspense fallback={<PageLoader label={label} />}>{children}</React.Suspense>
}

export function AppRouter() {
  const [location] = useLocation()
  return (
    <AppErrorBoundary resetKey={location}>
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/world/:worldId" component={WorldPage} />
        <Route path="/world/:worldId/play" component={WorldPlayPage} />
        <Route path="/scene/:sceneId" component={ScenePage} />
        <Route path="/map/:sceneId" component={ScenePage} />
        <Route path="/editor/:sceneId" component={ScenePage} />
        <Route path="/host/:sessionId">
          <Lazy label="Opening the table…">
            <HostPage />
          </Lazy>
        </Route>
        <Route path="/play/:sessionId">
          <Lazy label="Joining the table…">
            <PlayPage />
          </Lazy>
        </Route>
        <Route path="/tokens">
          <Lazy label="Opening the token maker…">
            <TokenMakerPage />
          </Lazy>
        </Route>
        <Route path="/join" component={JoinPage} />
        <Route path="/join/:code" component={JoinPage} />
        <Route path="/shared/:slug" component={SharedScenePage} />
        <Route component={NotFoundPage} />
      </Switch>
    </AppErrorBoundary>
  )
}
