import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@app/lib/cn"

const buttonVariants = cva(
  "relative inline-flex cursor-default shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-[0.5px] border-transparent text-[13px] font-medium [line-height:normal] outline-none select-none transition-[border,background-color,color,box-shadow,opacity] duration-150 ease-[ease] hover:duration-0 active:duration-0 disabled:pointer-events-none disabled:opacity-60 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:[outline:1px_solid_var(--linear-primary)] focus-visible:[outline-offset:0] motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default:
          "min-w-8 bg-linear-primary text-linear-primary-foreground shadow-linear-control hover:bg-linear-primary-hover active:bg-linear-primary-hover",
        secondary:
          "min-w-8 bg-linear-control bg-clip-padding text-linear-foreground shadow-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-linear-secondary after:content-[''] after:select-none hover:bg-linear-control-hover hover:after:shadow-linear-secondary-hover active:bg-linear-control-hover active:after:shadow-linear-secondary-hover",
        outline:
          "bg-linear-control text-linear-foreground shadow-linear-outline hover:bg-linear-control-hover hover:shadow-linear-outline-hover active:bg-linear-control-hover active:shadow-linear-outline-hover",
        ghost:
          "bg-transparent text-linear-borderless-foreground shadow-none hover:bg-linear-subtle hover:text-linear-bright active:bg-linear-subtle active:text-linear-bright",
        destructive:
          "bg-transparent text-linear-danger shadow-none hover:bg-linear-danger-subtle active:bg-linear-danger-subtle",
        warning:
          "min-w-8 bg-warning text-app-bg-primary shadow-linear-control hover:bg-warning/90 active:bg-warning/90",
      },
      size: {
        default: "h-8 rounded-[9999px] px-3",
        compact: "h-7 rounded-lg pl-2.5 pr-3 text-xs",
        select: "h-[30px] rounded-lg pl-2.5 pr-7 text-[13px] font-normal",
        icon: "size-7 min-w-0 rounded-[9999px] px-0.5 py-0",
        large: "h-11 rounded-[9999px] px-[18px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

type ButtonProps = React.ComponentPropsWithoutRef<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Component = asChild ? Slot : "button"

    return (
      <Component
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        type={asChild ? undefined : (type ?? "button")}
        {...props}
      />
    )
  },
)
Button.displayName = "Button"

export { Button }
