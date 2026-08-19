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
import { LoadingState } from '@app/components/ui/loading-state';
import { PageHead } from '@app/components/ui/page-head';
import { SectionCard } from '@app/components/ui/section-card';
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
        <Button type="button" variant="outline" aria-label={ariaLabel} disabled={disabled} className={cn('h-11 justify-between rounded-md border-app-border-pane bg-app-bg-secondary px-3 text-[12.5px] text-app-text-primary hover:bg-control', className)}>
          {triggerLabel}<ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuRadioGroup {...(value === undefined ? {} : { value })} onValueChange={(next) => { if (isToolPolicyState(next)) onChange(next); }}>
          {POLICY_OPTIONS.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value} className="h-11">{option.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToolRow({ tool, providerId, selected, disabled, onSelect, onDeselect, onChange }: { tool: AdminTool; providerId: ConnectableProviderId; selected: boolean; disabled: boolean; onSelect: (toolName: string) => void; onDeselect: (toolName: string) => void; onChange: (change: ToolPolicyChange) => void }): React.JSX.Element {
  const currentPolicy = POLICY_OPTIONS.find((option) => option.value === tool.state);
  return (
    <div className="border-t-[0.5px] border-app-border-pane px-4 py-4 first:border-t-0">
      <div className="flex items-start gap-1">
        <label className="-ml-3 flex size-11 shrink-0 cursor-pointer items-center justify-center">
          <Checkbox aria-label={`Select ${tool.title}`} checked={selected} disabled={disabled} onCheckedChange={(checked) => { if (checked) onSelect(tool.name); else onDeselect(tool.name); }} />
        </label>
        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><span className="text-[13px] font-semibold">{tool.title}</span>{tool.needsReview ? <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10.5px] font-semibold text-danger">Review required</span> : null}</div>
            <ToolDescription description={tool.description} title={tool.title} />
            <code className="mt-1 block break-all font-mono text-[11px] text-app-text-quaternary">{tool.name}</code>
          </div>
          <div className="shrink-0 text-[11px] font-medium text-app-text-tertiary">
            <div>Policy</div>
            <PolicyMenu ariaLabel={`Policy for ${tool.title}`} disabled={disabled} triggerLabel={currentPolicy?.label ?? tool.state} value={tool.state} className="mt-1 w-full sm:w-56" onChange={(state) => { if (state !== tool.state) onChange({ providerId, toolName: tool.name, fingerprint: tool.fingerprint, state }); }} />
          </div>
        </div>
      </div>
      <details className="ml-9 mt-3 text-[11.5px] text-app-text-tertiary">
        <summary className="min-h-11 cursor-pointer py-3 font-medium hover:text-app-text-primary">Review contract and fingerprint</summary>
        <div className="space-y-3 rounded-md bg-black/15 p-3">
          <div><div className="mb-1 font-semibold text-app-text-secondary">Fingerprint</div><code className="break-all font-mono text-[10.5px]">{tool.fingerprint}</code></div>
          <div><div className="mb-1 font-semibold text-app-text-secondary">Annotations</div><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px]">{JSON.stringify(tool.annotations, null, 2)}</pre></div>
          <div><div className="mb-1 font-semibold text-app-text-secondary">Input schema</div><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px]">{JSON.stringify(tool.inputSchema, null, 2)}</pre></div>
          {tool.outputSchema !== undefined ? <div><div className="mb-1 font-semibold text-app-text-secondary">Output schema</div><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px]">{JSON.stringify(tool.outputSchema, null, 2)}</pre></div> : null}
        </div>
      </details>
    </div>
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
  return <div aria-label="Batch actions" className="sticky top-3 z-20 mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border-[0.5px] border-app-border-pane bg-app-bg-primary/95 p-2 shadow-lg backdrop-blur"><div aria-live="polite" className="px-2 text-[12.5px] font-medium tabular-nums">{selectedCount} selected</div><div className="flex items-center gap-1.5"><Button type="button" variant="ghost" disabled={disabled} className="h-11 rounded-md px-3" onClick={onClear}>Clear</Button><PolicyMenu ariaLabel={`Set policy for ${selectedCount} selected tools`} disabled={disabled} triggerLabel={disabled ? 'Applying…' : 'Set policy'} className="w-40" onChange={onChange} /></div></div>;
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
      <div className="mt-4 flex justify-end"><Button type="button" variant="outline" disabled={refreshMutation.isPending} className="h-11 min-w-28 rounded-md" onClick={() => { refreshMutation.mutate(); }}>{refreshMutation.isPending ? 'Refreshing…' : 'Refresh tools'}</Button></div>
      <label className="mt-6 block text-[11px] font-medium text-app-text-tertiary">Search tools<input aria-label="Search tools" type="search" value={search} onChange={(event) => { setSearch(event.target.value); }} placeholder="Name or description" className="mt-1 block min-h-11 w-full rounded-md border border-app-border-pane bg-app-bg-secondary px-3 text-[13px] text-app-text-primary placeholder:text-app-text-quaternary" /></label>
      {selectedToolNames.size > 0 ? <BatchActions selectedCount={selectedToolNames.size} disabled={policyMutation.isPending} onClear={() => { setSelectedToolNames(new Set()); }} onChange={changeSelected} /> : null}
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
