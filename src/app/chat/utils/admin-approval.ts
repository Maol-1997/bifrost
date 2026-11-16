import { z } from 'zod';

export type AdminApprovalSummary = {
  title: string;
  details: readonly string[];
};

const POLICY_LABELS: Readonly<Record<string, string>> = {
  blocked: 'blocked',
  allowed_default_off: 'allowed, off by default',
  allowed_default_on: 'allowed, on by default',
};

const policyChangesSchema = z.object({
  providerId: z.string(),
  changes: z.array(z.object({ toolName: z.string(), state: z.string() })),
});
const ruleSchema = z.object({ providerId: z.string(), instructions: z.string() });
const providerSchema = z.object({ providerId: z.string() });

/**
 * What the administrator is approving, in words. Built from the exact input
 * the server will run, so the card shows every tool in a batch.
 */
export function describeAdminApproval(toolName: string, input: unknown): AdminApprovalSummary {
  if (toolName === 'bifrost_admin_set_mcp_tool_policies') {
    const parsed = policyChangesSchema.safeParse(input);
    if (parsed.success) {
      const { changes, providerId } = parsed.data;
      return {
        title: `Change ${changes.length} ${changes.length === 1 ? 'tool policy' : 'tool policies'} for ${providerId}`,
        details: changes.map((change) => `${change.toolName}: ${POLICY_LABELS[change.state] ?? change.state}`),
      };
    }
  }
  if (toolName === 'bifrost_admin_set_mcp_tool_rule') {
    const parsed = ruleSchema.safeParse(input);
    if (parsed.success) {
      return {
        title: `Set the automatic tool rule for ${parsed.data.providerId}`,
        details: [parsed.data.instructions],
      };
    }
  }
  if (toolName === 'bifrost_admin_clear_mcp_tool_rule') {
    const parsed = providerSchema.safeParse(input);
    if (parsed.success) return { title: `Remove the automatic tool rule for ${parsed.data.providerId}`, details: [] };
  }
  return { title: `Run ${toolName}`, details: [JSON.stringify(input, null, 2)] };
}
