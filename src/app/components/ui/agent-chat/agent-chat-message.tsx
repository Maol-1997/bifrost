import {
  ThumbsDown,
  ThumbsUp,
  X,
  Zap,
} from "lucide-react"
import { memo, type ReactNode, useLayoutEffect, useRef } from "react"

import { cn } from "@app/lib/cn"
import {
  AgentChatMessageActionButton,
  AgentChatUserActions,
} from "./agent-chat-actions"
import { CopyMessageIcon } from "./agent-chat-icons"

type AgentChatMessageRole = "assistant" | "user"

type AgentChatMessageProps = {
  actions?: boolean
  children: ReactNode
  className?: string
  onCopyMessage?: () => void
  onEditMessage?: () => void
  queued?: boolean
  role: AgentChatMessageRole
}

function AssistantMessageActions() {
  return (
    <div className="flex h-6 gap-0.5">
      <AgentChatMessageActionButton label="This was helpful">
        <ThumbsUp className="size-3.5" />
      </AgentChatMessageActionButton>
      <AgentChatMessageActionButton label="Leave feedback…">
        <ThumbsDown className="size-3.5" />
      </AgentChatMessageActionButton>
      <AgentChatMessageActionButton label="Copy message">
        <CopyMessageIcon />
      </AgentChatMessageActionButton>
    </div>
  )
}

function QueuedMessageActions() {
  return (
    <div className="flex h-6 justify-end gap-0.5">
      <AgentChatMessageActionButton label="Send immediately (steer)">
        <Zap className="size-3.5" />
      </AgentChatMessageActionButton>
      <AgentChatMessageActionButton label="Remove from queue">
        <X className="size-3.5" />
      </AgentChatMessageActionButton>
    </div>
  )
}

const AgentChatMessage = memo(function AgentChatMessage({
  actions = true,
  children,
  className,
  onCopyMessage,
  onEditMessage,
  queued = false,
  role,
}: AgentChatMessageProps) {
  const isUser = role === "user"

  return (
    <article
      className={cn(
        "agent-chat-message group flex w-full flex-col",
        isUser ? "items-end" : "items-start gap-1.5",
        className,
      )}
      data-queued={queued || undefined}
      data-role={role}
    >
      <div
        className={cn(
          "whitespace-pre-wrap break-words text-[15px] font-[450] leading-6 tracking-[-0.1px] text-linear-foreground",
          !isUser && "ml-2.5 w-[calc(100%-20px)]",
          isUser &&
            "max-w-[75%] overflow-clip rounded-lg bg-linear-agent-message px-3 py-2 text-linear-bright",
          queued && "opacity-70",
        )}
      >
        {children}
      </div>
      {actions && isUser && !queued && (
        <AgentChatUserActions
          {...(onCopyMessage ? { onCopyMessage } : {})}
          {...(onEditMessage ? { onEditMessage } : {})}
        />
      )}
      {actions && isUser && queued && <QueuedMessageActions />}
      {actions && !isUser && <AssistantMessageActions />}
    </article>
  )
})

type AgentChatMessagesProps = {
  children: ReactNode
  className?: string
  follow?: boolean
  timestamp?: string
}

const followThreshold = 48

function AgentChatMessages({
  children,
  className,
  follow = true,
  timestamp,
}: AgentChatMessagesProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const shouldFollow = useRef(true)
  const viewportRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const contentElement = contentRef.current
    const scrollViewport = viewportRef.current
    if (!contentElement || !scrollViewport) {
      return
    }
    const viewportElement = scrollViewport

    function updateFollowAnchor() {
      const distanceFromBottom =
        viewportElement.scrollHeight -
        viewportElement.clientHeight -
        viewportElement.scrollTop
      shouldFollow.current = distanceFromBottom <= followThreshold
    }

    let followFrame: number | undefined

    function followLatestMessage() {
      if (follow && shouldFollow.current && followFrame === undefined) {
        followFrame = requestAnimationFrame(() => {
          followFrame = undefined
          viewportElement.scrollTop = Number.MAX_SAFE_INTEGER
        })
      }
    }

    if (follow && shouldFollow.current) {
      viewportElement.scrollTop = Number.MAX_SAFE_INTEGER
    }
    viewportElement.addEventListener("scroll", updateFollowAnchor, { passive: true })

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(followLatestMessage)
    resizeObserver?.observe(contentElement)

    return () => {
      if (followFrame !== undefined) {
        cancelAnimationFrame(followFrame)
      }
      viewportElement.removeEventListener("scroll", updateFollowAnchor)
      resizeObserver?.disconnect()
    }
  }, [follow])

  return (
    <div
      ref={viewportRef}
      className="min-h-0 flex-1 overflow-y-auto"
      role="group"
      aria-label="Agent conversation"
    >
      <div
        ref={contentRef}
        className={cn(
          "mx-auto flex w-full max-w-[821px] flex-col gap-[26px] px-3 pb-5 pt-3 min-[1025px]:px-0",
          className,
        )}
      >
        {timestamp && (
          <time className="mb-[-4px] block self-center text-xs font-medium text-linear-agent-action">
            {timestamp}
          </time>
        )}
        {children}
      </div>
    </div>
  )
}

export {
  AgentChatMessage,
  AgentChatMessages,
  type AgentChatMessageProps,
  type AgentChatMessageRole,
}
