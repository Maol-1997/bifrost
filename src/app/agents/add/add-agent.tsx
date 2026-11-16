import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from '@app/components/ui/button';
import { CopyButton } from '@app/components/ui/copy-button';
import { PageHead } from '@app/components/ui/page-head';
import { SectionCard } from '@app/components/ui/section-card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@app/components/ui/tabs';
import { relativeTime } from '@app/lib/format/time-ago';
import { getMcpAddress, type ConnectedClient } from '@app/api/bifrost';
import { connectedClientsQueryOptions } from '@app/api/query-options';
import { APP_ROUTES } from '@features/utils/routes';

type ClientTab = { id: string; label: string; steps: readonly string[]; copyValue: (address: string) => string };

const clientTabs: readonly ClientTab[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    // `claude mcp add` defaults to stdio and would try to run the URL as a
    // command. Bifrost speaks Streamable HTTP, not the legacy two-endpoint SSE
    // transport, so the flag is `http`.
    steps: ['Open a terminal (the same one you run Claude Code from).', 'Run the command below.'],
    copyValue: (address) => `claude mcp add --transport http bifrost ${address}`,
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    steps: [
      'Open Claude Desktop and go to Settings → Connectors.',
      'Click “Add custom connector”, name it “Bifrost”, and paste the URL below.',
      'Click “Add”, then “Connect” to authorize Bifrost.',
    ],
    copyValue: (address) => address,
  },
  {
    id: 'codex',
    label: 'Codex',
    steps: ['Open a terminal.', 'Run the command below.'],
    copyValue: (address) => `codex mcp add bifrost -- npx -y mcp-remote ${address}`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    // Paste rather than `>`: that file usually already holds other servers, and
    // a redirect would silently delete them.
    steps: [
      'Open ~/.cursor/mcp.json (create it if it isn’t there).',
      'Add the entry below inside "mcpServers", then reload the Cursor window.',
    ],
    copyValue: (address) => `"bifrost": { "url": "${address}" }`,
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    steps: [
      'In ChatGPT on the web, enable Developer mode under Settings → Apps → Advanced Settings.',
      'Go to Settings → Apps → Create, name the app “Bifrost”, and use the URL below as its MCP endpoint.',
      'Click “Scan tools”, complete OAuth authorization, then click “Create”.',
    ],
    copyValue: (address) => address,
  },
  {
    id: 'other',
    label: 'Something else',
    steps: [
      'Any program that supports MCP servers over HTTP works with Bifrost.',
      'Give it the address below as the “MCP server URL”.',
      'It has to support OAuth — almost all of them do, and it’s what saves you from pasting a secret.',
    ],
    copyValue: (address) => address,
  },
];

type CheckState =
  { kind: 'idle' } | { kind: 'checking' } | { kind: 'connected'; client: ConnectedClient } | { kind: 'waiting' };

function checkLabel(state: CheckState): string {
  switch (state.kind) {
    case 'idle':
      return 'Waiting for your first call…';
    case 'checking':
      return 'Checking…';
    case 'connected':
      return `${state.client.name} reached Bifrost ${relativeTime(state.client.lastUsedAt)} — you’re all set`;
    case 'waiting':
      return 'Nothing has reached Bifrost yet — make a call from your agent, then check again';
  }
}

function StepHeading({ number, children }: { number: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-5 items-center justify-center rounded-full bg-brand/22 text-xs font-semibold text-brand-hover">
        {number}
      </span>
      <h2 className="text-sm font-semibold">{children}</h2>
    </div>
  );
}

function CopyableSetupValue({ value }: { value: string }): React.JSX.Element {
  return (
    <div className="mt-2.5 flex gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg linear-border-hairline border-app-border-pane bg-black/30 px-3 py-2.5 font-mono text-xs text-app-text-secondary">
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  );
}

export default function AddAgent(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data: address } = useQuery({ queryKey: ['mcp-address'], queryFn: getMcpAddress });
  const checkMutation = useMutation({
    mutationFn: async () => {
      const clients = await queryClient.query(connectedClientsQueryOptions);
      return clients.find((client) => client.kind === 'agent');
    },
  });
  const checkState: CheckState = checkMutation.isIdle
    ? { kind: 'idle' }
    : checkMutation.isPending
      ? { kind: 'checking' }
      : checkMutation.data
        ? { kind: 'connected', client: checkMutation.data }
        : { kind: 'waiting' };

  return (
    <section>
      <Link
        to={APP_ROUTES.agents}
        className="mb-[18px] inline-flex min-h-11 items-center gap-1.5 text-xs text-app-text-tertiary hover:text-app-text-primary"
      >
        ← Sessions
      </Link>
      <PageHead
        title="Add an agent"
        subtitle="Connect Claude Code, Claude Desktop, Codex, Cursor, ChatGPT or another agent app to Bifrost. You only need to do this once, and it takes about a minute."
      />
      <SectionCard className="mt-6 p-5">
        <StepHeading number="1">Copy your Bifrost address</StepHeading>
        <div className="mt-3 flex gap-2">
          <div className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg linear-border-hairline border-app-border-pane bg-black/30 px-3 py-2.5 font-mono text-xs text-app-text-secondary">
            {address ?? 'Loading…'}
          </div>
          {address ? <CopyButton value={address} /> : null}
        </div>
        <p className="mt-2 text-xs text-app-text-quaternary">
          The same address for everyone here. Your program proves it’s you in step 2, so there’s no key to keep secret.
        </p>
      </SectionCard>
      <SectionCard className="mt-3.5 p-5">
        <StepHeading number="2">Run this, then approve it in the browser</StepHeading>
        <Tabs defaultValue="claude-code" className="mt-3">
          <TabsList variant="underline" className="w-full justify-start overflow-x-auto">
            {clientTabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id} variant="underline">
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {clientTabs.map((tab) => (
            <TabsContent key={tab.id} value={tab.id} className="mt-3.5">
              {tab.steps.map((step, index) => (
                <div key={step} className="flex gap-2 py-1 text-xs leading-5 text-app-text-secondary">
                  <span className="text-app-text-quaternary">{index + 1}.</span>
                  <span>{step}</span>
                </div>
              ))}
              {address ? <CopyableSetupValue value={tab.copyValue(address)} /> : null}
            </TabsContent>
          ))}
        </Tabs>
        <p className="mt-3 text-xs leading-copy text-app-text-quaternary text-pretty">
          A browser tab will open asking you to authorize the program. Approve it once and it stays connected on its own
          — it renews itself in the background, so there’s nothing to redo later. You can disconnect it any time from
          Sessions.
        </p>
      </SectionCard>
      <SectionCard className="mt-3.5 p-5">
        <StepHeading number="3">Check it worked</StepHeading>
        <p className="mt-2.5 text-xs leading-5 text-app-text-tertiary text-pretty">
          Ask your agent something simple, like{' '}
          <em className="text-app-text-secondary">“list my GitHub repositories”</em>. The moment it reaches Bifrost,
          this turns green.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div
            className={`inline-flex min-h-9 items-center gap-2 rounded-full linear-border-hairline px-3 text-xs ${checkState.kind === 'connected' ? 'border-success/35 bg-success/7 text-success' : 'border-app-border-pane text-app-text-tertiary'}`}
          >
            <span
              className={`size-[7px] rounded-full ${checkState.kind === 'connected' ? 'bg-success' : checkState.kind === 'checking' ? 'animate-design-blink bg-warning' : 'animate-design-blink bg-app-text-quaternary'}`}
            />
            {checkLabel(checkState)}
          </div>
          {checkState.kind === 'idle' || checkState.kind === 'waiting' ? (
            <Button
              variant="outline"
              onClick={() => {
                checkMutation.mutate();
              }}
            >
              I've done it — check now
            </Button>
          ) : null}
        </div>
        <p className="mt-3 text-xs text-app-text-quaternary">
          Stuck? <strong className="font-medium text-app-text-tertiary">#bifrost-help</strong> will get you going — no
          question is too basic.
        </p>
      </SectionCard>
    </section>
  );
}
