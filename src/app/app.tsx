import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@app/components/chrome/app-shell';
import { APP_ROUTES } from '@features/utils/routes';

const AccountSecurity = lazy(() => import('./account-security/account-security'));
const AgentSetup = lazy(() => import('./agents/add/add-agent'));
const AgentSessions = lazy(() => import('./agents/agents'));
const AdminTools = lazy(() => import('./admin-tools/admin-tools'));
const ConnectionResult = lazy(() => import('./connection-result/connection-result'));
const IntegrationDetail = lazy(() => import('./integrations/[providerId]/integration-detail'));
const Integrations = lazy(() => import('./integrations/integrations'));
const ServiceStatus = lazy(() => import('./service-status/service-status'));
const SignIn = lazy(() => import('./sign-in/sign-in'));
const DEFAULT_ADMIN_TOOLS_ROUTE = `${APP_ROUTES.adminTools}/github`;

export function App(): React.JSX.Element {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-app-bg-primary" />}>
      <Routes>
        <Route path={APP_ROUTES.signIn} element={<SignIn />} />
        <Route path={APP_ROUTES.connectionResult} element={<ConnectionResult />} />
        <Route element={<AppShell />}>
          <Route path={APP_ROUTES.integrations} element={<Integrations />} />
          <Route path={APP_ROUTES.integrationDetail} element={<IntegrationDetail />} />
          <Route path={APP_ROUTES.addAgent} element={<AgentSetup />} />
          <Route path={APP_ROUTES.agents} element={<AgentSessions />} />
          <Route path={APP_ROUTES.serviceStatus} element={<ServiceStatus />} />
          <Route path={APP_ROUTES.accountSecurity} element={<AccountSecurity />} />
          <Route path={APP_ROUTES.adminTools} element={<Navigate to={DEFAULT_ADMIN_TOOLS_ROUTE} replace />} />
          <Route path={APP_ROUTES.adminToolDetail} element={<AdminTools />} />
        </Route>
        <Route path="*" element={<Navigate to={APP_ROUTES.integrations} replace />} />
      </Routes>
    </Suspense>
  );
}
