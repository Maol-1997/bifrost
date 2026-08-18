import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { AgentFacingError } from '../src/errors.js';
import { defineTool, type ToolExecutionContext } from '../src/providers/types.js';

const context: ToolExecutionContext = {
  userId: 'u',
  accessToken: 't',
  requestId: 'r',
  signal: new AbortController().signal,
};

describe('defineTool input validation', () => {
  it('rejects invalid input without reaching the executor', async () => {
    const execute = vi.fn(async () => ({}));
    const tool = defineTool({
      name: 'github_list_pull_requests',
      title: 'List pull requests',
      description: 'List pull requests',
      mutability: 'read',
      inputSchema: z.object({ owner: z.string() }),
      execute,
    });

    await expect(tool.execute({ owner: 42 }, context)).rejects.toThrow(AgentFacingError);
    // The agent has to be able to tell which tool and which argument it got wrong.
    await expect(tool.execute({ owner: 42 }, context)).rejects.toThrow(/Invalid input for github_list_pull_requests: owner:/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('hands the executor parsed input, so schema defaults are already applied', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const tool = defineTool({
      name: 'linear_list_my_issues',
      title: 'List my issues',
      description: 'List my issues',
      mutability: 'read',
      inputSchema: z.object({ first: z.number().default(20) }),
      execute,
    });

    await expect(tool.execute({}, context)).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ first: 20 }, context);
  });

  it('carries the tool metadata through untouched', () => {
    const inputSchema = z.object({ text: z.string() });
    const tool = defineTool({
      name: 'slack_post_message',
      title: 'Post message',
      description: 'Post a message to a channel',
      mutability: 'write',
      inputSchema,
      execute: async () => ({}),
    });

    expect(tool.name).toBe('slack_post_message');
    expect(tool.title).toBe('Post message');
    expect(tool.description).toBe('Post a message to a channel');
    expect(tool.mutability).toBe('write');
    expect(tool.inputSchema).toBe(inputSchema);
  });
});
