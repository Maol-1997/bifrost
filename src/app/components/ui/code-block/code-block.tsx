import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLanguage from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import * as React from 'react';

import { cn } from '@app/lib/cn';
import './code-block.css';

type CodeBlockProps = Omit<React.ComponentPropsWithoutRef<'pre'>, 'children'> & {
  code: string;
  label?: string;
  language?: string;
};

const COPY_CONFIRMATION_DURATION = 1200;

const languageLabels: Record<string, string> = {
  bash: 'Bash',
  css: 'CSS',
  html: 'HTML',
  javascript: 'JavaScript',
  js: 'JavaScript',
  json: 'JSON',
  markdown: 'Markdown',
  md: 'Markdown',
  py: 'Python',
  python: 'Python',
  shell: 'Shell',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  xml: 'XML',
};

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdownLanguage);
hljs.registerLanguage('md', markdownLanguage);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);

function highlightedCode(code: string, language: string) {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(code, { language }).value;
  }

  return hljs.highlightAuto(code, []).value;
}

function languageLabel(language: string): string {
  const knownLabel = languageLabels[language];
  if (knownLabel) return knownLabel;
  if (!language) return 'Code';
  return `${language.charAt(0).toUpperCase()}${language.slice(1)}`;
}

function WrapIcon() {
  return (
    <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
      <path d="M10.25 12.2988 14 9.70117l-3.75-2.59765v5.19528ZM2.75 8.95117a.75.75 0 0 0 0 1.50003h5.4663a.75.75 0 0 0 0-1.50003H2.75Zm0-5.25a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
      <path d="M11.75 15.077A3.25 3.25 0 0 0 15 11.827v-4.5a3.25 3.25 0 0 0-3.25-3.25h-4.5A3.25 3.25 0 0 0 4 7.327v4.5a3.25 3.25 0 0 0 3.25 3.25h4.5Zm1.75-3.25a1.75 1.75 0 0 1-1.75 1.75h-4.5a1.75 1.75 0 0 1-1.75-1.75v-4.5c0-.967.784-1.75 1.75-1.75h4.5c.966 0 1.75.783 1.75 1.75v4.5Z" />
      <path d="M10.957 1.941c.487.451.062 1.136-.602 1.136-.244 0-.472-.106-.678-.235a1.742 1.742 0 0 0-.927-.265h-4.5c-.477 0-.91.19-1.225.5H3v.025c-.31.316-.5.748-.5 1.225v4.5c0 .34.097.658.265.927.13.206.235.434.235.677 0 .665-.685 1.09-1.136.603A3.239 3.239 0 0 1 1 8.827v-4.5a3.25 3.25 0 0 1 3.25-3.25h4.5c.852 0 1.627.328 2.207.864Z" />
    </svg>
  );
}

const CodeBlock = React.memo(
  React.forwardRef<HTMLPreElement, CodeBlockProps>(function CodeBlock(
    { className, code, label, language = '', ...props },
    ref,
  ) {
    const normalizedLanguage = language.trim().toLowerCase();
    const displayedLanguage = label ?? languageLabel(normalizedLanguage);
    const highlighted = React.useMemo(() => highlightedCode(code, normalizedLanguage), [code, normalizedLanguage]);
    const [copied, setCopied] = React.useState(false);
    const [wrapped, setWrapped] = React.useState(false);
    const copyTimer = React.useRef<number>(undefined);

    React.useEffect(
      () => () => {
        if (copyTimer.current !== undefined) {
          window.clearTimeout(copyTimer.current);
        }
      },
      [],
    );

    async function copyCode() {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), COPY_CONFIRMATION_DURATION);
    }

    return (
      <pre
        ref={ref}
        className={cn('agent-code-block', className)}
        data-language={normalizedLanguage}
        data-wrap={wrapped}
        {...props}
      >
        <span className="agent-code-toolbar" contentEditable={false}>
          <span className="agent-code-language">{displayedLanguage}</span>
          <span className="agent-code-actions">
            <button
              aria-label={wrapped ? 'Disable line wrap' : 'Enable line wrap'}
              onClick={() => setWrapped((currentWrap) => !currentWrap)}
              type="button"
            >
              <WrapIcon />
            </button>
            <button aria-label={copied ? 'Copied' : 'Copy content'} onClick={() => void copyCode()} type="button">
              <CopyIcon />
            </button>
          </span>
        </span>
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    );
  }),
);

CodeBlock.displayName = 'CodeBlock';

export { CodeBlock };
