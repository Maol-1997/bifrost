import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import type { AppShellContext } from '@/components/app-shell';
import { initialsOf } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { ErrorState } from '@/components/states';
import { APP_ROUTES } from '@/lib/routes';
import { getConnectedClients, getProviderCatalog, getProviders, type ConnectedClient, type Provider } from '@/api/bifrost';

export function AccountSecurityPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { user } = useOutletContext<AppShellContext>();
  const [providers, setProviders] = useState<readonly Provider[]>(getProviderCatalog());
  const [clients, setClients] = useState<readonly ConnectedClient[]>([]);
  const [hasLoadError, setHasLoadError] = useState(false);
  // No fallback to the catalog on failure: this screen summarizes what is
  // authorized, and a fixture shown here would read as a real answer.
  const load = useCallback(async (): Promise<void> => {
    setHasLoadError(false);
    try {
      const [loadedProviders, loadedClients] = await Promise.all([getProviders(), getConnectedClients()]);
      setProviders(loadedProviders); setClients(loadedClients);
    } catch {
      setHasLoadError(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
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
      <PageHeader title="Account & security" />
      {user ? (
        <SectionCard className="mt-[22px] flex flex-wrap items-center gap-3 p-4 sm:flex-nowrap">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand/25 text-[13px] font-semibold text-brand-hover">{initialsOf(user.name)}</div>
          <div className="min-w-[220px] flex-1"><div className="text-[13.5px] font-semibold">{user.name}</div><div className="mt-0.5 text-xs text-app-text-tertiary">{user.email} · signed in with Google</div></div>
          <form action="/auth/logout" method="post"><Button type="submit" variant="outline">Sign out</Button></form>
        </SectionCard>
      ) : null}
      <h2 className="mt-6 text-[13.5px] font-semibold">Everything you've authorized</h2>
      <p className="mt-1 text-[12.5px] text-app-text-tertiary">One place to see it all — click through to change anything.</p>
      {hasLoadError ? <ErrorState title="We couldn't load this summary" body="Nothing has changed on your account — this page just failed to load it. It usually fixes itself on retry." onRetry={() => void load()} /> : (
        <SectionCard className="mt-3">
          {summaryRows.map((row) => <button type="button" key={row.big} onClick={() => { void navigate(row.to); }} className="flex min-h-11 w-full items-center gap-3 border-t border-white/6 px-3.5 py-3 text-left first:border-t-0 hover:bg-white/2.5"><span className="min-w-0 flex-1"><strong className="text-[13px] font-semibold">{row.big}</strong><span className="ml-2 text-[12.5px] text-app-text-tertiary">{row.detail}</span></span><span className="text-app-text-quaternary">→</span></button>)}
        </SectionCard>
      )}
    </section>
  );
}
