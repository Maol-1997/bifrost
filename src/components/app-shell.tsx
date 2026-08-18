import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { BifrostMark } from '@/components/bifrost-mark';
import { cn, initialsOf } from '@/lib/utils';
import { useAppHealth, type AppHealthState } from '@/lib/use-app-health';
import { APP_ROUTES } from '@/lib/routes';
import { getCurrentUser, type CurrentUser, type HealthSnapshot } from '@/api/bifrost';

/** What the shell loads once and shares with every page under it. */
export type AppShellContext = { health: AppHealthState; user: CurrentUser | undefined };

const navItems: readonly { to: string; label: string }[] = [
  { to: APP_ROUTES.integrations, label: 'Integrations' },
  { to: APP_ROUTES.agents, label: 'Agents & sessions' },
  { to: APP_ROUTES.serviceStatus, label: 'Service status' },
];

function isActiveRoute(pathname: string, to: string): boolean {
  if (to === APP_ROUTES.integrations) return pathname.startsWith(APP_ROUTES.integrations);
  if (to === APP_ROUTES.agents) return pathname.startsWith(APP_ROUTES.agents);
  return pathname === to;
}

/** The badge reports every affected service, while red still signals any outage. */
function statusBadge(snapshot: HealthSnapshot | undefined): { text: string; className: string } | undefined {
  if (!snapshot) return undefined;
  const down = snapshot.apps.filter((app) => app.health === 'down').length;
  const degraded = snapshot.apps.filter((app) => app.health === 'degraded').length;
  const issues = down + degraded;
  if (issues > 0) return { text: `${issues} ${issues === 1 ? 'issue' : 'issues'}`, className: down > 0 ? 'bg-danger/15 text-danger' : 'bg-warning/15 text-warning' };
  return undefined;
}

export function AppShell(): React.JSX.Element {
  const location = useLocation();
  const health = useAppHealth();
  const [user, setUser] = useState<CurrentUser | undefined>(undefined);
  useEffect(() => { void getCurrentUser().then(setUser); }, []);
  const badge = statusBadge(health.snapshot);
  return (
    <div className="min-h-dvh bg-app-bg-primary text-app-text-primary lg:flex">
      <aside className="border-b-[0.5px] border-app-border-pane bg-app-bg-sidebar px-3 py-3 lg:fixed lg:inset-y-0 lg:w-(--sidebar-width) lg:border-r-[0.5px] lg:border-b-0">
        <div className="flex items-center gap-2 px-2 pb-3.5"><BifrostMark className="size-[22px]" /><span className="text-sm font-semibold tracking-[-0.01em]">Bifrost</span></div>
        <nav aria-label="Primary" className="flex gap-1 overflow-x-auto lg:flex-col">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} className={cn('flex min-h-9 shrink-0 items-center justify-between gap-3 rounded-md px-2 py-1.5 text-[13px] text-app-text-tertiary hover:bg-white/5 hover:text-app-text-secondary lg:min-h-0', isActiveRoute(location.pathname, item.to) && 'bg-white/7 font-semibold text-app-text-primary')}>
              <span>{item.label}</span>{item.to === APP_ROUTES.serviceStatus && badge ? <span className={cn('rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold', badge.className)}>{badge.text}</span> : null}
            </NavLink>
          ))}
          {user ? <NavLink to={APP_ROUTES.accountSecurity} className={({ isActive }) => cn('flex min-h-9 shrink-0 items-center rounded-md px-2 py-1.5 text-[13px] text-app-text-tertiary hover:bg-white/5 hover:text-app-text-secondary lg:hidden', isActive && 'bg-white/7 font-semibold text-app-text-primary')}>Account & security</NavLink> : null}
        </nav>
        {user ? (
          <NavLink to={APP_ROUTES.accountSecurity} aria-label="Account & security" className={({ isActive }) => cn('bottom-3 left-3 right-3 hidden items-center gap-2 rounded-lg p-2 text-app-text-primary hover:bg-white/5 lg:absolute lg:flex', isActive && 'bg-white/7')}>
            <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/25 text-[10.5px] font-semibold text-brand-hover">{initialsOf(user.name)}</div>
            <div className="min-w-0"><div className="truncate text-[12.5px] font-medium">{user.name}</div><div className="truncate text-[10.5px] text-app-text-quaternary">Account & security</div></div>
          </NavLink>
        ) : null}
      </aside>
      <main className="min-h-dvh flex-1 lg:ml-(--sidebar-width)">
        <div className="mx-auto max-w-[760px] px-5 pb-24 pt-8 sm:px-10 sm:pt-11"><Outlet context={{ health, user } satisfies AppShellContext} /></div>
      </main>
    </div>
  );
}
