import type { ComponentType, SVGProps } from 'react';

import { cn } from '@/lib/utils';
import type { ProviderId } from '@/api/bifrost';
import { GithubDark } from '@/components/ui/svgs/githubDark';
import { Linear } from '@/components/ui/svgs/linear';
import { Notion } from '@/components/ui/svgs/notion';
import { Slack } from '@/components/ui/svgs/slack';

// GitHub and Notion ship monochrome marks, so we take the variants whose fill
// is white — anything else disappears against our dark tiles. Linear's mark is
// drawn with `currentColor`, so the `text-logo` below is what colours it;
// Slack keeps its own colours because its mark is only legible in full colour.
// Partial on purpose: the provider list grows server-side, and a provider with
// no logo yet must fall back to its monogram rather than render an empty tile.
const providerLogos: Partial<Record<ProviderId, ComponentType<SVGProps<SVGSVGElement>>>> = {
  github: GithubDark,
  linear: Linear,
  slack: Slack,
  notion: Notion,
};

const tileSizes = {
  sm: 'size-7 rounded-[7px] text-xs',
  md: 'size-8 rounded-lg text-sm',
  lg: 'size-10 rounded-[10px] text-[17px]',
} as const;

const logoSizes = { sm: 'size-4', md: 'size-[18px]', lg: 'size-[22px]' } as const;

export function ProviderIcon({
  providerId,
  monogram,
  size = 'md',
}: {
  providerId: ProviderId;
  monogram: string;
  size?: keyof typeof tileSizes;
}): React.JSX.Element {
  const Logo = providerLogos[providerId];
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center border-[0.5px] border-plate-border bg-white/6 font-semibold text-app-text-secondary',
        tileSizes[size],
      )}
    >
      {Logo ? <Logo aria-hidden className={cn('text-logo', logoSizes[size])} /> : monogram}
    </div>
  );
}
