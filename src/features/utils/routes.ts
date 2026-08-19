export const APP_ROUTES = {
  signIn: '/sign-in',
  integrations: '/integrations',
  integrationDetail: '/integrations/:providerId',
  agents: '/agents',
  addAgent: '/agents/add',
  serviceStatus: '/service-status',
  accountSecurity: '/account-security',
  adminTools: '/admin/tools',
  adminToolDetail: '/admin/tools/:providerId',
} as const;
