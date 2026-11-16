import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '@app/components/ui/button';
import { EmptyState } from '@app/components/ui/empty-state';
import { ErrorState } from '@app/components/ui/error-state';
import { LoadingState } from '@app/components/ui/loading-state';
import { PageHead } from '@app/components/ui/page-head';
import { SectionCard } from '@app/components/ui/section-card';
import { renewClient, revokeClient } from '@app/api/bifrost';
import { connectedClientsQueryOptions } from '@app/api/query-options';
import { APP_ROUTES } from '@features/utils/routes';
import { ClientRow } from './components/client-row';

export default function Agents(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const isEmptyDemo = searchParams.get('state') === 'empty';
  const queryClient = useQueryClient();
  const clientsQuery = useQuery({ ...connectedClientsQueryOptions, enabled: !isEmptyDemo });
  const renewMutation = useMutation({
    mutationFn: renewClient,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectedClientsQueryOptions.queryKey }),
  });
  const revokeMutation = useMutation({
    mutationFn: revokeClient,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectedClientsQueryOptions.queryKey }),
  });
  const clients = isEmptyDemo ? [] : (clientsQuery.data ?? []);
  const isLoading = !isEmptyDemo && clientsQuery.isPending;
  const hasLoadError = !isEmptyDemo && clientsQuery.isError;
  const clientActionPending = renewMutation.isPending || revokeMutation.isPending;
  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-[220px] flex-1">
          <PageHead
            title="Sessions"
            subtitle="The agent apps and browser sessions using your Bifrost account right now. Come here to add an agent, troubleshoot access or revoke anything you don't recognize."
          />
        </div>
        <Button asChild className="shrink-0">
          <Link to={APP_ROUTES.addAgent}>Add an agent</Link>
        </Button>
      </div>
      {isLoading ? <LoadingState label="Loading agents and sessions…" /> : null}
      {!isLoading && hasLoadError ? (
        <ErrorState
          title="We couldn't load your agents and sessions"
          body="Nothing has changed on your account — this page just failed to load the list. It usually fixes itself on retry."
          onRetry={() => {
            void clientsQuery.refetch();
          }}
        />
      ) : null}
      {!isLoading && !hasLoadError && clients.length === 0 ? (
        <EmptyState
          title="Nothing is using your account yet"
          body="Add an agent to start using Bifrost. Every program and browser session with access will appear here, where you can revoke it at any time."
        />
      ) : null}
      {!isLoading && !hasLoadError && clients.length > 0 ? (
        <>
          <SectionCard className="mt-[22px]">
            {clients.map((client) => (
              <ClientRow
                actionsDisabled={clientActionPending}
                key={client.id}
                client={client}
                onRenew={() => {
                  renewMutation.mutate(client);
                }}
                onRevoke={() => {
                  revokeMutation.mutate(client);
                }}
              />
            ))}
          </SectionCard>
          <p className="mt-3.5 text-xs leading-copy text-app-text-quaternary text-pretty">
            Don't recognize one? Revoke it — that program loses access immediately, and nothing else changes. Connected
            programs keep themselves signed in. A browser session can only renew itself: if another browser needs
            renewal, open Bifrost there and use Renew. The Renew button appears only for this browser.
          </p>
        </>
      ) : null}
    </section>
  );
}
