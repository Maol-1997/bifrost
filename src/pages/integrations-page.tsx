import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/page-header';
import { ProviderCard } from '@/components/provider-card';
import { SectionCard } from '@/components/section-card';
import { startProviderConnection, disconnectProvider, getProviderCatalog, getProviders, isConnectableProvider, setProviderHidden, type Provider, type ProviderId } from '@/api/bifrost';

export function IntegrationsPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const requestedState = searchParams.get('state');
  const [providers, setProviders] = useState<readonly Provider[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<ProviderId | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setIsLoading(true); setError(null);
    if (requestedState === 'loading') return;
    try {
      const loaded = requestedState === 'empty'
        ? getProviderCatalog().map((provider) => ({ ...provider, status: provider.id === 'notion' ? 'unavailable' as const : 'not-connected' as const }))
        : await getProviders();
      setProviders(loaded);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unknown error');
    } finally { setIsLoading(false); }
  }, [requestedState]);

  useEffect(() => { if (requestedState === 'error') { setIsLoading(false); setError('Demo error'); } else void load(); }, [load, requestedState]);

  async function connect(providerId: ProviderId): Promise<void> {
    if (!isConnectableProvider(providerId)) return;
    setConnectingId(providerId);
    await startProviderConnection(providerId);
    window.setTimeout(() => { setConnectingId(null); void load(); }, 900);
  }

  async function hide(provider: Provider): Promise<void> { await setProviderHidden(provider.id, !provider.isHidden); await load(); }
  async function disconnect(providerId: ProviderId): Promise<void> { await disconnectProvider(providerId); await load(); }
  const isFirstRun = providers.filter((provider) => provider.id !== 'notion').every((provider) => provider.status === 'not-connected');

  return (
    <section>
      <PageHeader title="Integrations" subtitle="The apps and tools your agents can use as you. Connect an app once here, and every agent you use picks it up automatically." />
      {isLoading ? <LoadingState label="Loading your integrations…" /> : null}
      {error ? <ErrorState title="We couldn't load your integrations" body="Your integrations are fine — this page just failed to load them. It usually fixes itself on retry." onRetry={() => void load()} /> : null}
      {!isLoading && !error ? (
        <>
          {isFirstRun ? <EmptyState tone="accent" title="Let's connect your first app" body="Pick something you already use. You'll approve it on that app's own site — Bifrost never sees your password — and from then on your agents can use it as you. You can see, limit and undo everything from this page." /> : null}
          <SectionCard className="mt-[22px] overflow-visible">
            {providers.map((provider) => <ProviderCard key={provider.id} provider={provider} isConnecting={connectingId === provider.id} onConnect={() => void connect(provider.id)} onHide={() => void hide(provider)} onDisconnect={() => void disconnect(provider.id)} />)}
          </SectionCard>
          <p className="mt-3.5 text-xs leading-[1.55] text-app-text-quaternary text-pretty">Connecting an app never gives Bifrost your password — you approve it on the app's own site, and you can disconnect any time. <strong className="font-medium text-app-text-tertiary">Hidden</strong> means it stays connected but your agents can't use it.</p>
        </>
      ) : null}
    </section>
  );
}
