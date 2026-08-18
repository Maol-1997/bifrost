import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { Button } from '@app/components/ui/button';
import { EmptyState } from '@app/components/ui/empty-state';
import { SectionCard } from '@app/components/ui/section-card';
import { getProviderCatalog } from '@app/api/bifrost';
import { APP_ROUTES, integrationDetailPath } from '@features/utils/routes';

type ResultVariant = 'success' | 'cancelled' | 'error';

function parseVariant(value: string | null): ResultVariant | undefined {
  return value === 'success' || value === 'cancelled' || value === 'error' ? value : undefined;
}

export function ConnectionResultScreen(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const provider = getProviderCatalog().find((entry) => entry.id === searchParams.get('provider'));
  const variant = parseVariant(searchParams.get('result'));
  // Both come from the URL. A page that defaulted to "connected" for a
  // malformed one would claim access was granted when nothing happened.
  if (!provider || !variant) return <Navigate to={APP_ROUTES.integrations} replace />;
  const content = variant === 'success'
    ? { icon: '✓', title: `${provider.name} is connected`, body: `Your agents can use ${provider.name} as you from now on. Here’s what that means — and you can turn any of it off:`, primary: 'Add an agent', primaryTo: APP_ROUTES.addAgent }
    : variant === 'cancelled'
      ? { icon: '—', title: 'No problem — nothing was connected', body: `You said no on ${provider.name}’s page, so Bifrost got no access at all. If you change your mind, you can connect it any time from Integrations.`, primary: 'Back to integrations', primaryTo: APP_ROUTES.integrations }
      : { icon: '!', title: 'That didn’t work — and it’s not your fault', body: `Something failed between ${provider.name} and Bifrost on the way back. Nothing was connected. Trying again usually fixes it.`, primary: 'Try again', primaryTo: `/oauth/${provider.id}/start` };
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-[440px] text-center">
        <div className={`mx-auto flex size-12 items-center justify-center rounded-full text-xl ${variant === 'success' ? 'bg-success/15 text-success' : variant === 'error' ? 'bg-danger/15 text-danger' : 'bg-white/7 text-app-text-tertiary'}`}>{content.icon}</div>
        {variant === 'cancelled' ? <EmptyState tone="result" title={content.title} body={content.body} /> : <><h1 className="mt-[18px] text-lg font-semibold tracking-[-0.01em]">{content.title}</h1><p className="mt-2 text-[13px] leading-[1.6] text-app-text-tertiary text-pretty">{content.body}</p></>}
        {variant === 'success' ? <SectionCard className="mt-[18px] py-1.5 text-left">{provider.successCapabilities.map((capability) => <div key={capability} className="flex items-baseline gap-2 px-3.5 py-1.5 text-[12.5px] leading-5 text-app-text-secondary"><span className="text-success">✓</span>{capability}</div>)}</SectionCard> : null}
        <div className="mt-[22px] flex justify-center gap-2">
          <Button asChild>{variant === 'error' ? <a href={content.primaryTo}>{content.primary}</a> : <Link to={content.primaryTo}>{content.primary}</Link>}</Button>
          {variant !== 'cancelled' ? <Button asChild variant="outline"><Link to={variant === 'success' ? integrationDetailPath(provider.id) : APP_ROUTES.integrations}>{variant === 'success' ? 'See its tools' : 'Back to integrations'}</Link></Button> : null}
        </div>
        {variant === 'error' ? <p className="mt-4 text-xs leading-5 text-app-text-quaternary">If it keeps failing, tell #bifrost-help what time it happened — that’s all they need.</p> : null}
      </div>
    </main>
  );
}
