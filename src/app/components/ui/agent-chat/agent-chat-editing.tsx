import * as React from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@app/components/ui/tooltip';
import { cn } from '@app/lib/cn';
import { CloseChatIcon, EditMessageIcon } from './agent-chat-icons';

type AgentChatEditingBannerProps = React.ComponentPropsWithoutRef<'div'> & {
  onCancel?: () => void;
};

function AgentChatEditingBanner({ className, onCancel, ...props }: AgentChatEditingBannerProps) {
  return (
    <div
      className={cn(
        'mx-auto flex h-[27px] w-[calc(100%-24px)] max-w-[821px] items-start justify-between gap-2 pb-1',
        className,
      )}
      {...props}
    >
      <div className="flex h-[23px] items-center gap-1.5 py-1 pl-2 pr-1 text-linear-agent-composer-icon">
        <EditMessageIcon />
        <span className="text-xs font-[450] leading-[14.5px]">Editing message</span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="Cancel editing"
            className="relative mr-2 flex size-5 cursor-default items-center justify-center rounded-full linear-border-hairline border-transparent px-0.5 text-linear-foreground transition-[background-color,color] duration-150 hover:bg-linear-agent-header-hover hover:text-linear-bright focus-visible:bg-linear-agent-header-hover focus-visible:text-linear-bright focus-visible:outline-none"
            onClick={onCancel}
            type="button"
          >
            <CloseChatIcon />
          </button>
        </TooltipTrigger>
        <TooltipContent className="border-linear-menu-border bg-linear-popover text-linear-menu-foreground">
          Cancel editing
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export { AgentChatEditingBanner };
