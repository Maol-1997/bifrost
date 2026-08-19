import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import type { AppShellContext } from '@app/components/chrome/app-shell';
import { Button } from '@app/components/ui/button';
import { ErrorState } from '@app/components/ui/error-state';
import { PageHead } from '@app/components/ui/page-head';
import { SectionCard } from '@app/components/ui/section-card';
import { SettingsLinkRow, SettingsLinkRowIcon, SettingsRow, SettingsRowAction, SettingsRowContent } from '@app/components/ui/settings-group';
import { initialsOf } from '@app/lib/initials';
import { getProviderCatalog } from '@app/api/bifrost';
import { connectedClientsQueryOptions, providersQueryOptions } from '@app/api/query-options';
import { APP_ROUTES } from '@features/utils/routes';

export default function AccountSecurity(): React.JSX.Element {
  const { user } = useOutletContext<AppShellContext>();
  const providersQuery = useQuery(providersQueryOptions);
  const clientsQuery = useQuery(connectedClientsQueryOptions);
  const providers = providersQuery.data?.data ?? getProviderCatalog();
  const clients = clientsQuery.data ?? [];
  const hasLoadError = providersQuery.isError || clientsQuery.isError;
  // No fallback to the catalog on failure: this screen summarizes what is
  // authorized, and a fixture shown here would read as a real answer.
  const connectedProviders = providers.filter((provider) => provider.status === 'connected');
  const totalTools = connectedProviders.reduce((count, provider) => count + provider.tools.length, 0);
  const enabledTools = connectedProviders.reduce((count, provider) => count + provider.tools.filter((tool) => tool.isEnabled).length, 0);
  const providerNames = connectedProviders.map((provider) => provider.name).join(', ');

  const summaryRows = [
    // "apps", not "tools": this row counts GitHub, Linear and Slack, and the row
    // below it counts tools for real now, so the two cannot share a word.
    { big: `${connectedProviders.length} ${connectedProviders.length === 1 ? 'app connected' : 'apps connected'}`, detail: providerNames || 'Nothing connected right now', to: APP_ROUTES.integrations },
    { big: `${enabledTools} of ${totalTools} tools enabled`, detail: 'What your agents are allowed to do', to: APP_ROUTES.integrations },
    { big: `${clients.length} active ${clients.length === 1 ? 'session' : 'sessions'}`, detail: clients.length > 0 ? clients.map((client) => client.name).join(', ') : 'No agents or browsers are using your account', to: APP_ROUTES.agents },
  ] as const;

  return (
    <section>
      <PageHead title="Account & security" />
      {user ? (
        <SectionCard className="mt-[22px]">
          <SettingsRow className="h-auto min-h-[65px] flex-wrap sm:flex-nowrap">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand/25 text-[13px] font-semibold text-brand-hover">{initialsOf(user.name)}</div>
            <SettingsRowContent className="min-w-[220px]"><div className="text-[13.5px] font-semibold">{user.name}</div><div className="mt-0.5 text-xs text-app-text-tertiary">{user.email} · signed in with Google</div></SettingsRowContent>
            <SettingsRowAction><form action="/auth/logout" method="post"><Button type="submit" variant="outline">Sign out</Button></form></SettingsRowAction>
          </SettingsRow>
        </SectionCard>
      ) : null}
      <h2 className="mt-6 text-[13.5px] font-semibold">Everything you've authorized</h2>
      <p className="mt-1 text-[12.5px] text-app-text-tertiary">One place to see it all — click through to change anything.</p>
      {hasLoadError ? <ErrorState title="We couldn't load this summary" body="Nothing has changed on your account — this page just failed to load it. It usually fixes itself on retry." onRetry={() => { void Promise.all([providersQuery.refetch(), clientsQuery.refetch()]); }} /> : (
        <SectionCard className="mt-3">
          {summaryRows.map((row) => <SettingsLinkRow key={row.big} asChild><Link to={row.to}><span className="min-w-0 flex-1"><strong className="text-[13px] font-semibold">{row.big}</strong><span className="ml-2 text-[12.5px] text-app-text-tertiary">{row.detail}</span></span><SettingsLinkRowIcon /></Link></SettingsLinkRow>)}
        </SectionCard>
      )}
    </section>
  );
}
