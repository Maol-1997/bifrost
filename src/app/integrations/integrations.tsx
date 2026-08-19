import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { EmptyState } from '@app/components/ui/empty-state';
import { ErrorState } from '@app/components/ui/error-state';
import { LoadingState } from '@app/components/ui/loading-state';
import { PageHead } from '@app/components/ui/page-head';
import { SectionCard } from '@app/components/ui/section-card';
import { TooltipProvider } from '@app/components/ui/tooltip';
import { startProviderConnection, disconnectProvider, getProviderCatalog, isConnectableProvider, setProviderHidden, type Provider, type ProviderId } from '@app/api/bifrost';
import { providersQueryOptions } from '@app/api/query-options';
import { ProviderCard } from './components/provider-card';

const CONNECTION_SETTLE_MS = 900;
const emptyDemoProviders = getProviderCatalog().map((provider) => ({
  ...provider,
  status: 'not-connected' as const,
}));

function waitForConnectionRedirect(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, CONNECTION_SETTLE_MS));
}

export default function Integrations(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedState = searchParams.get('state');
  const usesLiveData = requestedState !== 'loading' && requestedState !== 'empty' && requestedState !== 'error';
  const queryClient = useQueryClient();
  const providersQuery = useQuery({ ...providersQueryOptions, enabled: usesLiveData });
  const connectMutation = useMutation({
    mutationFn: async (providerId: ProviderId) => {
      if (!isConnectableProvider(providerId)) return;
      await startProviderConnection(providerId);
      await waitForConnectionRedirect();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: providersQueryOptions.queryKey }),
  });
  const hideMutation = useMutation({
    mutationFn: (provider: Provider) => setProviderHidden(provider.id, !provider.isHidden),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: providersQueryOptions.queryKey }),
  });
  const disconnectMutation = useMutation({
    mutationFn: disconnectProvider,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: providersQueryOptions.queryKey }),
  });
  const providers = requestedState === 'empty' ? emptyDemoProviders : providersQuery.data?.data ?? [];
  const isLoading = requestedState === 'loading' || (usesLiveData && providersQuery.isPending);
  const hasLoadError = requestedState === 'error' || (usesLiveData && providersQuery.isError);
  const connectingId = connectMutation.isPending ? connectMutation.variables : null;
  const isFirstRun = providers.every((provider) => provider.status === 'not-connected');

  function retry(): void {
    if (requestedState === 'error') {
      setSearchParams((current) => {
        current.delete('state');
        return current;
      }, { replace: true });
      return;
    }
    void providersQuery.refetch();
  }

  return (
    <section>
      <PageHead title="Integrations" subtitle="The apps and tools your agents can use as you. Connect an app once here, and every agent you use picks it up automatically." />
      {isLoading ? <LoadingState label="Loading your integrations…" /> : null}
      {hasLoadError ? <ErrorState title="We couldn't load your integrations" body="Your integrations are fine — this page just failed to load them. It usually fixes itself on retry." onRetry={retry} /> : null}
      {!isLoading && !hasLoadError ? (
        <>
          {isFirstRun ? <EmptyState tone="accent" title="Let's connect your first app" body="Pick something you already use. You'll approve it on that app's own site — Bifrost never sees your password — and from then on your agents can use it as you. You can see, limit and undo everything from this page." /> : null}
          <TooltipProvider>
            <SectionCard className="mt-[22px] overflow-hidden">
              {providers.map((provider) => <ProviderCard key={provider.id} provider={provider} isConnecting={connectingId === provider.id} onConnect={() => { connectMutation.mutate(provider.id); }} onHide={() => { hideMutation.mutate(provider); }} onDisconnect={() => { disconnectMutation.mutate(provider.id); }} />)}
            </SectionCard>
          </TooltipProvider>
          <p className="mt-3.5 text-xs leading-[1.55] text-app-text-quaternary text-pretty">Connecting an app never gives Bifrost your password — you approve it on the app's own site, and you can disconnect any time. <strong className="font-medium text-app-text-tertiary">Hidden</strong> means it stays connected but your agents can't use it.</p>
        </>
      ) : null}
    </section>
  );
}
