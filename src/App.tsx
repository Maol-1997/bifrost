import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/app-shell';
import { ConnectionResultPage } from '@/pages/connection-result-page';
import { IntegrationsPage } from '@/pages/integrations-page';
import { AddAgentPage } from '@/pages/add-agent-page';
import { AgentsSessionsPage } from '@/pages/agents-sessions-page';
import { AccountSecurityPage } from '@/pages/account-security-page';
import { IntegrationDetailPage } from '@/pages/integration-detail-page';
import { SignInPage } from '@/pages/sign-in-page';
import { ServiceStatusPage } from '@/pages/service-status-page';
import { APP_ROUTES } from '@/lib/routes';

export function App(): React.JSX.Element {
  return (
    <Routes>
      <Route path={APP_ROUTES.signIn} element={<SignInPage />} />
      <Route path={APP_ROUTES.connectionResult} element={<ConnectionResultPage />} />
      <Route element={<AppShell />}>
        <Route path={APP_ROUTES.integrations} element={<IntegrationsPage />} />
        <Route path={APP_ROUTES.integrationDetail} element={<IntegrationDetailPage />} />
        <Route path={APP_ROUTES.addAgent} element={<AddAgentPage />} />
        <Route path={APP_ROUTES.agents} element={<AgentsSessionsPage />} />
        <Route path={APP_ROUTES.serviceStatus} element={<ServiceStatusPage />} />
        <Route path={APP_ROUTES.accountSecurity} element={<AccountSecurityPage />} />
      </Route>
      <Route path="*" element={<Navigate to={APP_ROUTES.integrations} replace />} />
    </Routes>
  );
}
