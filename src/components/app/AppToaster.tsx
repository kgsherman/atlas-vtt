import { useLocation } from "wouter"

import { Toaster } from "@/components/ui/sonner"

import { useResolvedTheme } from "./theme"

/**
 * Bottom offset (px) that keeps toasts above the play views' bottom-right camera dock (the host console
 * also has its status bar under the map). Elsewhere: Sonner's default.
 */
function toastBottomOffset(pathname: string): number | undefined {
  if (pathname.startsWith("/play/")) return 64
  if (pathname.startsWith("/host/")) return 88
  return undefined
}

/** App-wide toasts, following the app theme (not only the OS preference). */
export function AppToaster() {
  const theme = useResolvedTheme()
  const [location] = useLocation()
  const bottom = toastBottomOffset(location)
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      closeButton
      visibleToasts={4}
      offset={bottom === undefined ? undefined : { bottom }}
    />
  )
}
