import { X, Zap } from "lucide-react"
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

function AssistantMessageActions({ onCopyMessage }: { onCopyMessage: () => void }) {
  return (
    <div className="flex h-6 gap-0.5">
      <AgentChatMessageActionButton label="Copy message" onClick={onCopyMessage}>
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
      {actions && !isUser && onCopyMessage
        ? <AssistantMessageActions onCopyMessage={onCopyMessage} />
        : null}
    </article>
  )
})

type AgentChatMessagesProps = {
  children: ReactNode
  className?: string
  follow?: boolean
  preserveInitialTimestamp?: boolean
  timestamp?: string
}

const followThreshold = 48
const pinnedPromptGap = 16

function AgentChatMessages({
  children,
  className,
  follow = true,
  preserveInitialTimestamp = false,
  timestamp,
}: AgentChatMessagesProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const shouldFollow = useRef(true)
  const spacerRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const scrollContent = contentRef.current
    const scrollSpacer = spacerRef.current
    const scrollViewport = viewportRef.current
    if (!scrollContent || !scrollSpacer || !scrollViewport) {
      return
    }
    const contentElement = scrollContent
    const spacerElement = scrollSpacer
    const viewportElement = scrollViewport
    const initialPrompts = contentElement.querySelectorAll('[data-role="user"]')
    let pinnedPrompt = preserveInitialTimestamp
      ? initialPrompts[initialPrompts.length - 1]
      : undefined
    let shouldPreserveInitialPosition = preserveInitialTimestamp

    function updateFollowAnchor() {
      const distanceFromBottom =
        viewportElement.scrollHeight -
        viewportElement.clientHeight -
        viewportElement.scrollTop
      shouldFollow.current = distanceFromBottom <= followThreshold
    }

    // Reserving the room the newest turn still lacks to fill the viewport is what keeps a
    // sent prompt at the top: the bottom of the scroll range lands on it, and the reply
    // consumes the reserved room instead of pushing the prompt back up. Once the turn is
    // taller than the viewport nothing is reserved and following the bottom resumes.
    function reserveRoomBelowLatestPrompt() {
      const prompts = contentElement.querySelectorAll('[data-role="user"]')
      const latestPrompt = prompts[prompts.length - 1]
      if (!latestPrompt) {
        spacerElement.style.height = "0px"
        return
      }
      if (latestPrompt !== pinnedPrompt) {
        pinnedPrompt = latestPrompt
        shouldPreserveInitialPosition = false
        shouldFollow.current = true
      }
      const promptTop =
        latestPrompt.getBoundingClientRect().top - contentElement.getBoundingClientRect().top
      const turnHeight = contentElement.offsetHeight - promptTop
      const reservedRoom = viewportElement.clientHeight - turnHeight - pinnedPromptGap
      spacerElement.style.height = `${Math.max(0, reservedRoom)}px`
    }

    function followLatestPrompt() {
      const contentFits = contentElement.offsetHeight <= viewportElement.clientHeight
      reserveRoomBelowLatestPrompt()
      if (follow && shouldFollow.current) {
        if (shouldPreserveInitialPosition && contentFits) {
          viewportElement.scrollTop = 0
          return
        }
        shouldPreserveInitialPosition = false
        viewportElement.scrollTop = Number.MAX_SAFE_INTEGER
      }
    }

    followLatestPrompt()
    viewportElement.addEventListener("scroll", updateFollowAnchor, { passive: true })

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(followLatestPrompt)
    resizeObserver?.observe(contentElement)
    resizeObserver?.observe(viewportElement)

    return () => {
      viewportElement.removeEventListener("scroll", updateFollowAnchor)
      resizeObserver?.disconnect()
    }
  }, [follow, preserveInitialTimestamp])

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
        data-agent-chat-message-list=""
      >
        {timestamp && (
          <time
            className="mb-[-4px] block self-center text-xs font-medium text-linear-agent-action"
            data-agent-chat-timestamp=""
          >
            {timestamp}
          </time>
        )}
        {children}
      </div>
      <div ref={spacerRef} aria-hidden="true" />
    </div>
  )
}

export {
  AgentChatMessage,
  AgentChatMessages,
  type AgentChatMessageProps,
  type AgentChatMessageRole,
}
