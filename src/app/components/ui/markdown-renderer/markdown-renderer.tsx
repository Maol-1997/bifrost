import MarkdownIt, { type Token } from "markdown-it"
import taskLists from "markdown-it-task-lists"
import * as React from "react"

import { CodeBlock } from "@app/components/ui/code-block"
import {
  MermaidDiagram,
  preloadMermaidDiagram,
} from "@app/components/ui/mermaid-diagram"
import { cn } from "@app/lib/cn"
import "./markdown-renderer.css"

type MarkdownRendererProps = Omit<
  React.ComponentPropsWithoutRef<"div">,
  "children"
> & {
  markdown: string
  streaming?: boolean
}

type MarkdownSegment =
  | { content: string; type: "markdown" }
  | { content: string; language: string; type: "code" }
  | { complete: boolean; content: string; type: "mermaid" }

const markdownParser = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
})

markdownParser.use(taskLists, { enabled: false, label: true })

markdownParser.renderer.rules.table_open = () =>
  '<div class="table-responsive"><table>'
markdownParser.renderer.rules.table_close = () => "</table></div>"

markdownParser.renderer.rules.link_open = (tokens, index, options, _environment, self) => {
  const token = tokens[index]
  if (!token) return ""
  token.attrSet("target", "_blank")
  token.attrSet("rel", "noopener noreferrer nofollow")
  return self.renderToken(tokens, index, options)
}

function lineStartOffsets(markdown: string) {
  const offsets = [0]

  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      offsets.push(index + 1)
    }
  }

  return offsets
}

function fencedTokens(markdown: string) {
  return markdownParser
    .parse(markdown, {})
    .filter((token): token is Token & { map: [number, number] } =>
      token.type === "fence" && token.map !== null,
    )
}

function fenceIsClosed(markdown: string, token: Token, offsets: number[]) {
  if (!token.map) {
    return false
  }

  const [, endLine] = token.map
  const fenceEnd = offsets[endLine] ?? markdown.length
  const fenceLines = markdown.slice(0, fenceEnd).trimEnd().split("\n")
  const closingLine = fenceLines.at(-1)?.trimStart() ?? ""
  return closingLine.startsWith(token.markup)
}

function segmentFromFence(token: Token, complete: boolean): MarkdownSegment {
  const language = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? ""

  if (language === "mermaid") {
    return { complete, content: token.content.trim(), type: "mermaid" }
  }

  return { content: token.content, language, type: "code" }
}

function parseMarkdownSegments(markdown: string) {
  const segments: MarkdownSegment[] = []
  const offsets = lineStartOffsets(markdown)
  let cursor = 0

  for (const token of fencedTokens(markdown)) {
    const [startLine, endLine] = token.map
    const start = offsets[startLine] ?? markdown.length
    const end = offsets[endLine] ?? markdown.length

    if (start > cursor) {
      segments.push({ content: markdown.slice(cursor, start), type: "markdown" })
    }

    segments.push(segmentFromFence(token, fenceIsClosed(markdown, token, offsets)))
    cursor = end
  }

  if (cursor < markdown.length) {
    segments.push({ content: markdown.slice(cursor), type: "markdown" })
  }

  if (segments.length === 0) {
    return [{ content: markdown, type: "markdown" as const }]
  }

  return segments
}

function completedMermaidSources(markdown: string) {
  return parseMarkdownSegments(markdown)
    .filter(
      (segment): segment is Extract<MarkdownSegment, { type: "mermaid" }> =>
        segment.type === "mermaid" && segment.complete,
    )
    .map((segment) => segment.content)
}

function preloadMarkdownDiagrams(markdown: string) {
  return Promise.all(completedMermaidSources(markdown).map(preloadMermaidDiagram))
}

type RenderSegmentOptions = {
  deferMermaid: boolean
  index: number
  segment: MarkdownSegment
  streaming: boolean
}

function renderSegment({
  deferMermaid,
  index,
  segment,
  streaming,
}: RenderSegmentOptions) {
  if (segment.type === "mermaid") {
    if (!segment.complete && streaming) {
      return null
    }

    if (!segment.complete) {
      return (
        <CodeBlock
          key={`code-${index}-mermaid`}
          code={segment.content}
          language="mermaid"
        />
      )
    }

    return (
      <MermaidDiagram
        defer={deferMermaid}
        key={`diagram-${index}-${segment.content}`}
        source={segment.content}
      />
    )
  }

  if (segment.type === "code") {
    return (
      <CodeBlock
        key={`code-${index}-${segment.language}`}
        code={segment.content}
        language={segment.language}
      />
    )
  }

  return (
    <div
      key={`markdown-${index}`}
      className="agent-markdown-segment"
      dangerouslySetInnerHTML={{ __html: markdownParser.render(segment.content) }}
    />
  )
}

const MarkdownRenderer = React.memo(
  React.forwardRef<HTMLDivElement, MarkdownRendererProps>(function MarkdownRenderer(
    { className, markdown, onClick, streaming = false, ...props },
    ref,
  ) {
    const [savedDiagramsActivated, setSavedDiagramsActivated] =
      React.useState(false)
    const segments = React.useMemo(() => parseMarkdownSegments(markdown), [markdown])
    const deferMermaid = !streaming && !savedDiagramsActivated

    function activateSavedDiagrams(event: React.MouseEvent<HTMLDivElement>) {
      setSavedDiagramsActivated(true)
      onClick?.(event)
    }

    return (
      <div
        ref={ref}
        aria-label="Rendered markdown"
        className={cn("agent-markdown", className)}
        onClick={activateSavedDiagrams}
        role="document"
        {...props}
      >
        {segments.map((segment, index) =>
          renderSegment({ deferMermaid, index, segment, streaming }),
        )}
      </div>
    )
  }),
)

MarkdownRenderer.displayName = "MarkdownRenderer"

export {
  MarkdownRenderer,
  preloadMarkdownDiagrams,
  type MarkdownRendererProps,
}
