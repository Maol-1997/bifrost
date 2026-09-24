import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@app/components/ui/tooltip"
import { cn } from "@app/lib/cn"
import { StopIcon, SubmitIcon } from "./agent-chat-icons"
import { useTypeToFocus } from "./use-type-to-focus"

type AgentChatComposerVariant = "conversation" | "empty"
type AgentChatComposerSize = "default" | "mini"

type AgentChatComposerProps = Omit<
  React.ComponentPropsWithoutRef<"textarea">,
  "onChange" | "onSubmit" | "value"
> & {
  /** Route typing that starts anywhere on the page into this composer. */
  captureTyping?: boolean
  onChange?: (value: string) => void
  onStop?: () => void
  onSubmit?: (value: string) => void
  submitting?: boolean
  size?: AgentChatComposerSize
  value?: string
  variant?: AgentChatComposerVariant
}

const editorMinimumHeight = 24
const miniEditorMinimumHeight = 21

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
  captureTyping = false,
  className,
  onChange,
  onKeyDown,
  onStop,
  onSubmit,
  placeholder,
  size = "default",
  submitting = false,
  value = "",
  variant = "empty",
  ...props
}: AgentChatComposerProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const hasInput = Boolean(value.trim())
  const actionDisabled = submitting ? !onStop : !hasInput
  useTypeToFocus(textareaRef, captureTyping)

  React.useLayoutEffect(() => {
    if (textareaRef.current) {
      syncTextareaHeight(
        textareaRef.current,
        size === "mini" ? miniEditorMinimumHeight : editorMinimumHeight,
      )
    }
  }, [size, value])

  function submitMessage() {
    if (submitting) return
    const trimmedValue = value.trim()
    if (trimmedValue) {
      onSubmit?.(trimmedValue)
    }
  }

  function runComposerAction() {
    if (submitting) {
      onStop?.()
      return
    }
    submitMessage()
  }

  // The editor's padding and the empty toolbar read as part of the input, so a
  // press there should land in the textarea. Preventing the default keeps focus
  // (and the caret) from leaving it on the way.
  function focusEditorFromSurface(event: React.MouseEvent<HTMLDivElement>) {
    const textarea = textareaRef.current
    if (!textarea || event.button !== 0) return
    if (event.target instanceof Element && event.target.closest("textarea, button, a, [role='button']")) return
    event.preventDefault()
    textarea.focus()
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
        "relative z-10 mx-auto w-[min(712px,calc(100%-48px))] min-[1025px]:w-[min(712px,calc(100%-32px))]",
        size === "mini"
          ? "-translate-x-1 w-[calc(100%+8px)] max-w-none p-1 min-[1025px]:w-[calc(100%+8px)]"
          : variant === "conversation" &&
          "w-[calc(100%-16px)] max-w-[829px] p-1 min-[1025px]:w-[calc(100%-24px)]",
        className,
      )}
      data-agent-composer-shell=""
      data-variant={variant}
    >
      <div
        className={cn(
          "agent-chat-composer relative flex w-full cursor-text flex-col gap-2 rounded-[10px] p-3 shadow-linear-control",
          size === "mini"
            ? "rounded-[7px] bg-linear-agent-message px-1 py-1.5"
            : variant === "conversation" &&
            "bg-linear-agent-composer-conversation",
          size !== "mini" && variant === "empty" && "bg-linear-agent-composer-empty",
        )}
        data-size={size}
        data-variant={variant}
        onMouseDown={focusEditorFromSurface}
      >
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto px-1.5 py-0.5",
            size !== "mini" && (variant === "empty" ? "min-h-12" : "min-h-[72px]"),
          )}
          data-agent-composer-editor=""
        >
          <textarea
            ref={textareaRef}
            aria-label="Send a message to Bifrost"
            className={cn(
              "block w-full resize-none overflow-y-auto bg-transparent p-0 font-[450] text-linear-foreground outline-none placeholder:text-linear-agent-placeholder",
              size === "mini"
                ? "text-[13px] leading-[20.8px]"
                : "text-[15px] leading-6 tracking-[-0.1px]",
            )}
            onChange={(event) => onChange?.(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder ?? (variant === "empty" ? "Ask Bifrost…" : "Reply…")}
            rows={1}
            value={value}
            {...props}
          />
        </div>

        <div
          className={cn(
            "flex h-6 items-center justify-end",
            size === "mini" && "h-7 items-end pb-1 pl-0.5 pr-1.5",
          )}
          data-agent-composer-toolbar=""
        >
          <ComposerIconButton
            aria-disabled={actionDisabled}
            className={cn(
              "rounded-xl bg-linear-agent-submit-disabled",
              hasInput && !submitting &&
                "bg-linear-primary text-linear-primary-foreground shadow-linear-control hover:bg-linear-primary-hover hover:text-linear-primary-foreground",
            )}
            disabled={actionDisabled}
            label={submitting ? "Stop response" : "Send message"}
            onClick={runComposerAction}
          >
            {submitting ? <StopIcon /> : <SubmitIcon />}
          </ComposerIconButton>
        </div>
      </div>
    </div>
  )
}

export { AgentChatComposer }
