import type { z } from 'zod';

export type ProviderId = 'github' | 'linear' | 'slack';
export type ToolMutability = 'read' | 'write';

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  mutability: ToolMutability;
  inputSchema: z.ZodType;
  execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
};

export function defineTool<InputSchema extends z.ZodType>(definition: Omit<ToolDefinition, 'inputSchema' | 'execute'> & {
  inputSchema: InputSchema;
  execute: (input: z.infer<InputSchema>, context: ToolExecutionContext) => Promise<unknown>;
}): ToolDefinition {
  return {
    ...definition,
    execute: (input, context) => definition.execute(definition.inputSchema.parse(input), context),
  };
}

export type ToolExecutionContext = {
  userId: string;
  accessToken: string;
  requestId: string;
  signal: AbortSignal;
};

export type ProviderDefinition = {
  id: ProviderId;
  prefix: `${ProviderId}_`;
  displayName: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  tools: readonly ToolDefinition[];
  /**
   * Reads back the handle the user just authorized as, so Integrations can name
   * the real account instead of guessing. Called once, right after the token
   * exchange; a failure here must never fail the connection itself.
   */
  readAccountLabel: (accessToken: string, signal: AbortSignal) => Promise<string>;
};

export type ProviderMount = {
  providerId: ProviderId;
  isMounted: boolean;
  error?: string;
};
