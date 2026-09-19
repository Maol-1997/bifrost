import { lazy, Suspense, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { BifrostNewChatLoadingState } from '@app/components/bifrost-new-chat';
import { BifrostMark } from '@app/components/ui/bifrost-mark';
import { DownloadAppsIcon } from '@app/components/ui/icons/download-apps-icon';
import { IntegrationsIcon } from '@app/components/ui/icons/integrations-icon';
import type { LinearIconProps } from '@app/components/ui/icons/linear-icon';
import { PulseIcon } from '@app/components/ui/icons/pulse-icon';
import { SidebarAgentIcon } from '@app/components/ui/icons/sidebar-agent-icon';
import { Sidebar, SidebarBackdrop, SidebarContent, SidebarGroup, SidebarHeader, SidebarLink, SidebarMobileHeader, SidebarSpacer, SidebarTrigger } from '@app/components/ui/sidebar';
import { cn } from '@app/lib/cn';
import { initialsOf } from '@app/lib/initials';
import { getCurrentUser, type CurrentUser, type HealthSnapshot } from '@app/api/bifrost';
import { claimPersistedQueries } from '@app/api/persister';
import { useLiveInvalidations } from '@app/api/use-live-invalidations';
import { APP_ROUTES } from '@features/utils/routes';
import { AdminToolNavigation } from './admin-tool-navigation';
import { useAppHealth, type AppHealthState } from './use-app-health';

const Chat = lazy(() => import('@app/chat/chat'));

/** What the shell loads once and shares with every page under it. */
export type AppShellContext = { health: AppHealthState; user: CurrentUser | null | undefined };

const navItems: readonly { to: string; label: string; icon: React.ComponentType<LinearIconProps> }[] = [
  { to: APP_ROUTES.chat, label: 'Agent', icon: SidebarAgentIcon },
  { to: APP_ROUTES.integrations, label: 'Integrations', icon: IntegrationsIcon },
  { to: APP_ROUTES.agents, label: 'Sessions', icon: DownloadAppsIcon },
  { to: APP_ROUTES.serviceStatus, label: 'Service status', icon: PulseIcon },
];

function isActiveRoute(pathname: string, to: string): boolean {
  if (to === APP_ROUTES.chat) return pathname === APP_ROUTES.chat;
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
  const isChat = location.pathname === APP_ROUTES.chat;
  const [agentToolbarHost, setAgentToolbarHost] = useState<HTMLDivElement | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const health = useAppHealth();
  const queryClient = useQueryClient();
  const { data: user } = useQuery({ queryKey: ['current-user'], queryFn: getCurrentUser });
  const userEmail = user?.email;
  useLiveInvalidations(Boolean(user));

  useEffect(() => {
    if (userEmail === undefined) return;
    void claimPersistedQueries(queryClient, userEmail).catch(() => undefined);
  }, [queryClient, userEmail]);
  const badge = statusBadge(health.snapshot);

  useEffect(() => {
    setIsSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!isSidebarOpen) return;
    function closeSidebarWithEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setIsSidebarOpen(false);
    }
    window.addEventListener('keydown', closeSidebarWithEscape);
    return () => { window.removeEventListener('keydown', closeSidebarWithEscape); };
  }, [isSidebarOpen]);

  return (
    <div className="flex h-dvh min-w-0 overflow-hidden bg-linear-sidebar-background text-linear-foreground">
      <SidebarBackdrop open={isSidebarOpen} aria-label="Close navigation" onClick={() => { setIsSidebarOpen(false); }} />
      <Sidebar id="bifrost-sidebar" aria-label="Primary navigation" open={isSidebarOpen} onOpenChange={setIsSidebarOpen}>
        <SidebarHeader className="h-auto px-4 pb-5">
          <div className="flex select-none items-center gap-2"><BifrostMark className="size-[22px]" /><span className="text-sm font-semibold text-linear-bright">Bifrost</span></div>
        </SidebarHeader>
        <SidebarContent className="pt-2">
          <SidebarGroup>
            <nav aria-label="Primary">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
                <SidebarLink key={item.to} asChild active={isActiveRoute(location.pathname, item.to)}>
                  <NavLink to={item.to}>
                    <Icon aria-hidden="true" />
                    <span>{item.label}</span>{item.to === APP_ROUTES.serviceStatus && badge ? <span className={cn('ml-auto rounded-full px-1.5 py-0.5 text-xs font-semibold', badge.className)}>{badge.text}</span> : null}
                  </NavLink>
                </SidebarLink>
            );
          })}
            </nav>
          </SidebarGroup>
          {user?.isAdmin ? <AdminToolNavigation /> : null}
        </SidebarContent>
        {user ? (
          <SidebarLink asChild active={location.pathname === APP_ROUTES.accountSecurity} className="mb-3 h-auto py-2">
            <NavLink to={APP_ROUTES.accountSecurity} aria-label="Account & security">
            <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/25 text-xs font-semibold text-brand-hover">{initialsOf(user.name)}</div>
            <div className="min-w-0"><div className="truncate text-xs font-medium">{user.name}</div><div className="truncate text-xs text-app-text-quaternary">Account & security</div></div>
            </NavLink>
          </SidebarLink>
        ) : null}
      </Sidebar>
      <SidebarSpacer />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <main className={cn('flex min-h-0 min-w-0 flex-1 flex-col bg-linear-gallery-main min-[1025px]:mr-2 min-[1025px]:mt-2 min-[1025px]:rounded-xl min-[1025px]:linear-border-hairline min-[1025px]:border-linear-border min-[1025px]:shadow-linear-control', isChat ? 'overflow-hidden' : 'overflow-y-auto')}>
          <SidebarMobileHeader>
            <SidebarTrigger aria-label="Open navigation" aria-controls="bifrost-sidebar" aria-expanded={isSidebarOpen} onClick={() => { setIsSidebarOpen(true); }} />
            <span className="font-medium text-linear-bright">Bifrost</span>
          </SidebarMobileHeader>
          <Suspense fallback={isChat ? <BifrostNewChatLoadingState /> : null}>
            <Chat
              active={isChat}
              toolbarHost={agentToolbarHost}
              {...(user ? { owner: user.email } : {})}
            />
          </Suspense>
          {!isChat ? (
            <div className={cn(
              'mx-auto w-full px-5 pb-24 pt-8 sm:px-10 sm:pt-11',
              location.pathname.startsWith(APP_ROUTES.adminTools) ? 'max-w-5xl' : 'max-w-[760px]',
            )}>
              <Outlet context={{ health, user } satisfies AppShellContext} />
            </div>
          ) : null}
        </main>
        <div className="relative h-9 shrink-0 bg-linear-sidebar-background max-[1024px]:hidden">
          <div ref={setAgentToolbarHost} className="absolute inset-x-0 top-1 h-7" />
        </div>
      </div>
    </div>
  );
}
