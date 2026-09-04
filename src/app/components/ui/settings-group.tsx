import * as React from "react"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@app/lib/cn"
import { Surface, type SurfaceProps } from "./surface"

type SettingsGroupProps = Omit<SurfaceProps, "variant">

const SettingsGroup = React.forwardRef<HTMLDivElement, SettingsGroupProps>(
  ({ className, ...props }, ref) => (
    <Surface
      ref={ref}
      variant="settings"
      className={cn("overflow-hidden", className)}
      {...props}
    />
  ),
)
SettingsGroup.displayName = "SettingsGroup"

const SettingsRow = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "relative flex h-[65px] items-center gap-3 p-4",
      "after:absolute after:bottom-0 after:left-4 after:right-4 after:h-[0.5px] after:bg-linear-settings-divider after:content-[''] last:after:hidden",
      className,
    )}
    {...props}
  />
))
SettingsRow.displayName = "SettingsRow"

const SettingsRowContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex min-w-0 flex-1 flex-col gap-[3px]", className)}
    {...props}
  />
))
SettingsRowContent.displayName = "SettingsRowContent"

const SettingsRowTitle = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "text-[13px] font-medium text-linear-bright [line-height:normal]",
      className,
    )}
    {...props}
  />
))
SettingsRowTitle.displayName = "SettingsRowTitle"

const SettingsRowDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<"p">
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn(
      "m-0 text-xs font-[450] text-linear-input-disabled [line-height:normal]",
      className,
    )}
    {...props}
  />
))
SettingsRowDescription.displayName = "SettingsRowDescription"

const SettingsRowAction = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("ml-auto flex shrink-0 items-center", className)}
    {...props}
  />
))
SettingsRowAction.displayName = "SettingsRowAction"

type SettingsLinkRowProps = React.ComponentPropsWithoutRef<"a"> & {
  asChild?: boolean
}

const SettingsLinkRow = React.forwardRef<HTMLAnchorElement, SettingsLinkRowProps>(
  ({ asChild = false, className, ...props }, ref) => {
    const Component = asChild ? Slot : "a"

    return (
      <Component
        ref={ref}
        className={cn(
          "relative flex h-[65px] cursor-default items-center gap-3 rounded-none p-4 text-inherit no-underline outline-none",
          "first:rounded-t-[10px] last:rounded-b-[10px]",
          "hover:bg-linear-settings-row-hover data-[preview=hover]:bg-linear-settings-row-hover",
          "focus-visible:z-[2] focus-visible:[outline:1px_solid_var(--linear-primary)] focus-visible:[outline-offset:0]",
          "after:pointer-events-none after:absolute after:bottom-0 after:left-4 after:right-4 after:z-[1] after:h-[0.5px] after:bg-linear-settings-divider after:content-[''] last:after:hidden",
          className,
        )}
        {...props}
      />
    )
  },
)
SettingsLinkRow.displayName = "SettingsLinkRow"

const SettingsLinkRowIcon = React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<"span">
>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    className={cn(
      "ml-auto flex size-4 shrink-0 items-center justify-center text-linear-input-disabled",
      className,
    )}
    {...props}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M5.46967 11.4697C5.17678 11.7626 5.17678 12.2374 5.46967 12.5303C5.76256 12.8232 6.23744 12.8232 6.53033 12.5303L10.5303 8.53033C10.8207 8.23999 10.8236 7.77014 10.5368 7.47624L6.63419 3.47624C6.34492 3.17976 5.87009 3.17391 5.57361 3.46318C5.27713 3.75244 5.27128 4.22728 5.56054 4.52376L8.94583 7.99351L5.46967 11.4697Z"
      />
    </svg>
  </span>
))
SettingsLinkRowIcon.displayName = "SettingsLinkRowIcon"

export {
  SettingsGroup,
  SettingsLinkRow,
  SettingsLinkRowIcon,
  SettingsRow,
  SettingsRowAction,
  SettingsRowContent,
  SettingsRowDescription,
  SettingsRowTitle,
}
