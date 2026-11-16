import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format, isToday, isYesterday } from 'date-fns';
import { createPortal } from 'react-dom';
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { BifrostNewChatLoadingState } from '@app/components/bifrost-new-chat';
import { BifrostMark } from '@app/components/ui/bifrost-mark';
import { Button } from '@app/components/ui/button';
import {
  AgentChat,
  AgentChatComposer,
  AgentChatDock,
  AgentChatEditingBanner,
  AgentChatEmptyState,
  AgentChatGlobalToolbar,
  AgentChatMessage,
  AgentChatMessages,
  AgentMarkdown,
  type AgentHistoryItem,
  type AgentChatPlacement,
} from '@app/components/ui/agent-chat';
import { ProviderIcon } from '@app/components/ui/provider-icon';
import { getChatConfig, isConnectableProvider } from '@app/api/bifrost';
import type { ProviderId } from '@app/api/bifrost';
import { cn } from '@app/lib/cn';
import { APP_ROUTES } from '@features/utils/routes';
import {
  createEmptyConversation,
  deleteConversation,
  listConversations,
  type StoredConversation,
} from './utils/chat-history';
import { useConversationRecord } from './hooks/use-conversation-record';
import { useMessageEditing } from './hooks/use-message-editing';
import { describeAdminApproval } from './utils/admin-approval';
import { messageText, wasDeclined } from './utils/chat-messages';

const CHAT_ID_QUERY_PARAMETER = 'id';

function conversationsQueryKey(owner: string) {
  return ['chat-conversations', owner] as const;
}

type ChatProps = {
  active?: boolean;
  owner?: string;
  toolbarHost: HTMLElement | null;
};

type FloatingConversation = {
  conversation: StoredConversation;
  placement: Exclude<AgentChatPlacement, 'page'>;
};

type ChatConversationRecord = {
  conversation: StoredConversation;
  history: readonly StoredConversation[];
  onChange: (conversation: StoredConversation) => void;
  onDelete: (conversation: StoredConversation) => Promise<void>;
};

type ChatConversationNavigation = {
  onConversationStarted?: (conversationId: string) => void;
  onHistorySelect: (id: string) => void;
  onNewChat: () => void;
};

type ChatConversationDock = {
  active: boolean;
  onOpenFullPage: (conversation: StoredConversation) => void;
  onPlacementChange: (placement: AgentChatPlacement, conversation: StoredConversation) => void;
  placement: AgentChatPlacement;
};

type ChatToolPart = DynamicToolUIPart | ToolUIPart;
type ChatToolSource = { kind: 'bifrost' } | { kind: 'provider'; providerId: ProviderId } | { kind: 'unknown' };
type ApprovalResponder = (response: { id: string; approved: boolean }) => void;

export default function Chat({ active = true, owner, toolbarHost }: ChatProps): React.JSX.Element | null {
  const { data: config } = useQuery({ queryKey: ['chat-config'], queryFn: getChatConfig });
  if (!config || !owner) return active ? <BifrostNewChatLoadingState /> : null;
  if (!config.configured) {
    if (!active) return null;

    return (
      <AgentChat className="h-full min-h-[540px] bg-transparent" title="Bifrost">
        <AgentChatEmptyState>
          <div className="mx-auto max-w-md px-6 text-center">
            <h1 className="text-xl font-semibold text-linear-bright">Chat is not configured</h1>
            <p className="mt-2 text-sm leading-6 text-linear-muted">
              Add ANTHROPIC_API_KEY to the server environment to enable Bifrost chat.
            </p>
          </div>
        </AgentChatEmptyState>
      </AgentChat>
    );
  }
  return <ChatHistory active={active} owner={owner} toolbarHost={toolbarHost} />;
}

function ChatHistory({
  active,
  owner,
  toolbarHost,
}: {
  active: boolean;
  owner: string;
  toolbarHost: HTMLElement | null;
}): React.JSX.Element | null {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // No background refetch: every write below goes through setQueryData, and a
  // background refetch could roll back a save still inside its debounce window.
  const conversationsQuery = useQuery({
    queryKey: conversationsQueryKey(owner),
    queryFn: () => listConversations(owner),
    staleTime: Infinity,
  });
  const conversations = conversationsQuery.data;
  const setConversations = useCallback(
    (updater: (current: StoredConversation[]) => StoredConversation[]): void => {
      queryClient.setQueryData<StoredConversation[]>(conversationsQueryKey(owner), (current = []) => updater(current));
    },
    [owner, queryClient],
  );
  const [activeConversation, setActiveConversation] = useState<StoredConversation>();
  const [floatingConversation, setFloatingConversation] = useState<FloatingConversation>();
  const conversationsRef = useRef(conversations);
  const activeConversationRef = useRef(activeConversation);
  conversationsRef.current = conversations;
  activeConversationRef.current = activeConversation;
  const historyReady = conversationsQuery.isSuccess;
  const requestedConversationId = active
    ? new URLSearchParams(location.search).get(CHAT_ID_QUERY_PARAMETER)
    : undefined;

  useEffect(() => {
    const storedConversations = conversationsRef.current;
    if (!storedConversations) return;
    if (!active) {
      setActiveConversation((current) => current ?? createEmptyConversation(owner));
      return;
    }
    if (!requestedConversationId) {
      setActiveConversation((current) =>
        shouldCreateNewConversation(current, storedConversations) ? createEmptyConversation(owner) : current,
      );
      return;
    }
    if (activeConversationRef.current?.id === requestedConversationId) return;

    const selected = storedConversations.find((conversation) => conversation.id === requestedConversationId);
    if (selected) {
      setActiveConversation((current) => (current?.id === selected.id ? current : selected));
      setFloatingConversation((current) => (current?.conversation.id === selected.id ? undefined : current));
      return;
    }

    setActiveConversation(createEmptyConversation(owner));
    void navigate(APP_ROUTES.chat, { replace: true });
  }, [active, historyReady, navigate, owner, requestedConversationId]);

  function openConversationUrl(conversationId: string): void {
    void navigate(`${APP_ROUTES.chat}?${CHAT_ID_QUERY_PARAMETER}=${encodeURIComponent(conversationId)}`);
  }

  function openNewChatUrl(): void {
    void navigate(APP_ROUTES.chat);
  }

  function replaceWithNewChatUrl(): void {
    void navigate(APP_ROUTES.chat, { replace: true });
  }

  function selectConversation(id: string): void {
    const selected = conversations?.find((conversation) => conversation.id === id);
    if (!selected) return;
    setActiveConversation(selected);
    setFloatingConversation((current) => (current?.conversation.id === id ? undefined : current));
    openConversationUrl(id);
  }

  const startConversation = useCallback((): void => {
    setActiveConversation(createEmptyConversation(owner));
    void navigate(APP_ROUTES.chat);
  }, [navigate, owner]);

  const updateConversation = useCallback(
    (conversation: StoredConversation): void => {
      setActiveConversation((current) => (current?.id === conversation.id ? conversation : current));
      setFloatingConversation((current) =>
        current?.conversation.id === conversation.id ? { ...current, conversation } : current,
      );
      setConversations((current) =>
        [conversation, ...current.filter((entry) => entry.id !== conversation.id)].sort(
          (left, right) => right.updatedAt - left.updatedAt,
        ),
      );
    },
    [setConversations],
  );

  function changePagePlacement(placement: AgentChatPlacement, conversation: StoredConversation): void {
    if (placement !== 'toolbar') return;
    if (conversation.messages.length > 0) updateConversation(conversation);
    setFloatingConversation({ conversation, placement: 'toolbar' });
    setActiveConversation(createEmptyConversation(owner));
    openNewChatUrl();
  }

  function changeFloatingPlacement(placement: AgentChatPlacement, conversation: StoredConversation): void {
    if (conversation.messages.length > 0) updateConversation(conversation);
    if (placement === 'page') {
      setActiveConversation(conversation);
      setFloatingConversation(undefined);
      return;
    }
    setFloatingConversation({ conversation, placement });
  }

  function openNewMiniChat(): void {
    setFloatingConversation({
      conversation: createEmptyConversation(owner),
      placement: 'toolbar',
    });
  }

  function openConversationInMini(id: string): void {
    const selected =
      floatingConversation?.conversation.id === id
        ? floatingConversation.conversation
        : conversations?.find((conversation) => conversation.id === id);
    if (!selected) return;

    setFloatingConversation({ conversation: selected, placement: 'toolbar' });
    if (activeConversation?.id !== id) return;
    setActiveConversation(createEmptyConversation(owner));
    if (active) openNewChatUrl();
  }

  async function removeConversation(conversation: StoredConversation): Promise<void> {
    const remainingConversations = (conversations ?? []).filter((entry) => entry.id !== conversation.id);
    const deletedActiveConversation = activeConversation?.id === conversation.id;
    const deletedFloatingConversation =
      floatingConversation?.conversation.id === conversation.id ? floatingConversation : undefined;

    setConversations(() => remainingConversations);
    if (deletedActiveConversation) {
      setActiveConversation(createEmptyConversation(owner));
      replaceWithNewChatUrl();
    }
    setFloatingConversation((current) => (current?.conversation.id === conversation.id ? undefined : current));

    try {
      await deleteConversation(conversation.id);
    } catch (error) {
      setConversations((current) =>
        [conversation, ...current.filter((entry) => entry.id !== conversation.id)].sort(
          (left, right) => right.updatedAt - left.updatedAt,
        ),
      );
      if (deletedActiveConversation) {
        setActiveConversation(conversation);
        openConversationUrl(conversation.id);
      }
      if (deletedFloatingConversation) setFloatingConversation(deletedFloatingConversation);
      toast.error('Chat could not be deleted');
      throw error;
    }
  }

  if (conversationsQuery.isPending) {
    return active ? <BifrostNewChatLoadingState /> : null;
  }

  if (conversationsQuery.isError) {
    return active ? (
      <AgentChat className="h-full min-h-[540px] bg-transparent" title="Bifrost">
        <AgentChatEmptyState>
          <div aria-busy={conversationsQuery.isFetching} className="mx-auto max-w-md px-6 text-center" role="alert">
            <h1 className="text-xl font-semibold text-linear-bright">Chat history could not be opened</h1>
            <p className="mt-2 text-sm leading-6 text-linear-muted">
              Nothing was deleted. Your history is still stored in this browser.
            </p>
            <Button
              className="mt-4 min-w-20"
              disabled={conversationsQuery.isFetching}
              onClick={() => {
                void conversationsQuery.refetch();
              }}
              variant="outline"
            >
              Retry
            </Button>
          </div>
        </AgentChatEmptyState>
      </AgentChat>
    ) : null;
  }

  if (!activeConversation) {
    return active ? <BifrostNewChatLoadingState /> : null;
  }

  const loadedConversations = conversationsQuery.data;
  const toolbarHistoryItems = historyItems(loadedConversations, floatingConversation?.conversation.id);

  return (
    <>
      <div className={`relative min-h-0 ${active ? 'h-full' : 'h-0'}`}>
        <ChatConversation
          dock={{
            active,
            onOpenFullPage: (conversation) => openConversationUrl(conversation.id),
            onPlacementChange: changePagePlacement,
            placement: 'page',
          }}
          key={activeConversation.id}
          navigation={{
            onConversationStarted: openConversationUrl,
            onHistorySelect: selectConversation,
            onNewChat: startConversation,
          }}
          record={{
            conversation: activeConversation,
            history: loadedConversations,
            onChange: updateConversation,
            onDelete: removeConversation,
          }}
        />
        {floatingConversation && floatingConversation.conversation.id !== activeConversation.id ? (
          <ChatConversation
            dock={{
              active,
              onOpenFullPage: (conversation) => openConversationUrl(conversation.id),
              onPlacementChange: changeFloatingPlacement,
              placement: floatingConversation.placement,
            }}
            key={floatingConversation.conversation.id}
            navigation={{
              onHistorySelect: selectConversation,
              onNewChat: startConversation,
            }}
            record={{
              conversation: floatingConversation.conversation,
              history: loadedConversations,
              onChange: updateConversation,
              onDelete: removeConversation,
            }}
          />
        ) : null}
      </div>
      {toolbarHost
        ? createPortal(
            <AgentChatGlobalToolbar
              history={{
                items: toolbarHistoryItems,
                onNewChat: openNewMiniChat,
                onSelect: (item) => openConversationInMini(item.id),
              }}
              {...(floatingConversation?.placement === 'minimized'
                ? {
                    tab: {
                      onOpen: () =>
                        setFloatingConversation({
                          ...floatingConversation,
                          placement: 'toolbar',
                        }),
                      title: floatingConversation.conversation.title,
                    },
                  }
                : {})}
            />,
            toolbarHost,
          )
        : null}
    </>
  );
}

function ChatConversation({
  dock,
  navigation,
  record,
}: {
  dock: ChatConversationDock;
  navigation: ChatConversationNavigation;
  record: ChatConversationRecord;
}): React.JSX.Element {
  const { conversation, history } = record;
  const [input, setInput] = useState('');
  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/chat' }), []);
  const { addToolApprovalResponse, error, messages, regenerate, sendMessage, setMessages, status, stop } = useChat({
    id: conversation.id,
    messages: conversation.messages,
    transport,
    // Once every pending change in the last answer is approved or denied, the
    // agent continues with those decisions.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  const isWorking = status === 'submitted' || status === 'streaming';
  const isMiniChat = dock.placement !== 'page';
  const conversationRecord = useConversationRecord({
    conversation,
    isWorking,
    messages,
    onConversationChange: record.onChange,
    onDelete: record.onDelete,
    stop,
  });
  const messageEditing = useMessageEditing({
    isWorking,
    messages,
    regenerate,
    setMessages,
    stop,
  });
  const conversationHistoryItems = historyItems(history, conversation.id);

  function respondToApproval(response: { id: string; approved: boolean }): void {
    void addToolApprovalResponse(response);
  }

  function submit(value: string): void {
    // A pending tool call without an answer would leave the model's history incomplete.
    if (hasPendingApproval(messages)) {
      toast.error('Approve or deny the pending change first');
      return;
    }
    if (messageEditing.submitEditedMessage(value)) {
      setInput('');
      return;
    }
    if (messages.length === 0) navigation.onConversationStarted?.(conversation.id);
    setInput('');
    void sendMessage({ text: value });
  }

  function beginEditingMessage(message: UIMessage): void {
    const editedText = messageEditing.beginEditingMessage(message);
    if (editedText !== undefined) setInput(editedText);
  }

  function cancelEditingMessage(): void {
    messageEditing.cancelEditingMessage();
    setInput('');
  }

  function copyMessage(message: UIMessage): void {
    void navigator.clipboard.writeText(messageText(message)).catch(() => toast.error('Message could not be copied'));
  }

  function cancelResponseAndChangeConversation(action: () => void): void {
    if (isWorking) void stop();
    action();
  }

  function copyAsMarkdown(): void {
    void navigator.clipboard
      .writeText(conversationMarkdown(conversationRecord.title, messages))
      .then(() => toast.success('Copied as markdown'))
      .catch(() => toast.error('Chat could not be copied'));
  }

  return (
    <AgentChatDock
      className="h-full min-h-[540px] bg-transparent"
      {...(messages.length > 0
        ? {
            conversation: {
              favorite: conversation.favorite,
              onCopyAsMarkdown: copyAsMarkdown,
              onDelete: conversationRecord.deleteCurrentConversation,
              onFavoriteChange: conversationRecord.changeFavorite,
            },
          }
        : {})}
      history={{
        items: conversationHistoryItems,
        onNewChat: () => cancelResponseAndChangeConversation(navigation.onNewChat),
        onSelect: (item) => cancelResponseAndChangeConversation(() => navigation.onHistorySelect(item.id)),
      }}
      onOpenFullPage={() => dock.onOpenFullPage(conversationRecord.currentConversation())}
      pageVisible={dock.active}
      placement={{
        current: dock.placement,
        kind: 'controlled',
        onChange: (nextPlacement) => dock.onPlacementChange(nextPlacement, conversationRecord.currentConversation()),
      }}
      title={conversationRecord.title}
    >
      {messages.length === 0 && !isMiniChat ? (
        <AgentChatEmptyState>
          <AgentChatComposer
            autoFocus
            captureTyping={dock.active}
            value={input}
            onChange={setInput}
            onStop={() => {
              void stop();
            }}
            onSubmit={submit}
            submitting={isWorking}
          />
        </AgentChatEmptyState>
      ) : (
        <>
          {messages.length === 0 ? (
            <div className="min-h-0 flex-1" />
          ) : (
            <AgentChatMessages
              preserveInitialTimestamp={isMiniChat}
              {...(isMiniChat ? { timestamp: conversationTimestamp(conversation.createdAt) } : {})}
            >
              {messageEditing.visibleMessages.map((message, index) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  onApprovalResponse={isWorking ? undefined : respondToApproval}
                  onCopy={() => copyMessage(message)}
                  onEdit={() => beginEditingMessage(message)}
                  showAssistantActions={isMiniChat}
                  streaming={
                    isWorking && index === messageEditing.visibleMessages.length - 1 && message.role === 'assistant'
                  }
                />
              ))}
              {status === 'submitted' && !messageEditing.editingMessageId ? (
                <AgentChatMessage actions={false} role="assistant">
                  <span className="animate-design-blink text-linear-muted">Thinking…</span>
                </AgentChatMessage>
              ) : null}
            </AgentChatMessages>
          )}
          <div className={cn('shrink-0', isMiniChat ? 'px-2 pb-1' : 'pb-4 pt-2')} data-agent-chat-composer-area="">
            {messageEditing.editingMessageId ? <AgentChatEditingBanner onCancel={cancelEditingMessage} /> : null}
            <AgentChatComposer
              autoFocus
              captureTyping={dock.active && !isMiniChat}
              onChange={setInput}
              onStop={() => {
                void stop();
              }}
              onSubmit={submit}
              {...(messages.length === 0 ? { placeholder: 'Ask Bifrost…' } : {})}
              size={isMiniChat ? 'mini' : 'default'}
              submitting={isWorking}
              value={input}
              variant="conversation"
            />
            {error ? (
              <p className="mx-auto mt-2 max-w-[821px] px-4 text-xs text-linear-danger">
                Bifrost could not complete that request.
              </p>
            ) : null}
            {conversationRecord.historyError ? (
              <p className="mx-auto mt-2 max-w-[821px] px-4 text-xs text-linear-danger">
                This conversation could not be saved to chat history.
              </p>
            ) : null}
          </div>
        </>
      )}
    </AgentChatDock>
  );
}

function ChatMessage({
  message,
  onApprovalResponse,
  onCopy,
  onEdit,
  showAssistantActions,
  streaming,
}: {
  message: UIMessage;
  onApprovalResponse: ApprovalResponder | undefined;
  onCopy: () => void;
  onEdit: () => void;
  showAssistantActions: boolean;
  streaming: boolean;
}): React.JSX.Element {
  const text = messageText(message);
  const toolParts = message.parts.filter(isToolUIPart);

  return (
    <AgentChatMessage
      actions={message.role === 'user' || showAssistantActions}
      onCopyMessage={onCopy}
      {...(message.role === 'user' ? { onEditMessage: onEdit } : {})}
      role={message.role === 'user' ? 'user' : 'assistant'}
    >
      {toolParts.map((part) =>
        part.state === 'approval-requested' && part.approval.isAutomatic !== true ? (
          <ToolApprovalRequest
            key={part.toolCallId}
            approvalId={part.approval.id}
            input={part.input}
            onResponse={onApprovalResponse}
            toolName={getToolName(part)}
          />
        ) : (
          <ToolActivity key={part.toolCallId} part={part} />
        ),
      )}
      {message.role === 'assistant' ? <AgentMarkdown markdown={text} streaming={streaming} /> : text}
      {wasDeclined(message) ? <DeclinedNotice /> : null}
    </AgentChatMessage>
  );
}

function DeclinedNotice(): React.JSX.Element {
  return (
    <p className="mt-2 text-xs text-app-text-tertiary" role="status">
      Claude declined this request, so the answer stops here. Try rephrasing it or start a new chat.
    </p>
  );
}

function conversationTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${conversationDay(date)} ${format(date, 'p')}`;
}

function conversationDay(date: Date): string {
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'MMM d');
}

function conversationMarkdown(title: string, messages: readonly UIMessage[]): string {
  const transcript = messages
    .map((message) => {
      const text = messageText(message).trim();
      if (!text) return undefined;
      return `## ${message.role === 'user' ? 'You' : 'Bifrost'}\n\n${text}`;
    })
    .filter((section): section is string => section !== undefined)
    .join('\n\n');
  return `# ${title}\n\n${transcript}\n`;
}

function hasPendingApproval(messages: readonly UIMessage[]): boolean {
  return messages.some((message) =>
    message.parts.some((part) => isToolUIPart(part) && part.state === 'approval-requested'),
  );
}

function ToolApprovalRequest({
  approvalId,
  input,
  onResponse,
  toolName,
}: {
  approvalId: string;
  input: unknown;
  onResponse: ApprovalResponder | undefined;
  toolName: string;
}): React.JSX.Element {
  const summary = describeAdminApproval(toolName, input);

  return (
    <div
      aria-label="Change waiting for your approval"
      className="mb-3 rounded-notice linear-border-hairline border-warning/35 bg-warning/7 p-3.5 text-xs text-app-text-secondary"
      role="group"
    >
      <p className="font-medium text-linear-bright">{summary.title}</p>
      {summary.details.length > 0 ? (
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto whitespace-pre-wrap break-words">
          {summary.details.map((detail, index) => (
            <li key={index}>{detail}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-app-text-tertiary">Nothing changes until you approve.</p>
      <div className="mt-3 flex gap-2">
        <Button disabled={!onResponse} onClick={() => onResponse?.({ id: approvalId, approved: true })} size="compact">
          Approve
        </Button>
        <Button
          disabled={!onResponse}
          onClick={() => onResponse?.({ id: approvalId, approved: false })}
          size="compact"
          variant="secondary"
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

function ToolActivity({ part }: { part: ChatToolPart }): React.JSX.Element {
  const finished = part.state === 'output-available' || part.state === 'output-error' || part.state === 'output-denied';
  const source = toolSource(part);
  const title = toolDisplayTitle(part, source);

  return (
    <div className="mb-2 flex select-none items-center gap-2 text-xs font-medium text-linear-agent-action">
      <span
        aria-hidden="true"
        className={`flex size-4 shrink-0 items-center justify-center ${finished ? 'opacity-70' : 'animate-design-pulse'}`}
      >
        {source.kind === 'provider' ? (
          <ProviderIcon providerId={source.providerId} size="sidebar" />
        ) : source.kind === 'bifrost' ? (
          <BifrostMark className="size-4" />
        ) : (
          <span className={`size-1.5 rounded-full ${finished ? 'bg-linear-muted' : 'bg-linear-primary'}`} />
        )}
      </span>
      <span>
        {part.state === 'output-denied' ? 'Denied' : finished ? 'Used' : 'Using'} {title}
      </span>
    </div>
  );
}

function toolDisplayTitle(part: ChatToolPart, source: ChatToolSource): string {
  const title = part.title?.trim();
  if (title) return title;
  return humanizeToolName(getToolName(part), source);
}

function toolSource(part: ChatToolPart): ChatToolSource {
  const metadataProviderId = part.toolMetadata?.providerId;
  if (isProviderId(metadataProviderId)) return { kind: 'provider', providerId: metadataProviderId };
  if (part.toolMetadata?.source === 'bifrost-admin') return { kind: 'bifrost' };

  const toolName = getToolName(part);
  if (toolName.startsWith('bifrost_')) return { kind: 'bifrost' };
  const nameProviderId = toolName.slice(0, toolName.indexOf('_'));
  return isProviderId(nameProviderId) ? { kind: 'provider', providerId: nameProviderId } : { kind: 'unknown' };
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && isConnectableProvider(value);
}

function humanizeToolName(toolName: string, source: ChatToolSource): string {
  const unprefixedName =
    source.kind === 'provider'
      ? toolName.slice(source.providerId.length + 1)
      : toolName.replace(/^bifrost_(?:admin_)?/, '');
  const words = unprefixedName.replaceAll(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : toolName;
}

function relativeAge(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function historyItems(
  conversations: readonly StoredConversation[],
  currentConversationId?: string,
): AgentHistoryItem[] {
  return conversations.map((conversation) => ({
    age: relativeAge(conversation.updatedAt),
    current: conversation.id === currentConversationId,
    favorite: conversation.favorite,
    group: 'Recent',
    id: conversation.id,
    title: conversation.title,
  }));
}

function shouldCreateNewConversation(
  conversation: StoredConversation | undefined,
  storedConversations: readonly StoredConversation[],
): boolean {
  if (!conversation) return true;
  if (conversation.messages.length > 0) return true;
  return storedConversations.some((stored) => stored.id === conversation.id);
}
