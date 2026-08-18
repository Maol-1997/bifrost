import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CopyButton } from '@/components/copy-button';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { relativeTime } from '@/lib/time';
import { APP_ROUTES } from '@/lib/routes';
import { checkClientConnection, getMcpAddress, type ConnectedClient } from '@/api/bifrost';

type ClientTab = { id: string; label: string; steps: readonly string[]; command: (address: string) => string };

const clientTabs: readonly ClientTab[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    // `claude mcp add` defaults to stdio and would try to run the URL as a
    // command. Bifrost speaks Streamable HTTP, not the legacy two-endpoint SSE
    // transport, so the flag is `http`.
    steps: ['Open a terminal (the same one you run Claude Code from).', 'Run the command below.'],
    command: (address) => `claude mcp add --transport http bifrost ${address}`,
  },
  {
    id: 'codex',
    label: 'Codex',
    steps: ['Open a terminal.', 'Run the command below.'],
    command: (address) => `codex mcp add bifrost -- npx -y mcp-remote ${address}`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    // Paste rather than `>`: that file usually already holds other servers, and
    // a redirect would silently delete them.
    steps: ['Open ~/.cursor/mcp.json (create it if it isn’t there).', 'Add the entry below inside "mcpServers", then reload the Cursor window.'],
    command: (address) => `"bifrost": { "url": "${address}" }`,
  },
  {
    id: 'other',
    label: 'Something else',
    steps: ['Any program that supports MCP servers over HTTP works with Bifrost.', 'Give it the address below as the “MCP server URL”.', 'It has to support OAuth — almost all of them do, and it’s what saves you from pasting a secret.'],
    command: (address) => address,
  },
];

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'connected'; client: ConnectedClient }
  | { kind: 'waiting' };

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
  return <div className="flex items-center gap-2.5"><span className="flex size-5 items-center justify-center rounded-full bg-brand/22 text-[11px] font-semibold text-brand-hover">{number}</span><h2 className="text-[13.5px] font-semibold">{children}</h2></div>;
}

function CommandBlock({ value }: { value: string }): React.JSX.Element {
  return <div className="mt-2.5 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border-[0.5px] border-app-border-pane bg-black/30 px-3 py-2.5 font-mono text-xs text-app-text-secondary">{value}</code><CopyButton value={value} /></div>;
}

export function AddAgentPage(): React.JSX.Element {
  const [address, setAddress] = useState<string>();
  const [checkState, setCheckState] = useState<CheckState>({ kind: 'idle' });

  useEffect(() => { void getMcpAddress().then(setAddress); }, []);

  async function check(): Promise<void> {
    setCheckState({ kind: 'checking' });
    const client = await checkClientConnection();
    setCheckState(client ? { kind: 'connected', client } : { kind: 'waiting' });
  }

  return (
    <section>
      <Link to={APP_ROUTES.agents} className="mb-[18px] inline-flex min-h-11 items-center gap-1.5 text-[12.5px] text-app-text-tertiary hover:text-app-text-primary">← Agents & sessions</Link>
      <PageHeader title="Add an agent" subtitle="Connect Claude Code, Codex, Cursor or another agent app to Bifrost. You only need to do this once, and it takes about a minute." />
      <SectionCard className="mt-6 p-5">
        <StepHeading number="1">Copy your Bifrost address</StepHeading>
        <div className="mt-3 flex gap-2"><div className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg border-[0.5px] border-app-border-pane bg-black/30 px-3 py-2.5 font-mono text-[12.5px] text-app-text-secondary">{address ?? 'Loading…'}</div>{address ? <CopyButton value={address} /> : null}</div>
        <p className="mt-2 text-[11.5px] text-app-text-quaternary">The same address for everyone here. Your program proves it’s you in step 2, so there’s no key to keep secret.</p>
      </SectionCard>
      <SectionCard className="mt-3.5 p-5">
        <StepHeading number="2">Run this, then approve it in the browser</StepHeading>
        <Tabs defaultValue="claude-code" className="mt-3">
          <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b-[0.5px] border-app-border-pane bg-transparent p-0">
            {clientTabs.map((tab) => <TabsTrigger key={tab.id} value={tab.id} className="min-h-11 rounded-none border-b-2 border-transparent px-3 text-[12.5px] text-app-text-tertiary data-[state=active]:border-brand data-[state=active]:bg-transparent data-[state=active]:text-app-text-primary data-[state=active]:shadow-none">{tab.label}</TabsTrigger>)}
          </TabsList>
          {clientTabs.map((tab) => (
            <TabsContent key={tab.id} value={tab.id} className="mt-3.5">
              {tab.steps.map((step, index) => <div key={step} className="flex gap-2 py-1 text-[12.5px] leading-5 text-app-text-secondary"><span className="text-app-text-quaternary">{index + 1}.</span><span>{step}</span></div>)}
              {address ? <CommandBlock value={tab.command(address)} /> : null}
            </TabsContent>
          ))}
        </Tabs>
        <p className="mt-3 text-[11.5px] leading-[1.55] text-app-text-quaternary text-pretty">A browser tab will open asking you to authorize the program. Approve it once and it stays connected on its own — it renews itself in the background, so there’s nothing to redo later. You can disconnect it any time from Agents & sessions.</p>
      </SectionCard>
      <SectionCard className="mt-3.5 p-5">
        <StepHeading number="3">Check it worked</StepHeading>
        <p className="mt-2.5 text-[12.5px] leading-5 text-app-text-tertiary text-pretty">Ask your agent something simple, like <em className="text-app-text-secondary">“list my GitHub repositories”</em>. The moment it reaches Bifrost, this turns green.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className={`inline-flex min-h-9 items-center gap-2 rounded-full border-[0.5px] px-3 text-[12.5px] ${checkState.kind === 'connected' ? 'border-success/35 bg-success/7 text-success' : 'border-app-border-pane text-app-text-tertiary'}`}><span className={`size-[7px] rounded-full ${checkState.kind === 'connected' ? 'bg-success' : checkState.kind === 'checking' ? 'animate-design-blink bg-warning' : 'animate-design-blink bg-app-text-quaternary'}`} />{checkLabel(checkState)}</div>
          {checkState.kind === 'idle' || checkState.kind === 'waiting' ? <Button variant="outline" onClick={() => void check()}>I've done it — check now</Button> : null}
        </div>
        <p className="mt-3 text-[11.5px] text-app-text-quaternary">Stuck? <strong className="font-medium text-app-text-tertiary">#bifrost-help</strong> will get you going — no question is too basic.</p>
      </SectionCard>
    </section>
  );
}
