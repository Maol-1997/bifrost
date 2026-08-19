import * as React from "react"

import { cn } from "@app/lib/cn"
import { AgentChat, type AgentChatProps, type AgentHistoryItem } from "./agent-chat"
import { AgentChatMini } from "./agent-chat-mini"

type AgentChatPlacement = "minimized" | "page" | "toolbar"

type AgentChatDockProps = Pick<
  AgentChatProps,
  "conversation" | "favorite" | "onCopyAsMarkdown" | "onDelete" | "onFavoriteChange" | "onHistorySelect" | "onNewChat"
> & {
  children: React.ReactNode
  className?: string
  defaultPlacement?: AgentChatPlacement
  history?: AgentHistoryItem[]
  onOpenFullPage?: () => void
  onPlacementChange?: (placement: AgentChatPlacement) => void
  pageVisible?: boolean
  placement?: AgentChatPlacement
  title?: string
}

type PlacementStateOptions = Pick<
  AgentChatDockProps,
  "defaultPlacement" | "onPlacementChange" | "placement"
>

function useAgentChatPlacement({
  defaultPlacement = "page",
  onPlacementChange,
  placement,
}: PlacementStateOptions) {
  const [internalPlacement, setInternalPlacement] =
    React.useState<AgentChatPlacement>(defaultPlacement)
  const currentPlacement = placement ?? internalPlacement

  function changePlacement(nextPlacement: AgentChatPlacement) {
    if (placement === undefined) {
      setInternalPlacement(nextPlacement)
    }
    onPlacementChange?.(nextPlacement)
  }

  return [currentPlacement, changePlacement] as const
}

function AgentChatDock({
  children,
  className,
  conversation = false,
  defaultPlacement,
  favorite = false,
  history = [],
  onCopyAsMarkdown,
  onDelete,
  onFavoriteChange,
  onHistorySelect,
  onNewChat,
  onOpenFullPage,
  onPlacementChange,
  pageVisible = true,
  placement,
  title = "New chat",
}: AgentChatDockProps) {
  const [currentPlacement, changePlacement] = useAgentChatPlacement({
    ...(defaultPlacement ? { defaultPlacement } : {}),
    ...(onPlacementChange ? { onPlacementChange } : {}),
    ...(placement ? { placement } : {}),
  })

  function openFullPage(): void {
    changePlacement("page")
    onOpenFullPage?.()
  }

  if (currentPlacement === "page") {
    if (!pageVisible) return null

    return (
      <AgentChat
        {...(className ? { className } : {})}
        conversation={conversation}
        favorite={favorite}
        history={history}
        {...(onCopyAsMarkdown ? { onCopyAsMarkdown } : {})}
        {...(onDelete ? { onDelete } : {})}
        {...(onFavoriteChange ? { onFavoriteChange } : {})}
        {...(onHistorySelect ? { onHistorySelect } : {})}
        onMoveToToolbar={() => changePlacement("toolbar")}
        {...(onNewChat ? { onNewChat } : {})}
        title={title}
      >
        {children}
      </AgentChat>
    )
  }

  const floating = !pageVisible
  const floatingContent = currentPlacement === "toolbar" ? (
    <AgentChatMini
      {...(onCopyAsMarkdown ? { onCopyAsMarkdown } : {})}
      {...(onDelete ? { onDelete } : {})}
      onClose={() => changePlacement("minimized")}
      onMinimize={() => changePlacement("minimized")}
      onOpenFullPage={openFullPage}
      position={floating ? "fixed" : "contained"}
      title={title}
    >
      {children}
    </AgentChatMini>
  ) : (
    <button
      aria-label={`Open ${title}`}
      className={cn(
        "flex h-7 max-w-[260px] items-center rounded-lg border-[0.5px] border-transparent px-3 text-xs font-medium text-linear-muted transition-[background-color,color] duration-150 hover:bg-linear-ghost-hover hover:text-linear-foreground focus-visible:bg-linear-ghost-hover focus-visible:text-linear-foreground focus-visible:outline-none",
        floating ? "fixed bottom-3 right-3 z-[90]" : "absolute bottom-1.5 right-12",
      )}
      onClick={() => changePlacement("toolbar")}
      type="button"
    >
      <span className="truncate">{title}</span>
    </button>
  )

  return floatingContent
}

export {
  AgentChatDock,
  type AgentChatDockProps,
  type AgentChatPlacement,
}
