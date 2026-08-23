import { Button } from '@app/components/ui/button';
import { SettingsRow } from '@app/components/ui/settings-group';
import { StatusBadge } from '@app/components/ui/status-badge';
import { shortDate } from '@app/lib/format/short-date';
import { relativeTime } from '@app/lib/format/time-ago';
import type { ConnectedClient } from '@app/api/bifrost';
import { ClientIcon } from './client-icon';

export function ClientRow({ actionsDisabled, client, onRenew, onRevoke }: { actionsDisabled: boolean; client: ConnectedClient; onRenew: () => void; onRevoke: () => void }): React.JSX.Element {
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
    <SettingsRow className="h-auto min-h-[65px] flex-wrap sm:flex-nowrap">
      <ClientIcon logo={client.logo} monogram={client.monogram} />
      <div className="min-w-[220px] flex-1"><div className="text-[13.5px] font-semibold">{client.name}</div><div className="mt-0.5 text-xs text-app-text-tertiary">{metadata}</div></div>
      <div className="ml-11 text-right sm:ml-0"><StatusBadge status={client.health} /><div className="mt-0.5 text-[11.5px] text-app-text-quaternary">Last used {relativeTime(client.lastUsedAt)}</div></div>
      {client.kind === 'browser' && client.isCurrent && client.health === 'needs-renewal' ? <Button disabled={actionsDisabled} size="compact" onClick={onRenew}>Renew</Button> : null}
      <Button disabled={actionsDisabled} size="compact" variant="destructive" onClick={onRevoke}>{client.isCurrent ? 'Sign out' : 'Revoke'}</Button>
    </SettingsRow>
  );
}
