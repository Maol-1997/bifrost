import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { animated, useSpring } from "@react-spring/web"

import { cn } from "@app/lib/cn"

const SIDEBAR_DESKTOP_QUERY = "(min-width: 1025px)"
const SIDEBAR_DESKTOP_WIDTH = 244
const SIDEBAR_MOBILE_WIDTH = 330
const SIDEBAR_SPRING = {
  tension: 1200,
  friction: 80,
  precision: 0.1,
} as const

type SidebarCollapsibleContextValue = {
  contentId: string
  onOpenChange: (open: boolean) => void
  open: boolean
}

const SidebarCollapsibleContext = React.createContext<
  SidebarCollapsibleContextValue | undefined
>(undefined)

function useSidebarCollapsible() {
  const context = React.useContext(SidebarCollapsibleContext)
  if (!context) {
    throw new Error(
      "SidebarCollapsible components must be inside SidebarCollapsible",
    )
  }
  return context
}

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
          "fixed inset-y-0 z-[96] flex h-dvh max-w-full shrink-0 flex-col overflow-hidden bg-linear-gallery-main shadow-none transition-shadow duration-150 ease-in data-[state=open]:shadow-linear-dialog motion-reduce:transition-none min-[1025px]:bg-linear-sidebar-background min-[1025px]:shadow-none",
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

type SidebarCollapsibleProps = React.ComponentPropsWithoutRef<"div"> & {
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  open?: boolean
}

const SidebarCollapsible = React.forwardRef<
  HTMLDivElement,
  SidebarCollapsibleProps
>(
  (
    {
      className,
      defaultOpen = true,
      onOpenChange,
      open: controlledOpen,
      ...props
    },
    ref,
  ) => {
    const contentId = React.useId()
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
    const open = controlledOpen ?? internalOpen

    function changeOpen(nextOpen: boolean) {
      if (controlledOpen === undefined) {
        setInternalOpen(nextOpen)
      }
      onOpenChange?.(nextOpen)
    }

    return (
      <SidebarCollapsibleContext.Provider
        value={{ contentId, onOpenChange: changeOpen, open }}
      >
        <div
          ref={ref}
          className={cn("w-full", className)}
          data-state={open ? "open" : "closed"}
          {...props}
        />
      </SidebarCollapsibleContext.Provider>
    )
  },
)
SidebarCollapsible.displayName = "SidebarCollapsible"

function SidebarDisclosureIcon(
  props: React.ComponentPropsWithoutRef<"svg">,
) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        fill="currentColor"
        d="M7.00194 10.6239C6.66861 10.8183 6.25 10.5779 6.25 10.192V5.80802C6.25 5.42212 6.66861 5.18169 7.00194 5.37613L10.7596 7.56811C11.0904 7.76105 11.0904 8.23895 10.7596 8.43189L7.00194 10.6239Z"
      />
    </svg>
  )
}

type SidebarCollapsibleTriggerVariant = "section" | "team"

type SidebarCollapsibleTriggerProps = Omit<
  React.ComponentPropsWithoutRef<"button">,
  "children"
> & {
  action?: React.ReactNode
  children: React.ReactNode
  variant?: SidebarCollapsibleTriggerVariant
}

const SidebarCollapsibleTrigger = React.forwardRef<
  HTMLButtonElement,
  SidebarCollapsibleTriggerProps
>(
  (
    { action, children, className, onClick, variant = "section", ...props },
    ref,
  ) => {
    const { contentId, onOpenChange, open } = useSidebarCollapsible()

    function toggleOpen(event: React.MouseEvent<HTMLButtonElement>) {
      onClick?.(event)
      if (!event.defaultPrevented) {
        onOpenChange(!open)
      }
    }

    return (
      <div
        className={cn(
          "group/sidebar-trigger mx-[12.5px] flex h-7 w-[305px] items-center rounded-lg min-[1025px]:mx-3 min-[1025px]:w-[220px]",
          variant === "team" &&
            "hover:bg-linear-muted-hover focus-within:bg-linear-muted-hover",
        )}
      >
        <button
          ref={ref}
          aria-controls={contentId}
          aria-expanded={open}
          className={cn(
            "flex h-7 min-w-0 flex-1 cursor-default items-center overflow-hidden border-0 bg-transparent outline-none",
            "focus-visible:text-linear-bright",
            variant === "section"
              ? "gap-0.5 px-1 text-[13px] font-normal text-linear-search-placeholder [line-height:24px] hover:text-linear-bright"
              : "gap-2 pl-[9px] text-[13px] font-medium text-linear-bright [line-height:normal]",
            className,
          )}
          onClick={toggleOpen}
          type="button"
          {...props}
        >
          {children}
          <SidebarDisclosureIcon
            className={cn(
              "size-4 shrink-0 rotate-0 transition-transform duration-150 ease-out motion-reduce:transition-none",
              open && "rotate-90",
              variant === "section"
                ? "text-linear-search-placeholder"
                : "text-linear-inline-placeholder",
            )}
          />
        </button>
        {action}
      </div>
    )
  },
)
SidebarCollapsibleTrigger.displayName = "SidebarCollapsibleTrigger"

type SidebarCollapsibleContentProps = React.ComponentPropsWithoutRef<"div">

const SidebarCollapsibleContent = React.forwardRef<
  HTMLDivElement,
  SidebarCollapsibleContentProps
>(({ children, className, ...props }, ref) => {
  const { contentId, open } = useSidebarCollapsible()

  return (
    <div
      ref={ref}
      aria-hidden={!open}
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        className,
      )}
      data-state={open ? "open" : "closed"}
      id={contentId}
      inert={open ? undefined : true}
      {...props}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
})
SidebarCollapsibleContent.displayName = "SidebarCollapsibleContent"

type SidebarNestedLinkProps = React.ComponentPropsWithoutRef<"a"> & {
  active?: boolean
  asChild?: boolean
}

const SidebarNestedLink = React.forwardRef<
  HTMLAnchorElement,
  SidebarNestedLinkProps
>(({ active = false, asChild = false, children, className, ...props }, ref) => {
  const Component = asChild ? Slot : "a"

  return (
    <Component
      ref={ref}
      aria-current={active ? "page" : undefined}
      className={cn(
        "my-px ml-[31.5px] flex h-7 w-[286px] cursor-default items-center gap-1.5 overflow-hidden rounded-lg py-0 pl-1.5 pr-[9px] text-[13px] font-medium [line-height:normal] text-linear-search-placeholder outline-none transition-[background-color,color] duration-150 ease-[ease] hover:bg-linear-muted-hover hover:text-linear-bright focus-visible:bg-linear-muted-hover focus-visible:text-linear-bright motion-reduce:transition-none min-[1025px]:ml-[31px] min-[1025px]:w-[201px] [&>span]:min-w-0 [&>span]:truncate [&>svg]:size-3.5 [&>svg]:shrink-0",
        active && "bg-linear-sidebar-active text-linear-bright",
        className,
      )}
      data-active={active}
      {...props}
    >
      {children}
    </Component>
  )
})
SidebarNestedLink.displayName = "SidebarNestedLink"

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
  SidebarContent,
  SidebarCollapsible,
  SidebarCollapsibleContent,
  SidebarCollapsibleTrigger,
  SidebarGroup,
  SidebarHeader,
  SidebarLink,
  SidebarMobileHeader,
  SidebarNestedLink,
  SidebarSpacer,
  SidebarTrigger,
  type SidebarBackdropProps,
  type SidebarCollapsibleProps,
  type SidebarCollapsibleTriggerProps,
  type SidebarLinkProps,
  type SidebarNestedLinkProps,
  type SidebarProps,
  type SidebarSpacerProps,
}
