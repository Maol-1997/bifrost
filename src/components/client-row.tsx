import { Button } from '@/components/ui/button';
import { ClientIcon } from '@/components/client-icon';
import { StatusBadge } from '@/components/status';
import { relativeTime, shortDate } from '@/lib/time';
import type { ConnectedClient } from '@/api/bifrost';

export function ClientRow({ client, onRenew, onRevoke }: { client: ConnectedClient; onRenew: () => void; onRevoke: () => void }): React.JSX.Element {
  const metadata = [
    client.isCurrent ? 'this browser' : null,
    `first connected ${shortDate(client.firstConnectedAt)}`,
    // Worth saying out loud: it is the difference between a client you have to
    // come back and renew and one you can forget about.
    client.kind === 'agent' ? 'renews itself' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="flex flex-wrap items-center gap-3 border-t-[0.5px] border-app-border-pane p-3.5 first:border-t-0 sm:flex-nowrap">
      <ClientIcon logo={client.logo} monogram={client.monogram} />
      <div className="min-w-[220px] flex-1"><div className="text-[13.5px] font-semibold">{client.name}</div><div className="mt-0.5 text-xs text-app-text-tertiary">{metadata}</div></div>
      <div className="ml-11 text-right sm:ml-0"><StatusBadge status={client.health} /><div className="mt-0.5 text-[11.5px] text-app-text-quaternary">Last used {relativeTime(client.lastUsedAt)}</div></div>
      {client.kind === 'browser' && client.health === 'needs-renewal' ? <Button size="sm" className="bg-warning text-app-bg-primary hover:bg-warning/90" onClick={onRenew}>Renew</Button> : null}
      <Button size="sm" variant="outline" className="border-danger/30 text-danger hover:bg-danger/10 hover:text-danger" onClick={onRevoke}>{client.isCurrent ? 'Sign out' : 'Revoke'}</Button>
    </div>
  );
}
