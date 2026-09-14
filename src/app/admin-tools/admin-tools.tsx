import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { getProviderCatalog, isConnectableProvider, refreshAdminProviderTools, setToolPolicies, type AdminTool, type AdminToolProvider, type CachedResult, type ProviderId, type ToolContractChange, type ToolContractReview, type ToolMutability, type ToolPolicyBatchChange, type ToolPolicyChange, type ToolPolicyState } from '@app/api/bifrost';
import { adminToolsQueryOptions } from '@app/api/query-options';
import { Button } from '@app/components/ui/button';
import { Checkbox, type CheckboxState } from '@app/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@app/components/ui/dropdown-menu';
import { ErrorState } from '@app/components/ui/error-state';
import { ExpandableText } from '@app/components/ui/expandable-text';
import { SearchInput } from '@app/components/ui/input';
import { PageHead } from '@app/components/ui/page-head';
import { SectionCard } from '@app/components/ui/section-card';
import { Skeleton } from '@app/components/ui/skeleton';
import { SettingsRow } from '@app/components/ui/settings-group';
import { Surface } from '@app/components/ui/surface';
import { cn } from '@app/lib/cn';
import { APP_ROUTES } from '@features/utils/routes';

const POLICY_OPTIONS: readonly { value: ToolPolicyState; label: string }[] = [
  { value: 'blocked', label: 'Blocked' },
  { value: 'allowed_default_off', label: 'Allowed, off by default' },
  { value: 'allowed_default_on', label: 'Allowed, on by default' },
];
const PROVIDER_NAMES = new Map(getProviderCatalog().map((provider) => [provider.id, provider.name]));

function isToolPolicyState(value: string): value is ToolPolicyState {
  return POLICY_OPTIONS.some((option) => option.value === value);
}

function providerName(providerId: ProviderId): string {
  return PROVIDER_NAMES.get(providerId) ?? providerId;
}

function matchesSearch(tool: AdminTool, normalizedSearch: string): boolean {
  return normalizedSearch.length === 0 || `${tool.title} ${tool.name} ${tool.description}`.toLowerCase().includes(normalizedSearch);
}

function compareTools(left: AdminTool, right: AdminTool): number {
  if (left.needsReview !== right.needsReview) return left.needsReview ? -1 : 1;
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

function getSelectionState(tools: readonly AdminTool[], selected: ReadonlySet<string>): CheckboxState {
  const selectedCount = tools.filter((tool) => selected.has(tool.name)).length;
  return selectedCount === 0 ? false : selectedCount === tools.length ? true : 'indeterminate';
}

type ToolSelectionController = {
  clear: () => void;
  deselect: (toolName: string) => void;
  deselectAll: (tools: readonly AdminTool[]) => void;
  deselectNames: (toolNames: readonly string[]) => void;
  isSelected: (toolName: string) => boolean;
  select: (toolName: string) => void;
  selectAll: (tools: readonly AdminTool[]) => void;
  selectedCount: number;
  stateFor: (tools: readonly AdminTool[]) => CheckboxState;
};

function useToolSelection(): ToolSelectionController {
  const [selectedToolNames, setSelectedToolNames] = useState<Set<string>>(() => new Set());

  return {
    clear: () => { setSelectedToolNames(new Set()); },
    deselect: (toolName) => { setSelectedToolNames((current) => removeSelection(current, toolName)); },
    deselectAll: (tools) => { setSelectedToolNames((current) => removeSelections(current, tools)); },
    deselectNames: (toolNames) => {
      setSelectedToolNames((current) => {
        const next = new Set(current);
        for (const toolName of toolNames) next.delete(toolName);
        return next;
      });
    },
    isSelected: (toolName) => selectedToolNames.has(toolName),
    select: (toolName) => { setSelectedToolNames((current) => addSelection(current, toolName)); },
    selectAll: (tools) => { setSelectedToolNames((current) => addSelections(current, tools)); },
    selectedCount: selectedToolNames.size,
    stateFor: (tools) => getSelectionState(tools, selectedToolNames),
  };
}

type ToolAdministrationController = {
  changePolicy: (change: ToolPolicyChange) => void;
  disabled: boolean;
  selection: ToolSelectionController;
};

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
      <pre className="max-h-64 overflow-auto whitespace-pre font-mono text-caption leading-5 text-linear-input-disabled">{value}</pre>
    </Surface>
  );
}

function ReviewBadge({ review }: { review: ToolContractReview }): React.JSX.Element | null {
  if (review.kind === 'approved') return null;
  return (
    <span className={cn(
      'rounded-full px-2 py-0.5 text-badge font-semibold',
      review.kind === 'new' ? 'bg-brand/10 text-brand-hover' : 'bg-warning/10 text-warning',
    )}>
      {review.kind === 'new' ? 'New tool' : 'Contract changed'}
    </span>
  );
}

function ContractChangeRow({ change }: { change: ToolContractChange }): React.JSX.Element {
  return (
    <div className="rounded-notice linear-border-hairline border-app-border-pane p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="break-all font-mono text-caption text-linear-bright">{change.path}</code>
        <span className="rounded-full bg-linear-card-hover px-2 py-0.5 text-mini font-semibold uppercase tracking-label text-app-text-tertiary">{change.kind}</span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {change.kind === 'added' ? null : <ContractBlock label="Previous" value={JSON.stringify(change.before, null, 2)} />}
        {change.kind === 'removed' ? null : <ContractBlock label="Current" value={JSON.stringify(change.after, null, 2)} />}
      </div>
    </div>
  );
}

function ContractReviewDetails({ review }: { review: ToolContractReview }): React.JSX.Element | null {
  if (review.kind === 'approved') return null;
  if (review.kind === 'new') {
    return (
      <div className="sm:col-span-2 rounded-notice linear-border-hairline border-brand/25 bg-brand/5 p-3 text-detail text-app-text-secondary">
        <div className="font-semibold text-linear-bright">New tool</div>
        <p className="mt-1">No previously approved contract exists for this tool.</p>
      </div>
    );
  }
  if (review.changes === null) {
    return (
      <div className="sm:col-span-2 rounded-notice linear-border-hairline border-warning/30 bg-warning/5 p-3 text-detail text-app-text-secondary">
        <div className="font-semibold text-linear-bright">Contract changed</div>
        <p className="mt-1">The previous approval predates contract snapshots, so its exact changes are unavailable. Approving this version enables detailed comparisons from now on.</p>
      </div>
    );
  }
  return (
    <div className="sm:col-span-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="font-semibold text-linear-bright">Changes since approval</div>
        <span className="tabular-nums text-app-text-quaternary">{review.changes.length}{review.truncated ? '+' : ''} changes</span>
      </div>
      <div className="space-y-2">{review.changes.map((change) => <ContractChangeRow key={`${change.kind}:${change.path}`} change={change} />)}</div>
      {review.truncated ? <p className="mt-2 text-warning">Only the first 100 changes are shown.</p> : null}
    </div>
  );
}

function ToolRow({ tool, providerId, controller }: { tool: AdminTool; providerId: ProviderId; controller: ToolAdministrationController }): React.JSX.Element {
  const currentPolicy = POLICY_OPTIONS.find((option) => option.value === tool.state);
  const { disabled, selection } = controller;
  return (
    <SettingsRow className="block h-auto min-h-[65px] p-0">
      <div className="grid grid-cols-[44px_minmax(0,1fr)] items-start gap-x-3 px-4 py-4 sm:grid-cols-[44px_minmax(0,1fr)_188px]">
        <label className="flex size-11 cursor-pointer items-start justify-center pt-0.5">
          <Checkbox aria-label={`Select ${tool.title}`} checked={selection.isSelected(tool.name)} disabled={disabled} onCheckedChange={(checked) => { if (checked) selection.select(tool.name); else selection.deselect(tool.name); }} />
        </label>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><span className="text-body font-medium text-linear-bright">{tool.title}</span><ReviewBadge review={tool.review} /></div>
          <ExpandableText label={tool.title} text={tool.description} />
          <code className="mt-1 block truncate font-mono text-caption text-app-text-quaternary" title={tool.name}>{tool.name}</code>
        </div>
        <div className="col-start-2 mt-3 min-w-0 text-caption font-medium text-app-text-tertiary sm:col-start-3 sm:row-start-1 sm:mt-0">
          <div>Policy</div>
          <PolicyMenu ariaLabel={`Policy for ${tool.title}`} disabled={disabled} triggerLabel={currentPolicy?.label ?? tool.state} value={tool.state} className="mt-1 w-full" onChange={(state) => { if (state !== tool.state) controller.changePolicy({ providerId, toolName: tool.name, fingerprint: tool.fingerprint, state }); }} />
        </div>
      </div>
      <details className="group text-detail text-app-text-tertiary open:linear-border-t-hairline open:border-linear-settings-divider">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-4 pl-18 font-medium outline-none hover:text-linear-bright focus-visible:linear-focus-outline [&::-webkit-details-marker]:hidden">
          <ChevronDown aria-hidden className="size-3.5 shrink-0 -rotate-90 transition-transform duration-150 group-open:rotate-0 motion-reduce:transition-none" />
          Review contract and fingerprint
        </summary>
        <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2">
          <ContractReviewDetails review={tool.review} />
          <div className="sm:col-span-2"><ContractBlock label="Fingerprint" value={tool.fingerprint} /></div>
          <ContractBlock label="Annotations" value={JSON.stringify(tool.annotations, null, 2)} />
          <ContractBlock label="Input schema" value={JSON.stringify(tool.inputSchema, null, 2)} />
          {tool.outputSchema !== undefined ? <ContractBlock label="Output schema" value={JSON.stringify(tool.outputSchema, null, 2)} /> : null}
        </div>
      </details>
    </SettingsRow>
  );
}

function ToolRowSkeleton(): React.JSX.Element {
  return (
    <div className="grid min-h-[65px] grid-cols-[44px_minmax(0,1fr)] items-start gap-x-3 linear-border-t-hairline border-linear-settings-divider px-4 py-4 first:border-t-0 sm:grid-cols-[44px_minmax(0,1fr)_188px]">
      <div className="flex justify-center pt-0.5"><Skeleton shape="checkbox" className="size-4" /></div>
      <div className="flex min-w-0 flex-col gap-2.5 pt-1">
        <Skeleton className="h-2.5 w-36" />
        <Skeleton variant="subtle" className="h-2 w-full max-w-105" />
        <Skeleton variant="subtle" className="h-2 w-52" />
      </div>
      <div className="col-start-2 mt-3 min-w-0 sm:col-start-3 sm:row-start-1 sm:mt-0">
        <Skeleton variant="subtle" className="mt-0.5 h-2 w-10" />
        <Skeleton shape="control" className="mt-2 h-[30px] w-full" />
      </div>
    </div>
  );
}

function ToolAdministrationSkeleton(): React.JSX.Element {
  return (
    <div aria-live="polite" aria-busy="true" className="mt-7">
      {[3, 2].map((rowCount, groupIndex) => (
        <section className={groupIndex === 0 ? undefined : 'mt-3'} key={groupIndex}>
          <div className="flex min-h-11 items-center justify-between px-1">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton variant="subtle" className="h-2 w-6" />
          </div>
          <SectionCard className="mt-2 overflow-hidden">
            {Array.from({ length: rowCount }, (_, index) => <ToolRowSkeleton key={index} />)}
          </SectionCard>
        </section>
      ))}
      <div className="mt-3 text-center text-xs text-app-text-quaternary">Loading official provider tools…</div>
    </div>
  );
}

type ToolGroupModel = { mutability: ToolMutability; tools: readonly AdminTool[]; providerId: ProviderId };

function ToolGroup({ group, controller }: { group: ToolGroupModel; controller: ToolAdministrationController }): React.JSX.Element | null {
  const { mutability, tools, providerId } = group;
  if (tools.length === 0) return null;
  const isRead = mutability === 'read';
  const selectedState = controller.selection.stateFor(tools);
  return (
    <section className="mt-3">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <h3 className={isRead ? 'text-caption font-semibold uppercase tracking-section text-success' : 'text-caption font-semibold uppercase tracking-section text-warning'}>{isRead ? 'Read' : 'Write'}</h3>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-detail text-app-text-tertiary"><Checkbox aria-label={`Select all ${isRead ? 'read' : 'write'} tools`} checked={selectedState} disabled={controller.disabled} onCheckedChange={(checked) => { if (checked) controller.selection.selectAll(tools); else controller.selection.deselectAll(tools); }} />Select all</label>
        </div>
        <span className="text-caption tabular-nums text-app-text-quaternary">{tools.length}</span>
      </div>
      <SectionCard className="mt-2 overflow-hidden">{tools.map((tool) => <ToolRow key={tool.name} tool={tool} providerId={providerId} controller={controller} />)}</SectionCard>
    </section>
  );
}

function ProviderTools({ provider, normalizedSearch, controller }: { provider: AdminToolProvider; normalizedSearch: string; controller: ToolAdministrationController }): React.JSX.Element {
  const matchingTools = provider.tools.filter((tool) => matchesSearch(tool, normalizedSearch));
  const sortedTools = [...matchingTools].sort(compareTools);
  const readTools = sortedTools.filter((tool) => tool.mutability === 'read');
  const writeTools = sortedTools.filter((tool) => tool.mutability === 'write');
  const allSelectedState = matchingTools.length === 0 ? false : controller.selection.stateFor(matchingTools);
  return (
    <section className="mt-7">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <h2 className="text-emphasis font-semibold">{providerName(provider.providerId)}</h2>
        <div className="flex items-center gap-3">
          {provider.status === 'ready' && matchingTools.length > 0 ? <label className="flex min-h-11 cursor-pointer items-center gap-2 text-detail text-app-text-tertiary"><Checkbox aria-label="Select all visible tools" checked={allSelectedState} disabled={controller.disabled} onCheckedChange={(checked) => { if (checked) controller.selection.selectAll(matchingTools); else controller.selection.deselectAll(matchingTools); }} />Select all</label> : null}
          <span className="text-xs text-app-text-quaternary">{provider.status === 'ready' ? `${matchingTools.length} tools` : null}</span>
        </div>
      </div>
      {provider.status === 'not-connected' ? <p className="mt-2 rounded-notice linear-border-hairline border-app-border-pane p-3.5 text-compact text-app-text-tertiary">Connect your admin account to {providerName(provider.providerId)} in <Link className="text-brand hover:text-brand-hover" to={APP_ROUTES.integrations}>Integrations</Link> to review its official tools.</p> : null}
      {provider.status === 'error' ? <p role="alert" className="mt-2 rounded-notice linear-border-hairline border-warning/35 bg-warning/7 p-3.5 text-compact text-app-text-secondary">The official MCP endpoint could not be loaded. Reconnect the provider if this continues.</p> : null}
      {provider.status === 'ready' && matchingTools.length === 0 ? <p className="mt-2 rounded-notice linear-border-hairline border-app-border-pane p-3.5 text-compact text-app-text-tertiary">No tools match this search.</p> : null}
      {provider.status === 'ready' ? <ToolGroup group={{ mutability: 'read', tools: readTools, providerId: provider.providerId }} controller={controller} /> : null}
      {provider.status === 'ready' ? <ToolGroup group={{ mutability: 'write', tools: writeTools, providerId: provider.providerId }} controller={controller} /> : null}
    </section>
  );
}

function BatchActions({ controller, onChange }: { controller: ToolAdministrationController; onChange: (state: ToolPolicyState) => void }): React.JSX.Element {
  const { disabled, selection } = controller;
  return <div aria-label="Batch actions" className="flex min-h-11 items-center justify-between gap-3"><div aria-live="polite" className="text-compact font-medium tabular-nums">{selection.selectedCount} selected</div><div className="flex items-center gap-1.5"><Button type="button" variant="ghost" size="large" disabled={disabled} onClick={selection.clear}>Clear</Button><PolicyMenu ariaLabel={`Set policy for ${selection.selectedCount} selected tools`} disabled={disabled} triggerLabel={disabled ? 'Applying…' : 'Set policy'} className="w-40" onChange={onChange} /></div></div>;
}

function AdminProviderTools({ providerId }: { providerId: ProviderId }): React.JSX.Element {
  const [search, setSearch] = useState('');
  const selection = useToolSelection();
  const queryClient = useQueryClient();
  const queryOptions = adminToolsQueryOptions(providerId);
  const toolsQuery = useQuery(queryOptions);
  const normalizedSearch = search.trim().toLowerCase();
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); }, [providerId]);
  const refreshMutation = useMutation({
    mutationFn: () => refreshAdminProviderTools(providerId),
    onSuccess: (result) => {
      queryClient.setQueryData(queryOptions.queryKey, result);
      selection.clear();
    },
  });
  const policyMutation = useMutation({
    mutationFn: setToolPolicies,
    onSuccess: (cache, change) => {
      const stateByName = new Map(change.tools.map((tool) => [tool.toolName, tool.state]));
      queryClient.setQueryData<CachedResult<AdminToolProvider>>(queryOptions.queryKey, (result) => result && ({ cache, data: { ...result.data, tools: result.data.tools.map((tool) => { const state = stateByName.get(tool.name); return state === undefined ? tool : { ...tool, state, needsReview: false, review: { kind: 'approved' } }; }) } }));
      selection.deselectNames(change.tools.map((tool) => tool.toolName));
    },
  });
  const changeOne = (change: ToolPolicyChange) => { policyMutation.mutate({ providerId: change.providerId, tools: [{ toolName: change.toolName, fingerprint: change.fingerprint, state: change.state }] }); };
  const changeSelected = (state: ToolPolicyState) => {
    const provider = toolsQuery.data?.data;
    if (!provider) return;
    const tools: ToolPolicyBatchChange['tools'] = provider.tools.filter((tool) => selection.isSelected(tool.name)).map((tool) => ({ toolName: tool.name, fingerprint: tool.fingerprint, state }));
    if (tools.length !== 0) policyMutation.mutate({ providerId, tools });
  };
  const controller: ToolAdministrationController = {
    changePolicy: changeOne,
    disabled: policyMutation.isPending,
    selection,
  };
  return (
    <section>
      <PageHead title={`${providerName(providerId)} tools`} subtitle={`Review tools discovered from ${providerName(providerId)}'s official MCP server. New or changed contracts stay blocked until you approve their current fingerprint.`} />
      <div className="mt-4 min-h-11">
        {selection.selectedCount > 0
          ? <BatchActions controller={controller} onChange={changeSelected} />
          : <div className="flex min-h-11 items-center justify-end"><Button type="button" variant="outline" size="large" disabled={refreshMutation.isPending} className="min-w-28" onClick={() => { refreshMutation.mutate(); }}>{refreshMutation.isPending ? 'Refreshing…' : 'Refresh tools'}</Button></div>}
      </div>
      <label htmlFor="tool-search" className="mt-6 block text-caption font-medium text-app-text-tertiary">Search tools</label>
      <SearchInput id="tool-search" variant="content" value={search} onChange={(event) => { setSearch(event.target.value); }} placeholder="Name or description" containerClassName="mt-1" className="h-11" />
      {toolsQuery.isPending ? <ToolAdministrationSkeleton /> : null}
      {toolsQuery.isError ? <ErrorState title="We couldn't load tool administration" body="You may not have administrator access, or provider discovery failed before the catalog could load." onRetry={() => { void toolsQuery.refetch(); }} /> : null}
      {policyMutation.isError ? <p role="alert" className="mt-4 text-compact text-danger">No policies were saved. A selected tool may have changed, refresh and review it again.</p> : null}
      {refreshMutation.isError ? <p role="alert" className="mt-4 text-compact text-danger">The official MCP endpoint could not be refreshed. Try again.</p> : null}
      {toolsQuery.data ? <ProviderTools provider={toolsQuery.data.data} normalizedSearch={normalizedSearch} controller={controller} /> : null}
    </section>
  );
}

export default function AdminTools(): React.JSX.Element {
  const { providerId } = useParams();
  return providerId === undefined || !isConnectableProvider(providerId)
    ? <Navigate to={`${APP_ROUTES.adminTools}/github`} replace />
    : <AdminProviderTools key={providerId} providerId={providerId} />;
}
