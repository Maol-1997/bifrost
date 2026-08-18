import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@app/lib/cn"

/**
 * Measured off Linear (settings/customer-requests): a 30x20 track with a 14px
 * knob inset 3px on each side.
 *
 * The knob animates `left` and `right` rather than `translate-x`, with the two
 * staggered 50ms apart in whichever direction it is travelling. That is what
 * makes it stretch as it leaves and settle as it lands — swapping it for a
 * transform would move the knob to the right places and lose the whole feel.
 */
const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "relative inline-block h-5 w-[30px] shrink-0 cursor-pointer rounded-full border-0 outline-none",
      "transition-[background-color,opacity] duration-150 ease-out",
      "bg-switch-off data-[state=checked]:bg-brand",
      "focus-visible:ring-2 focus-visible:ring-brand/60 disabled:cursor-not-allowed disabled:opacity-50",
      // Linear pads the hit area 6px past the track on every side, so the
      // control is comfortably tappable without looking any bigger.
      "before:absolute before:-inset-1.5 before:content-['']",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none absolute top-1/2 block -translate-y-1/2 rounded-full bg-white",
        "left-[3px] right-[13px] [transition:left_.1s_ease-out,right_.1s_ease-out_.05s]",
        "data-[state=checked]:left-[13px] data-[state=checked]:right-[3px]",
        "data-[state=checked]:[transition:left_.1s_ease-out_.05s,right_.1s_ease-out]",
        // Height only: the width is whatever left/right leave over, which is
        // exactly the 14px circle at rest and the stretch mid-travel.
        "h-3.5"
      )}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
