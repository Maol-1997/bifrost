import type { UIMessage } from "ai"

const DATABASE_NAME = "bifrost-chat"
const DATABASE_VERSION = 1
const CONVERSATION_STORE = "conversations"

export type StoredConversation = {
  createdAt: number
  favorite: boolean
  id: string
  messages: UIMessage[]
  owner: string
  title: string
  updatedAt: number
}

export function createEmptyConversation(owner: string): StoredConversation {
  const now = Date.now()
  return {
    createdAt: now,
    favorite: false,
    id: crypto.randomUUID(),
    messages: [],
    owner,
    title: "New chat",
    updatedAt: now,
  }
}

export async function listConversations(owner: string): Promise<StoredConversation[]> {
  const database = await openChatDatabase()
  const transaction = database.transaction(CONVERSATION_STORE, "readonly")
  const readRequest = transaction.objectStore(CONVERSATION_STORE).getAll() as IDBRequest<unknown[]>
  const storedValues = await requestResult(readRequest)
  await transactionComplete(transaction)
  database.close()
  return storedValues
    .filter(isStoredConversation)
    .map((conversation): StoredConversation => ({
      ...conversation,
      favorite: conversation.favorite ?? false,
    }))
    .filter((conversation) => conversation.owner === owner)
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function saveConversation(conversation: StoredConversation): Promise<void> {
  const database = await openChatDatabase()
  const transaction = database.transaction(CONVERSATION_STORE, "readwrite")
  transaction.objectStore(CONVERSATION_STORE).put(conversation)
  await transactionComplete(transaction)
  database.close()
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const database = await openChatDatabase()
  const transaction = database.transaction(CONVERSATION_STORE, "readwrite")
  transaction.objectStore(CONVERSATION_STORE).delete(conversationId)
  await transactionComplete(transaction)
  database.close()
}

export function conversationTitle(messages: readonly UIMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user")
  const text = firstUserMessage?.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim()
  if (!text) return "New chat"
  return text.length > 48 ? `${text.slice(0, 47).trimEnd()}…` : text
}

function openChatDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onerror = () => reject(request.error ?? new Error("Unable to open chat history"))
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CONVERSATION_STORE)) {
        request.result.createObjectStore(CONVERSATION_STORE, { keyPath: "id" })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("Unable to read chat history"))
    request.onsuccess = () => resolve(request.result)
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.onabort = () => reject(transaction.error ?? new Error("Chat history transaction was aborted"))
    transaction.onerror = () => reject(transaction.error ?? new Error("Unable to update chat history"))
    transaction.oncomplete = () => resolve()
  })
}

type StoredConversationRecord = Omit<StoredConversation, "favorite"> & { favorite?: boolean }

function isStoredConversation(value: unknown): value is StoredConversationRecord {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<StoredConversation>
  return typeof candidate.id === "string"
    && typeof candidate.title === "string"
    && typeof candidate.createdAt === "number"
    && typeof candidate.updatedAt === "number"
    && typeof candidate.owner === "string"
    && (candidate.favorite === undefined || typeof candidate.favorite === "boolean")
    && Array.isArray(candidate.messages)
}
