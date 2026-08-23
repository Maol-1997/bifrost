export const APP_ROUTES = {
  signIn: '/sign-in',
  integrations: '/integrations',
  integrationDetail: '/integrations/:providerId',
  chat: '/chat',
  agents: '/agents',
  addAgent: '/agents/add',
  serviceStatus: '/service-status',
  accountSecurity: '/account-security',
  adminTools: '/admin/tools',
  adminToolDetail: '/admin/tools/:providerId',
} as const;

const DYNAMIC_ROUTE_SEGMENT = /\/:[^/]+/g;

export const SPA_FALLBACK_ROUTES: readonly string[] = [...new Set([
  '/',
  ...Object.values(APP_ROUTES).map((route) => route.replace(DYNAMIC_ROUTE_SEGMENT, '/*')),
])];
