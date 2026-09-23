import { MoonIcon, SunIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { useResolvedTheme } from "./theme"

export function ThemeToggle() {
  const { setTheme } = useTheme()
  const resolved = useResolvedTheme()
  const next = resolved === "dark" ? "light" : "dark"
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label={`Switch to ${next} theme`} onClick={() => setTheme(next)} />}>
        {resolved === "dark" ? <MoonIcon /> : <SunIcon />}
      </TooltipTrigger>
      <TooltipContent>
        {resolved === "dark" ? "Dark theme" : "Light theme"} · switch to {next}
      </TooltipContent>
    </Tooltip>
  )
}
