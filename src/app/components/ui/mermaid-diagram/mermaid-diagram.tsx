import * as React from 'react';
import { Check, Code2, Copy, MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@app/components/ui/dropdown-menu';
import { cn } from '@app/lib/cn';
import { getCachedMermaidDiagram, preloadMermaidDiagram, type RenderedDiagram } from './mermaid-renderer';
import './mermaid-diagram.css';

type MermaidDiagramProps = Omit<React.ComponentPropsWithoutRef<'figure'>, 'children'> & {
  defer?: boolean;
  source: string;
};

type RenderedDiagramState = RenderedDiagram & {
  source: string;
};

const COPY_CONFIRMATION_DURATION = 1200;

const MONOSPACE_FONT_STACK = 'ui-monospace,"SFMono-Regular",Consolas,"Liberation Mono",Menlo,Courier,monospace';

function diagramDocument(svg: string) {
  return `<!doctype html><html><head><style>
    html,body{background:#19191b;height:100%;margin:0;padding:0;overflow:hidden;user-select:text;font-family:${MONOSPACE_FONT_STACK}}
    body{display:flex;align-items:center;justify-content:center}
    body>svg{display:block;width:100%;height:auto;max-height:100%}
    svg text,svg tspan{font-family:${MONOSPACE_FONT_STACK};font-weight:300}
  </style></head><body>${svg}</body></html>`;
}

const MermaidDiagram = React.memo(
  React.forwardRef<HTMLElement, MermaidDiagramProps>(function MermaidDiagram(
    { className, defer = false, source, ...props },
    ref,
  ) {
    const [copied, setCopied] = React.useState(false);
    const [activatedSource, setActivatedSource] = React.useState<string | null>(() =>
      defer && !getCachedMermaidDiagram(source) ? null : source,
    );
    const [errorState, setErrorState] = React.useState<{
      message: string;
      source: string;
    }>();
    const [loadedSvg, setLoadedSvg] = React.useState<string>();
    const [showSource, setShowSource] = React.useState(false);
    const [renderedState, setRenderedState] = React.useState<RenderedDiagramState | undefined>(() => {
      const cachedDiagram = getCachedMermaidDiagram(source);
      return cachedDiagram ? { ...cachedDiagram, source } : undefined;
    });
    const diagram = renderedState?.source === source ? renderedState : getCachedMermaidDiagram(source);
    const frameDocument = React.useMemo(() => (diagram ? diagramDocument(diagram.svg) : undefined), [diagram]);
    const error = errorState?.source === source ? errorState.message : undefined;
    const isActivated = !defer || activatedSource === source || Boolean(getCachedMermaidDiagram(source));
    const copyTimer = React.useRef<number>(undefined);

    React.useEffect(
      () => () => {
        if (copyTimer.current !== undefined) {
          window.clearTimeout(copyTimer.current);
        }
      },
      [],
    );

    React.useEffect(() => {
      if (!isActivated) {
        return;
      }

      const cachedDiagram = getCachedMermaidDiagram(source);
      if (cachedDiagram) {
        setRenderedState({ ...cachedDiagram, source });
        setErrorState(undefined);
        return;
      }

      setErrorState(undefined);
      let active = true;
      void preloadMermaidDiagram(source)
        .then((renderedDiagram) => {
          if (active) {
            setRenderedState({ ...renderedDiagram, source });
            setErrorState(undefined);
          }
        })
        .catch((reason: unknown) => {
          if (active) {
            setErrorState({
              message: reason instanceof Error ? reason.message : 'Unable to render diagram',
              source,
            });
          }
        });

      return () => {
        active = false;
      };
    }, [isActivated, source]);

    async function copySource(): Promise<void> {
      try {
        await navigator.clipboard.writeText(source);
        setCopied(true);
        window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), COPY_CONFIRMATION_DURATION);
      } catch {
        setCopied(false);
        window.clearTimeout(copyTimer.current);
        toast.error('Diagram source could not be copied');
      }
    }

    return (
      <figure
        ref={ref}
        aria-busy={!diagram && !error}
        className={cn('agent-mermaid', className)}
        data-source-visible={showSource}
        data-state={diagram ? 'ready' : error ? 'error' : 'loading'}
        {...props}
      >
        <div className="agent-mermaid-menu">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button aria-label="Diagram actions" type="button">
                <MoreHorizontal aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44 min-w-44" sideOffset={4}>
              <DropdownMenuItem onSelect={() => setShowSource((visible) => !visible)}>
                <Code2 className="size-4" aria-hidden="true" />
                {showSource ? 'Hide source' : 'Show source'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copySource()}>
                {copied ? (
                  <Check className="size-4" aria-hidden="true" />
                ) : (
                  <Copy className="size-4" aria-hidden="true" />
                )}
                {copied ? 'Copied' : 'Copy source'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {showSource && (
          <pre className="agent-mermaid-source">
            <code>{source}</code>
          </pre>
        )}
        {!showSource && !diagram && !error && (
          <button
            aria-label={isActivated ? 'Rendering diagram' : 'Render diagram'}
            className="agent-mermaid-loading"
            disabled={isActivated}
            onClick={() => setActivatedSource(source)}
            type="button"
          />
        )}
        {!showSource && error && <pre className="agent-mermaid-error">{error}</pre>}
        {!showSource && diagram && (
          <div
            className="agent-mermaid-stage"
            style={
              {
                '--diagram-aspect-ratio': `${diagram.dimensions.width} / ${diagram.dimensions.height}`,
                '--diagram-width': `${diagram.dimensions.width}px`,
              } as React.CSSProperties
            }
          >
            <div aria-hidden="true" className="agent-mermaid-exact-skeleton" data-hidden={loadedSvg === diagram.svg} />
            {frameDocument !== undefined && (
              <iframe
                aria-label="Mermaid diagram"
                data-loaded={loadedSvg === diagram.svg}
                onLoad={() => setLoadedSvg(diagram.svg)}
                sandbox=""
                srcDoc={frameDocument}
                title="Mermaid diagram"
              />
            )}
          </div>
        )}
      </figure>
    );
  }),
);

MermaidDiagram.displayName = 'MermaidDiagram';

export { MermaidDiagram };
