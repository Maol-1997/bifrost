import { MoreHorizontal } from 'lucide-react';
import { generatePath, Link, useNavigate } from 'react-router-dom';
import { Button } from '@app/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@app/components/ui/dropdown-menu';
import { ProviderIcon } from '@app/components/ui/provider-icon';
import { SettingsLinkRow, SettingsRow, SettingsRowContent, SettingsRowDescription, SettingsRowTitle } from '@app/components/ui/settings-group';
import { StatusBadge } from '@app/components/ui/status-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@app/components/ui/tooltip';
import { cn } from '@app/lib/cn';
import type { Provider } from '@app/api/bifrost';
import { APP_ROUTES } from '@features/utils/routes';

type ProviderCardProps = {
  provider: Provider;
  isConnecting: boolean;
  onConnect: () => void;
  onHide: () => void;
  onDisconnect: () => void;
};

function ProviderSummary({ provider }: { provider: Provider }): React.JSX.Element {
  const isUnavailable = provider.status === 'unavailable';
  const needsReconnect = provider.status === 'needs-reconnect';

  return (
    <>
      <ProviderIcon providerId={provider.id} monogram={provider.monogram} />
      <SettingsRowContent>
        <SettingsRowTitle className="flex items-center gap-2 text-[13.5px] font-semibold">
          <span className="truncate">{provider.name}</span>
          {provider.isHidden ? <span className="shrink-0 rounded-full border border-dashed border-warning/50 px-2 py-0.5 text-[10.5px] font-medium text-warning">Hidden by you</span> : null}
        </SettingsRowTitle>
        <SettingsRowDescription className="text-app-text-tertiary">{provider.description}</SettingsRowDescription>
        {isUnavailable ? <SettingsRowDescription className="mt-1 text-[11.5px] text-app-text-quaternary">Your team hasn’t been granted access yet — ask #bifrost-help.</SettingsRowDescription> : null}
        {needsReconnect ? <SettingsRowDescription className="mt-1 text-[11.5px] text-warning">Your authorization expired. Reconnecting takes 10 seconds.</SettingsRowDescription> : null}
      </SettingsRowContent>
    </>
  );
}

function ConnectProviderButton({ providerName, isConnecting, onConnect }: { providerName: string; isConnecting: boolean; onConnect: () => void }): React.JSX.Element {
  const tooltip = `Connect your ${providerName} account`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="secondary" aria-label={tooltip} disabled={isConnecting} onClick={onConnect}>
          Connect
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function ProviderCard({ provider, isConnecting, onConnect, onHide, onDisconnect }: ProviderCardProps): React.JSX.Element {
  const navigate = useNavigate();
  const isUnavailable = provider.status === 'unavailable';
  const isConnected = provider.status === 'connected';
  const needsReconnect = provider.status === 'needs-reconnect';
  const detailPath = generatePath(APP_ROUTES.integrationDetail, { providerId: provider.id });
  const hasHoverBackground = isConnected || needsReconnect;

  if (isUnavailable) {
    return (
      <SettingsRow className="h-auto min-h-[65px] opacity-55">
        <ProviderSummary provider={provider} />
        <StatusBadge status={provider.status} className="hidden sm:flex" />
      </SettingsRow>
    );
  }

  return (
    <div data-hoverable={hasHoverBackground || undefined} className={cn("group relative after:absolute after:bottom-0 after:left-4 after:right-4 after:z-[1] after:h-[0.5px] after:bg-linear-settings-divider after:content-[''] last:after:hidden", 'data-hoverable:hover:after:bg-transparent has-[+[data-hoverable]:hover]:after:bg-transparent', provider.isHidden && 'opacity-75')}>
      {isConnected || needsReconnect ? (
        <SettingsLinkRow asChild className={cn('h-auto min-h-[65px] rounded-none first:rounded-none last:rounded-none after:hidden group-first:rounded-t-[10px] group-last:rounded-b-[10px] group-hover:bg-linear-settings-row-hover', isConnected ? 'pr-14' : 'pr-28')}>
          <Link to={detailPath} aria-label={`View ${provider.name} tools`}>
            <ProviderSummary provider={provider} />
          </Link>
        </SettingsLinkRow>
      ) : (
        <SettingsRow className="h-auto min-h-[65px] pr-24 after:hidden">
          <ProviderSummary provider={provider} />
        </SettingsRow>
      )}
      <div className="absolute right-4 top-1/2 z-[2] flex -translate-y-1/2 items-center gap-2">
        {provider.status === 'not-connected' ? <ConnectProviderButton providerName={provider.name} isConnecting={isConnecting} onConnect={onConnect} /> : null}
        {needsReconnect ? <Button disabled={isConnecting} onClick={onConnect} className="bg-warning text-app-bg-primary hover:bg-warning/90">Reconnect</Button> : null}
        {isConnected ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7" aria-label={`${provider.name} actions`}><MoreHorizontal /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => { void navigate(detailPath); }}>View tools…</DropdownMenuItem>
              <DropdownMenuItem onSelect={onHide}>{provider.isHidden ? 'Show to agents' : 'Hide from agents'}</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={onDisconnect}>Disconnect</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
