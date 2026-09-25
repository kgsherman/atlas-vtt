import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border bg-clip-padding text-xs/relaxed font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "rounded-[2px] atlas-framed bg-secondary atlas-framed-warm",
        outline: "rounded-[2px] atlas-framed bg-secondary",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground shadow-[inset_0_1px_0_color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:bg-[color-mix(in_oklch,var(--secondary),var(--gilt)_8%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "border-transparent hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/60 dark:hover:text-gilt-hi",
        destructive:
          "border-destructive/30 bg-destructive/10 text-destructive shadow-[inset_0_1px_0_color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:border-destructive/60 hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        /** The current choice in a set of options (the framed `default` is for actions). */
        selected:
          "border-transparent bg-primary text-primary-foreground shadow-[inset_0_1px_0_color-mix(in_oklch,var(--foreground)_18%,transparent)] hover:bg-primary/85",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
        /** A choice in an event-style prompt: a full-width band between gold hairlines. */
        decision: "atlas-decision w-full rounded-none border-0",
      },
      size: {
        default:
          "h-7 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-5 gap-1 rounded-sm px-2 text-[0.625rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-6 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-8 gap-1 px-2.5 text-xs/relaxed has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs": "size-5 rounded-sm [&_svg:not([class*='size-'])]:size-2.5",
        "icon-sm": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-lg": "size-8 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    compoundVariants: [
      // Framed plates need room inside the frame (icon sizes stay square).
      {
        variant: ["default", "outline"],
        size: "default",
        class:
          "h-8 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
      },
      {
        variant: ["default", "outline"],
        size: "sm",
        class:
          "h-7 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
      },
      {
        variant: ["default", "outline"],
        size: "lg",
        class:
          "h-9 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
      },
      {
        variant: "decision",
        class:
          "h-auto min-h-9 px-6 py-2 text-sm whitespace-normal focus-visible:ring-0 active:not-aria-[haspopup]:translate-y-0",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
