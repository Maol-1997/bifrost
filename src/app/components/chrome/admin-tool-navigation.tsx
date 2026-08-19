import { useState } from 'react';
import { ChevronRight, Wrench } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { getProviderCatalog, isConnectableProvider } from '@app/api/bifrost';
import { Button } from '@app/components/ui/button';
import { ProviderIcon } from '@app/components/ui/provider-icon';
import { SidebarGroup, SidebarLink } from '@app/components/ui/sidebar';
import { cn } from '@app/lib/cn';
import { APP_ROUTES } from '@features/utils/routes';

const providers = getProviderCatalog().filter((provider) => isConnectableProvider(provider.id));

function providerRoute(providerId: string): string {
  return `${APP_ROUTES.adminTools}/${providerId}`;
}

export function AdminToolNavigation(): React.JSX.Element {
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith(APP_ROUTES.adminTools);
  const activeProviderId = location.pathname.slice(`${APP_ROUTES.adminTools}/`.length);
  const [isExpanded, setIsExpanded] = useState(isAdminRoute);
  return (
    <SidebarGroup>
      <Button type="button" variant="muted" size="compact" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} Tool administration providers`} aria-expanded={isExpanded} aria-controls="admin-provider-navigation" className={cn('mx-3 w-[220px] justify-between rounded-lg', isAdminRoute && 'bg-linear-sidebar-active text-linear-bright')} onClick={() => { setIsExpanded((current) => !current); }}>
        <span className="flex min-w-0 items-center gap-1.5">
          <Wrench aria-hidden="true" className="size-4" />
          <span className="truncate">Tool administration</span>
        </span>
        <span className="flex size-4 shrink-0 items-center justify-center text-linear-input-disabled">
          <ChevronRight aria-hidden className={cn('size-4 transition-transform duration-150 ease-out motion-reduce:transition-none', isExpanded && 'rotate-90')} />
        </span>
      </Button>
      {isExpanded ? (
        <div id="admin-provider-navigation" className="mt-1">
          {providers.map((provider) => {
            const isActive = isAdminRoute && activeProviderId === provider.id;
            return (
              <SidebarLink key={provider.id} asChild active={isActive} className="pl-5">
                <NavLink to={providerRoute(provider.id)}>
                  <ProviderIcon providerId={provider.id} monogram={provider.monogram} size="sidebar" />
                  <span>{provider.name}</span>
                </NavLink>
              </SidebarLink>
            );
          })}
        </div>
      ) : null}
    </SidebarGroup>
  );
}
