import * as React from "react"
import { Copy, Trash2 } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@app/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@app/components/ui/tooltip"
import { cn } from "@app/lib/cn"
import {
  CloseChatIcon,
  MinimizeChatIcon,
  MoreIcon,
  OpenFullPageIcon,
} from "./agent-chat-icons"

type AgentChatMiniPosition = "contained" | "fixed"

type AgentChatMiniProps = React.ComponentPropsWithoutRef<"section"> & {
  onClose?: () => void
  onCopyAsMarkdown?: () => void
  onDelete?: () => void
  onMinimize?: () => void
  onOpenFullPage?: () => void
  position?: AgentChatMiniPosition
  title?: string
}

type MiniHeaderButtonProps = React.ComponentPropsWithoutRef<"button"> & {
  label: string
}

const chatTooltipClassName =
  "border-linear-menu-border bg-linear-popover text-linear-menu-foreground"

const MiniHeaderButton = React.forwardRef<
  HTMLButtonElement,
  MiniHeaderButtonProps
>(({ children, className, label, ...props }, ref) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        ref={ref}
        aria-label={label}
        className={cn(
          "relative flex size-7 cursor-default items-center justify-center rounded-full border-[0.5px] border-transparent px-0.5 text-linear-agent-composer-icon transition-[border,background-color,color,opacity] duration-150 hover:bg-linear-agent-header-hover hover:text-linear-bright focus-visible:bg-linear-agent-header-hover focus-visible:text-linear-bright focus-visible:outline-none",
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
))
MiniHeaderButton.displayName = "MiniHeaderButton"

function MiniChatOptions({
  onCopyAsMarkdown,
  onDelete,
}: Pick<AgentChatMiniProps, "onCopyAsMarkdown" | "onDelete">) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <MiniHeaderButton label="Chat options">
          <MoreIcon />
        </MiniHeaderButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44 min-w-44" sideOffset={4}>
        <DropdownMenuItem
          disabled={!onCopyAsMarkdown}
          {...(onCopyAsMarkdown ? { onSelect: onCopyAsMarkdown } : {})}
        >
          <Copy className="size-4" aria-hidden="true" />
          Copy as markdown
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!onDelete}
          {...(onDelete ? { onSelect: onDelete } : {})}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const AgentChatMini = React.forwardRef<HTMLElement, AgentChatMiniProps>(
  function AgentChatMini(
    {
      children,
      className,
      onClose,
      onCopyAsMarkdown,
      onDelete,
      onMinimize,
      onOpenFullPage,
      position = "fixed",
      title = "New chat",
      ...props
    },
    ref,
  ) {
    return (
      <TooltipProvider>
        <section
          ref={ref}
          aria-label={title}
          aria-modal="true"
          className={cn(
            "z-[90] flex h-[480px] max-h-[calc(100%-24px)] w-[400px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-t-xl rounded-b-2xl border-[0.5px] border-linear-search-sidebar-border bg-linear-agent-mini shadow-linear-popover",
            position === "fixed"
              ? "fixed bottom-[34px] right-[110px] max-[700px]:bottom-3 max-[700px]:right-3"
              : "absolute bottom-4 right-4",
            className,
          )}
          role="dialog"
          {...props}
        >
          <header className="flex h-12 shrink-0 items-center justify-between border-b-[0.5px] border-linear-border bg-linear-input pl-2.5 pr-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate pl-1.5 text-[13px] font-medium text-linear-bright">
                {title}
              </span>
              <MiniChatOptions
                {...(onCopyAsMarkdown ? { onCopyAsMarkdown } : {})}
                {...(onDelete ? { onDelete } : {})}
              />
            </div>
            <div className="flex items-center gap-0.5">
              <MiniHeaderButton label="Minimize chat" onClick={onMinimize}>
                <MinimizeChatIcon />
              </MiniHeaderButton>
              <MiniHeaderButton label="Open full page" onClick={onOpenFullPage}>
                <OpenFullPageIcon />
              </MiniHeaderButton>
              <MiniHeaderButton label="Close chat" onClick={onClose}>
                <CloseChatIcon />
              </MiniHeaderButton>
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col [&_.agent-chat-message[data-role=user]]:pr-4">
            {children}
          </div>
        </section>
      </TooltipProvider>
    )
  },
)
AgentChatMini.displayName = "AgentChatMini"

export {
  AgentChatMini,
  type AgentChatMiniPosition,
  type AgentChatMiniProps,
}
