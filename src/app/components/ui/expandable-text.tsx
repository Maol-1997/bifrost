import { useId, useState } from 'react';

import { cn } from '@app/lib/cn';

const PREVIEW_CHARACTERS = 160;

export function ExpandableText({ label, text }: { label: string; text: string }): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const textId = useId();
  const canExpand = text.length > PREVIEW_CHARACTERS;

  return (
    <div>
      <p id={textId} className={cn('mt-1 text-[12.5px] leading-5 text-app-text-tertiary', canExpand && !isExpanded && 'line-clamp-3')}>{text}</p>
      {canExpand ? (
        <button
          type="button"
          aria-controls={textId}
          aria-expanded={isExpanded}
          className="-my-1 inline-flex min-h-11 items-center text-[11.5px] font-medium text-app-text-secondary hover:text-app-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          onClick={() => { setIsExpanded((current) => !current); }}
        >
          {isExpanded ? 'View less' : 'View more'} <span className="sr-only">about {label}</span>
        </button>
      ) : null}
    </div>
  );
}
