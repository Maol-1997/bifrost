import * as React from "react"
import { Copy, Plus, Star, Trash2, X } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@app/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@app/components/ui/tooltip"
import { cn } from "@app/lib/cn"
import { AgentChatToolbarButton } from "./agent-chat-actions"
import {
  ChevronDownIcon,
  MoreIcon,
  ProjectIcon,
  SearchIcon,
  UsersIcon,
} from "./agent-chat-icons"
import { AgentChatLogo } from "./agent-chat-logo"

type AgentHistoryItem = {
  age: string
  current?: boolean
  favorite?: boolean
  group?: string
  id: string
  title: string
}

type AgentChatProps = {
  children: React.ReactNode
  className?: string
  conversation?: boolean
  favorite?: boolean
  history?: AgentHistoryItem[]
  onCopyAsMarkdown?: () => void
  onDelete?: () => void
  onFavoriteChange?: (favorite: boolean) => void
  onHistorySelect?: (item: AgentHistoryItem) => void
  onMoveToToolbar?: () => void
  onNewChat?: () => void
  title?: string
}

type HeaderIconButtonProps = React.ComponentPropsWithoutRef<"button"> & {
  label: string
}

const HeaderIconButton = React.forwardRef<HTMLButtonElement, HeaderIconButtonProps>(
  ({ children, className, label, ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          aria-label={label}
          className={cn(
            "relative flex size-7 items-center justify-center rounded-full border-[0.5px] border-transparent text-linear-control-foreground transition-[background-color,color] duration-150 hover:bg-linear-ghost-hover focus-visible:bg-linear-ghost-hover focus-visible:outline-none max-[1024px]:size-8",
            className,
          )}
          type="button"
          {...props}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  ),
)
HeaderIconButton.displayName = "HeaderIconButton"

type HistoryMenuProps = {
  align?: "end" | "start"
  children: React.ReactNode
  history: AgentHistoryItem[]
  onNewChat?: () => void
  onSelect?: (item: AgentHistoryItem) => void
}

function ChatOptionsMenu({
  onCopyAsMarkdown,
  onDelete,
}: Pick<AgentChatProps, "onCopyAsMarkdown" | "onDelete">) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <HeaderIconButton label="Chat options">
          <MoreIcon />
        </HeaderIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44 min-w-44" sideOffset={4}>
        <DropdownMenuItem
          disabled={!onCopyAsMarkdown}
          {...(onCopyAsMarkdown ? { onSelect: onCopyAsMarkdown } : {})}
        >
          <Copy className="size-4" aria-hidden="true" />
          Copy as markdown
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!onDelete}
          {...(onDelete ? { onSelect: onDelete } : {})}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Delete
          <DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HistoryMenu({
  align = "start",
  children,
  history,
  onNewChat,
  onSelect,
}: HistoryMenuProps) {
  const group = history[0]?.group ?? "Today"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="max-h-[min(360px,calc(100vh-64px))] w-[min(272px,calc(100vw-24px))] min-w-0 overflow-y-auto rounded-lg py-1"
        sideOffset={2}
      >
        <DropdownMenuItem
          className="h-7 pl-3 pr-3 text-[12.5px] before:inset-x-1 before:rounded-md"
          {...(onNewChat ? { onSelect: onNewChat } : {})}
        >
          <Plus
            aria-hidden="true"
            className="text-linear-menu-icon"
            strokeWidth={1.75}
          />
          New chat
        </DropdownMenuItem>
        <DropdownMenuSeparator className="h-2 after:top-1" />
        <div
          aria-label={group}
          className="flex h-6 items-center px-3 text-[11px] font-medium text-linear-select-chevron"
          role="group"
        >
          {group}
        </div>
        {history.length === 0 ? (
          <div className="px-3.5 py-2 text-[13px] font-[450] text-linear-agent-action">
            No history
          </div>
        ) : (
          history.map((item) => (
            <DropdownMenuItem
              key={item.id}
              className="h-[30px] pl-3 pr-3 text-[12.5px] before:inset-x-1 before:rounded-md data-[current=true]:before:bg-linear-menu-item-hover"
              data-current={item.current}
              aria-current={item.current ? "page" : undefined}
              onSelect={() => onSelect?.(item)}
            >
              <span aria-hidden="true" className="flex w-6 shrink-0 items-center">
                {item.favorite ? <Star className="size-3 fill-current" /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate" title={item.title}>
                {item.title}
              </span>
              <span className="ml-2 shrink-0 tabular-nums text-linear-agent-action">
                {item.age}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type AgentChatHeaderProps = Omit<AgentChatProps, "children" | "className">

function AgentChatHeader({
  conversation = false,
  favorite = false,
  history = [],
  onCopyAsMarkdown,
  onDelete,
  onFavoriteChange,
  onHistorySelect,
  onMoveToToolbar,
  onNewChat,
  title = "New chat",
}: AgentChatHeaderProps) {
  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b-[0.5px] border-linear-border px-2">
      <div className="flex min-w-0 items-center">
        <HistoryMenu
          history={history}
          {...(onNewChat ? { onNewChat } : {})}
          {...(onHistorySelect ? { onSelect: onHistorySelect } : {})}
        >
          <button
            aria-label="Switch agent chat"
            className="relative ml-0 flex h-7 min-w-0 items-center gap-2 rounded-full border-[0.5px] border-transparent px-2 text-xs font-medium text-linear-control-foreground transition-[background-color,color] duration-150 hover:bg-linear-ghost-hover hover:text-linear-bright focus-visible:bg-linear-ghost-hover focus-visible:text-linear-bright focus-visible:outline-none data-[state=open]:bg-linear-ghost-hover data-[state=open]:text-linear-bright max-[1024px]:h-8 min-[1025px]:ml-0.5"
            type="button"
          >
            <span className="truncate">{title}</span>
            <span className="shrink-0 text-linear-select-chevron">
              <ChevronDownIcon />
            </span>
          </button>
        </HistoryMenu>
        {conversation ? (
          <>
            <HeaderIconButton
              aria-pressed={favorite}
              label={favorite ? "Remove from favorites" : "Add to favorites"}
              onClick={() => onFavoriteChange?.(!favorite)}
            >
              <Star className={cn("size-4", favorite && "fill-current text-linear-bright")} aria-hidden="true" />
            </HeaderIconButton>
            <ChatOptionsMenu
              {...(onCopyAsMarkdown ? { onCopyAsMarkdown } : {})}
              {...(onDelete ? { onDelete } : {})}
            />
          </>
        ) : null}
      </div>
      {conversation && onMoveToToolbar ? <AgentChatToolbarButton onClick={onMoveToToolbar} /> : null}
    </header>
  )
}

function AgentChat({
  children,
  className,
  conversation = false,
  favorite = false,
  history = [],
  onCopyAsMarkdown,
  onDelete,
  onFavoriteChange,
  onHistorySelect,
  onMoveToToolbar,
  onNewChat,
  title = "New chat",
}: AgentChatProps) {
  React.useEffect(() => {
    if (!conversation || !onDelete) return

    function handleDeleteShortcut(event: KeyboardEvent): void {
      if (!event.metaKey || event.key !== "Backspace" || isEditableTarget(event.target)) return
      event.preventDefault()
      onDelete?.()
    }

    window.addEventListener("keydown", handleDeleteShortcut)
    return () => window.removeEventListener("keydown", handleDeleteShortcut)
  }, [conversation, onDelete])

  return (
    <TooltipProvider>
      <div
        className={cn(
          "relative h-[720px] min-h-[600px] w-full overflow-hidden bg-linear-canvas",
          className,
        )}
      >
        <section className="absolute inset-0 flex flex-col overflow-hidden bg-linear-gallery-main">
          <AgentChatHeader
            conversation={conversation}
            favorite={favorite}
            history={history}
            {...(onCopyAsMarkdown ? { onCopyAsMarkdown } : {})}
            {...(onDelete ? { onDelete } : {})}
            {...(onFavoriteChange ? { onFavoriteChange } : {})}
            {...(onHistorySelect ? { onHistorySelect } : {})}
            {...(onMoveToToolbar ? { onMoveToToolbar } : {})}
            {...(onNewChat ? { onNewChat } : {})}
            title={title}
          />
          {children}
        </section>
      </div>
    </TooltipProvider>
  )
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
}

type AgentSuggestion = {
  description: string
  icon: "project" | "research" | "team"
  id: string
  title: string
}

type AgentChatSuggestionsProps = {
  onDismiss?: () => void
  onSelect?: (suggestion: AgentSuggestion) => void
  suggestions: AgentSuggestion[]
}

const suggestionIcons = {
  project: ProjectIcon,
  research: SearchIcon,
  team: UsersIcon,
} as const

function AgentChatSuggestions({
  onDismiss,
  onSelect,
  suggestions,
}: AgentChatSuggestionsProps) {
  return (
    <div className="mx-auto flex w-[calc(100%-48px)] max-w-[712px] flex-col gap-3 pt-3 min-[1025px]:w-[calc(100%-32px)]">
      <div className="flex h-7 items-center justify-between px-4">
        <span className="text-xs font-[450] text-linear-select-chevron">
          Get started with some examples
        </span>
        {onDismiss ? (
          <button
            aria-label="Dismiss"
            className="relative flex size-6 items-center justify-center rounded-full text-linear-control-foreground transition-colors duration-150 hover:bg-linear-ghost-hover hover:text-linear-bright focus-visible:bg-linear-ghost-hover focus-visible:outline-none"
            onClick={onDismiss}
            type="button"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {suggestions.map((suggestion) => {
          const Icon = suggestionIcons[suggestion.icon]
          return (
            <button
              key={suggestion.id}
              className="group relative flex min-h-[134px] flex-col gap-1.5 rounded-lg border-[0.5px] border-linear-border bg-transparent px-4 pb-3 pt-4 text-left text-linear-bright transition-colors duration-150 hover:bg-linear-card-hover focus-visible:bg-linear-card-hover focus-visible:outline-none"
              onClick={() => onSelect?.(suggestion)}
              type="button"
            >
              <span className="mb-auto flex size-4 items-center justify-center text-linear-bright [filter:drop-shadow(0_0_4px_lch(100_0_272/.3))]">
                <Icon />
              </span>
              <span className="text-[13px] font-medium leading-[15.5px]">
                {suggestion.title}
              </span>
              <span className="text-[13px] font-[450] leading-[19.5px] text-linear-muted">
                {suggestion.description}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

type AgentChatEmptyStateProps = {
  children: React.ReactNode
  className?: string
}

function AgentChatEmptyState({ children, className }: AgentChatEmptyStateProps) {
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div
        className={cn(
          "relative z-[1] mx-auto flex min-h-full w-full -translate-y-[11px] flex-col justify-center",
          className,
        )}
      >
        <div className="relative flex w-full flex-col">
          <AgentChatLogo className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-3/4" />
          {children}
        </div>
      </div>
    </div>
  )
}

export {
  AgentChat,
  AgentChatEmptyState,
  AgentChatHeader,
  AgentChatSuggestions,
  type AgentChatProps,
  type AgentHistoryItem,
  type AgentSuggestion,
}
