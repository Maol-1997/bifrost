import {
  AgentChat,
  AgentChatComposer,
  AgentChatEmptyState,
  AgentChatSuggestions,
  type AgentSuggestion,
} from "@app/components/ui/agent-chat"

const suggestions: AgentSuggestion[] = [
  { id: "github", icon: "project", title: "Review recent work", description: "Summarize my open pull requests and what needs attention." },
  { id: "sentry", icon: "research", title: "Investigate errors", description: "Find the most important unresolved Sentry issues." },
  { id: "linear", icon: "team", title: "Check project status", description: "Summarize what is moving and blocked in Linear." },
]

type BifrostNewChatContentProps = {
  input: string
  onChange: (value: string) => void
  onStop: () => void
  onSubmit: (value: string) => void
  submitting: boolean
}

function BifrostNewChatContent({
  input,
  onChange,
  onStop,
  onSubmit,
  submitting,
}: BifrostNewChatContentProps): React.JSX.Element {
  return (
    <>
      <AgentChatComposer
        autoFocus
        onChange={onChange}
        onStop={onStop}
        onSubmit={onSubmit}
        submitting={submitting}
        value={input}
      />
      <AgentChatSuggestions
        onSelect={(suggestion) => onSubmit(`${suggestion.title}. ${suggestion.description}`)}
        suggestions={suggestions}
      />
    </>
  )
}

function BifrostNewChatLoadingState(): React.JSX.Element {
  return (
    <div aria-busy="true" className="min-h-0 w-full flex-1" role="status">
      <span className="sr-only">Loading chat…</span>
      <div aria-hidden="true" className="h-full" inert>
        <AgentChat className="h-full min-h-[540px] bg-transparent">
          <AgentChatEmptyState>
            <AgentChatComposer value="" />
            <AgentChatSuggestions suggestions={suggestions} />
          </AgentChatEmptyState>
        </AgentChat>
      </div>
    </div>
  )
}

export { BifrostNewChatContent, BifrostNewChatLoadingState }
