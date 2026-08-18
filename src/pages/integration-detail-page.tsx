import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ProviderIcon } from '@/components/provider-icon';
import { SectionCard } from '@/components/section-card';
import { StatusBadge } from '@/components/status';
import { ToolRow } from '@/components/tool-row';
import { APP_ROUTES } from '@/lib/routes';
import { shortDate } from '@/lib/time';
import { connectProvider, disconnectProvider, getProviderCatalog, getProviders, isConnectableProvider, setToolEnabled, type Provider, type ProviderId } from '@/api/bifrost';

function isProviderId(value: string | undefined): value is ProviderId {
  return value === 'github' || value === 'linear' || value === 'slack' || value === 'notion';
}

export function IntegrationDetailPage(): React.JSX.Element {
  const { providerId: routeProviderId } = useParams();
  const providerId: ProviderId = isProviderId(routeProviderId) ? routeProviderId : 'github';
  const [provider, setProvider] = useState<Provider>(() => getProviderCatalog().find((entry) => entry.id === providerId) ?? getProviderCatalog()[0]!);
  const [toolError, setToolError] = useState<string | null>(null);

  useEffect(() => { void getProviders().then((providers) => { const loaded = providers.find((entry) => entry.id === providerId); if (loaded) setProvider(loaded); }).catch(() => undefined); }, [providerId]);

  // Falls back to the description rather than an empty line: before you connect
  // there is no account to name, and the subtitle slot still has to say something.
  const accountLine = provider.connectedAt
    ? `Connected ${shortDate(provider.connectedAt)}${provider.accountLabel ? ` · as ${provider.accountLabel}` : ''}`
    : provider.description;
  const isConnected = provider.status === 'connected';
  const canDisconnect = isConnected || provider.status === 'needs-reconnect';
  const enabledCount = provider.tools.filter((tool) => tool.isEnabled).length;
  const readTools = provider.tools.filter((tool) => tool.kind === 'read');
  const writeTools = provider.tools.filter((tool) => tool.kind === 'write');

  function setToolState(toolName: string, isEnabled: boolean): void {
    setProvider((current) => ({ ...current, tools: current.tools.map((tool) => tool.name === toolName ? { ...tool, isEnabled } : tool) }));
  }

  // Optimistic, with the switch put back if the server did not take it: a
  // switch left on that the server never saved would claim a permission the
  // agent does not have.
  async function toggleTool(toolName: string, isEnabled: boolean): Promise<void> {
    setToolError(null);
    setToolState(toolName, isEnabled);
    try {
      await setToolEnabled(toolName, isEnabled);
    } catch {
      setToolState(toolName, !isEnabled);
      setToolError(`That change to ${toolName} was not saved. Try again.`);
    }
  }

  async function disconnect(): Promise<void> {
    await disconnectProvider(provider.id);
    setProvider((current) => ({ ...current, status: 'not-connected', tools: current.tools.map((tool) => ({ ...tool, isEnabled: false })) }));
  }

  // No date in the expiry copy: we know the grant lapsed, not the hour it did,
  // and a made-up date is worse than none.
  const banner = provider.status === 'needs-reconnect'
    ? `Your authorization expired. Reconnect to keep using ${provider.name} — it takes 10 seconds and asks for the same permissions as before.`
    : provider.status === 'unavailable'
      ? `${provider.name} isn’t available to you yet — your team hasn’t been granted access. Ask #bifrost-help if you need it.`
      : provider.isHidden
        ? `${provider.name} is connected but hidden — your agents can’t use it until you show it again from Integrations.`
        : null;

  return (
    <section>
      <Link to={APP_ROUTES.integrations} className="mb-[18px] inline-flex min-h-11 items-center gap-1.5 text-[12.5px] text-app-text-tertiary hover:text-app-text-primary">← Integrations</Link>
      <div className="flex flex-wrap items-center gap-3">
        <ProviderIcon providerId={provider.id} monogram={provider.monogram} size="lg" />
        <div className="min-w-[220px] flex-1"><div className="flex items-center gap-2.5"><h1 className="text-lg font-semibold tracking-[-0.01em]">{provider.name}</h1><StatusBadge status={provider.status} /></div><div className="mt-0.5 text-[12.5px] text-app-text-tertiary">{accountLine}</div></div>
        {provider.status === 'not-connected' || provider.status === 'needs-reconnect' ? <Button variant={provider.status === 'needs-reconnect' ? 'default' : 'ghost'} onClick={() => { if (isConnectableProvider(provider.id)) void connectProvider(provider.id); }} className={provider.status === 'needs-reconnect' ? 'bg-warning text-app-bg-primary hover:bg-warning/90' : ''}>{provider.status === 'needs-reconnect' ? 'Reconnect' : `Connect ${provider.name}`}</Button> : null}
      </div>
      {banner ? <div className={`mt-[18px] rounded-[9px] border px-3.5 py-3 text-[12.5px] leading-5 ${provider.status === 'unavailable' ? 'border-white/10 bg-white/3 text-app-text-tertiary' : 'border-warning/35 bg-warning/7 text-app-text-secondary'}`}>{banner}</div> : null}

      <h2 className="mt-7 text-[13.5px] font-semibold">{canDisconnect ? 'What you allowed' : 'What you’ll be asked to approve'}</h2>
      <SectionCard className="mt-2.5 py-1.5">
        {provider.permissions.map((permission) => <div key={permission} className="flex items-baseline gap-2 px-3.5 py-1.5 text-[12.5px] leading-5 text-app-text-secondary"><span className="text-success">✓</span>{permission}</div>)}
        <div className="flex items-baseline gap-2 px-3.5 py-1.5 text-[12.5px] leading-5 text-app-text-tertiary"><span className="text-app-text-quaternary">✕</span>{provider.neverPermission}</div>
      </SectionCard>

      <div className="mt-7 flex items-baseline justify-between"><h2 className="text-[13.5px] font-semibold">Tools</h2><div className="text-xs text-app-text-quaternary">{isConnected ? `${enabledCount} of ${provider.tools.length} enabled` : `${provider.tools.length} tools`}</div></div>
      <p className="mt-1.5 text-[12.5px] leading-5 text-app-text-tertiary text-pretty">{isConnected ? `Turn off anything you don’t want your agents to do. This only affects your agents — nothing changes on ${provider.name}.` : `This is everything ${provider.name} offers. Connect first, then you can turn tools on and off one by one.`}</p>
      <SectionCard className="mt-3 overflow-hidden">
        <div className="bg-white/2.5 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[.07em] text-app-text-quaternary">Read — looks things up, changes nothing</div>
        {readTools.map((tool) => <ToolRow key={tool.name} tool={tool} isAvailable={isConnected} onToggle={(isEnabled) => void toggleTool(tool.name, isEnabled)} />)}
        <div className="border-t border-white/5 bg-warning/5 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[.07em] text-warning">Write — acts in your name, and starts off</div>
        {writeTools.map((tool) => <ToolRow key={tool.name} tool={tool} isAvailable={isConnected} onToggle={(isEnabled) => void toggleTool(tool.name, isEnabled)} />)}
      </SectionCard>
      {toolError ? <p role="alert" className="mt-2 text-[12.5px] leading-5 text-danger">{toolError}</p> : null}
      {canDisconnect ? <div className="mt-6 flex flex-col items-start justify-between gap-3 rounded-[10px] border border-app-border-2 p-3.5 sm:flex-row sm:items-center"><div className="text-[12.5px] leading-5 text-app-text-tertiary">Disconnecting cuts your agents' access immediately. Nothing gets deleted on {provider.name}.</div><Button variant="outline" className="shrink-0 border-danger/35 text-danger hover:bg-danger/10 hover:text-danger" onClick={() => void disconnect()}>Disconnect {provider.name}</Button></div> : null}
    </section>
  );
}
