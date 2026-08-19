import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@app/lib/cn"

const switchRootClasses =
  "group relative inline-flex h-5 w-[30px] shrink-0 touch-manipulation appearance-none items-center rounded-[72px] border-0 bg-linear-switch-off p-0 outline-none transition-[background-color,opacity] duration-150 ease-out before:absolute before:inset-[-6px] before:content-[''] hover:bg-linear-switch-off-hover active:bg-linear-switch-off-hover focus-visible:[outline:1px_solid_var(--linear-primary)] focus-visible:[outline-offset:2px] disabled:opacity-50 data-[preview=active]:bg-linear-switch-off-hover data-[preview=focus]:[outline:1px_solid_var(--linear-primary)] data-[preview=focus]:[outline-offset:2px] data-[preview=hover]:bg-linear-switch-off-hover data-[state=checked]:bg-linear-primary data-[state=checked]:hover:bg-linear-primary-hover data-[state=checked]:active:bg-linear-primary-hover data-[state=checked]:data-[preview=active]:bg-linear-primary-hover data-[state=checked]:data-[preview=hover]:bg-linear-primary-hover motion-reduce:transition-none"

const switchThumbClasses =
  "pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-[7px] bg-linear-switch-thumb data-[state=unchecked]:left-[3px] data-[state=unchecked]:right-[13px] data-[state=unchecked]:[transition:left_0.1s_ease-out,right_0.1s_ease-out_0.05s] data-[state=checked]:left-[13px] data-[state=checked]:right-[3px] data-[state=checked]:[transition:left_0.1s_ease-out_0.05s,right_0.1s_ease-out] group-hover:w-4 group-active:w-4 group-data-[preview=active]:w-4 group-data-[preview=hover]:w-4 data-[state=unchecked]:group-hover:right-[11px] data-[state=unchecked]:group-active:right-[11px] data-[state=unchecked]:group-data-[preview=active]:right-[11px] data-[state=unchecked]:group-data-[preview=hover]:right-[11px] data-[state=checked]:group-hover:left-[11px] data-[state=checked]:group-active:left-[11px] data-[state=checked]:group-data-[preview=active]:left-[11px] data-[state=checked]:group-data-[preview=hover]:left-[11px] motion-reduce:transition-none"

const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(switchRootClasses, className)}
    {...props}
  >
    <SwitchPrimitive.Thumb className={switchThumbClasses} />
  </SwitchPrimitive.Root>
))
Switch.displayName = SwitchPrimitive.Root.displayName

export { Switch, switchRootClasses, switchThumbClasses }
