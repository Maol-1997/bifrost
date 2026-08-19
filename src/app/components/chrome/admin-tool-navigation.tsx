import { Wrench } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { getProviderCatalog, isConnectableProvider } from '@app/api/bifrost';
import { ProviderIcon } from '@app/components/ui/provider-icon';
import { SidebarCollapsible, SidebarCollapsibleContent, SidebarCollapsibleTrigger, SidebarGroup, SidebarNestedLink } from '@app/components/ui/sidebar';
import { APP_ROUTES } from '@features/utils/routes';

const providers = getProviderCatalog().filter((provider) => isConnectableProvider(provider.id));

function providerRoute(providerId: string): string {
  return `${APP_ROUTES.adminTools}/${providerId}`;
}

export function AdminToolNavigation(): React.JSX.Element {
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith(APP_ROUTES.adminTools);
  const activeProviderId = location.pathname.slice(`${APP_ROUTES.adminTools}/`.length);
  return (
    <SidebarGroup>
      <SidebarCollapsible defaultOpen={isAdminRoute}>
        <SidebarCollapsibleTrigger variant="team">
          <Wrench aria-hidden="true" className="size-4" />
          <span className="truncate">Tool administration</span>
        </SidebarCollapsibleTrigger>
        <SidebarCollapsibleContent>
          <nav aria-label="Tool administration providers">
          {providers.map((provider) => {
            const isActive = isAdminRoute && activeProviderId === provider.id;
            return (
              <SidebarNestedLink key={provider.id} asChild active={isActive}>
                <NavLink to={providerRoute(provider.id)}>
                  <ProviderIcon providerId={provider.id} monogram={provider.monogram} size="sidebar" />
                  <span>{provider.name}</span>
                </NavLink>
              </SidebarNestedLink>
            );
          })}
          </nav>
        </SidebarCollapsibleContent>
      </SidebarCollapsible>
    </SidebarGroup>
  );
}
