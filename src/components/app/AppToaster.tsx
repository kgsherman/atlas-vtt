import { Toaster } from "@/components/ui/sonner"

import { useResolvedTheme } from "./theme"

/** App-wide toasts, following the app theme (not only the OS preference). */
export function AppToaster() {
  const theme = useResolvedTheme()
  return <Toaster theme={theme} position="bottom-right" closeButton visibleToasts={4} />
}
