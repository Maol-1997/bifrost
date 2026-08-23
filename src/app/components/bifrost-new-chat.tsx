// Direct imports on purpose: this file loads eagerly with the app shell, and
// the agent-chat barrel would drag markdown-it + highlight.js into the main
// bundle through agent-chat-markdown.
import {
  AgentChat,
  AgentChatEmptyState,
} from "@app/components/ui/agent-chat/agent-chat"
import { AgentChatComposer } from "@app/components/ui/agent-chat/agent-chat-composer"

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
    <AgentChatComposer
      autoFocus
      onChange={onChange}
      onStop={onStop}
      onSubmit={onSubmit}
      submitting={submitting}
      value={input}
    />
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
          </AgentChatEmptyState>
        </AgentChat>
      </div>
    </div>
  )
}

export { BifrostNewChatContent, BifrostNewChatLoadingState }
