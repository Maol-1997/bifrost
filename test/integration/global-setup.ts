import { integrationEnvironment, resetIntegrationDatabase } from './environment.js';

export default async function setup(): Promise<void> {
  await resetIntegrationDatabase(integrationEnvironment().databaseUrl);
}
