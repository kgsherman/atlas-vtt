import * as React from "react"

import { useTheme } from "@/components/theme-provider"

const QUERY = "(prefers-color-scheme: dark)"

function subscribeScheme(cb: () => void): () => void {
  const mq = window.matchMedia(QUERY)
  mq.addEventListener("change", cb)
  return () => mq.removeEventListener("change", cb)
}

const systemIsDark = () => window.matchMedia(QUERY).matches

/** The theme actually applied ("system" resolved). */
export function useResolvedTheme(): "dark" | "light" {
  const { theme } = useTheme()
  const dark = React.useSyncExternalStore(subscribeScheme, systemIsDark, () => true)
  return theme === "system" ? (dark ? "dark" : "light") : theme
}
