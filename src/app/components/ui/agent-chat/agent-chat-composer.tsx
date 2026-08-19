import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@app/components/ui/tooltip"
import { cn } from "@app/lib/cn"
import { SubmitIcon } from "./agent-chat-icons"

type AgentChatComposerVariant = "conversation" | "empty"

type AgentChatComposerProps = Omit<
  React.ComponentPropsWithoutRef<"textarea">,
  "onChange" | "onSubmit" | "value"
> & {
  onChange?: (value: string) => void
  onSubmit?: (value: string) => void
  submitting?: boolean
  value?: string
  variant?: AgentChatComposerVariant
}

const editorMinimumHeight = 24

function syncTextareaHeight(textarea: HTMLTextAreaElement, minimumHeight: number) {
  textarea.style.height = "auto"
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, minimumHeight), 288)
  textarea.style.height = `${nextHeight}px`
}

function ComposerIconButton({
  children,
  className,
  label,
  ...props
}: React.PropsWithChildren<
  { label: string } & React.ComponentPropsWithoutRef<"button">
>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          className={cn(
            "relative flex size-6 shrink-0 items-center justify-center rounded-full linear-border-hairline border-transparent p-0 text-linear-agent-composer-icon transition-[background-color,color] duration-150 hover:bg-linear-ghost-hover hover:text-linear-foreground focus-visible:bg-linear-ghost-hover focus-visible:text-linear-foreground focus-visible:outline-none",
            className,
          )}
          data-agent-composer-control=""
          type="button"
          {...props}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function AgentChatComposer({
  className,
  onChange,
  onKeyDown,
  onSubmit,
  placeholder,
  submitting = false,
  value = "",
  variant = "empty",
  ...props
}: AgentChatComposerProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  React.useLayoutEffect(() => {
    if (textareaRef.current) {
      syncTextareaHeight(textareaRef.current, editorMinimumHeight)
    }
  }, [value])

  function submitMessage() {
    const trimmedValue = value.trim()
    if (trimmedValue) {
      onSubmit?.(trimmedValue)
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    onKeyDown?.(event)

    if (event.defaultPrevented) {
      return
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      submitMessage()
    }
  }

  return (
    <div
      className={cn(
        "agent-chat-composer-shell relative z-10 mx-auto w-[min(712px,calc(100%-48px))] min-[1025px]:w-[min(712px,calc(100%-32px))]",
        variant === "conversation" &&
          "w-[calc(100%-16px)] max-w-[829px] p-1 min-[1025px]:w-[calc(100%-24px)]",
        className,
      )}
      data-agent-composer-shell=""
      data-variant={variant}
    >
      <div
        className={cn(
          "agent-chat-composer relative flex w-full flex-col gap-2 rounded-[10px] p-3 shadow-linear-control",
          variant === "conversation" &&
            "bg-linear-agent-composer-conversation",
          variant === "empty" && "bg-linear-agent-composer-empty",
        )}
        data-variant={variant}
      >
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto px-1.5 py-0.5",
            variant === "empty" ? "min-h-12" : "min-h-[72px]",
          )}
        >
          <textarea
            ref={textareaRef}
            aria-label="Send a message to Bifrost"
            className="block w-full resize-none overflow-y-auto bg-transparent p-0 text-[15px] font-[450] leading-6 tracking-[-0.1px] text-linear-foreground outline-none placeholder:text-linear-agent-placeholder"
            onChange={(event) => onChange?.(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder ?? (variant === "empty" ? "Ask Bifrost…" : "Reply…")}
            rows={1}
            value={value}
            {...props}
          />
        </div>

        <div className="flex h-6 items-center justify-end" data-agent-composer-toolbar="">
          <ComposerIconButton
            aria-disabled={!value.trim() || submitting}
            className={cn(
              "rounded-xl bg-linear-agent-submit-disabled",
              value.trim() && !submitting &&
                "bg-linear-primary text-linear-primary-foreground shadow-linear-control hover:bg-linear-primary-hover hover:text-linear-primary-foreground",
            )}
            disabled={!value.trim() || submitting}
            label="Send message"
            onClick={submitMessage}
          >
            <SubmitIcon />
          </ComposerIconButton>
        </div>
      </div>
    </div>
  )
}

export { AgentChatComposer, type AgentChatComposerProps }
