import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@app/lib/cn"

const surfaceVariants = cva("relative", {
  variants: {
    variant: {
      settings: "rounded-[10px] bg-linear-input shadow-linear-settings",
      dialog:
        "overflow-hidden rounded-xl border-[0.5px] border-linear-menu-border bg-linear-popover shadow-linear-dialog",
      inset:
        "rounded-md border border-linear-inset-border bg-linear-inset px-3 py-1.5",
      popover:
        "rounded-xl border-[0.5px] border-linear-popover-border bg-linear-popover shadow-linear-popover",
      popoverElevated:
        "rounded-xl border-[0.5px] border-linear-popover-elevated-border bg-linear-popover-elevated shadow-linear-popover",
    },
  },
  defaultVariants: {
    variant: "settings",
  },
})

type SurfaceProps = React.ComponentPropsWithoutRef<"div"> &
  VariantProps<typeof surfaceVariants> & {
    asChild?: boolean
  }

const Surface = React.forwardRef<HTMLDivElement, SurfaceProps>(
  ({ asChild = false, className, variant, ...props }, ref) => {
    const Component = asChild ? Slot : "div"

    return (
      <Component
        ref={ref}
        className={cn(surfaceVariants({ variant }), className)}
        {...props}
      />
    )
  },
)
Surface.displayName = "Surface"

export { Surface, type SurfaceProps }
