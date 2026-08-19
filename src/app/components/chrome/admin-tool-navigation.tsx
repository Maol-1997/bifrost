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
      <div className={cn('flex items-center rounded-md', isAdminRoute && 'bg-white/7 text-app-text-primary')}>
        <NavLink to={providerRoute('github')} className="flex min-h-11 min-w-0 flex-1 items-center px-2 text-[13px] text-app-text-tertiary hover:text-app-text-secondary lg:min-h-9" onClick={() => { setIsExpanded(true); }}>
          Tool administration
        </NavLink>
        <button type="button" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} Tool administration providers`} aria-expanded={isExpanded} aria-controls="admin-provider-navigation" className="flex size-11 shrink-0 items-center justify-center rounded-md text-app-text-quaternary hover:bg-white/5 hover:text-app-text-secondary lg:size-9" onClick={() => { setIsExpanded((current) => !current); }}>
          <ChevronRight aria-hidden className={cn('size-4 transition-transform duration-150 ease-out motion-reduce:transition-none', isExpanded && 'rotate-90')} />
        </button>
      </div>
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
