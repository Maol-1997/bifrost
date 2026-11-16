import type { UIMessage } from 'ai';
import { z } from 'zod';

const DATABASE_NAME = 'bifrost-chat';
const DATABASE_VERSION = 1;
const CONVERSATION_STORE = 'conversations';
export const CHAT_TITLE_VERSION = 1;

export type StoredConversation = {
  createdAt: number;
  favorite: boolean;
  generatedTitle: boolean;
  id: string;
  messages: UIMessage[];
  owner: string;
  title: string;
  titleVersion: number;
  updatedAt: number;
};

export function createEmptyConversation(owner: string): StoredConversation {
  const now = Date.now();
  return {
    createdAt: now,
    favorite: false,
    generatedTitle: false,
    id: crypto.randomUUID(),
    messages: [],
    owner,
    title: 'New chat',
    titleVersion: 0,
    updatedAt: now,
  };
}

export async function listConversations(owner: string): Promise<StoredConversation[]> {
  const database = await openChatDatabase();
  try {
    const transaction = database.transaction(CONVERSATION_STORE, 'readonly');
    const readRequest = transaction.objectStore(CONVERSATION_STORE).getAll() as IDBRequest<unknown[]>;
    const storedValues = await requestResult(readRequest);
    await transactionComplete(transaction);
    return normalizeStoredConversations(storedValues, owner);
  } finally {
    database.close();
  }
}

export async function saveConversation(conversation: StoredConversation): Promise<void> {
  const database = await openChatDatabase();
  try {
    const transaction = database.transaction(CONVERSATION_STORE, 'readwrite');
    transaction.objectStore(CONVERSATION_STORE).put(conversation);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const database = await openChatDatabase();
  try {
    const transaction = database.transaction(CONVERSATION_STORE, 'readwrite');
    transaction.objectStore(CONVERSATION_STORE).delete(conversationId);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export function conversationTitle(messages: readonly UIMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  const text = firstUserMessage?.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .trim();
  if (!text) return 'New chat';
  return text.length > 48 ? `${text.slice(0, 47).trimEnd()}…` : text;
}

function openChatDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let upgradingDatabase: IDBDatabase | undefined;
    request.onerror = () => {
      upgradingDatabase?.close();
      reject(request.error ?? new Error('Unable to open chat history'));
    };
    request.onupgradeneeded = () => {
      upgradingDatabase = request.result;
      if (!request.result.objectStoreNames.contains(CONVERSATION_STORE)) {
        request.result.createObjectStore(CONVERSATION_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('Unable to read chat history'));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.onabort = () => reject(transaction.error ?? new Error('Chat history transaction was aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Unable to update chat history'));
    transaction.oncomplete = () => resolve();
  });
}

const nonEmptyStringSchema = z.string().min(1);
const jsonObjectSchema = z.record(z.string(), z.json().optional());
const providerMetadataSchema = z.record(z.string(), jsonObjectSchema);
const toolApprovalRequestSchema = z
  .object({
    id: nonEmptyStringSchema,
    isAutomatic: z.boolean().optional(),
    signature: z.string().optional(),
  })
  .strict();
const approvedToolRequestSchema = toolApprovalRequestSchema
  .extend({
    approved: z.literal(true),
    reason: z.string().optional(),
  })
  .strict();
const deniedToolRequestSchema = toolApprovalRequestSchema
  .extend({
    approved: z.literal(false),
    reason: z.string().optional(),
  })
  .strict();
const respondedToolRequestSchema = toolApprovalRequestSchema
  .extend({
    approved: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();
const toolPartSharedShape = {
  callProviderMetadata: providerMetadataSchema.optional(),
  providerExecuted: z.boolean().optional(),
  title: z.string().optional(),
  toolCallId: nonEmptyStringSchema,
  toolMetadata: jsonObjectSchema.optional(),
};

function createToolPartSchema(identityShape: z.ZodRawShape) {
  return z.discriminatedUnion('state', [
    z
      .object({
        ...identityShape,
        ...toolPartSharedShape,
        state: z.literal('input-streaming'),
        input: z.unknown().optional(),
      })
      .strict(),
    z
      .object({
        ...identityShape,
        ...toolPartSharedShape,
        state: z.literal('input-available'),
        input: z.unknown(),
      })
      .strict(),
    z
      .object({
        ...identityShape,
        ...toolPartSharedShape,
        state: z.literal('approval-requested'),
        input: z.unknown(),
        approval: toolApprovalRequestSchema,
      })
      .strict(),
    z
      .object({
        ...identityShape,
        ...toolPartSharedShape,
        state: z.literal('approval-responded'),
        input: z.unknown(),
        approval: respondedToolRequestSchema,
      })
      .strict(),
    z
      .object({
        ...identityShape,
        ...toolPartSharedShape,
        state: z.literal('output-available'),
        input: z.unknown(),
        output: z.unknown(),
        preliminary: z.boolean().optional(),
        approval: approvedToolRequestSchema.optional(),
        resultProviderMetadata: providerMetadataSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...identityShape,
        ...toolPartSharedShape,
        state: z.literal('output-error'),
        input: z.unknown().optional(),
        rawInput: z.unknown().optional(),
        errorText: z.string(),
        approval: approvedToolRequestSchema.optional(),
        resultProviderMetadata: providerMetadataSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...identityShape,
        ...toolPartSharedShape,
        state: z.literal('output-denied'),
        input: z.unknown(),
        approval: deniedToolRequestSchema,
      })
      .strict(),
  ]);
}

const staticToolPartSchema = createToolPartSchema({
  type: z.string().regex(/^tool-.+$/),
});
const dynamicToolPartSchema = createToolPartSchema({
  type: z.literal('dynamic-tool'),
  toolName: nonEmptyStringSchema,
});
const uiMessagePartSchema = z.union([
  z
    .object({
      type: z.literal('text'),
      text: z.string(),
      state: z.enum(['streaming', 'done']).optional(),
      providerMetadata: providerMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('custom'),
      kind: z.string().regex(/^[^.]+\..+$/),
      providerMetadata: providerMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('reasoning'),
      id: z.string().optional(),
      text: z.string(),
      state: z.enum(['streaming', 'done']).optional(),
      providerMetadata: providerMetadataSchema.optional(),
    })
    .strict(),
  staticToolPartSchema,
  dynamicToolPartSchema,
  z
    .object({
      type: z.literal('source-url'),
      sourceId: nonEmptyStringSchema,
      url: z.string(),
      title: z.string().optional(),
      providerMetadata: providerMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('source-document'),
      sourceId: nonEmptyStringSchema,
      mediaType: nonEmptyStringSchema,
      title: z.string(),
      filename: z.string().optional(),
      providerMetadata: providerMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('file'),
      mediaType: nonEmptyStringSchema,
      filename: z.string().optional(),
      url: z.string(),
      providerReference: z.record(z.string(), z.string()).optional(),
      providerMetadata: providerMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('reasoning-file'),
      mediaType: nonEmptyStringSchema,
      url: z.string(),
      providerMetadata: providerMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.string().regex(/^data-.+$/),
      id: z.string().optional(),
      data: z.unknown(),
    })
    .strict(),
  z.object({ type: z.literal('step-start') }).strict(),
]);
const uiMessageSchema = z
  .object({
    id: nonEmptyStringSchema,
    role: z.enum(['system', 'user', 'assistant']),
    metadata: z.unknown().optional(),
    parts: z.array(uiMessagePartSchema),
  })
  .strict();
const storedConversationRecordSchema = z
  .object({
    createdAt: z.number().nonnegative(),
    favorite: z.boolean().optional(),
    generatedTitle: z.boolean().optional(),
    id: nonEmptyStringSchema,
    messages: z.array(z.unknown()),
    owner: nonEmptyStringSchema,
    title: z.string(),
    titleVersion: z.number().int().nonnegative().optional(),
    updatedAt: z.number().nonnegative(),
  })
  .strict();

function isUiMessage(value: unknown): value is UIMessage {
  const result = uiMessageSchema.safeParse(value);
  return result.success && (result.data.role === 'assistant' || result.data.parts.length > 0);
}

export function normalizeStoredConversations(storedValues: readonly unknown[], owner: string): StoredConversation[] {
  const conversations: StoredConversation[] = [];
  for (const storedValue of storedValues) {
    const result = storedConversationRecordSchema.safeParse(storedValue);
    if (!result.success || result.data.owner !== owner) continue;

    const messages = result.data.messages;
    if (!messages.every(isUiMessage)) continue;

    conversations.push({
      ...result.data,
      favorite: result.data.favorite ?? false,
      generatedTitle: result.data.generatedTitle ?? false,
      messages,
      titleVersion: result.data.titleVersion ?? 0,
    });
  }

  return conversations.sort((left, right) => right.updatedAt - left.updatedAt);
}
