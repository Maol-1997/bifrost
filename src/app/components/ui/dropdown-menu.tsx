import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"
import { cva, type VariantProps } from "class-variance-authority"
import { Check, ChevronRight, Circle } from "lucide-react"

import { cn } from "@app/lib/cn"

const dropdownMenuContentVariants = cva(
  "z-[600] min-w-[195px] overflow-hidden rounded-xl border-[0.5px] py-1.5 text-[13px] font-[450] [line-height:normal] shadow-linear-popover",
  {
    variants: {
      tone: {
        default:
          "border-linear-menu-border bg-linear-popover text-linear-menu-foreground",
        elevated:
          "border-linear-popover-elevated-border bg-linear-popover-elevated text-linear-menu-elevated-foreground",
      },
    },
    defaultVariants: {
      tone: "default",
    },
  },
)

const menuItemClassName =
  "relative flex h-8 cursor-default items-center rounded-none py-0 pl-3.5 pr-[18px] outline-none select-none before:absolute before:inset-x-1.5 before:inset-y-0 before:z-0 before:rounded-lg before:bg-transparent data-[disabled]:pointer-events-none data-[disabled]:opacity-50"

const dropdownMenuItemVariants = cva(menuItemClassName, {
  variants: {
    variant: {
      default:
        "data-[highlighted]:text-linear-bright data-[highlighted]:before:bg-linear-menu-item-hover",
      destructive:
        "text-linear-menu-danger data-[highlighted]:text-linear-menu-danger data-[highlighted]:before:bg-linear-menu-danger-hover",
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

function DropdownMenuItemContent({ children }: React.PropsWithChildren) {
  return (
    <span className="relative z-10 flex min-w-0 flex-1 items-center [&>svg]:mr-2 [&>svg]:size-4 [&>svg]:shrink-0">
      {children}
    </span>
  )
}

type DropdownMenuContentProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitive.Content
> &
  VariantProps<typeof dropdownMenuContentVariants>

const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  DropdownMenuContentProps
>(({ className, sideOffset = 4, tone, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(dropdownMenuContentVariants({ tone }), className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

type DropdownMenuItemProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitive.Item
> &
  VariantProps<typeof dropdownMenuItemVariants>

const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  DropdownMenuItemProps
>(({ className, children, variant, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(dropdownMenuItemVariants({ variant }), className)}
    {...props}
  >
    <DropdownMenuItemContent>{children}</DropdownMenuItemContent>
  </DropdownMenuPrimitive.Item>
))
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

const DropdownMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(dropdownMenuItemVariants(), className)}
    {...props}
  >
    <DropdownMenuItemContent>
      {children}
      <ChevronRight
        className="ml-auto mr-0 size-3 text-linear-menu-icon"
        aria-hidden="true"
      />
    </DropdownMenuItemContent>
  </DropdownMenuPrimitive.SubTrigger>
))
DropdownMenuSubTrigger.displayName =
  DropdownMenuPrimitive.SubTrigger.displayName

const DropdownMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.SubContent
    ref={ref}
    className={cn(
      dropdownMenuContentVariants({ tone: "default" }),
      className,
    )}
    {...props}
  />
))
DropdownMenuSubContent.displayName =
  DropdownMenuPrimitive.SubContent.displayName

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    {...(checked === undefined ? {} : { checked })}
    className={cn(dropdownMenuItemVariants(), "pl-8", className)}
    {...props}
  >
    <span className="absolute left-3 z-10 flex size-4 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="size-3.5" aria-hidden="true" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    <DropdownMenuItemContent>{children}</DropdownMenuItemContent>
  </DropdownMenuPrimitive.CheckboxItem>
))
DropdownMenuCheckboxItem.displayName =
  DropdownMenuPrimitive.CheckboxItem.displayName

const DropdownMenuRadioItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(dropdownMenuItemVariants(), "pl-8", className)}
    {...props}
  >
    <span className="absolute left-3 z-10 flex size-4 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Circle className="size-2 fill-current" aria-hidden="true" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    <DropdownMenuItemContent>{children}</DropdownMenuItemContent>
  </DropdownMenuPrimitive.RadioItem>
))
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName

const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1.5 text-[11px] font-medium text-linear-menu-icon",
      className,
    )}
    {...props}
  />
))
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName

const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn(
      "relative h-3 after:absolute after:inset-x-0 after:top-1.5 after:h-[0.5px] after:bg-linear-menu-separator",
      className,
    )}
    {...props}
  />
))
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"span">) {
  return (
    <span
      className={cn(
        "ml-auto pl-2 text-[11px] font-[450] text-linear-menu-icon",
        className,
      )}
      {...props}
    />
  )
}

const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
const DropdownMenuGroup = DropdownMenuPrimitive.Group
const DropdownMenuPortal = DropdownMenuPrimitive.Portal
const DropdownMenuSub = DropdownMenuPrimitive.Sub
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  dropdownMenuContentVariants,
  dropdownMenuItemVariants,
  type DropdownMenuContentProps,
  type DropdownMenuItemProps,
}
