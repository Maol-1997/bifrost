import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@app/components/chrome/app-shell';
import { APP_ROUTES } from '@features/utils/routes';

const AccountSecurity = lazy(() => import('./account-security/page'));
const AgentSetup = lazy(() => import('./agents/add/page'));
const AgentSessions = lazy(() => import('./agents/page'));
const ConnectionResult = lazy(() => import('./connection-result/page'));
const IntegrationDetail = lazy(() => import('./integrations/[providerId]/page'));
const Integrations = lazy(() => import('./integrations/page'));
const ServiceStatus = lazy(() => import('./service-status/page'));
const SignIn = lazy(() => import('./sign-in/page'));

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
        </Route>
        <Route path="*" element={<Navigate to={APP_ROUTES.integrations} replace />} />
      </Routes>
    </Suspense>
  );
}
