/**
 * Routes (wouter). Editor / host / play / token maker pages are code-split so three.js is never part of the home
 * bundle. Every route renders inside an error boundary that resets on navigation. Pages read their
 * parameters with wouter's useParams() (they stay mounted when only the parameter changes, e.g. the
 * editor replacing /editor/new with /editor/:id after the first save).
 */
import * as React from "react"
import { Route, Switch, useLocation } from "wouter"

import { AppErrorBoundary } from "@/components/app/AppErrorBoundary"
import { NotFoundPage } from "@/components/app/NotFoundPage"
import { PageLoader } from "@/components/app/Splash"
import HomePage from "@/routes/HomePage"
import JoinPage from "@/routes/JoinPage"
import SharedScenePage from "@/routes/SharedScenePage"

import { loaders } from "./routes"

const EditorPage = React.lazy(loaders.editor)
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
        <Route path="/editor/:sceneId">
          <Lazy label="Opening the editor…">
            <EditorPage />
          </Lazy>
        </Route>
        <Route path="/host/:sessionId">
          <Lazy label="Starting the session…">
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
