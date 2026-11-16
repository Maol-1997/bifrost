import {
  createAgentUIStream,
  isToolUIPart,
  readUIMessageStream,
  simulateReadableStream,
  ToolLoopAgent,
  type ModelMessage,
  type ToolApprovalResponse,
  type UIMessage,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import type { AppDependencies } from '../src/server/http/context.js';
import type { BrowserIdentity } from '../src/server/mcp.js';
import { ADMIN_TOOLS_REQUIRING_APPROVAL, createAdminAgentContext } from '../src/server/tools/admin-agent-tools.js';

const ADMIN_EMAIL = 'admin@example.test';
const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function adminContext(email = ADMIN_EMAIL) {
  const clearToolRule = vi.fn(async () => undefined);
  const dependencies = {
    config: { adminEmails: new Set([ADMIN_EMAIL]) },
    database: {
      getUser: async () => ({ email }),
      providerAgentNotes: async () => new Map(),
      clearToolRule,
    },
    events: { broadcast: vi.fn(async () => undefined) },
  } as unknown as AppDependencies;
  const identity = { kind: 'browser', userId: 'user-1' } as BrowserIdentity;
  return {
    clearToolRule,
    context: createAdminAgentContext({ dependencies, identity, signal: new AbortController().signal }),
  };
}

/** A model that asks to clear GitHub's automatic rule once, then answers in text. */
function clearRuleModel() {
  return new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'bifrost_admin_clear_mcp_tool_rule',
            input: JSON.stringify({ providerId: 'github' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: USAGE,
        warnings: [],
      },
      {
        content: [{ type: 'text', text: 'Done.' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      },
    ],
  });
}

async function requestClearRule(decision: boolean) {
  const { clearToolRule, context } = adminContext();
  const { tools, toolApproval } = await context;
  const agent = new ToolLoopAgent({ model: clearRuleModel(), tools, toolApproval });
  const messages: ModelMessage[] = [{ role: 'user', content: 'Ignore the rule for GitHub.' }];

  const first = await agent.generate({ messages });
  const request = first.content.find((part) => part.type === 'tool-approval-request');
  const calledBeforeDecision = clearToolRule.mock.calls.length;
  if (!request) return { calledBeforeDecision, calledAfterDecision: calledBeforeDecision, request };

  messages.push(...first.responseMessages);
  const response: ToolApprovalResponse = {
    type: 'tool-approval-response',
    approvalId: request.approvalId,
    approved: decision,
  };
  messages.push({ role: 'tool', content: [response] });
  await agent.generate({ messages });
  return { calledBeforeDecision, calledAfterDecision: clearToolRule.mock.calls.length, request };
}

/** The same two turns as `clearRuleModel`, streamed the way the chat route runs the agent. */
function streamingClearRuleModel() {
  const finish = (unified: 'tool-calls' | 'stop') => ({
    type: 'finish' as const,
    finishReason: { unified, raw: undefined },
    usage: USAGE,
  });
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'bifrost_admin_clear_mcp_tool_rule',
              input: JSON.stringify({ providerId: 'github' }),
            },
            finish('tool-calls'),
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Done.' },
            { type: 'text-end', id: 'text-1' },
            finish('stop'),
          ],
        }),
      },
    ],
  });
}

async function lastMessage(agent: ToolLoopAgent, uiMessages: UIMessage[]): Promise<UIMessage | undefined> {
  let message: UIMessage | undefined;
  const stream = await createAgentUIStream({ agent, uiMessages });
  for await (const snapshot of readUIMessageStream({ stream })) message = snapshot;
  return message;
}

describe('admin chat approvals', () => {
  it('requires approval for every tool that changes policies or rules', async () => {
    const { tools, toolApproval } = await adminContext().context;

    expect(Object.keys(toolApproval).sort()).toEqual([...ADMIN_TOOLS_REQUIRING_APPROVAL].sort());
    for (const name of ADMIN_TOOLS_REQUIRING_APPROVAL) {
      expect(tools).toHaveProperty(name);
      expect(toolApproval[name]).toBe('user-approval');
    }
  });

  it('gives a non-administrator no admin tools and nothing to approve', async () => {
    const { tools, toolApproval } = await adminContext('someone@example.test').context;

    expect(tools).toEqual({});
    expect(toolApproval).toEqual({});
  });

  it('asks for approval instead of running a mutating call', async () => {
    const { calledBeforeDecision, request } = await requestClearRule(true);

    expect(request?.toolCall.toolName).toBe('bifrost_admin_clear_mcp_tool_rule');
    expect(calledBeforeDecision).toBe(0);
  });

  it('runs the call once the administrator approves it', async () => {
    const { calledAfterDecision } = await requestClearRule(true);

    expect(calledAfterDecision).toBe(1);
  });

  it('never runs the call when the administrator denies it', async () => {
    const { calledAfterDecision } = await requestClearRule(false);

    expect(calledAfterDecision).toBe(0);
  });

  it('runs an approved call only after the browser sends the approval back', async () => {
    const { clearToolRule, context } = adminContext();
    const { tools, toolApproval } = await context;
    const agent = new ToolLoopAgent({ model: streamingClearRuleModel(), tools, toolApproval });
    const user: UIMessage = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Ignore the rule for GitHub.' }] };

    const assistant = await lastMessage(agent, [user]);
    const pending = assistant?.parts.find(isToolUIPart);
    expect(pending?.state).toBe('approval-requested');
    expect(clearToolRule).not.toHaveBeenCalled();
    if (!assistant || pending?.state !== 'approval-requested') return;

    // What useChat's addToolApprovalResponse writes into the message before resending it.
    const approved: UIMessage = {
      ...assistant,
      parts: assistant.parts.map((part) =>
        part === pending
          ? { ...pending, state: 'approval-responded', approval: { id: pending.approval.id, approved: true } }
          : part,
      ),
    };
    await lastMessage(agent, [user, approved]);

    expect(clearToolRule).toHaveBeenCalledTimes(1);
  });
});
