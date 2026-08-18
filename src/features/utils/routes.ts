export const APP_ROUTES = {
  signIn: '/sign-in',
  connectionResult: '/connection-result',
  integrations: '/integrations',
  integrationDetail: '/integrations/:providerId',
  agents: '/agents',
  addAgent: '/agents/add',
  serviceStatus: '/service-status',
  accountSecurity: '/account-security',
} as const;

export function integrationDetailPath(providerId: string): string {
  return `${APP_ROUTES.integrations}/${providerId}`;
}
