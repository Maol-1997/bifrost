import { MoreHorizontal } from 'lucide-react';
import { generatePath, useNavigate } from 'react-router-dom';
import { Button } from '@app/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@app/components/ui/dropdown-menu';
import { ProviderIcon } from '@app/components/ui/provider-icon';
import { StatusBadge } from '@app/components/ui/status-badge';
import { cn } from '@app/lib/cn';
import type { Provider } from '@app/api/bifrost';
import { APP_ROUTES } from '@features/utils/routes';

export function ProviderCard({ provider, isConnecting, onConnect, onHide, onDisconnect }: { provider: Provider; isConnecting: boolean; onConnect: () => void; onHide: () => void; onDisconnect: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const isUnavailable = provider.status === 'unavailable';
  const isConnected = provider.status === 'connected';
  const needsReconnect = provider.status === 'needs-reconnect';
  const detailPath = generatePath(APP_ROUTES.integrationDetail, { providerId: provider.id });
  return (
    <div className={cn('flex min-h-[59px] items-center gap-3 border-t-[0.5px] border-app-border-pane px-3.5 py-3 first:border-t-0', isUnavailable && 'opacity-55', provider.isHidden && 'opacity-75')}>
      <button type="button" aria-label={`View ${provider.name} tools`} disabled={isUnavailable} onClick={() => { void navigate(detailPath); }} className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default">
        <ProviderIcon providerId={provider.id} monogram={provider.monogram} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2"><span className="text-[13.5px] font-semibold">{provider.name}</span>{provider.isHidden ? <span className="rounded-full border border-dashed border-warning/50 px-2 py-0.5 text-[10.5px] font-medium text-warning">Hidden by you</span> : null}</span>
          <span className="mt-0.5 block text-xs text-app-text-tertiary">{provider.description}</span>
          {isUnavailable ? <span className="mt-1 block text-[11.5px] text-app-text-quaternary">Your team hasn’t been granted access yet — ask #bifrost-help.</span> : null}
          {needsReconnect ? <span className="mt-1 block text-[11.5px] text-warning">Your authorization expired. Reconnecting takes 10 seconds.</span> : null}
        </span>
      </button>
      {/* Only for the states nothing else on the row explains. "Connect" already
          says not-connected, and a row whose only control is the overflow menu
          is one that needs nothing from you. Unavailable has no button at all,
          so without the badge it would just look like a dimmed row. */}
      {isUnavailable || needsReconnect ? <StatusBadge status={provider.status} className="hidden sm:flex" /> : null}
      {provider.status === 'not-connected' || needsReconnect ? <Button variant={needsReconnect ? 'default' : 'ghost'} disabled={isConnecting} onClick={onConnect} className={needsReconnect ? 'bg-warning text-app-bg-primary hover:bg-warning/90' : ''}>{isConnecting ? 'Connecting…' : needsReconnect ? 'Reconnect' : 'Connect'}</Button> : null}
      {isConnected ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7" aria-label={`${provider.name} actions`}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => { void navigate(detailPath); }}>View tools…</DropdownMenuItem>
            <DropdownMenuItem onSelect={onHide}>{provider.isHidden ? 'Show to agents' : 'Hide from agents'}</DropdownMenuItem>
            <DropdownMenuItem className="text-danger focus:bg-danger/10 focus:text-danger" onSelect={onDisconnect}>Disconnect</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
