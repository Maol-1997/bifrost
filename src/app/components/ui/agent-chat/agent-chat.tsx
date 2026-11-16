import * as React from 'react';
import { Copy, Plus, Star, Trash2 } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@app/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@app/components/ui/tooltip';
import { cn } from '@app/lib/cn';
import { AgentChatToolbarButton } from './agent-chat-actions';
import { AgentToolbarIcon, ChatHistoryIcon, ChevronDownIcon, MoreIcon } from './agent-chat-icons';
import { AgentChatLogo } from './agent-chat-logo';

type AgentHistoryItem = {
  age: string;
  current?: boolean;
  favorite?: boolean;
  group?: string;
  id: string;
  title: string;
};

type AgentChatConversation = {
  favorite: boolean;
  onCopyAsMarkdown: () => void;
  onDelete: () => void;
  onFavoriteChange: (favorite: boolean) => void;
  onMoveToToolbar: () => void;
};

type AgentChatHistory = {
  items: AgentHistoryItem[];
  onNewChat: () => void;
  onSelect: (item: AgentHistoryItem) => void;
};

type AgentChatProps = {
  children: React.ReactNode;
  className?: string;
  conversation?: AgentChatConversation;
  history?: AgentChatHistory;
  title?: string;
};

type AgentChatToolbarTab = {
  onOpen: () => void;
  title: string;
};

type AgentChatGlobalToolbarProps = {
  history: AgentChatHistory;
  tab?: AgentChatToolbarTab;
};

type HeaderIconButtonProps = React.ComponentPropsWithoutRef<'button'> & {
  label: string;
};

const HeaderIconButton = React.forwardRef<HTMLButtonElement, HeaderIconButtonProps>(
  ({ children, className, label, ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          aria-label={label}
          className={cn(
            'relative flex size-7 items-center justify-center rounded-full border-[0.5px] border-transparent text-linear-control-foreground transition-[background-color,color] duration-150 hover:bg-linear-ghost-hover focus-visible:bg-linear-ghost-hover focus-visible:outline-none max-[1024px]:size-8',
            className,
          )}
          type="button"
          {...props}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  ),
);
HeaderIconButton.displayName = 'HeaderIconButton';

type HistoryMenuProps = {
  align?: 'end' | 'start';
  children: React.ReactNode;
  history?: AgentChatHistory;
};

function ChatOptionsMenu({ conversation }: { conversation: AgentChatConversation }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <HeaderIconButton label="Chat options">
          <MoreIcon />
        </HeaderIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44 min-w-44" sideOffset={4}>
        <DropdownMenuItem onSelect={conversation.onCopyAsMarkdown}>
          <Copy className="size-4" aria-hidden="true" />
          Copy as markdown
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={conversation.onDelete}>
          <Trash2 className="size-4" aria-hidden="true" />
          Delete
          <DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HistoryMenu({ align = 'start', children, history }: HistoryMenuProps) {
  const items = history?.items ?? [];
  const group = items[0]?.group ?? 'Today';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="max-h-[min(360px,calc(100vh-64px))] w-[min(272px,calc(100vw-24px))] min-w-0 overflow-y-auto rounded-lg py-1"
        sideOffset={2}
      >
        <DropdownMenuItem
          className="h-7 pl-3 pr-3 text-[12.5px] before:inset-x-1 before:rounded-md"
          disabled={!history}
          {...(history ? { onSelect: history.onNewChat } : {})}
        >
          <Plus aria-hidden="true" className="text-linear-menu-icon" strokeWidth={1.75} />
          New chat
        </DropdownMenuItem>
        <DropdownMenuSeparator className="h-2 after:top-1" />
        <div
          aria-label={group}
          className="flex h-6 items-center px-3 text-[11px] font-medium text-linear-select-chevron"
          role="group"
        >
          {group}
        </div>
        {items.length === 0 ? (
          <div className="px-3.5 py-2 text-[13px] font-[450] text-linear-agent-action">No history</div>
        ) : (
          items.map((item) => (
            <DropdownMenuItem
              key={item.id}
              className="h-[30px] pl-3 pr-3 text-[12.5px] before:inset-x-1 before:rounded-md data-[current=true]:before:bg-linear-menu-item-hover"
              data-current={item.current}
              aria-current={item.current ? 'page' : undefined}
              onSelect={() => history?.onSelect(item)}
            >
              <span aria-hidden="true" className="flex w-6 shrink-0 items-center">
                {item.favorite ? <Star className="size-3 fill-current" /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate" title={item.title}>
                {item.title}
              </span>
              <span className="ml-2 shrink-0 tabular-nums text-linear-agent-action">{item.age}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type AgentChatHeaderProps = Omit<AgentChatProps, 'children' | 'className'>;

function AgentChatHeader({ conversation, history, title = 'New chat' }: AgentChatHeaderProps) {
  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b-[0.5px] border-linear-border px-2">
      <div className="flex min-w-0 items-center">
        <HistoryMenu {...(history ? { history } : {})}>
          <button
            aria-label="Switch agent chat"
            className="relative ml-0 flex h-7 min-w-0 items-center gap-2 rounded-full border-[0.5px] border-transparent px-2 text-xs font-medium text-linear-control-foreground transition-[background-color,color] duration-150 hover:bg-linear-ghost-hover hover:text-linear-bright focus-visible:bg-linear-ghost-hover focus-visible:text-linear-bright focus-visible:outline-none data-[state=open]:bg-linear-ghost-hover data-[state=open]:text-linear-bright max-[1024px]:h-8 min-[1025px]:ml-0.5"
            type="button"
          >
            <span className="truncate">{title}</span>
            <span className="shrink-0 text-linear-select-chevron">
              <ChevronDownIcon />
            </span>
          </button>
        </HistoryMenu>
        {conversation ? (
          <>
            <HeaderIconButton
              aria-pressed={conversation.favorite}
              label={conversation.favorite ? 'Remove from favorites' : 'Add to favorites'}
              onClick={() => conversation.onFavoriteChange(!conversation.favorite)}
            >
              <Star
                className={cn('size-4', conversation.favorite && 'fill-current text-linear-bright')}
                aria-hidden="true"
              />
            </HeaderIconButton>
            <ChatOptionsMenu conversation={conversation} />
          </>
        ) : null}
      </div>
      {conversation ? <AgentChatToolbarButton onClick={conversation.onMoveToToolbar} /> : null}
    </header>
  );
}

function AgentChatGlobalToolbar({ history, tab }: AgentChatGlobalToolbarProps) {
  return (
    <div aria-label="Agent toolbar" className="flex h-7 items-center justify-end gap-0.5 pr-2.5" role="toolbar">
      {tab ? (
        <button
          aria-label={`Open ${tab.title}`}
          className="relative flex h-7 max-w-[260px] items-center rounded-[8px] border-[0.5px] border-transparent px-2 text-xs font-[450] leading-[normal] text-linear-muted transition-[background-color,color] duration-150 hover:bg-linear-ghost-hover hover:text-linear-foreground focus-visible:bg-linear-ghost-hover focus-visible:text-linear-foreground focus-visible:outline-none"
          onClick={tab.onOpen}
          type="button"
        >
          <span className="truncate">{tab.title}</span>
        </button>
      ) : null}
      <button
        aria-label="Agent"
        className="relative flex h-7 items-center rounded-[8px] border-[0.5px] border-transparent pl-2.5 pr-3 text-xs font-medium leading-[normal] text-linear-muted transition-[background-color,color] duration-150 hover:bg-linear-ghost-hover hover:text-linear-bright focus-visible:bg-linear-ghost-hover focus-visible:text-linear-bright focus-visible:outline-none"
        onClick={history.onNewChat}
        type="button"
      >
        <AgentToolbarIcon />
        <span className="ml-1.5">Agent</span>
      </button>
      <HistoryMenu align="end" history={history}>
        <button
          aria-label="Chat history"
          className="relative flex size-7 items-center justify-center rounded-[8px] border-[0.5px] border-transparent text-linear-muted transition-[background-color,color] duration-150 hover:bg-linear-ghost-hover hover:text-linear-bright focus-visible:bg-linear-ghost-hover focus-visible:text-linear-bright focus-visible:outline-none data-[state=open]:bg-linear-ghost-hover data-[state=open]:text-linear-bright"
          type="button"
        >
          <ChatHistoryIcon />
        </button>
      </HistoryMenu>
    </div>
  );
}

function AgentChat({ children, className, conversation, history, title = 'New chat' }: AgentChatProps) {
  const onDelete = conversation?.onDelete;

  React.useEffect(() => {
    if (!onDelete) return;
    const deleteConversation = onDelete;

    function handleDeleteShortcut(event: KeyboardEvent): void {
      if (!event.metaKey || event.key !== 'Backspace' || isEditableTarget(event.target)) return;
      event.preventDefault();
      deleteConversation();
    }

    window.addEventListener('keydown', handleDeleteShortcut);
    return () => window.removeEventListener('keydown', handleDeleteShortcut);
  }, [onDelete]);

  return (
    <TooltipProvider>
      <div className={cn('relative h-[720px] min-h-[600px] w-full overflow-hidden bg-linear-canvas', className)}>
        <section
          className="agent-chat-surface absolute inset-0 flex flex-col overflow-hidden bg-linear-gallery-main"
          data-conversation={conversation ? 'true' : 'false'}
        >
          <AgentChatHeader
            {...(conversation ? { conversation } : {})}
            {...(history ? { history } : {})}
            title={title}
          />
          {children}
        </section>
      </div>
    </TooltipProvider>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  );
}

type AgentChatEmptyStateProps = {
  children: React.ReactNode;
  className?: string;
};

function AgentChatEmptyState({ children, className }: AgentChatEmptyStateProps) {
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div
        className={cn(
          'relative z-1 mx-auto flex min-h-full w-full -translate-y-2.75 flex-col justify-center',
          className,
        )}
      >
        <div className="relative flex w-full flex-col">
          <AgentChatLogo className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 translate-y-[-85%]" />
          {children}
        </div>
      </div>
    </div>
  );
}

export {
  AgentChat,
  AgentChatEmptyState,
  AgentChatGlobalToolbar,
  type AgentChatConversation,
  type AgentChatHistory,
  type AgentHistoryItem,
};
