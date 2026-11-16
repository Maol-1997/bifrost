import { describe, expect, it } from 'vitest';
import { describeAdminApproval } from '../src/app/chat/utils/admin-approval.js';

describe('admin approval summary', () => {
  it('lists every tool in a policy batch with its new state', () => {
    const summary = describeAdminApproval('bifrost_admin_set_mcp_tool_policies', {
      providerId: 'github',
      changes: [
        { toolName: 'github_merge_pull_request', fingerprint: 'a'.repeat(64), state: 'allowed_default_on' },
        { toolName: 'github_delete_repository', fingerprint: 'b'.repeat(64), state: 'blocked' },
      ],
    });

    expect(summary).toEqual({
      title: 'Change 2 tool policies for github',
      details: ['github_merge_pull_request: allowed, on by default', 'github_delete_repository: blocked'],
    });
  });

  it('shows the full rule text the administrator is approving', () => {
    expect(
      describeAdminApproval('bifrost_admin_set_mcp_tool_rule', {
        providerId: 'linear',
        instructions: 'Read-only tools.',
      }),
    ).toEqual({ title: 'Set the automatic tool rule for linear', details: ['Read-only tools.'] });
    expect(describeAdminApproval('bifrost_admin_clear_mcp_tool_rule', { providerId: 'linear' })).toEqual({
      title: 'Remove the automatic tool rule for linear',
      details: [],
    });
  });

  it('falls back to the raw input instead of hiding an unexpected request', () => {
    const summary = describeAdminApproval('bifrost_admin_set_mcp_tool_policies', { providerId: 'github' });

    expect(summary.title).toBe('Run bifrost_admin_set_mcp_tool_policies');
    expect(summary.details[0]).toContain('"providerId": "github"');
  });
});
