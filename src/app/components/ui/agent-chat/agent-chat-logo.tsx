import { useId } from 'react';

import { cn } from '@app/lib/cn';

const bifrostOutlinePaths = [
  'M140 68H105C84.5655 68 68 84.5655 68 105V140C68 145.523 72.4772 150 78 150C83.5228 150 88 145.523 88 140V105C88 95.6112 95.6112 88 105 88H140C145.523 88 150 83.5228 150 78C150 72.4772 145.523 68 140 68Z',
  'M196 68H231C251.435 68 268 84.5655 268 105V140C268 145.523 263.523 150 258 150C252.477 150 248 145.523 248 140V105C248 95.6112 240.389 88 231 88H196C190.477 88 186 83.5228 186 78C186 72.4772 190.477 68 196 68Z',
  'M268 196V231C268 251.435 251.435 268 231 268H196C190.477 268 186 263.523 186 258C186 252.477 190.477 248 196 248H231C240.389 248 248 240.389 248 231V196C248 190.477 252.477 186 258 186C263.523 186 268 190.477 268 196Z',
  'M68 196V231C68 251.435 84.5655 268 105 268H140C145.523 268 150 263.523 150 258C150 252.477 145.523 248 140 248H105C95.6112 248 88 240.389 88 231V196C88 190.477 83.5228 186 78 186C72.4772 186 68 190.477 68 196Z',
  'M168 122C142.595 122 122 142.595 122 168C122 193.405 142.595 214 168 214C193.405 214 214 193.405 214 168C214 142.595 193.405 122 168 122ZM168 142C182.359 142 194 153.641 194 168C194 182.359 182.359 194 168 194C153.641 194 142 182.359 142 168C142 153.641 153.641 142 168 142Z',
] as const;

type AgentChatLogoProps = {
  className?: string;
};

function AgentChatLogo({ className }: AgentChatLogoProps) {
  const id = useId().replaceAll(':', '');
  const gradientId = `bifrost-agent-gradient-${id}`;
  const maskGradientId = `bifrost-agent-mask-gradient-${id}`;
  const maskId = `bifrost-agent-mask-${id}`;

  return (
    <svg
      aria-hidden="true"
      className={cn('size-84 shrink-0', className)}
      fill="transparent"
      height="336"
      viewBox="0 0 336 336"
      width="336"
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="325.0606"
          x2="10.9394"
          y1="108.3681"
          y2="227.6319"
        >
          <stop offset="0" stopColor="var(--linear-search-content-border)" />
          <stop offset="0.5" stopColor="var(--linear-search-content-border)" />
          <stop offset="1" stopColor="var(--linear-inline-placeholder)" />
        </linearGradient>
        <linearGradient id={maskGradientId} gradientUnits="userSpaceOnUse" x1="168" x2="168" y1="0" y2="336">
          <stop offset="0" stopColor="var(--color-white)" stopOpacity="0" />
          <stop offset="0.6" stopColor="var(--color-white)" />
        </linearGradient>
        <mask id={maskId}>
          <rect fill={`url(#${maskGradientId})`} height="336" width="336" />
        </mask>
      </defs>

      {bifrostOutlinePaths.map((path) => (
        <path
          key={path}
          d={path}
          fillRule="evenodd"
          stroke="var(--linear-border)"
          strokeWidth="0.5"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <g mask={`url(#${maskId})`}>
        {bifrostOutlinePaths.map((path) => (
          <path
            key={`gradient-${path}`}
            d={path}
            fillRule="evenodd"
            stroke={`url(#${gradientId})`}
            strokeWidth="0.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
    </svg>
  );
}

export { AgentChatLogo };
