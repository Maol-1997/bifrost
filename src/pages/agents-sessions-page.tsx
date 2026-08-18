import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ClientRow } from '@/components/client-row';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { Button } from '@/components/ui/button';
import { APP_ROUTES } from '@/lib/routes';
import { getClientSessions, renewClient, revokeClient, type ClientSession } from '@/api/bifrost';

export function AgentsSessionsPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const [clients, setClients] = useState<readonly ClientSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoadError, setHasLoadError] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    setIsLoading(true); setHasLoadError(false);
    try {
      setClients(searchParams.get('state') === 'empty' ? [] : await getClientSessions());
    } catch {
      setHasLoadError(true);
    } finally { setIsLoading(false); }
  }, [searchParams]);
  useEffect(() => { void load(); }, [load]);
  async function renew(client: ClientSession): Promise<void> { await renewClient(client); await load(); }
  async function revoke(client: ClientSession): Promise<void> { await revokeClient(client); await load(); }
  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-[220px] flex-1"><PageHeader title="Agents & sessions" subtitle="The agent apps and browser sessions using your Bifrost account right now. Come here to add an agent, troubleshoot access or revoke anything you don't recognize." /></div>
        <Button asChild className="shrink-0"><Link to={APP_ROUTES.addAgent}>Add an agent</Link></Button>
      </div>
      {isLoading ? <LoadingState label="Loading agents and sessions…" /> : null}
      {!isLoading && hasLoadError ? <ErrorState title="We couldn't load your agents and sessions" body="Nothing has changed on your account — this page just failed to load the list. It usually fixes itself on retry." onRetry={() => void load()} /> : null}
      {!isLoading && !hasLoadError && clients.length === 0 ? <EmptyState title="Nothing is using your account yet" body="Add an agent to start using Bifrost. Every program and browser session with access will appear here, where you can revoke it at any time." /> : null}
      {!isLoading && !hasLoadError && clients.length > 0 ? <><SectionCard className="mt-[22px]">{clients.map((client) => <ClientRow key={client.id} client={client} onRenew={() => void renew(client)} onRevoke={() => void revoke(client)} />)}</SectionCard><p className="mt-3.5 text-xs leading-[1.55] text-app-text-quaternary text-pretty">Don't recognize one? Revoke it — that program loses access immediately, and nothing else changes. Connected programs keep themselves signed in, so they never need renewing; <strong className="font-medium text-app-text-tertiary">needs renewal</strong> only ever means a browser you'll have to log into again.</p></> : null}
    </section>
  );
}
