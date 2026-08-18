import { Link, useOutletContext } from 'react-router-dom';
import { PageHeader } from '@/components/page-header';
import { ProviderIcon } from '@/components/provider-icon';
import { SectionCard } from '@/components/section-card';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status';
import { clockTime, relativeTime } from '@/lib/time';
import { APP_ROUTES } from '@/lib/routes';
import type { AppShellContext } from '@/components/app-shell';
import { getProviderCatalog, type AppHealth } from '@/api/bifrost';

const DAY_MS = 86_400_000;

function healthDetail(app: AppHealth, appName: string): string {
  if (app.health === 'unknown') return `Couldn't reach ${appName}'s status page`;
  if (app.health === 'operational') {
    if (!app.quietSince) return 'No issues reported';
    // Under a day the streak is not the story — the recent recovery is, and
    // "no issues for 0 days" would read as a lie to anyone who felt the outage.
    const quietDays = Math.floor((Date.now() - new Date(app.quietSince).getTime()) / DAY_MS);
    if (quietDays < 1) return `Back to normal ${relativeTime(app.quietSince)}`;
    return `No issues for ${quietDays} ${quietDays === 1 ? 'day' : 'days'}`;
  }
  if (!app.since) return `${appName} reports a problem on their status page`;
  return app.incidentTitle ? `Since ${clockTime(app.since)} — ${app.incidentTitle}` : `Since ${clockTime(app.since)}`;
}

export function ServiceStatusPage(): React.JSX.Element {
  // The shell already polls this so its sidebar badge cannot contradict the table.
  const { snapshot, hasFailed, reload } = useOutletContext<AppShellContext>().health;
  const providerMap = new Map(getProviderCatalog().map((provider) => [provider.id, provider]));
  const outages = (snapshot?.apps ?? []).filter((app) => app.health === 'down');

  return (
    <section>
      <PageHeader title="Service status" subtitle={<>Whether each integration is working <em>for everyone</em>. If it's fine here but failing for you, check <Link to={APP_ROUTES.integrations}>Integrations</Link> and <Link to={APP_ROUTES.agents}>Agents & sessions</Link>.</>} />
      {outages.map((app) => {
        const name = providerMap.get(app.appId)?.name ?? app.appId;
        return (
          <div key={app.appId} className="mt-5 rounded-[9px] border border-danger/30 bg-danger/6 px-3.5 py-2.5 text-[12.5px] leading-5 text-danger">
            {name} is down for everyone{app.since ? ` since ${clockTime(app.since)}` : ''}. If your agent’s {name} tools fail right now, it’s not you.
          </div>
        );
      })}
      {!snapshot && !hasFailed ? <LoadingState label="Checking each service…" /> : null}
      {hasFailed && !snapshot ? <ErrorState title="Couldn't check the services" body="Bifrost could not reach the status pages. Your connections are unaffected." onRetry={reload} /> : null}
      {snapshot ? (
        <>
          <SectionCard className="mt-5">
            {snapshot.apps.map((app) => {
              const provider = providerMap.get(app.appId);
              const name = provider?.name ?? app.appId;
              return (
                <div key={app.appId} className="flex items-center gap-3 border-t border-white/6 p-3.5 first:border-t-0">
                  <ProviderIcon providerId={app.appId} monogram={provider?.monogram ?? '?'} />
                  <div className="flex-1 text-[13.5px] font-semibold">{name}</div>
                  <div className="text-right">
                    <StatusBadge status={app.health} />
                    <div className="mt-0.5 text-[11.5px] text-app-text-quaternary">{healthDetail(app, name)}</div>
                  </div>
                </div>
              );
            })}
          </SectionCard>
          <p className="mt-3.5 text-xs text-app-text-quaternary">Last checked {relativeTime(snapshot.checkedAt)} · updates automatically · times are your local time.</p>
        </>
      ) : null}
    </section>
  );
}
