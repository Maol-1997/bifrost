import { describe, expect, it } from 'vitest';
import { mcpToolNameSchema } from '../src/server/tools/discovery.js';

describe('MCP tool names', () => {
  it.each([
    'a',
    'github_create_issue-comment.v2',
    'a'.repeat(128),
  ])('accepts %s', (toolName) => {
    expect(mcpToolNameSchema.safeParse(toolName).success).toBe(true);
  });

  it.each([
    '',
    'contains space',
    'contains/slash',
    'a'.repeat(129),
  ])('rejects %s', (toolName) => {
    expect(mcpToolNameSchema.safeParse(toolName).success).toBe(false);
  });
});
