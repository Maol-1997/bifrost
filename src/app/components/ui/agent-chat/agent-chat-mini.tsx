import * as React from 'react';
import { Copy, Trash2 } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@app/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@app/components/ui/tooltip';
import { cn } from '@app/lib/cn';
import { CloseChatIcon, MinimizeChatIcon, MoreIcon, OpenFullPageIcon } from './agent-chat-icons';

type AgentChatMiniPosition = 'contained' | 'fixed';
type AgentChatMiniActions = {
  onCopyAsMarkdown: () => void;
  onDelete: () => void;
};
type AgentChatMiniControls = {
  onClose: () => void;
  onMinimize: () => void;
  onOpenFullPage: () => void;
};

type AgentChatMiniProps = React.ComponentPropsWithoutRef<'section'> & {
  actions?: AgentChatMiniActions;
  controls: AgentChatMiniControls;
  position?: AgentChatMiniPosition;
  title?: string;
};

type MiniHeaderButtonProps = React.ComponentPropsWithoutRef<'button'> & {
  label: string;
};

const chatTooltipClassName = 'border-linear-menu-border bg-linear-popover text-linear-menu-foreground';

const MiniHeaderButton = React.forwardRef<HTMLButtonElement, MiniHeaderButtonProps>(
  ({ children, className, label, ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          aria-label={label}
          className={cn(
            'relative flex size-7 cursor-default items-center justify-center rounded-full border-[0.5px] border-transparent px-0.5 text-linear-agent-composer-icon transition-[border,background-color,color,opacity] duration-150 hover:bg-linear-agent-header-hover hover:text-linear-bright focus-visible:bg-linear-agent-header-hover focus-visible:text-linear-bright focus-visible:outline-none',
            className,
          )}
          type="button"
          {...props}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent className={chatTooltipClassName}>{label}</TooltipContent>
    </Tooltip>
  ),
);
MiniHeaderButton.displayName = 'MiniHeaderButton';

function MiniChatOptions({ actions }: { actions: AgentChatMiniActions }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <MiniHeaderButton label="Chat options">
          <MoreIcon />
        </MiniHeaderButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44 min-w-44" sideOffset={4}>
        <DropdownMenuItem onSelect={actions.onCopyAsMarkdown}>
          <Copy className="size-4" aria-hidden="true" />
          Copy as markdown
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={actions.onDelete}>
          <Trash2 className="size-4" aria-hidden="true" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const AgentChatMini = React.forwardRef<HTMLElement, AgentChatMiniProps>(function AgentChatMini(
  { actions, children, className, controls, position = 'fixed', title = 'New chat', ...props },
  ref,
) {
  return (
    <TooltipProvider>
      <section
        ref={ref}
        aria-label={title}
        aria-modal="true"
        className={cn(
          'agent-chat-mini z-[90] flex h-[619px] max-h-[calc(100%-28px)] w-[400px] max-w-[calc(100%-28px)] flex-col overflow-hidden rounded-t-xl rounded-b-2xl border-[0.5px] border-linear-search-sidebar-border bg-linear-agent-mini shadow-linear-popover',
          position === 'fixed'
            ? 'fixed bottom-[34px] right-8 max-[700px]:bottom-3.5 max-[700px]:right-3.5'
            : 'absolute bottom-[26px] right-6 max-[700px]:fixed max-[700px]:bottom-3.5 max-[700px]:right-3.5',
          className,
        )}
        role="dialog"
        {...props}
      >
        <header className="flex h-12 shrink-0 items-center justify-between bg-linear-input pl-2.5 pr-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate pl-1.5 text-[13px] font-medium text-linear-bright">{title}</span>
            {actions ? <MiniChatOptions actions={actions} /> : null}
          </div>
          <div className="flex items-center gap-0.5">
            <MiniHeaderButton label="Minimize chat" onClick={controls.onMinimize}>
              <MinimizeChatIcon />
            </MiniHeaderButton>
            <MiniHeaderButton label="Open full page" onClick={controls.onOpenFullPage}>
              <OpenFullPageIcon />
            </MiniHeaderButton>
            <MiniHeaderButton label="Close chat" onClick={controls.onClose}>
              <CloseChatIcon />
            </MiniHeaderButton>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col bg-linear-input">{children}</div>
      </section>
    </TooltipProvider>
  );
});
AgentChatMini.displayName = 'AgentChatMini';

export { AgentChatMini };
