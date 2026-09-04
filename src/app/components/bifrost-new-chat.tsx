// Direct imports on purpose: this file loads eagerly with the app shell, and
// the agent-chat barrel would drag markdown-it + highlight.js into the main
// bundle through agent-chat-markdown.
import {
  AgentChat,
  AgentChatEmptyState,
} from "@app/components/ui/agent-chat/agent-chat"
import { AgentChatComposer } from "@app/components/ui/agent-chat/agent-chat-composer"

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

export { BifrostNewChatLoadingState }
