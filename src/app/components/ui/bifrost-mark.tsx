import type { SVGProps } from 'react';

/**
 * The Bifrost mark. Kept identical to `public/favicon.svg` so the tab icon and
 * the in-app logo cannot drift apart.
 *
 * Self-contained on purpose: it draws its own rounded plate and hairline
 * border, so callers only set a size — no wrapper tile, no background.
 */
export function BifrostMark(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 256 256" role="img" aria-label="Bifrost" {...props}>
      <rect width="256" height="256" rx="56" fill="#0F1012" />
      <rect x="5" y="5" width="246" height="246" rx="52" fill="none" stroke="#3E3F41" strokeWidth="2" />
      <g fill="none" stroke="#D0D6E0" strokeWidth="18" strokeLinecap="round">
        <path d="M103 61H78a17 17 0 0 0-17 17v25M153 61h25a17 17 0 0 1 17 17v25M195 153v25a17 17 0 0 1-17 17h-25M103 195H78a17 17 0 0 1-17-17v-25" />
        <circle cx="128" cy="128" r="36" />
      </g>
    </svg>
  );
}
