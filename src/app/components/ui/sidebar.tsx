import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { animated, useSpring } from "@react-spring/web"
import { ChevronLeft } from "lucide-react"

import { cn } from "@app/lib/cn"
import { SearchInput } from "./input"

const SIDEBAR_DESKTOP_QUERY = "(min-width: 1025px)"
const SIDEBAR_DESKTOP_WIDTH = 244
const SIDEBAR_MOBILE_WIDTH = 330
const SIDEBAR_SPRING = {
  tension: 1200,
  friction: 80,
  precision: 0.1,
} as const

function useMediaQuery(query: string) {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") {
        return () => undefined
      }

      const mediaQuery = window.matchMedia(query)
      mediaQuery.addEventListener("change", onChange)
      return () => mediaQuery.removeEventListener("change", onChange)
    },
    [query],
  )
  const getSnapshot = React.useCallback(
    () =>
      typeof window.matchMedia === "function"
        ? window.matchMedia(query).matches
        : false,
    [query],
  )

  return React.useSyncExternalStore(subscribe, getSnapshot, () => false)
}

type SidebarProps = Omit<
  React.ComponentPropsWithoutRef<typeof animated.aside>,
  "style"
> & {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  style?: React.CSSProperties
}

const Sidebar = React.forwardRef<HTMLElement, SidebarProps>(
  ({ className, onOpenChange, open = false, style, ...props }, ref) => {
    const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_QUERY)
    const shouldReduceMotion = useMediaQuery(
      "(prefers-reduced-motion: reduce)",
    )
    const width = isDesktop ? SIDEBAR_DESKTOP_WIDTH : SIDEBAR_MOBILE_WIDTH
    const left = isDesktop ? 0 : open ? 0 : -SIDEBAR_MOBILE_WIDTH
    const springs = useSpring({
      width,
      left,
      config: SIDEBAR_SPRING,
      immediate: shouldReduceMotion,
    })

    React.useEffect(() => {
      if (isDesktop && open) {
        onOpenChange?.(false)
      }
    }, [isDesktop, onOpenChange, open])

    return (
      <animated.aside
        ref={ref}
        data-state={open ? "open" : "closed"}
        data-layout={isDesktop ? "desktop" : "mobile"}
        className={cn(
          "fixed inset-y-0 z-[96] flex h-dvh max-w-full shrink-0 flex-col overflow-hidden bg-linear-gallery-main shadow-none transition-shadow duration-150 ease-in data-[state=open]:shadow-linear-dialog motion-reduce:transition-none min-[1025px]:bg-linear-canvas min-[1025px]:shadow-none",
          className,
        )}
        style={{ ...style, width: springs.width, left: springs.left }}
        {...props}
      />
    )
  },
)
Sidebar.displayName = "Sidebar"

type SidebarSpacerProps = Omit<
  React.ComponentPropsWithoutRef<typeof animated.div>,
  "style"
> & { style?: React.CSSProperties }

const SidebarSpacer = React.forwardRef<HTMLDivElement, SidebarSpacerProps>(
  ({ className, style, ...props }, ref) => {
    const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_QUERY)
    const shouldReduceMotion = useMediaQuery(
      "(prefers-reduced-motion: reduce)",
    )
    const springs = useSpring({
      width: isDesktop ? SIDEBAR_DESKTOP_WIDTH : 0,
      config: SIDEBAR_SPRING,
      immediate: shouldReduceMotion,
    })

    return (
      <animated.div
        ref={ref}
        aria-hidden="true"
        className={cn("h-full shrink-0", className)}
        style={{ ...style, width: springs.width }}
        {...props}
      />
    )
  },
)
SidebarSpacer.displayName = "SidebarSpacer"

type SidebarBackdropProps = React.ComponentPropsWithoutRef<"button"> & {
  open?: boolean
}

const SidebarBackdrop = React.forwardRef<
  HTMLButtonElement,
  SidebarBackdropProps
>(({ className, open = false, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    aria-hidden={!open}
    tabIndex={open ? 0 : -1}
    data-state={open ? "open" : "closed"}
    className={cn(
      "fixed inset-0 z-[95] hidden border-0 bg-linear-sidebar-backdrop p-0 opacity-0 outline-none transition-opacity duration-200 ease-out data-[state=open]:pointer-events-auto data-[state=open]:opacity-100 motion-reduce:transition-none max-[1024px]:block data-[state=closed]:pointer-events-none",
      className,
    )}
    {...props}
  />
))
SidebarBackdrop.displayName = "SidebarBackdrop"

function SidebarMenuIcon(props: React.ComponentPropsWithoutRef<"svg">) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4.25 2C2.45508 2 1 3.45508 1 5.25V10.75C1 12.5449 2.45508 14 4.25 14H11.75C13.5449 14 15 12.5449 15 10.75V5.25C15 3.45508 13.5449 2 11.75 2H4.25ZM2.5 5.5C2.5 4.39543 3.39543 3.5 4.5 3.5H11.5C12.6046 3.5 13.5 4.39543 13.5 5.5V10.5C13.5 11.6046 12.6046 12.5 11.5 12.5H4.5C3.39543 12.5 2.5 11.6046 2.5 10.5V5.5Z"
      />
      <rect x="4" y="5" width="1.5" height="6" rx="0.75" />
    </svg>
  )
}

const SidebarTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<"button">
>(({ className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      "relative hidden size-7 shrink-0 items-center justify-center rounded-full border-[0.5px] border-transparent px-0.5 py-0 text-linear-select-chevron outline-none transition-[background-color,color] duration-150 ease-[ease] hover:bg-linear-muted-hover hover:text-linear-bright focus-visible:border-linear-menu-border focus-visible:text-linear-bright motion-reduce:transition-none max-[1024px]:flex",
      className,
    )}
    {...props}
  >
    <SidebarMenuIcon className="size-4" />
  </button>
))
SidebarTrigger.displayName = "SidebarTrigger"

const SidebarMobileHeader = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "hidden h-[43.5px] shrink-0 items-center gap-2 px-[15px] max-[1024px]:flex",
      className,
    )}
    {...props}
  />
))
SidebarMobileHeader.displayName = "SidebarMobileHeader"

const SidebarMobileBackLink = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentPropsWithoutRef<"a">
>(({ className, children, ...props }, ref) => (
  <a
    ref={ref}
    className={cn(
      "flex h-[23px] cursor-default items-center gap-2 text-base font-normal text-linear-bright outline-none focus-visible:underline",
      className,
    )}
    {...props}
  >
    <svg
      width="11"
      height="18"
      viewBox="0 0 11 18"
      fill="currentColor"
      className="text-linear-inline-placeholder"
      aria-hidden="true"
    >
      <path d="M3.68293 8.63202L3.30966 8.99195L3.68293 9.35188L10.1643 15.6015C10.6051 16.0265 10.6028 16.7325 10.162 17.1712C9.70399 17.6104 8.96011 17.6096 8.5031 17.1689L0.83567 9.77564C0.388109 9.34408 0.388109 8.65592 0.83567 8.22436L8.5031 0.83107C8.96089 0.389643 9.70653 0.389643 10.1643 0.83107C10.6119 1.26263 10.6119 1.95079 10.1643 2.38235L3.68293 8.63202Z" />
    </svg>
    {children}
  </a>
))
SidebarMobileBackLink.displayName = "SidebarMobileBackLink"

const SidebarHeader = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("h-[97.5px] shrink-0 pt-[16.5px]", className)}
    {...props}
  />
))
SidebarHeader.displayName = "SidebarHeader"

const SidebarBackLink = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentPropsWithoutRef<"a">
>(({ className, children, ...props }, ref) => (
  <a
    ref={ref}
    className={cn(
      "ml-4 flex h-7 w-fit cursor-default items-center gap-1 rounded-full border-[0.5px] border-transparent py-0 pl-1.5 pr-3 text-[13px] font-medium [line-height:normal] text-linear-muted outline-none transition-colors duration-150 ease-[ease] hover:bg-linear-muted-hover hover:text-linear-bright focus-visible:border-linear-menu-border focus-visible:text-linear-bright motion-reduce:transition-none",
      className,
    )}
    {...props}
  >
    <ChevronLeft className="size-3.5 shrink-0" aria-hidden="true" />
    {children}
  </a>
))
SidebarBackLink.displayName = "SidebarBackLink"

type SidebarSearchProps = React.ComponentPropsWithoutRef<typeof SearchInput>

const SidebarSearch = React.forwardRef<
  React.ComponentRef<typeof SearchInput>,
  SidebarSearchProps
>(({ className, containerClassName, ...props }, ref) => (
  <SearchInput
    ref={ref}
    className={cn("w-[305px] min-[1025px]:w-[220px]", className)}
    containerClassName={cn(
      "mx-[12.5px] mt-3 w-[305px] min-[1025px]:mx-3 min-[1025px]:w-[220px]",
      containerClassName,
    )}
    {...props}
  />
))
SidebarSearch.displayName = "SidebarSearch"

const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("min-h-0 flex-1 overflow-y-auto pt-4", className)}
    {...props}
  />
))
SidebarContent.displayName = "SidebarContent"

const SidebarGroup = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("mb-4", className)} {...props} />
))
SidebarGroup.displayName = "SidebarGroup"

const SidebarGroupLabel = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<"h2">
>(({ className, ...props }, ref) => (
  <h2
    ref={ref}
    className={cn(
      "mx-[12.5px] mb-1.5 flex h-[15.5px] items-center pl-2.5 text-[13px] font-medium [line-height:normal] text-linear-muted min-[1025px]:mx-3",
      className,
    )}
    {...props}
  />
))
SidebarGroupLabel.displayName = "SidebarGroupLabel"

type SidebarLinkProps = React.ComponentPropsWithoutRef<"a"> & {
  active?: boolean
  asChild?: boolean
}

const SidebarLink = React.forwardRef<HTMLAnchorElement, SidebarLinkProps>(
  ({ active = false, asChild = false, className, children, ...props }, ref) => {
    const Component = asChild ? Slot : "a"

    return (
    <Component
      ref={ref}
      aria-current={active ? "page" : undefined}
      data-active={active}
      className={cn(
        "mx-[12.5px] my-px flex h-7 w-[305px] cursor-default items-center gap-1.5 overflow-hidden rounded-lg py-0 pl-2.5 pr-[9px] text-[13px] font-medium [line-height:normal] text-linear-muted outline-none transition-colors duration-150 ease-[ease] hover:bg-linear-muted-hover hover:text-linear-bright focus-visible:bg-linear-muted-hover focus-visible:text-linear-bright data-[active=true]:bg-linear-sidebar-active data-[active=true]:text-linear-bright motion-reduce:transition-none min-[1025px]:mx-3 min-[1025px]:w-[220px] [&>span]:min-w-0 [&>span]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
    </Component>
    )
  },
)
SidebarLink.displayName = "SidebarLink"

export {
  Sidebar,
  SidebarBackdrop,
  SidebarBackLink,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarLink,
  SidebarMobileBackLink,
  SidebarMobileHeader,
  SidebarSearch,
  SidebarSpacer,
  SidebarTrigger,
  type SidebarBackdropProps,
  type SidebarLinkProps,
  type SidebarProps,
  type SidebarSearchProps,
  type SidebarSpacerProps,
}
