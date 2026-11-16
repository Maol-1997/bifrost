import { describe, expect, it } from 'vitest';
import { normalizeStoredConversations } from '../src/app/chat/utils/chat-history.js';

const OWNER = 'owner@example.com';

type ConversationFixtureOptions = {
  id?: string;
  messages?: unknown[];
  owner?: string;
  updatedAt?: number;
};

function conversationFixture({
  id = 'conversation',
  messages = [{ id: 'message', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
  owner = OWNER,
  updatedAt = 2,
}: ConversationFixtureOptions = {}): Record<string, unknown> {
  return {
    createdAt: 1,
    favorite: true,
    generatedTitle: true,
    id,
    messages,
    owner,
    title: 'Conversation',
    titleVersion: 1,
    updatedAt,
  };
}

describe('stored chat history normalization', () => {
  it('returns an empty list for empty storage', () => {
    expect(normalizeStoredConversations([], OWNER)).toEqual([]);
  });

  it('keeps only conversations owned by the current user', () => {
    const conversations = normalizeStoredConversations(
      [
        conversationFixture({ id: 'current-owner' }),
        conversationFixture({ id: 'different-owner', owner: 'other@example.com' }),
      ],
      OWNER,
    );

    expect(conversations.map((conversation) => conversation.id)).toEqual(['current-owner']);
  });

  it('fills defaults omitted by legacy records', () => {
    const legacyConversation = conversationFixture();
    delete legacyConversation.favorite;
    delete legacyConversation.generatedTitle;
    delete legacyConversation.titleVersion;

    expect(normalizeStoredConversations([legacyConversation], OWNER)[0]).toMatchObject({
      favorite: false,
      generatedTitle: false,
      titleVersion: 0,
    });
  });

  it('orders conversations by most recent update', () => {
    const conversations = normalizeStoredConversations(
      [
        conversationFixture({ id: 'oldest', updatedAt: 10 }),
        conversationFixture({ id: 'newest', updatedAt: 30 }),
        conversationFixture({ id: 'middle', updatedAt: 20 }),
      ],
      OWNER,
    );

    expect(conversations.map((conversation) => conversation.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it.each([
    ['a non-object record', null],
    ['a non-array message collection', { ...conversationFixture(), messages: {} }],
    ['a message without an id', conversationFixture({ messages: [{ role: 'user', parts: [] }] })],
    ['an unknown message role', conversationFixture({ messages: [{ id: 'message', role: 'tool', parts: [] }] })],
    ['an empty user message', conversationFixture({ messages: [{ id: 'message', role: 'user', parts: [] }] })],
    [
      'an unknown part type',
      conversationFixture({ messages: [{ id: 'message', role: 'assistant', parts: [{ type: 'mystery' }] }] }),
    ],
    [
      'a malformed text part',
      conversationFixture({ messages: [{ id: 'message', role: 'assistant', parts: [{ type: 'text', text: 42 }] }] }),
    ],
    [
      'an incomplete tool result',
      conversationFixture({
        messages: [
          {
            id: 'message',
            role: 'assistant',
            parts: [{ type: 'tool-search', toolCallId: 'call', state: 'output-available', input: {} }],
          },
        ],
      }),
    ],
  ])('discards %s', (_description, malformedRecord) => {
    expect(normalizeStoredConversations([malformedRecord], OWNER)).toEqual([]);
  });
});
