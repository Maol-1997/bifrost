import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { getProviderCatalog, isConnectableProvider, refreshAdminProviderTools, setToolPolicies, type AdminTool, type AdminToolProvider, type CachedResult, type ConnectableProviderId, type ToolMutability, type ToolPolicyBatchChange, type ToolPolicyChange, type ToolPolicyState } from '@app/api/bifrost';
import { adminToolsQueryOptions } from '@app/api/query-options';
import { Button } from '@app/components/ui/button';
import { Checkbox, type CheckboxState } from '@app/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@app/components/ui/dropdown-menu';
import { ErrorState } from '@app/components/ui/error-state';
import { SearchInput } from '@app/components/ui/input';
import { LoadingState } from '@app/components/ui/loading-state';
import { PageHead } from '@app/components/ui/page-head';
import { SectionCard } from '@app/components/ui/section-card';
import { SettingsRow } from '@app/components/ui/settings-group';
import { Surface } from '@app/components/ui/surface';
import { cn } from '@app/lib/cn';
import { APP_ROUTES } from '@features/utils/routes';

const DESCRIPTION_PREVIEW_CHARACTERS = 160;
const POLICY_OPTIONS: readonly { value: ToolPolicyState; label: string }[] = [
  { value: 'blocked', label: 'Blocked' },
  { value: 'allowed_default_off', label: 'Allowed, off by default' },
  { value: 'allowed_default_on', label: 'Allowed, on by default' },
];
const PROVIDER_NAMES = new Map(getProviderCatalog().map((provider) => [provider.id, provider.name]));

function isToolPolicyState(value: string): value is ToolPolicyState {
  return POLICY_OPTIONS.some((option) => option.value === value);
}

function providerName(providerId: ConnectableProviderId): string {
  return PROVIDER_NAMES.get(providerId) ?? providerId;
}

function matchesSearch(tool: AdminTool, normalizedSearch: string): boolean {
  return normalizedSearch.length === 0 || `${tool.title} ${tool.name} ${tool.description}`.toLowerCase().includes(normalizedSearch);
}

function compareTools(left: AdminTool, right: AdminTool): number {
  const leftBlocked = left.state === 'blocked';
  const rightBlocked = right.state === 'blocked';
  return leftBlocked !== rightBlocked ? leftBlocked ? -1 : 1 : left.title.localeCompare(right.title);
}

function addSelection(selected: ReadonlySet<string>, toolName: string): Set<string> {
  const next = new Set(selected);
  next.add(toolName);
  return next;
}

function removeSelection(selected: ReadonlySet<string>, toolName: string): Set<string> {
  const next = new Set(selected);
  next.delete(toolName);
  return next;
}

function addSelections(selected: ReadonlySet<string>, tools: readonly AdminTool[]): Set<string> {
  const next = new Set(selected);
  for (const tool of tools) next.add(tool.name);
  return next;
}

function removeSelections(selected: ReadonlySet<string>, tools: readonly AdminTool[]): Set<string> {
  const next = new Set(selected);
  for (const tool of tools) next.delete(tool.name);
  return next;
}

function selectionState(tools: readonly AdminTool[], selected: ReadonlySet<string>): CheckboxState {
  const selectedCount = tools.filter((tool) => selected.has(tool.name)).length;
  return selectedCount === 0 ? false : selectedCount === tools.length ? true : 'indeterminate';
}

function ToolDescription({ description, title }: { description: string; title: string }): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const descriptionId = useId();
  const isTruncated = description.length > DESCRIPTION_PREVIEW_CHARACTERS;
  return (
    <div>
      <p id={descriptionId} className={cn('mt-1 text-[12.5px] leading-5 text-app-text-tertiary', isTruncated && !isExpanded && 'line-clamp-3')}>{description}</p>
      {isTruncated ? (
        <button type="button" aria-controls={descriptionId} aria-expanded={isExpanded} className="-my-1 inline-flex min-h-11 items-center text-[11.5px] font-medium text-app-text-secondary hover:text-app-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60" onClick={() => { setIsExpanded((current) => !current); }}>
          {isExpanded ? 'View less' : 'View more'} <span className="sr-only">about {title}</span>
        </button>
      ) : null}
    </div>
  );
}

function PolicyMenu({ ariaLabel, disabled, triggerLabel, value, className, onChange }: { ariaLabel: string; disabled: boolean; triggerLabel: string; value?: ToolPolicyState; className?: string; onChange: (state: ToolPolicyState) => void }): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="select" aria-label={ariaLabel} disabled={disabled} className={cn('justify-start [&_svg]:absolute [&_svg]:right-2.5', className)}>
          {triggerLabel}<ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup {...(value === undefined ? {} : { value })} onValueChange={(next) => { if (isToolPolicyState(next)) onChange(next); }}>
          {POLICY_OPTIONS.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value}>{option.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContractBlock({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <Surface variant="inset" className="min-w-0 p-3">
      <div className="mb-2 text-xs font-medium text-linear-bright">{label}</div>
      <pre className="max-h-64 overflow-auto whitespace-pre font-mono text-[11px] leading-5 text-linear-input-disabled">{value}</pre>
    </Surface>
  );
}

function ToolRow({ tool, providerId, selected, disabled, onSelect, onDeselect, onChange }: { tool: AdminTool; providerId: ConnectableProviderId; selected: boolean; disabled: boolean; onSelect: (toolName: string) => void; onDeselect: (toolName: string) => void; onChange: (change: ToolPolicyChange) => void }): React.JSX.Element {
  const currentPolicy = POLICY_OPTIONS.find((option) => option.value === tool.state);
  return (
    <SettingsRow className="block h-auto min-h-[65px] p-0">
      <div className="grid grid-cols-[44px_minmax(0,1fr)] items-start gap-x-3 px-4 py-4 sm:grid-cols-[44px_minmax(0,1fr)_188px]">
        <label className="flex size-11 cursor-pointer items-start justify-center pt-0.5">
          <Checkbox aria-label={`Select ${tool.title}`} checked={selected} disabled={disabled} onCheckedChange={(checked) => { if (checked) onSelect(tool.name); else onDeselect(tool.name); }} />
        </label>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><span className="text-[13px] font-medium text-linear-bright">{tool.title}</span>{tool.needsReview ? <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10.5px] font-semibold text-danger">Review required</span> : null}</div>
          <ToolDescription description={tool.description} title={tool.title} />
          <code className="mt-1 block truncate font-mono text-[11px] text-app-text-quaternary" title={tool.name}>{tool.name}</code>
        </div>
        <div className="col-start-2 mt-3 min-w-0 text-[11px] font-medium text-app-text-tertiary sm:col-start-3 sm:row-start-1 sm:mt-0">
          <div>Policy</div>
          <PolicyMenu ariaLabel={`Policy for ${tool.title}`} disabled={disabled} triggerLabel={currentPolicy?.label ?? tool.state} value={tool.state} className="mt-1 w-full" onChange={(state) => { if (state !== tool.state) onChange({ providerId, toolName: tool.name, fingerprint: tool.fingerprint, state }); }} />
        </div>
      </div>
      <details className="group text-[11.5px] text-app-text-tertiary open:border-t-[0.5px] open:border-linear-settings-divider">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-4 pl-[72px] font-medium outline-none hover:text-linear-bright focus-visible:[outline:1px_solid_var(--linear-primary)] focus-visible:[outline-offset:-1px] [&::-webkit-details-marker]:hidden">
          <ChevronDown aria-hidden className="size-3.5 shrink-0 -rotate-90 transition-transform duration-150 group-open:rotate-0 motion-reduce:transition-none" />
          Review contract and fingerprint
        </summary>
        <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><ContractBlock label="Fingerprint" value={tool.fingerprint} /></div>
          <ContractBlock label="Annotations" value={JSON.stringify(tool.annotations, null, 2)} />
          <ContractBlock label="Input schema" value={JSON.stringify(tool.inputSchema, null, 2)} />
          {tool.outputSchema !== undefined ? <ContractBlock label="Output schema" value={JSON.stringify(tool.outputSchema, null, 2)} /> : null}
        </div>
      </details>
    </SettingsRow>
  );
}

type SelectionHandlers = { selectedToolNames: ReadonlySet<string>; disabled: boolean; onSelect: (name: string) => void; onDeselect: (name: string) => void; onSelectAll: (tools: readonly AdminTool[]) => void; onDeselectAll: (tools: readonly AdminTool[]) => void; onChange: (change: ToolPolicyChange) => void };

function ToolGroup({ mutability, tools, providerId, selectedToolNames, disabled, onSelect, onDeselect, onSelectAll, onDeselectAll, onChange }: SelectionHandlers & { mutability: ToolMutability; tools: readonly AdminTool[]; providerId: ConnectableProviderId }): React.JSX.Element | null {
  if (tools.length === 0) return null;
  const isRead = mutability === 'read';
  const selectedState = selectionState(tools, selectedToolNames);
  return (
    <section className="mt-3">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <h3 className={isRead ? 'text-[11px] font-semibold uppercase tracking-[.07em] text-success' : 'text-[11px] font-semibold uppercase tracking-[.07em] text-warning'}>{isRead ? 'Read' : 'Write'}</h3>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[11.5px] text-app-text-tertiary"><Checkbox aria-label={`Select all ${isRead ? 'read' : 'write'} tools`} checked={selectedState} disabled={disabled} onCheckedChange={(checked) => { if (checked) onSelectAll(tools); else onDeselectAll(tools); }} />Select all</label>
        </div>
        <span className="text-[11px] tabular-nums text-app-text-quaternary">{tools.length}</span>
      </div>
      <SectionCard className="mt-2 overflow-hidden">{tools.map((tool) => <ToolRow key={tool.name} tool={tool} providerId={providerId} selected={selectedToolNames.has(tool.name)} disabled={disabled} onSelect={onSelect} onDeselect={onDeselect} onChange={onChange} />)}</SectionCard>
    </section>
  );
}

function ProviderTools({ provider, normalizedSearch, selectedToolNames, disabled, onSelect, onDeselect, onSelectAll, onDeselectAll, onChange }: SelectionHandlers & { provider: AdminToolProvider; normalizedSearch: string }): React.JSX.Element {
  const matchingTools = provider.tools.filter((tool) => matchesSearch(tool, normalizedSearch));
  const sortedTools = [...matchingTools].sort(compareTools);
  const readTools = sortedTools.filter((tool) => tool.mutability === 'read');
  const writeTools = sortedTools.filter((tool) => tool.mutability === 'write');
  const allSelectedState = matchingTools.length === 0 ? false : selectionState(matchingTools, selectedToolNames);
  return (
    <section className="mt-7">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <h2 className="text-[13.5px] font-semibold">{providerName(provider.providerId)}</h2>
        <div className="flex items-center gap-3">
          {provider.status === 'ready' && matchingTools.length > 0 ? <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[11.5px] text-app-text-tertiary"><Checkbox aria-label="Select all visible tools" checked={allSelectedState} disabled={disabled} onCheckedChange={(checked) => { if (checked) onSelectAll(matchingTools); else onDeselectAll(matchingTools); }} />Select all</label> : null}
          <span className="text-xs text-app-text-quaternary">{provider.status === 'ready' ? `${matchingTools.length} tools` : null}</span>
        </div>
      </div>
      {provider.status === 'not-connected' ? <p className="mt-2 rounded-[9px] border-[0.5px] border-app-border-pane p-3.5 text-[12.5px] text-app-text-tertiary">Connect your admin account to {providerName(provider.providerId)} in <Link className="text-brand hover:text-brand-hover" to={APP_ROUTES.integrations}>Integrations</Link> to review its official tools.</p> : null}
      {provider.status === 'error' ? <p role="alert" className="mt-2 rounded-[9px] border-[0.5px] border-warning/35 bg-warning/7 p-3.5 text-[12.5px] text-app-text-secondary">The official MCP endpoint could not be loaded. Reconnect the provider if this continues.</p> : null}
      {provider.status === 'ready' && matchingTools.length === 0 ? <p className="mt-2 rounded-[9px] border-[0.5px] border-app-border-pane p-3.5 text-[12.5px] text-app-text-tertiary">No tools match this search.</p> : null}
      {provider.status === 'ready' ? <ToolGroup mutability="read" tools={readTools} providerId={provider.providerId} selectedToolNames={selectedToolNames} disabled={disabled} onSelect={onSelect} onDeselect={onDeselect} onSelectAll={onSelectAll} onDeselectAll={onDeselectAll} onChange={onChange} /> : null}
      {provider.status === 'ready' ? <ToolGroup mutability="write" tools={writeTools} providerId={provider.providerId} selectedToolNames={selectedToolNames} disabled={disabled} onSelect={onSelect} onDeselect={onDeselect} onSelectAll={onSelectAll} onDeselectAll={onDeselectAll} onChange={onChange} /> : null}
    </section>
  );
}

function BatchActions({ selectedCount, disabled, onClear, onChange }: { selectedCount: number; disabled: boolean; onClear: () => void; onChange: (state: ToolPolicyState) => void }): React.JSX.Element {
  return <div aria-label="Batch actions" className="flex min-h-11 items-center justify-between gap-3"><div aria-live="polite" className="text-[12.5px] font-medium tabular-nums">{selectedCount} selected</div><div className="flex items-center gap-1.5"><Button type="button" variant="ghost" size="large" disabled={disabled} onClick={onClear}>Clear</Button><PolicyMenu ariaLabel={`Set policy for ${selectedCount} selected tools`} disabled={disabled} triggerLabel={disabled ? 'Applying…' : 'Set policy'} className="w-40" onChange={onChange} /></div></div>;
}

function AdminProviderTools({ providerId }: { providerId: ConnectableProviderId }): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [selectedToolNames, setSelectedToolNames] = useState<Set<string>>(() => new Set());
  const queryClient = useQueryClient();
  const queryOptions = adminToolsQueryOptions(providerId);
  const toolsQuery = useQuery(queryOptions);
  const normalizedSearch = search.trim().toLowerCase();
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); }, [providerId]);
  const refreshMutation = useMutation({
    mutationFn: () => refreshAdminProviderTools(providerId),
    onSuccess: (result) => {
      queryClient.setQueryData(queryOptions.queryKey, result);
      setSelectedToolNames(new Set());
    },
  });
  const policyMutation = useMutation({
    mutationFn: setToolPolicies,
    onSuccess: (cache, change) => {
      const stateByName = new Map(change.tools.map((tool) => [tool.toolName, tool.state]));
      queryClient.setQueryData<CachedResult<AdminToolProvider>>(queryOptions.queryKey, (result) => result && ({ cache, data: { ...result.data, tools: result.data.tools.map((tool) => { const state = stateByName.get(tool.name); return state === undefined ? tool : { ...tool, state, needsReview: false }; }) } }));
      setSelectedToolNames((current) => { const next = new Set(current); for (const tool of change.tools) next.delete(tool.toolName); return next; });
    },
  });
  const changeOne = (change: ToolPolicyChange) => { policyMutation.mutate({ providerId: change.providerId, tools: [{ toolName: change.toolName, fingerprint: change.fingerprint, state: change.state }] }); };
  const changeSelected = (state: ToolPolicyState) => {
    const provider = toolsQuery.data?.data;
    if (!provider) return;
    const tools: ToolPolicyBatchChange['tools'] = provider.tools.filter((tool) => selectedToolNames.has(tool.name)).map((tool) => ({ toolName: tool.name, fingerprint: tool.fingerprint, state }));
    if (tools.length !== 0) policyMutation.mutate({ providerId, tools });
  };
  return (
    <section>
      <PageHead title={`${providerName(providerId)} tools`} subtitle={`Review tools discovered from ${providerName(providerId)}'s official MCP server. New or changed contracts stay blocked until you approve their current fingerprint.`} />
      <div className="mt-4 min-h-11">
        {selectedToolNames.size > 0
          ? <BatchActions selectedCount={selectedToolNames.size} disabled={policyMutation.isPending} onClear={() => { setSelectedToolNames(new Set()); }} onChange={changeSelected} />
          : <div className="flex min-h-11 items-center justify-end"><Button type="button" variant="outline" size="large" disabled={refreshMutation.isPending} className="min-w-28" onClick={() => { refreshMutation.mutate(); }}>{refreshMutation.isPending ? 'Refreshing…' : 'Refresh tools'}</Button></div>}
      </div>
      <label htmlFor="tool-search" className="mt-6 block text-[11px] font-medium text-app-text-tertiary">Search tools</label>
      <SearchInput id="tool-search" variant="content" value={search} onChange={(event) => { setSearch(event.target.value); }} placeholder="Name or description" containerClassName="mt-1" className="h-11" />
      {toolsQuery.isPending ? <LoadingState label="Loading official provider tools…" /> : null}
      {toolsQuery.isError ? <ErrorState title="We couldn't load tool administration" body="You may not have administrator access, or provider discovery failed before the catalog could load." onRetry={() => { void toolsQuery.refetch(); }} /> : null}
      {policyMutation.isError ? <p role="alert" className="mt-4 text-[12.5px] text-danger">No policies were saved. A selected tool may have changed, refresh and review it again.</p> : null}
      {refreshMutation.isError ? <p role="alert" className="mt-4 text-[12.5px] text-danger">The official MCP endpoint could not be refreshed. Try again.</p> : null}
      {toolsQuery.data ? <ProviderTools provider={toolsQuery.data.data} normalizedSearch={normalizedSearch} selectedToolNames={selectedToolNames} disabled={policyMutation.isPending} onSelect={(name) => { setSelectedToolNames((current) => addSelection(current, name)); }} onDeselect={(name) => { setSelectedToolNames((current) => removeSelection(current, name)); }} onSelectAll={(tools) => { setSelectedToolNames((current) => addSelections(current, tools)); }} onDeselectAll={(tools) => { setSelectedToolNames((current) => removeSelections(current, tools)); }} onChange={changeOne} /> : null}
    </section>
  );
}

export default function AdminTools(): React.JSX.Element {
  const { providerId } = useParams();
  return providerId === undefined || !isConnectableProvider(providerId)
    ? <Navigate to={`${APP_ROUTES.adminTools}/github`} replace />
    : <AdminProviderTools key={providerId} providerId={providerId} />;
}
