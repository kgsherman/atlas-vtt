import { LogInIcon } from "lucide-react"

import { useServices } from "@/app/services"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

import { SignInButtons } from "./SignInButtons"

/** Header shortcut to the sign-in providers, for Cloud guests only. */
export function LogInButton() {
  const { mode, identity } = useServices()
  if (mode !== "supabase" || (!identity.isAnonymous && identity.account)) return null
  return (
    <Popover>
      <PopoverTrigger render={<Button size="lg" />}>
        <LogInIcon data-icon="inline-start" />
        Log in
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60">
        <SignInButtons />
      </PopoverContent>
    </Popover>
  )
}
