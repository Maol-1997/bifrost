import * as React from "react"

import { cn } from "@app/lib/cn"
import {
  AgentChat,
  type AgentChatConversation,
  type AgentChatHistory,
} from "./agent-chat"
import { AgentChatMini } from "./agent-chat-mini"

type AgentChatPlacement = "minimized" | "page" | "toolbar"

type AgentChatDockConversation = Omit<AgentChatConversation, "onMoveToToolbar">
type AgentChatPlacementControl =
  | {
    current: AgentChatPlacement
    kind: "controlled"
    onChange: (placement: AgentChatPlacement) => void
  }
  | {
    defaultPlacement?: AgentChatPlacement
    kind: "uncontrolled"
    onChange?: (placement: AgentChatPlacement) => void
  }

type AgentChatDockProps = {
  children: React.ReactNode
  className?: string
  conversation?: AgentChatDockConversation
  history?: AgentChatHistory
  onOpenFullPage?: () => void
  pageVisible?: boolean
  placement?: AgentChatPlacementControl
  title?: string
}

function useAgentChatPlacement(control?: AgentChatPlacementControl) {
  const defaultPlacement = control?.kind === "uncontrolled"
    ? control.defaultPlacement ?? "page"
    : "page"
  const [internalPlacement, setInternalPlacement] =
    React.useState<AgentChatPlacement>(defaultPlacement)
  const currentPlacement = control?.kind === "controlled"
    ? control.current
    : internalPlacement

  function changePlacement(nextPlacement: AgentChatPlacement) {
    if (control?.kind !== "controlled") {
      setInternalPlacement(nextPlacement)
    }
    control?.onChange?.(nextPlacement)
  }

  return [currentPlacement, changePlacement] as const
}

function AgentChatDock({
  children,
  className,
  conversation,
  history,
  onOpenFullPage,
  pageVisible = true,
  placement,
  title = "New chat",
}: AgentChatDockProps) {
  const [currentPlacement, changePlacement] = useAgentChatPlacement(placement)

  function openFullPage(): void {
    changePlacement("page")
    onOpenFullPage?.()
  }

  if (currentPlacement === "page") {
    if (!pageVisible) return null

    return (
      <AgentChat
        {...(className ? { className } : {})}
        {...(conversation ? {
          conversation: {
            ...conversation,
            onMoveToToolbar: () => changePlacement("toolbar"),
          },
        } : {})}
        {...(history ? { history } : {})}
        title={title}
      >
        {children}
      </AgentChat>
    )
  }

  const floating = !pageVisible
  const floatingContent = currentPlacement === "toolbar" ? (
    <AgentChatMini
      {...(conversation ? {
        actions: {
          onCopyAsMarkdown: conversation.onCopyAsMarkdown,
          onDelete: conversation.onDelete,
        },
      } : {})}
      controls={{
        onClose: () => changePlacement("minimized"),
        onMinimize: () => changePlacement("minimized"),
        onOpenFullPage: openFullPage,
      }}
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
  type AgentChatDockConversation,
  type AgentChatDockProps,
  type AgentChatPlacement,
  type AgentChatPlacementControl,
}
