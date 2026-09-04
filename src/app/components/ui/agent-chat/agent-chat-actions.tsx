import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@app/components/ui/tooltip"
import { cn } from "@app/lib/cn"
import {
  CopyMessageIcon,
  EditMessageIcon,
  MoveToToolbarIcon,
} from "./agent-chat-icons"

type AgentChatMessageActionButtonProps = React.ComponentPropsWithoutRef<"button"> & {
  label: string
}

const chatTooltipClassName =
  "border-linear-menu-border bg-linear-popover text-linear-menu-foreground"

const AgentChatMessageActionButton = React.forwardRef<
  HTMLButtonElement,
  AgentChatMessageActionButtonProps
>(({ children, className, label, ...props }, ref) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        ref={ref}
        aria-label={label}
        className={cn(
          "relative flex size-6 cursor-default items-center justify-center rounded-full linear-border-hairline border-transparent px-0.5 text-linear-agent-action transition-[border,background-color,color,opacity] duration-150 hover:bg-linear-agent-action-hover hover:text-linear-bright focus-visible:bg-linear-agent-action-hover focus-visible:text-linear-bright focus-visible:outline-none",
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
AgentChatMessageActionButton.displayName = "AgentChatMessageActionButton"

type AgentChatUserActionsProps = React.ComponentPropsWithoutRef<"div"> & {
  onCopyMessage?: () => void
  onEditMessage?: () => void
  visibility?: "hover" | "visible"
}

function AgentChatUserActions({
  className,
  onCopyMessage,
  onEditMessage,
  visibility = "hover",
  ...props
}: AgentChatUserActionsProps) {
  return (
    <div
      className={cn(
        "mt-1 flex h-[26px] w-[50px] items-center justify-end gap-0.5 self-end opacity-0 transition-opacity duration-150 [margin-bottom:-30px] group-focus-within:opacity-100 group-hover:opacity-100 data-[visibility=visible]:opacity-100",
        className,
      )}
      data-visibility={visibility}
      {...props}
    >
      <AgentChatMessageActionButton label="Copy message" {...(onCopyMessage ? { onClick: onCopyMessage } : {})}>
        <CopyMessageIcon />
      </AgentChatMessageActionButton>
      <AgentChatMessageActionButton label="Edit message" {...(onEditMessage ? { onClick: onEditMessage } : {})}>
        <EditMessageIcon />
      </AgentChatMessageActionButton>
    </div>
  )
}

type AgentChatToolbarButtonProps = Omit<
  React.ComponentPropsWithoutRef<"button">,
  "children"
> & {
  label?: string
}

const AgentChatToolbarButton = React.forwardRef<
  HTMLButtonElement,
  AgentChatToolbarButtonProps
>(({ className, label = "Move to toolbar", ...props }, ref) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        ref={ref}
        aria-label={label}
        className={cn(
          "relative flex size-7 cursor-default items-center justify-center rounded-full border-[0.5px] border-transparent px-0.5 text-linear-agent-header-icon transition-[border,background-color,color,opacity] duration-150 hover:bg-linear-agent-header-hover hover:text-linear-bright focus-visible:bg-linear-agent-header-hover focus-visible:text-linear-bright focus-visible:outline-none",
          className,
        )}
        type="button"
        {...props}
      >
        <MoveToToolbarIcon />
      </button>
    </TooltipTrigger>
    <TooltipContent className={chatTooltipClassName}>{label}</TooltipContent>
  </Tooltip>
))
AgentChatToolbarButton.displayName = "AgentChatToolbarButton"

export {
  AgentChatMessageActionButton,
  AgentChatToolbarButton,
  AgentChatUserActions,
}
