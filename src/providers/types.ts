import type { z } from 'zod';
import { AgentFacingError } from '../errors.js';

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
    execute: async (input, context) => {
      const parsed = definition.inputSchema.safeParse(input);
      // The agent chose these arguments, so the validation message is its to see.
      if (!parsed.success) throw new AgentFacingError(`Invalid input for ${definition.name}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`);
      return definition.execute(parsed.data as z.infer<InputSchema>, context);
    },
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
