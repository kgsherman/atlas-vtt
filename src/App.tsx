import { AppRouter } from "@/app/router"
import { ServicesProvider } from "@/app/ServicesProvider"
import { AppErrorBoundary } from "@/components/app/AppErrorBoundary"
import { AppToaster } from "@/components/app/AppToaster"
import { TooltipProvider } from "@/components/ui/tooltip"

/** App shell: tooltips, toasts, error boundary, services (identity, repositories, transport) and routes. */
export function App() {
  return (
    <TooltipProvider delay={350}>
      <AppErrorBoundary>
        <ServicesProvider>
          <AppRouter />
        </ServicesProvider>
      </AppErrorBoundary>
      <AppToaster />
    </TooltipProvider>
  )
}

export default App
