import * as React from "react"

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

  if (currentPlacement === "minimized") return null

  return (
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
      position={pageVisible ? "contained" : "fixed"}
      title={title}
    >
      {children}
    </AgentChatMini>
  )
}

export {
  AgentChatDock,
  type AgentChatDockConversation,
  type AgentChatDockProps,
  type AgentChatPlacement,
  type AgentChatPlacementControl,
}
