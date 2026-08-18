import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Measured off Linear's live app (settings/issue-labels), not eyeballed.
// The pill radius, the 0.5px transparent border and the hairline shadow are
// the three things that make these read as Linear buttons; the transparent
// border also keeps hover/focus from shifting layout by half a pixel.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full border-[0.5px] border-transparent text-[13px] font-medium transition-[border-color,background-color,color,opacity] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-brand text-white shadow-[0_0.5px_1px_1px_rgb(0_0_0/0.3)] hover:bg-brand-hover",
        destructive:
          "bg-danger text-white shadow-[0_0.5px_1px_1px_rgb(0_0_0/0.3)] hover:bg-danger/90",
        // Linear's "Edit": same pill and hairline border as the ghost, but it
        // carries a fill at rest and only deepens on hover. The label colour
        // never changes — only the surface moves.
        secondary:
          "bg-raised text-app-text-secondary hover:bg-raised-hover",
        outline:
          "border-control-border bg-transparent text-app-text-secondary hover:bg-control",
        // Linear's own Connect button: transparent at rest, no shadow, and it
        // only grows a surface on hover. Measured, not eyeballed.
        ghost: "text-app-text-secondary hover:bg-control-hover hover:text-white",
        link: "text-link underline-offset-4 hover:underline",
      },
      size: {
        // `xs` is Linear's inline-action size (their "Edit"): 24px tall, 12px
        // text, 8px of horizontal padding. Small enough to sit inside a row of
        // text without pushing the line height around.
        xs: "h-6 px-2 text-[12px]",
        default: "h-8 px-3",
        sm: "h-7 px-2.5 text-[12.5px]",
        lg: "h-9 px-4",
        icon: "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
