import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

// Measured off Linear (settings/project-updates), not eyeballed. The three
// things that make it read as theirs: 11px text at weight 450, an 8px radius
// that deliberately breaks from the pill radius of the buttons, and the same
// hairline shadow the controls use. It has no arrow — the 8px gap is the only
// thing tying it to its trigger.
const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 8, side = "bottom", ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      side={side}
      sideOffset={sideOffset}
      className={cn(
        // z-1100 matches Linear and keeps a tooltip above our dialogs, which sit at z-50.
        "z-[1100] max-w-xs overflow-hidden rounded-lg border-[0.5px] border-tooltip-border bg-tooltip px-2 py-[5px] text-[11px] font-[450] leading-[16.5px] text-app-text-secondary shadow-[0_0.5px_1px_1px_rgb(0_0_0/0.3)]",
        // Linear scales the surface out of the corner nearest the trigger, which
        // is exactly what Radix's transform-origin variable gives us.
        "origin-[--radix-tooltip-content-transform-origin] animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
