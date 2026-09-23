import * as React from "react"
import { toast } from "sonner"

import { isAccountProvider, providerLabel } from "@/app/account"
import { userMessage } from "@/app/library"
import { useServices } from "@/app/services"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ACCOUNT_PROVIDERS, type AccountProvider } from "@/net/auth"
import { cn } from "@/lib/utils"

import { DiscordIcon } from "./DiscordIcon"

type IconComponent = (props: React.SVGProps<SVGSVGElement>) => React.ReactNode

/** Brand mark per provider. Adding a provider to ACCOUNT_PROVIDERS requires an entry here. */
const PROVIDER_ICONS: Record<AccountProvider, IconComponent> = {
  discord: DiscordIcon,
}

/** The provider's mark, or nothing for providers Atlas doesn't offer ("email", …). */
export function ProviderIcon({ provider, ...props }: { provider: string } & React.SVGProps<SVGSVGElement>) {
  if (!isAccountProvider(provider)) return null
  const Icon = PROVIDER_ICONS[provider]
  return <Icon {...props} />
}

/**
 * One "Continue with …" button per provider in ACCOUNT_PROVIDERS. A guest links the provider (and
 * becomes permanent); if that account already exists the redirect offers to sign in to it instead.
 */
export function SignInButtons({
  orientation = "vertical",
  size = "default",
  className,
}: {
  orientation?: "vertical" | "horizontal"
  size?: "default" | "xs"
  className?: string
}) {
  const services = useServices()
  const [busy, setBusy] = React.useState<AccountProvider | null>(null)

  const signIn = async (provider: AccountProvider) => {
    setBusy(provider)
    try {
      await services.signIn(provider)
      // The browser is leaving for the provider: keep the spinner.
    } catch (err) {
      setBusy(null)
      toast.error(`Couldn't reach ${providerLabel(provider)}`, { description: userMessage(err) })
    }
  }

  return (
    <div className={cn("flex", orientation === "vertical" ? "flex-col gap-2" : "items-center gap-1", className)}>
      {ACCOUNT_PROVIDERS.map((provider) => (
        <Button
          key={provider}
          variant="outline"
          size={size}
          className={cn(orientation === "vertical" && "w-full")}
          onClick={() => signIn(provider)}
          disabled={busy !== null}
        >
          {busy === provider ? <Spinner data-icon="inline-start" /> : <ProviderIcon provider={provider} data-icon="inline-start" />}
          Continue with {providerLabel(provider)}
        </Button>
      ))}
    </div>
  )
}
