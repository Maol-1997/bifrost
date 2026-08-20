import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useChat } from "@ai-sdk/react"
import { useQuery } from "@tanstack/react-query"
import { DefaultChatTransport, type DynamicToolUIPart, type UIMessage } from "ai"
import { useLocation, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import {
  AgentChat,
  AgentChatComposer,
  AgentChatDock,
  AgentChatEmptyState,
  AgentChatMessage,
  AgentChatMessages,
  AgentChatSuggestions,
  AgentMarkdown,
  type AgentHistoryItem,
  type AgentChatPlacement,
  type AgentSuggestion,
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
const suggestions: AgentSuggestion[] = [
  { id: "github", icon: "project", title: "Review recent work", description: "Summarize my open pull requests and what needs attention." },
  { id: "sentry", icon: "research", title: "Investigate errors", description: "Find the most important unresolved Sentry issues." },
  { id: "linear", icon: "team", title: "Check project status", description: "Summarize what is moving and blocked in Linear." },
]

type ChatProps = {
  active?: boolean
  owner: string
}

type FloatingConversation = {
  conversation: StoredConversation
  placement: Exclude<AgentChatPlacement, "page">
}

export default function Chat({ active = true, owner }: ChatProps): React.JSX.Element | null {
  const { data: config } = useQuery({ queryKey: ["chat-config"], queryFn: getChatConfig })
  if (!config) return active ? <div className="h-full min-h-[540px] bg-linear-canvas" /> : null
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
    if (!active || !conversations) return
    if (!requestedConversationId) {
      setActiveConversation((current) => shouldCreateNewConversation(current, conversations)
        ? createEmptyConversation(owner)
        : current)
      return
    }
    if (activeConversation?.id === requestedConversationId) return

    const selected = conversations.find((conversation) => conversation.id === requestedConversationId)
    if (selected) {
      setActiveConversation(selected)
      setFloatingConversation((current) => current?.conversation.id === selected.id ? undefined : current)
      return
    }

    setActiveConversation(createEmptyConversation(owner))
    void navigate(APP_ROUTES.chat, { flushSync: true, replace: true })
  }, [
    active,
    activeConversation?.id,
    conversations,
    navigate,
    owner,
    requestedConversationId,
  ])

  function openConversationUrl(conversationId: string): void {
    void navigate(
      `${APP_ROUTES.chat}?${CHAT_ID_QUERY_PARAMETER}=${encodeURIComponent(conversationId)}`,
      { flushSync: true },
    )
  }

  function openNewChatUrl(): void {
    void navigate(APP_ROUTES.chat, { flushSync: true })
  }

  function replaceWithNewChatUrl(): void {
    void navigate(APP_ROUTES.chat, { flushSync: true, replace: true })
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
    void navigate(APP_ROUTES.chat, { flushSync: true })
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
    try {
      await deleteConversation(conversation.id)
      const remainingConversations = (conversations ?? []).filter((entry) => entry.id !== conversation.id)
      setConversations(remainingConversations)
      const deletedActiveConversation = activeConversation?.id === conversation.id
      if (deletedActiveConversation) {
        setActiveConversation(createEmptyConversation(owner))
        replaceWithNewChatUrl()
      }
      setFloatingConversation((current) => current?.conversation.id === conversation.id ? undefined : current)
      toast("Chat deleted", {
        action: {
          label: "Undo",
          onClick: () => {
            void saveConversation(conversation)
              .then(() => updateConversation(conversation))
              .catch(() => toast.error("Chat could not be restored"))
          },
        },
      })
    } catch (error) {
      toast.error("Chat could not be deleted")
      throw error
    }
  }

  if (!activeConversation || !conversations) {
    return active ? <div className="h-full min-h-[540px] bg-linear-canvas" /> : null
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
          <AgentChatComposer
            onChange={setInput}
            onSubmit={submit}
            submitting={isWorking}
            value={input}
          />
          <AgentChatSuggestions onSelect={(suggestion) => submit(suggestionPrompt(suggestion))} suggestions={suggestions} />
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
  const toolParts = message.parts.filter((part): part is DynamicToolUIPart => part.type === "dynamic-tool")

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

function ToolActivity({ part }: { part: DynamicToolUIPart }): React.JSX.Element {
  const finished = part.state === "output-available" || part.state === "output-error" || part.state === "output-denied"
  const providerId = toolProviderId(part)
  const title = toolDisplayTitle(part, providerId)

  return (
    <div className="mb-2 flex items-center gap-2 text-xs font-medium text-linear-agent-action">
      {providerId ? (
        <span aria-hidden="true" className={finished ? "opacity-70" : "animate-design-pulse"}>
          <ProviderIcon providerId={providerId} size="sidebar" />
        </span>
      ) : (
        <span aria-hidden="true" className={finished ? "size-1.5 rounded-full bg-linear-muted" : "size-1.5 animate-design-pulse rounded-full bg-linear-primary"} />
      )}
      <span>{finished ? "Used" : "Using"} {title}</span>
    </div>
  )
}

function toolDisplayTitle(part: DynamicToolUIPart, providerId: ProviderId | undefined): string {
  const title = part.title?.trim()
  if (title) return title
  return humanizeToolName(part.toolName, providerId)
}

function toolProviderId(part: DynamicToolUIPart): ProviderId | undefined {
  const metadataProviderId = part.toolMetadata?.providerId
  if (isProviderId(metadataProviderId)) return metadataProviderId
  const nameProviderId = part.toolName.slice(0, part.toolName.indexOf("_"))
  return isProviderId(nameProviderId) ? nameProviderId : undefined
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && isConnectableProvider(value)
}

function humanizeToolName(toolName: string, providerId: ProviderId | undefined): string {
  const unprefixedName = providerId ? toolName.slice(providerId.length + 1) : toolName
  const words = unprefixedName.replaceAll(/[_-]+/g, " ").trim().toLowerCase()
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : toolName
}

function suggestionPrompt(suggestion: AgentSuggestion): string {
  return `${suggestion.title}. ${suggestion.description}`
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
