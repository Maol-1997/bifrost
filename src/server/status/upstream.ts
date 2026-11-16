import { z } from 'zod';
import { errorSummary, logger } from '../logger.js';

/**
 * Reads the public status pages of the apps Bifrost proxies.
 *
 * These are the vendors' own uptime feeds, not our view of them: this page
 * answers "is GitHub broken for everyone?", which is the question a user asks
 * before blaming their own connection. Nothing here is authenticated and
 * nothing here is user-specific.
 */

const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;

export const STATUS_APP_IDS = ['github', 'linear', 'sentry', 'slack', 'notion', 'granola'] as const;
export type StatusAppId = (typeof STATUS_APP_IDS)[number];

/** `unknown` means we could not reach or parse the vendor's feed — never that they are fine. */
export type SystemHealth = 'operational' | 'degraded' | 'down' | 'unknown';

export type AppHealth = {
  appId: StatusAppId;
  health: SystemHealth;
  statusUrl: string;
  incidentTitle?: string;
  /** ISO start of the open incident. Absent unless something is currently wrong. */
  since?: string;
  /** ISO resolution of the vendor's last incident. Absent when their feed has no history. */
  quietSince?: string;
};

export type HealthSnapshot = { checkedAt: string; apps: readonly AppHealth[] };

// Every one of these is a Statuspage tenant, so they share the v2 REST shape.
// Slack is the exception and gets its own reader below.
const STATUSPAGE_HOSTS = {
  granola: 'https://status.granola.ai',
  github: 'https://www.githubstatus.com',
  linear: 'https://linearstatus.com',
  sentry: 'https://status.sentry.io',
  notion: 'https://www.notion-status.com',
} as const satisfies Partial<Record<StatusAppId, string>>;

const SLACK_STATUS_URL = 'https://slack-status.com';

const statuspageStatusSchema = z.object({
  status: z.object({ indicator: z.enum(['none', 'minor', 'major', 'critical', 'maintenance']) }),
});

const statuspageIncidentsSchema = z.object({
  incidents: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      created_at: z.string(),
      resolved_at: z.string().nullish(),
    }),
  ),
});

const slackCurrentSchema = z.object({
  status: z.enum(['ok', 'active']),
  // Slack does not publish the full set of incident types, so we read it as a
  // string and treat anything we do not recognize as degraded. `status: active`
  // already proves something is wrong, so this can never under-report an outage.
  active_incidents: z.array(z.object({ title: z.string(), type: z.string(), date_created: z.string() })).default([]),
});

const slackHistorySchema = z.array(z.object({ status: z.string(), date_updated: z.string() }));

// Public, unauthenticated, identical for every user, so a per-process cache is
// enough — sharing it through Redis would only save the vendors a handful of
// requests per minute and would couple this module to the coordinator.
let cachedSnapshot: { snapshot: HealthSnapshot; expiresAt: number } | undefined;
let inFlight: Promise<HealthSnapshot> | undefined;

/**
 * Current health of every app Bifrost proxies, straight from the vendors' own
 * status feeds.
 *
 * Cached for a minute and single-flighted: this endpoint is public, so a burst
 * of callers on a cold cache must still produce exactly one fan-out upstream.
 * That guarantee is what makes it safe to serve without authentication.
 */
export async function readAppHealth(): Promise<HealthSnapshot> {
  if (cachedSnapshot && cachedSnapshot.expiresAt > Date.now()) return cachedSnapshot.snapshot;
  inFlight ??= refresh().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function refresh(): Promise<HealthSnapshot> {
  const apps = await Promise.all(STATUS_APP_IDS.map((appId) => readOneApp(appId)));
  const snapshot: HealthSnapshot = { checkedAt: new Date().toISOString(), apps };
  cachedSnapshot = { snapshot, expiresAt: Date.now() + CACHE_TTL_MS };
  return snapshot;
}

async function readOneApp(appId: StatusAppId): Promise<AppHealth> {
  const statusUrl = appId === 'slack' ? SLACK_STATUS_URL : STATUSPAGE_HOSTS[appId];
  try {
    return appId === 'slack' ? await readSlack() : await readStatuspage(appId, STATUSPAGE_HOSTS[appId]);
  } catch (error) {
    // A vendor's status page being unreachable says nothing about the vendor, so
    // we surface "unknown" rather than guessing in either direction.
    logger.warn({ ...errorSummary(error), appId }, 'Upstream status feed is unreadable');
    return { appId, health: 'unknown', statusUrl };
  }
}

async function readStatuspage(appId: StatusAppId, host: string): Promise<AppHealth> {
  const [status, history] = await Promise.all([
    fetchJson(`${host}/api/v2/status.json`, statuspageStatusSchema),
    fetchJson(`${host}/api/v2/incidents.json`, statuspageIncidentsSchema),
  ]);
  const health = statuspageHealth(status.status.indicator);
  const base = { appId, health, statusUrl: host };
  if (health === 'operational') return { ...base, ...quietSince(latestResolvedAt(history.incidents)) };
  const open = history.incidents.find(
    (incident) => incident.resolved_at === null || incident.resolved_at === undefined,
  );
  return open ? { ...base, incidentTitle: open.name, since: open.created_at } : base;
}

async function readSlack(): Promise<AppHealth> {
  const [current, history] = await Promise.all([
    fetchJson(`${SLACK_STATUS_URL}/api/v2.0.0/current`, slackCurrentSchema),
    fetchJson(`${SLACK_STATUS_URL}/api/v2.0.0/history`, slackHistorySchema),
  ]);
  const resolvedAt = history
    .filter((incident) => incident.status !== 'active')
    .map((incident) => incident.date_updated)
    .sort()
    .at(-1);
  if (current.status === 'ok') {
    return { appId: 'slack', health: 'operational', statusUrl: SLACK_STATUS_URL, ...quietSince(resolvedAt) };
  }
  const worst = current.active_incidents.find((incident) => incident.type === 'outage') ?? current.active_incidents[0];
  const health: SystemHealth = worst?.type === 'outage' ? 'down' : 'degraded';
  const base = { appId: 'slack' as const, health, statusUrl: SLACK_STATUS_URL };
  return worst ? { ...base, incidentTitle: worst.title, since: worst.date_created } : base;
}

export type StatuspageIndicator = z.infer<typeof statuspageStatusSchema>['status']['indicator'];

/**
 * Statuspage's five indicators collapsed onto our three. Scheduled maintenance
 * counts as degraded rather than operational: from an agent's point of view a
 * planned outage still fails its tool calls.
 */
export function statuspageHealth(indicator: StatuspageIndicator): SystemHealth {
  switch (indicator) {
    case 'none':
      return 'operational';
    case 'minor':
    case 'maintenance':
      return 'degraded';
    case 'major':
    case 'critical':
      return 'down';
  }
}

function latestResolvedAt(incidents: z.infer<typeof statuspageIncidentsSchema>['incidents']): string | undefined {
  return incidents
    .map((incident) => incident.resolved_at)
    .filter((resolvedAt): resolvedAt is string => typeof resolvedAt === 'string')
    .sort()
    .at(-1);
}

function quietSince(resolvedAt: string | undefined): { quietSince?: string } {
  if (!resolvedAt) return {};
  const resolved = new Date(resolvedAt);
  // A vendor with a clock-skewed or malformed timestamp should read as "no
  // history", never as a suspiciously long quiet streak.
  if (Number.isNaN(resolved.getTime()) || resolved.getTime() > Date.now()) return {};
  return { quietSince: resolved.toISOString() };
}

async function fetchJson<Schema extends z.ZodType>(url: string, schema: Schema): Promise<z.infer<Schema>> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': 'bifrost-status-reader' },
  });
  if (!response.ok) throw new Error(`Status feed ${url} responded ${response.status}`);
  return schema.parse(await response.json()) as z.infer<Schema>;
}
