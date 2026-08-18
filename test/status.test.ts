import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeClient } from '../src/clients/describe.js';
import { statuspageHealth, type AppHealth, type HealthSnapshot, type StatusAppId, type StatuspageIndicator } from '../src/status/upstream.js';

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  errorSummary: (error: unknown) => ({ errorType: 'Error', message: String(error) }),
}));

describe('statuspage severity mapping', () => {
  it('never reports a non-none indicator as operational', () => {
    const indicators: readonly StatuspageIndicator[] = ['minor', 'major', 'critical', 'maintenance'];

    expect(indicators.map(statuspageHealth)).toEqual(['degraded', 'down', 'down', 'degraded']);
    expect(statuspageHealth('none')).toBe('operational');
  });
});

describe('client identification', () => {
  it('names the clients we know from their user agent', () => {
    expect(describeClient('mcp', 'claude-cli/1.4.2 (external, cli)').name).toBe('Claude Code');
    expect(describeClient('mcp', 'Cursor/0.45.1').name).toBe('Cursor');
    expect(describeClient('bifrost-web', 'Mozilla/5.0').name).toBe('Bifrost web');
  });

  it('shows an unrecognized client verbatim instead of inventing a name', () => {
    // A client the user cannot identify is the one they may want to revoke, so
    // guessing a friendly label here would hide exactly the wrong thing.
    expect(describeClient('mcp', 'weird-agent/9.9 (unknown)')).toEqual({ name: 'weird-agent', monogram: 'we', logo: undefined });
    expect(describeClient('mcp', undefined)).toEqual({ name: 'mcp', monogram: 'mc', logo: undefined });
  });

  it('hands the clients we ship a mark for their own logo', () => {
    expect(describeClient('mcp', 'claude-code/2.1.234 (cli)').logo).toBe('claude-code');
    expect(describeClient('mcp', 'codex_cli_rs/0.5.0').logo).toBe('codex');
    expect(describeClient('mcp', 'Cursor/0.45.1').logo).toBe('cursor');
    expect(describeClient('opencode', undefined).logo).toBe('opencode');
  });

  it('keeps OpenCode and Codex apart', () => {
    // Two different products whose names both end in "code[x]". Reading one as
    // the other would put the wrong company's logo on the user's screen.
    expect(describeClient('opencode', 'opencode/0.4.1').name).toBe('OpenCode');
    expect(describeClient('mcp', 'codex/0.5.0').name).toBe('Codex');
  });

  it('leaves a recognized client without a mark on its monogram', () => {
    expect(describeClient('mcp', 'Windsurf/1.2.0').logo).toBeUndefined();
    expect(describeClient('mcp', 'Windsurf/1.2.0').monogram).toBe('Wi');
  });
});

type FeedTable = Record<string, () => Response>;

const STATUSPAGE_HOSTS = {
  github: 'https://www.githubstatus.com',
  linear: 'https://linearstatus.com',
  notion: 'https://www.notion-status.com',
} as const;
const SLACK_HOST = 'https://slack-status.com';
const CHECKED_AT = new Date('2026-08-18T12:00:00.000Z');
const CACHE_TTL_MS = 60_000;

function jsonFeed(body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { status: 200 });
}

function statuspageFeeds(host: string, status: unknown, incidents: unknown): FeedTable {
  return {
    [`${host}/api/v2/status.json`]: jsonFeed(status),
    [`${host}/api/v2/incidents.json`]: jsonFeed(incidents),
  };
}

function healthyStatuspage(host: string): FeedTable {
  return statuspageFeeds(host, { status: { indicator: 'none' } }, { incidents: [] });
}

function slackFeeds(current: unknown, history: unknown): FeedTable {
  return {
    [`${SLACK_HOST}/api/v2.0.0/current`]: jsonFeed(current),
    [`${SLACK_HOST}/api/v2.0.0/history`]: jsonFeed(history),
  };
}

function healthySlack(): FeedTable {
  return slackFeeds({ status: 'ok', active_incidents: [] }, []);
}

function allHealthyFeeds(): FeedTable {
  return {
    ...healthyStatuspage(STATUSPAGE_HOSTS.github),
    ...healthyStatuspage(STATUSPAGE_HOSTS.linear),
    ...healthyStatuspage(STATUSPAGE_HOSTS.notion),
    ...healthySlack(),
  };
}

let fetchedUrls: string[] = [];

/**
 * A fresh copy of the module per test: its cache and single-flight promise live
 * at module scope, so one test's snapshot would otherwise answer the next one.
 */
async function loadStatusReader(feeds: FeedTable): Promise<typeof import('../src/status/upstream.js')> {
  vi.resetModules();
  fetchedUrls = [];
  vi.stubGlobal('fetch', (input: string | URL): Promise<Response> => {
    const url = input.toString();
    fetchedUrls.push(url);
    const feed = feeds[url];
    return feed ? Promise.resolve(feed()) : Promise.reject(new Error(`unstubbed status feed: ${url}`));
  });
  return import('../src/status/upstream.js');
}

function appHealth(snapshot: HealthSnapshot, appId: StatusAppId): AppHealth {
  const app = snapshot.apps.find((entry) => entry.appId === appId);
  if (!app) throw new Error(`snapshot carries no health for ${appId}`);
  return app;
}

describe('reading the vendors status feeds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CHECKED_AT);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fans out once for a burst of callers on a cold cache', async () => {
    const feeds = allHealthyFeeds();
    const { readAppHealth } = await loadStatusReader(feeds);

    const snapshots = await Promise.all(Array.from({ length: 5 }, () => readAppHealth()));

    expect(new Set(snapshots).size).toBe(1);
    // This endpoint is public, so five callers must not become five fan-outs.
    expect(fetchedUrls.toSorted()).toEqual(Object.keys(feeds).toSorted());
  });

  it('serves the cache for a minute and refetches the moment it expires', async () => {
    const { readAppHealth } = await loadStatusReader(allHealthyFeeds());
    const first = await readAppHealth();

    vi.setSystemTime(CHECKED_AT.getTime() + CACHE_TTL_MS - 1);
    expect(await readAppHealth()).toBe(first);
    expect(fetchedUrls).toHaveLength(8);

    vi.setSystemTime(CHECKED_AT.getTime() + CACHE_TTL_MS);
    expect(await readAppHealth()).not.toBe(first);
    expect(fetchedUrls).toHaveLength(16);
  });

  it('reports a major Statuspage indicator as down, named after the open incident', async () => {
    const { readAppHealth } = await loadStatusReader({
      ...allHealthyFeeds(),
      ...statuspageFeeds(
        STATUSPAGE_HOSTS.github,
        { status: { indicator: 'major' } },
        { incidents: [{ name: 'Elevated errors on the API', status: 'investigating', created_at: '2026-08-18T11:30:00.000Z', resolved_at: null }] },
      ),
    });

    expect(appHealth(await readAppHealth(), 'github')).toEqual({
      appId: 'github',
      health: 'down',
      statusUrl: STATUSPAGE_HOSTS.github,
      incidentTitle: 'Elevated errors on the API',
      since: '2026-08-18T11:30:00.000Z',
    });
  });

  it('reports a Slack outage as down', async () => {
    const { readAppHealth } = await loadStatusReader({
      ...allHealthyFeeds(),
      ...slackFeeds(
        { status: 'active', active_incidents: [{ title: 'Message sending is failing', type: 'outage', date_created: '2026-08-18T11:00:00.000Z' }] },
        [],
      ),
    });

    expect(appHealth(await readAppHealth(), 'slack')).toEqual({
      appId: 'slack',
      health: 'down',
      statusUrl: SLACK_HOST,
      incidentTitle: 'Message sending is failing',
      since: '2026-08-18T11:00:00.000Z',
    });
  });

  it('reports a Slack incident type it does not recognize as degraded', async () => {
    // Slack does not publish its full set of types, so an unknown one still has
    // to read as trouble: `status: active` already proves something is wrong.
    const { readAppHealth } = await loadStatusReader({
      ...allHealthyFeeds(),
      ...slackFeeds(
        { status: 'active', active_incidents: [{ title: 'Some links are slow to unfurl', type: 'incident', date_created: '2026-08-18T11:00:00.000Z' }] },
        [],
      ),
    });

    const slack = appHealth(await readAppHealth(), 'slack');
    expect(slack.health).toBe('degraded');
    expect(slack.incidentTitle).toBe('Some links are slow to unfurl');
  });

  it('marks only the unreadable feed unknown and still reports the rest', async () => {
    const { readAppHealth } = await loadStatusReader({
      ...allHealthyFeeds(),
      [`${STATUSPAGE_HOSTS.linear}/api/v2/status.json`]: () => new Response('gateway timeout', { status: 504 }),
    });

    const snapshot = await readAppHealth();

    // Unknown, never operational: a vendor's status page being down says
    // nothing about the vendor.
    expect(appHealth(snapshot, 'linear')).toEqual({ appId: 'linear', health: 'unknown', statusUrl: STATUSPAGE_HOSTS.linear });
    const unaffected: readonly StatusAppId[] = ['github', 'notion', 'slack'];
    expect(unaffected.map((appId) => appHealth(snapshot, appId).health)).toEqual(['operational', 'operational', 'operational']);
  });

  it('reads a malformed resolution timestamp as no history rather than a quiet streak', async () => {
    const { readAppHealth } = await loadStatusReader({
      ...allHealthyFeeds(),
      ...statuspageFeeds(
        STATUSPAGE_HOSTS.notion,
        { status: { indicator: 'none' } },
        { incidents: [{ name: 'Search was degraded', status: 'resolved', created_at: '2026-08-01T09:00:00.000Z', resolved_at: 'not-a-date' }] },
      ),
    });

    expect(appHealth(await readAppHealth(), 'notion')).toEqual({ appId: 'notion', health: 'operational', statusUrl: STATUSPAGE_HOSTS.notion });
  });
});
