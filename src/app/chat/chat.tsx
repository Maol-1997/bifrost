import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useChat } from "@ai-sdk/react"
import { useQuery } from "@tanstack/react-query"
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai"
import { useLocation, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { BifrostNewChatContent, BifrostNewChatLoadingState } from "@app/components/bifrost-new-chat"
import { BifrostMark } from "@app/components/ui/bifrost-mark"
import {
  AgentChat,
  AgentChatComposer,
  AgentChatDock,
  AgentChatEmptyState,
  AgentChatMessage,
  AgentChatMessages,
  AgentMarkdown,
  type AgentHistoryItem,
  type AgentChatPlacement,
} from "@app/components/ui/agent-chat"
import { ProviderIcon } from "@app/components/ui/provider-icon"
import { generateChatTitle, getChatConfig, isConnectableProvider } from "@app/api/bifrost"
import type { ProviderId } from "@app/api/bifrost"
import { APP_ROUTES } from "@features/utils/routes"
import {
  CHAT_TITLE_VERSION,
  conversationTitle,
  createEmptyConversation,
  deleteConversation,
  listConversations,
  saveConversation,
  type StoredConversation,
} from "./utils/chat-history"

const SAVE_DELAY_MS = 250
const CHAT_ID_QUERY_PARAMETER = "id"

type ChatProps = {
  active?: boolean
  owner?: string
}

type FloatingConversation = {
  conversation: StoredConversation
  placement: Exclude<AgentChatPlacement, "page">
}

type ChatToolPart = DynamicToolUIPart | ToolUIPart
type ChatToolSource =
  | { kind: "bifrost" }
  | { kind: "provider"; providerId: ProviderId }
  | { kind: "unknown" }

export default function Chat({ active = true, owner }: ChatProps): React.JSX.Element | null {
  const { data: config } = useQuery({ queryKey: ["chat-config"], queryFn: getChatConfig })
  if (!config || !owner) return active ? <BifrostNewChatLoadingState /> : null
  if (!config.configured) {
    if (!active) return null

    return (
      <AgentChat className="h-full min-h-[540px] bg-transparent" title="Bifrost">
        <AgentChatEmptyState>
          <div className="mx-auto max-w-md px-6 text-center">
            <h1 className="text-xl font-semibold text-linear-bright">Chat is not configured</h1>
            <p className="mt-2 text-sm leading-6 text-linear-muted">Add OPENAI_API_KEY to the server environment to enable Bifrost chat.</p>
          </div>
        </AgentChatEmptyState>
      </AgentChat>
    )
  }
  return <ChatHistory active={active} owner={owner} />
}

function ChatHistory({ active, owner }: { active: boolean; owner: string }): React.JSX.Element | null {
  const location = useLocation()
  const navigate = useNavigate()
  const [conversations, setConversations] = useState<StoredConversation[]>()
  const [activeConversation, setActiveConversation] = useState<StoredConversation>()
  const [floatingConversation, setFloatingConversation] = useState<FloatingConversation>()
  const conversationsRef = useRef(conversations)
  const activeConversationRef = useRef(activeConversation)
  conversationsRef.current = conversations
  activeConversationRef.current = activeConversation
  const historyReady = conversations !== undefined
  const requestedConversationId = active
    ? new URLSearchParams(location.search).get(CHAT_ID_QUERY_PARAMETER)
    : undefined

  useEffect(() => {
    let active = true
    void listConversations(owner)
      .then((stored) => {
        if (!active) return
        setConversations(stored)
      })
      .catch(() => {
        if (!active) return
        setConversations([])
      })
    return () => { active = false }
  }, [owner])

  useEffect(() => {
    const storedConversations = conversationsRef.current
    if (!active || !storedConversations) return
    if (!requestedConversationId) {
      setActiveConversation((current) => shouldCreateNewConversation(current, storedConversations)
        ? createEmptyConversation(owner)
        : current)
      return
    }
    if (activeConversationRef.current?.id === requestedConversationId) return

    const selected = storedConversations.find((conversation) => conversation.id === requestedConversationId)
    if (selected) {
      setActiveConversation((current) => current?.id === selected.id ? current : selected)
      setFloatingConversation((current) => current?.conversation.id === selected.id ? undefined : current)
      return
    }

    setActiveConversation(createEmptyConversation(owner))
    void navigate(APP_ROUTES.chat, { replace: true })
  }, [
    active,
    historyReady,
    navigate,
    owner,
    requestedConversationId,
  ])

  function openConversationUrl(conversationId: string): void {
    void navigate(
      `${APP_ROUTES.chat}?${CHAT_ID_QUERY_PARAMETER}=${encodeURIComponent(conversationId)}`,
    )
  }

  function openNewChatUrl(): void {
    void navigate(APP_ROUTES.chat)
  }

  function replaceWithNewChatUrl(): void {
    void navigate(APP_ROUTES.chat, { replace: true })
  }

  function selectConversation(id: string): void {
    const selected = conversations?.find((conversation) => conversation.id === id)
    if (!selected) return
    setActiveConversation(selected)
    setFloatingConversation((current) => current?.conversation.id === id ? undefined : current)
    openConversationUrl(id)
  }

  const startConversation = useCallback((): void => {
    setActiveConversation(createEmptyConversation(owner))
    void navigate(APP_ROUTES.chat)
  }, [navigate, owner])

  const updateConversation = useCallback((conversation: StoredConversation): void => {
    setActiveConversation((current) => current?.id === conversation.id ? conversation : current)
    setFloatingConversation((current) => current?.conversation.id === conversation.id
      ? { ...current, conversation }
      : current)
    setConversations((current = []) => [
      conversation,
      ...current.filter((entry) => entry.id !== conversation.id),
    ].sort((left, right) => right.updatedAt - left.updatedAt))
  }, [])

  function changePagePlacement(
    placement: AgentChatPlacement,
    conversation: StoredConversation,
  ): void {
    if (placement !== "toolbar") return
    if (conversation.messages.length > 0) updateConversation(conversation)
    setFloatingConversation({ conversation, placement: "toolbar" })
    setActiveConversation(createEmptyConversation(owner))
    openNewChatUrl()
  }

  function changeFloatingPlacement(
    placement: AgentChatPlacement,
    conversation: StoredConversation,
  ): void {
    if (conversation.messages.length > 0) updateConversation(conversation)
    if (placement === "page") {
      setActiveConversation(conversation)
      setFloatingConversation(undefined)
      return
    }
    setFloatingConversation({ conversation, placement })
  }

  async function removeConversation(conversation: StoredConversation): Promise<void> {
    const remainingConversations = (conversations ?? []).filter((entry) => entry.id !== conversation.id)
    const deletedActiveConversation = activeConversation?.id === conversation.id
    const deletedFloatingConversation = floatingConversation?.conversation.id === conversation.id
      ? floatingConversation
      : undefined

    setConversations(remainingConversations)
    if (deletedActiveConversation) {
      setActiveConversation(createEmptyConversation(owner))
      replaceWithNewChatUrl()
    }
    setFloatingConversation((current) => current?.conversation.id === conversation.id ? undefined : current)

    try {
      await deleteConversation(conversation.id)
    } catch (error) {
      setConversations((current = []) => [
        conversation,
        ...current.filter((entry) => entry.id !== conversation.id),
      ].sort((left, right) => right.updatedAt - left.updatedAt))
      if (deletedActiveConversation) {
        setActiveConversation(conversation)
        openConversationUrl(conversation.id)
      }
      if (deletedFloatingConversation) setFloatingConversation(deletedFloatingConversation)
      toast.error("Chat could not be deleted")
      throw error
    }
  }

  if (!activeConversation || !conversations) {
    return active ? <BifrostNewChatLoadingState /> : null
  }

  return (
    <div className={`relative min-h-0 ${active ? "h-full" : "h-0"}`}>
      <ChatConversation
        active={active}
        key={`page:${activeConversation.id}`}
        conversation={activeConversation}
        history={conversations}
        onConversationChange={updateConversation}
        onDelete={removeConversation}
        onHistorySelect={selectConversation}
        onNewChat={startConversation}
        onConversationStarted={openConversationUrl}
        onOpenFullPage={(conversation) => openConversationUrl(conversation.id)}
        onPlacementChange={changePagePlacement}
        placement="page"
      />
      {floatingConversation && floatingConversation.conversation.id !== activeConversation.id ? (
        <ChatConversation
          active={active}
          key={`floating:${floatingConversation.conversation.id}`}
          conversation={floatingConversation.conversation}
          history={conversations}
          onConversationChange={updateConversation}
          onDelete={removeConversation}
          onHistorySelect={selectConversation}
          onNewChat={startConversation}
          onOpenFullPage={(conversation) => openConversationUrl(conversation.id)}
          onPlacementChange={(placement, conversation) => changeFloatingPlacement(placement, conversation)}
          placement={floatingConversation.placement}
        />
      ) : null}
    </div>
  )
}

function ChatConversation({
  active,
  conversation,
  history,
  onConversationChange,
  onDelete,
  onHistorySelect,
  onNewChat,
  onConversationStarted,
  onOpenFullPage,
  onPlacementChange,
  placement,
}: {
  active: boolean
  conversation: StoredConversation
  history: readonly StoredConversation[]
  onConversationChange: (conversation: StoredConversation) => void
  onDelete: (conversation: StoredConversation) => Promise<void>
  onHistorySelect: (id: string) => void
  onNewChat: () => void
  onConversationStarted?: (conversationId: string) => void
  onOpenFullPage: (conversation: StoredConversation) => void
  onPlacementChange: (placement: AgentChatPlacement, conversation: StoredConversation) => void
  placement: AgentChatPlacement
}): React.JSX.Element {
  const [input, setInput] = useState("")
  const [historyError, setHistoryError] = useState(false)
  const deleting = useRef(false)
  const pendingSave = useRef<StoredConversation | undefined>(undefined)
  const hasCurrentGeneratedTitle = conversation.generatedTitle
    && conversation.titleVersion === CHAT_TITLE_VERSION
  const titleGenerationStarted = useRef(hasCurrentGeneratedTitle)
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), [])
  const { error, messages, sendMessage, status, stop } = useChat({
    id: conversation.id,
    messages: conversation.messages,
    transport,
  })
  const isWorking = status === "submitted" || status === "streaming"
  const provisionalTitle = conversationTitle(messages)
  const title = hasCurrentGeneratedTitle ? conversation.title : provisionalTitle
  const currentConversationRef = useRef<StoredConversation>(conversation)
  currentConversationRef.current = {
    ...conversation,
    messages,
    title,
    updatedAt: Date.now(),
  }
  const historyItems = history.map((entry): AgentHistoryItem => ({
    age: relativeAge(entry.updatedAt),
    current: entry.id === conversation.id,
    favorite: entry.favorite,
    group: "Recent",
    id: entry.id,
    title: entry.title,
  }))

  useEffect(() => {
    if (messages.length === 0) return
    const updatedConversation: StoredConversation = {
      ...conversation,
      messages,
      title,
      updatedAt: Date.now(),
    }
    pendingSave.current = updatedConversation
    let active = true
    const timeout = window.setTimeout(() => {
      if (deleting.current) return
      void saveConversation(updatedConversation).then(() => {
        if (active) onConversationChange(updatedConversation)
      }).catch(() => { if (active) setHistoryError(true) })
    }, SAVE_DELAY_MS)
    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [
    conversation.createdAt,
    conversation.favorite,
    conversation.generatedTitle,
    conversation.id,
    conversation.owner,
    conversation.titleVersion,
    messages,
    onConversationChange,
    title,
  ])

  const firstUserMessage = firstUserMessageText(messages)
  useEffect(() => {
    if (!firstUserMessage || hasCurrentGeneratedTitle || titleGenerationStarted.current) return
    titleGenerationStarted.current = true
    let active = true
    void generateChatTitle(firstUserMessage)
      .then((generatedTitle) => {
        if (!active || deleting.current) return
        const updatedConversation: StoredConversation = {
          ...currentConversationRef.current,
          generatedTitle: true,
          title: generatedTitle,
          titleVersion: CHAT_TITLE_VERSION,
          updatedAt: Date.now(),
        }
        pendingSave.current = updatedConversation
        return saveConversation(updatedConversation).then(() => {
          if (active) onConversationChange(updatedConversation)
        })
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [firstUserMessage, hasCurrentGeneratedTitle, onConversationChange])

  useEffect(() => () => {
    if (!deleting.current && pendingSave.current) void saveConversation(pendingSave.current).catch(() => undefined)
  }, [])

  function submit(value: string): void {
    if (messages.length === 0) onConversationStarted?.(conversation.id)
    setInput("")
    void sendMessage({ text: value })
  }

  function changeConversation(action: () => void): void {
    if (isWorking) void stop()
    action()
  }

  function currentConversation(): StoredConversation {
    return currentConversationRef.current
  }

  function copyAsMarkdown(): void {
    void navigator.clipboard.writeText(conversationMarkdown(title, messages))
      .then(() => toast.success("Copied as markdown"))
      .catch(() => toast.error("Chat could not be copied"))
  }

  function changeFavorite(favorite: boolean): void {
    const updatedConversation = { ...currentConversation(), favorite }
    pendingSave.current = updatedConversation
    void saveConversation(updatedConversation)
      .then(() => onConversationChange(updatedConversation))
      .catch(() => setHistoryError(true))
  }

  function deleteCurrentConversation(): void {
    const deletedConversation = currentConversation()
    deleting.current = true
    pendingSave.current = undefined
    if (isWorking) void stop()
    void onDelete(deletedConversation).catch(() => {
      deleting.current = false
      pendingSave.current = deletedConversation
    })
  }

  return (
    <AgentChatDock
      className="h-full min-h-[540px] bg-transparent"
      conversation={messages.length > 0}
      favorite={conversation.favorite}
      history={historyItems}
      onCopyAsMarkdown={copyAsMarkdown}
      onDelete={deleteCurrentConversation}
      onFavoriteChange={changeFavorite}
      onHistorySelect={(item) => changeConversation(() => onHistorySelect(item.id))}
      onNewChat={() => changeConversation(onNewChat)}
      onOpenFullPage={() => onOpenFullPage(currentConversation())}
      onPlacementChange={(nextPlacement) => onPlacementChange(nextPlacement, currentConversation())}
      pageVisible={active}
      placement={placement}
      title={title}
    >
      {messages.length === 0 ? (
        <AgentChatEmptyState>
          <BifrostNewChatContent
            input={input}
            onChange={setInput}
            onStop={() => { void stop() }}
            onSubmit={submit}
            submitting={isWorking}
          />
        </AgentChatEmptyState>
      ) : (
        <>
          <AgentChatMessages>
            {messages.map((message, index) => (
              <ChatMessage
                key={message.id}
                message={message}
                streaming={isWorking && index === messages.length - 1 && message.role === "assistant"}
              />
            ))}
            {status === "submitted" ? (
              <AgentChatMessage actions={false} role="assistant">
                <span className="animate-design-blink text-linear-muted">Thinking…</span>
              </AgentChatMessage>
            ) : null}
          </AgentChatMessages>
          <div className="shrink-0 pb-4 pt-2">
            <AgentChatComposer
              onChange={setInput}
              onStop={() => { void stop() }}
              onSubmit={submit}
              submitting={isWorking}
              value={input}
              variant="conversation"
            />
            {error ? <p className="mx-auto mt-2 max-w-[821px] px-4 text-xs text-linear-danger">Bifrost could not complete that request.</p> : null}
            {historyError ? <p className="mx-auto mt-2 max-w-[821px] px-4 text-xs text-linear-danger">This conversation could not be saved to chat history.</p> : null}
          </div>
        </>
      )}
    </AgentChatDock>
  )
}

function ChatMessage({ message, streaming }: { message: UIMessage; streaming: boolean }): React.JSX.Element {
  const text = messageText(message)
  const toolParts = message.parts.filter(isToolUIPart)

  return (
    <AgentChatMessage actions={false} role={message.role === "user" ? "user" : "assistant"}>
      {toolParts.map((part) => <ToolActivity key={part.toolCallId} part={part} />)}
      {message.role === "assistant" ? <AgentMarkdown markdown={text} streaming={streaming} /> : text}
    </AgentChatMessage>
  )
}

function conversationMarkdown(title: string, messages: readonly UIMessage[]): string {
  const transcript = messages
    .map((message) => {
      const text = messageText(message).trim()
      if (!text) return undefined
      return `## ${message.role === "user" ? "You" : "Bifrost"}\n\n${text}`
    })
    .filter((section): section is string => section !== undefined)
    .join("\n\n")
  return `# ${title}\n\n${transcript}\n`
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

function firstUserMessageText(messages: readonly UIMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user")
  return firstUserMessage ? messageText(firstUserMessage).trim() : ""
}

function ToolActivity({ part }: { part: ChatToolPart }): React.JSX.Element {
  const finished = part.state === "output-available" || part.state === "output-error" || part.state === "output-denied"
  const source = toolSource(part)
  const title = toolDisplayTitle(part, source)

  return (
    <div className="mb-2 flex items-center gap-2 text-xs font-medium text-linear-agent-action">
      {source.kind === "provider" ? (
        <span aria-hidden="true" className={finished ? "opacity-70" : "animate-design-pulse"}>
          <ProviderIcon providerId={source.providerId} size="sidebar" />
        </span>
      ) : source.kind === "bifrost" ? (
        <span aria-hidden="true" className={finished ? "opacity-70" : "animate-design-pulse"}>
          <BifrostMark className="size-4" />
        </span>
      ) : (
        <span aria-hidden="true" className={finished ? "size-1.5 rounded-full bg-linear-muted" : "size-1.5 animate-design-pulse rounded-full bg-linear-primary"} />
      )}
      <span>{finished ? "Used" : "Using"} {title}</span>
    </div>
  )
}

function toolDisplayTitle(part: ChatToolPart, source: ChatToolSource): string {
  const title = part.title?.trim()
  if (title) return title
  return humanizeToolName(getToolName(part), source)
}

function toolSource(part: ChatToolPart): ChatToolSource {
  const metadataProviderId = part.toolMetadata?.providerId
  if (isProviderId(metadataProviderId)) return { kind: "provider", providerId: metadataProviderId }
  if (part.toolMetadata?.source === "bifrost-admin") return { kind: "bifrost" }

  const toolName = getToolName(part)
  if (toolName.startsWith("bifrost_")) return { kind: "bifrost" }
  const nameProviderId = toolName.slice(0, toolName.indexOf("_"))
  return isProviderId(nameProviderId)
    ? { kind: "provider", providerId: nameProviderId }
    : { kind: "unknown" }
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && isConnectableProvider(value)
}

function humanizeToolName(toolName: string, source: ChatToolSource): string {
  const unprefixedName = source.kind === "provider"
    ? toolName.slice(source.providerId.length + 1)
    : toolName.replace(/^bifrost_(?:admin_)?/, "")
  const words = unprefixedName.replaceAll(/[_-]+/g, " ").trim().toLowerCase()
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : toolName
}

function relativeAge(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function shouldCreateNewConversation(
  conversation: StoredConversation | undefined,
  storedConversations: readonly StoredConversation[],
): boolean {
  if (!conversation) return true
  if (conversation.messages.length > 0) return true
  return storedConversations.some((stored) => stored.id === conversation.id)
}
