import * as React from "react"

import {
  MarkdownRenderer,
  preloadMarkdownDiagrams,
} from "@app/components/ui/markdown-renderer/markdown-renderer"

type AgentMarkdownProps = {
  className?: string
  markdown: string
  streaming?: boolean
}

function usePreparedMarkdown(value: string, streaming: boolean) {
  const [frameValue, setFrameValue] = React.useState(value)
  const streamStarted = React.useRef(streaming)

  React.useEffect(() => {
    if (streaming) {
      streamStarted.current = true
    }

    if (!streaming && !streamStarted.current) {
      setFrameValue(value)
      return
    }

    let active = true
    const frame = requestAnimationFrame(() => {
      void preloadMarkdownDiagrams(value)
        .catch(() => undefined)
        .then(() => {
          if (active) {
            setFrameValue(value)
            if (!streaming) {
              streamStarted.current = false
            }
          }
        })
    })

    return () => {
      active = false
      cancelAnimationFrame(frame)
    }
  }, [streaming, value])

  return frameValue
}

const AgentMarkdown = React.memo(function AgentMarkdown({
  className,
  markdown,
  streaming = false,
}: AgentMarkdownProps) {
  const renderedMarkdown = usePreparedMarkdown(markdown, streaming)

  return (
    <MarkdownRenderer
      className={className}
      markdown={renderedMarkdown}
      streaming={streaming}
    />
  )
})

export {
  AgentMarkdown,
  type AgentMarkdownProps,
}
