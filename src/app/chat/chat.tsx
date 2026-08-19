import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useChat } from "@ai-sdk/react"
import { useQuery } from "@tanstack/react-query"
import { DefaultChatTransport, type DynamicToolUIPart, type UIMessage } from "ai"
import { useNavigate } from "react-router-dom"
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
  type AgentSuggestion,
} from "@app/components/ui/agent-chat"
import { ProviderIcon } from "@app/components/ui/provider-icon"
import { getChatConfig } from "@app/api/bifrost"
import type { ProviderId } from "@app/api/bifrost"
import { APP_ROUTES } from "@features/utils/routes"
import {
  conversationTitle,
  createEmptyConversation,
  deleteConversation,
  listConversations,
  saveConversation,
  type StoredConversation,
} from "./utils/chat-history"

const SAVE_DELAY_MS = 250
const suggestions: AgentSuggestion[] = [
  { id: "github", icon: "project", title: "Review recent work", description: "Summarize my open pull requests and what needs attention." },
  { id: "sentry", icon: "research", title: "Investigate errors", description: "Find the most important unresolved Sentry issues." },
  { id: "linear", icon: "team", title: "Check project status", description: "Summarize what is moving and blocked in Linear." },
]

type ChatProps = {
  active?: boolean
  owner: string
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
  const [conversations, setConversations] = useState<StoredConversation[]>()
  const [activeConversation, setActiveConversation] = useState<StoredConversation>()

  useEffect(() => {
    let active = true
    void listConversations(owner)
      .then((stored) => {
        if (!active) return
        setConversations(stored)
        setActiveConversation(stored[0] ?? createEmptyConversation(owner))
      })
      .catch(() => {
        if (!active) return
        setConversations([])
        setActiveConversation(createEmptyConversation(owner))
      })
    return () => { active = false }
  }, [owner])

  function selectConversation(id: string): void {
    const selected = conversations?.find((conversation) => conversation.id === id)
    if (selected) setActiveConversation(selected)
  }

  const startConversation = useCallback((): void => {
    setActiveConversation(createEmptyConversation(owner))
  }, [owner])

  const updateConversation = useCallback((conversation: StoredConversation): void => {
    setActiveConversation(conversation)
    setConversations((current = []) => [
      conversation,
      ...current.filter((entry) => entry.id !== conversation.id),
    ].sort((left, right) => right.updatedAt - left.updatedAt))
  }, [])

  async function removeConversation(conversation: StoredConversation): Promise<void> {
    try {
      await deleteConversation(conversation.id)
      const remainingConversations = (conversations ?? []).filter((entry) => entry.id !== conversation.id)
      setConversations(remainingConversations)
      setActiveConversation(remainingConversations[0] ?? createEmptyConversation(owner))
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
    <ChatConversation
      active={active}
      key={activeConversation.id}
      conversation={activeConversation}
      history={conversations}
      onConversationChange={updateConversation}
      onDelete={removeConversation}
      onHistorySelect={selectConversation}
      onNewChat={startConversation}
    />
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
}: {
  active: boolean
  conversation: StoredConversation
  history: readonly StoredConversation[]
  onConversationChange: (conversation: StoredConversation) => void
  onDelete: (conversation: StoredConversation) => Promise<void>
  onHistorySelect: (id: string) => void
  onNewChat: () => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const [input, setInput] = useState("")
  const [historyError, setHistoryError] = useState(false)
  const deleting = useRef(false)
  const pendingSave = useRef<StoredConversation | undefined>(undefined)
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), [])
  const { error, messages, sendMessage, status, stop } = useChat({
    id: conversation.id,
    messages: conversation.messages,
    transport,
  })
  const isWorking = status === "submitted" || status === "streaming"
  const title = conversationTitle(messages)
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
      title: conversationTitle(messages),
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
  }, [conversation.createdAt, conversation.favorite, conversation.id, messages, onConversationChange])

  useEffect(() => () => {
    if (!deleting.current && pendingSave.current) void saveConversation(pendingSave.current).catch(() => undefined)
  }, [])

  function submit(value: string): void {
    setInput("")
    void sendMessage({ text: value })
  }

  function changeConversation(action: () => void): void {
    if (isWorking) void stop()
    action()
  }

  function currentConversation(): StoredConversation {
    return {
      ...conversation,
      messages,
      title,
      updatedAt: Date.now(),
    }
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
      onOpenFullPage={() => { void navigate(APP_ROUTES.chat) }}
      pageVisible={active}
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
  return value === "github"
    || value === "linear"
    || value === "sentry"
    || value === "slack"
    || value === "notion"
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
