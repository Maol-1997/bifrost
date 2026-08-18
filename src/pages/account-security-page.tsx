import { useEffect, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import type { AppShellContext } from '@/components/app-shell';
import { initialsOf } from '@/lib/utils';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { APP_ROUTES } from '@/lib/routes';
import { getClientSessions, getProviderCatalog, getProviders, revokeEverything, type ClientSession, type Provider } from '@/api/bifrost';

export function AccountSecurityPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { user } = useOutletContext<AppShellContext>();
  const [providers, setProviders] = useState<readonly Provider[]>(getProviderCatalog());
  const [clients, setClients] = useState<readonly ClientSession[]>([]);
  const [isRevoked, setIsRevoked] = useState(false);
  useEffect(() => { void Promise.all([getProviders().catch(() => getProviderCatalog()), getClientSessions()]).then(([loadedProviders, loadedClients]) => { setProviders(loadedProviders); setClients(loadedClients); }); }, []);
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

  async function revokeAll(): Promise<void> {
    await revokeEverything();
    setProviders(getProviderCatalog().map((provider) => ({ ...provider, status: provider.id === 'notion' ? 'unavailable' : 'not-connected', tools: provider.tools.map((tool) => ({ ...tool, isEnabled: false })) })));
    setClients([]); setIsRevoked(true);
  }

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
      <SectionCard className="mt-3">
        {summaryRows.map((row) => <button type="button" key={row.big} onClick={() => { void navigate(row.to); }} className="flex min-h-11 w-full items-center gap-3 border-t border-white/6 px-3.5 py-3 text-left first:border-t-0 hover:bg-white/2.5"><span className="min-w-0 flex-1"><strong className="text-[13px] font-semibold">{row.big}</strong><span className="ml-2 text-[12.5px] text-app-text-tertiary">{row.detail}</span></span><span className="text-app-text-quaternary">→</span></button>)}
      </SectionCard>
      <div className="mt-6 rounded-[10px] border border-danger/22 p-4">
        <h2 className="text-[13.5px] font-semibold text-danger">Revoke everything</h2>
        <p className="mt-1 text-[12.5px] leading-5 text-app-text-tertiary text-pretty">Disconnects every integration and signs every agent and browser session out, in one go. Your agents keep running, but with access to nothing until you reconnect. Use it if you lose a laptop or just want a clean slate.</p>
        {isRevoked ? <div className="mt-3 text-[12.5px] text-success">Done. Nothing has access to your account anymore.</div> : (
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="outline" className="mt-3 border-danger/40 text-danger hover:bg-danger/10 hover:text-danger">Revoke everything…</Button></AlertDialogTrigger>
            <AlertDialogContent className="border-app-border-3 bg-app-bg-quaternary">
              <AlertDialogHeader><AlertDialogTitle>Revoke everything?</AlertDialogTitle><AlertDialogDescription>This disconnects {connectedProviders.length} {connectedProviders.length === 1 ? 'integration' : 'integrations'} and revokes {clients.length} active {clients.length === 1 ? 'session' : 'sessions'}. Your agents lose access immediately.</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => void revokeAll()} className="bg-danger text-app-bg-primary hover:bg-danger/90">Yes, revoke it all</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </section>
  );
}
