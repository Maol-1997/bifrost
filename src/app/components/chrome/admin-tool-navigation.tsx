import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { getProviderCatalog, isConnectableProvider } from '@app/api/bifrost';
import { ProviderIcon } from '@app/components/ui/provider-icon';
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
    <div className="shrink-0">
      <button type="button" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} Tool administration providers`} aria-expanded={isExpanded} aria-controls="admin-provider-navigation" className={cn('flex min-h-11 w-full touch-manipulation items-center justify-between rounded-md px-2 text-left text-[13px] text-app-text-tertiary hover:bg-white/5 hover:text-app-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand', isAdminRoute && 'bg-white/7 text-app-text-primary')} onClick={() => { setIsExpanded((current) => !current); }}>
        <span>Tool administration</span>
        <span className="flex size-9 shrink-0 items-center justify-center text-app-text-quaternary">
          <ChevronRight aria-hidden className={cn('size-4 transition-transform duration-150 ease-out motion-reduce:transition-none', isExpanded && 'rotate-90')} />
        </span>
      </button>
      {isExpanded ? (
        <div id="admin-provider-navigation" className="mt-1 flex gap-1 lg:flex-col lg:pl-2">
          {providers.map((provider) => {
            const isActive = isAdminRoute && activeProviderId === provider.id;
            return (
              <NavLink key={provider.id} to={providerRoute(provider.id)} aria-current={isActive ? 'page' : undefined} className={cn('flex min-h-11 shrink-0 items-center gap-2 rounded-md px-2 text-[12.5px] text-app-text-tertiary hover:bg-white/5 hover:text-app-text-secondary lg:min-h-9', isActive && 'bg-white/7 text-app-text-primary')}>
                <ProviderIcon providerId={provider.id} monogram={provider.monogram} size="sm" />
                <span>{provider.name}</span>
              </NavLink>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
