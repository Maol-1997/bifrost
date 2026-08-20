import { useCallback, useEffect, useRef, useState } from "react"
import type { UIMessage } from "ai"

import { generateChatTitle } from "@app/api/bifrost"
import {
  CHAT_TITLE_VERSION,
  conversationTitle,
  saveConversation,
  type StoredConversation,
} from "../utils/chat-history"
import { firstUserMessageText } from "../utils/chat-messages"

const SAVE_DELAY_MS = 250

type ConversationRecordOptions = {
  conversation: StoredConversation
  isWorking: boolean
  messages: UIMessage[]
  onConversationChange: (conversation: StoredConversation) => void
  onDelete: (conversation: StoredConversation) => Promise<void>
  stop: () => Promise<unknown>
}

function useConversationRecord({
  conversation,
  isWorking,
  messages,
  onConversationChange,
  onDelete,
  stop,
}: ConversationRecordOptions) {
  const [historyError, setHistoryError] = useState(false)
  const deleting = useRef(false)
  const pendingSave = useRef<StoredConversation | undefined>(undefined)
  const hasCurrentGeneratedTitle = conversation.generatedTitle
    && conversation.titleVersion === CHAT_TITLE_VERSION
  const titleGenerationStarted = useRef(hasCurrentGeneratedTitle)
  const title = hasCurrentGeneratedTitle
    ? conversation.title
    : conversationTitle(messages)
  const currentConversationRef = useRef<StoredConversation>(conversation)
  currentConversationRef.current = {
    ...conversation,
    messages,
    title,
    updatedAt: Date.now(),
  }

  useEffect(() => {
    if (messages.length === 0) return

    const updatedConversation = currentConversationRef.current
    pendingSave.current = updatedConversation
    let active = true
    const timeout = window.setTimeout(() => {
      if (deleting.current) return
      void saveConversation(updatedConversation)
        .then(() => {
          if (active) onConversationChange(updatedConversation)
        })
        .catch(() => {
          if (active) setHistoryError(true)
        })
    }, SAVE_DELAY_MS)

    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [
    conversation.createdAt,
    conversation.favorite,
    conversation.generatedTitle,
    conversation.id,
    conversation.owner,
    conversation.titleVersion,
    messages,
    onConversationChange,
    title,
  ])

  const firstUserMessage = firstUserMessageText(messages)
  useEffect(() => {
    if (!firstUserMessage || hasCurrentGeneratedTitle || titleGenerationStarted.current) return

    titleGenerationStarted.current = true
    let active = true
    void generateChatTitle(firstUserMessage)
      .then((generatedTitle) => {
        if (!active || deleting.current) return

        const updatedConversation: StoredConversation = {
          ...currentConversationRef.current,
          generatedTitle: true,
          title: generatedTitle,
          titleVersion: CHAT_TITLE_VERSION,
          updatedAt: Date.now(),
        }
        pendingSave.current = updatedConversation
        return saveConversation(updatedConversation).then(() => {
          if (active) onConversationChange(updatedConversation)
        })
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [firstUserMessage, hasCurrentGeneratedTitle, onConversationChange])

  useEffect(() => () => {
    if (!deleting.current && pendingSave.current) {
      void saveConversation(pendingSave.current).catch(() => undefined)
    }
  }, [])

  const currentConversation = useCallback(
    (): StoredConversation => currentConversationRef.current,
    [],
  )

  const changeFavorite = useCallback((favorite: boolean): void => {
    const updatedConversation = { ...currentConversationRef.current, favorite }
    pendingSave.current = updatedConversation
    void saveConversation(updatedConversation)
      .then(() => onConversationChange(updatedConversation))
      .catch(() => setHistoryError(true))
  }, [onConversationChange])

  const deleteCurrentConversation = useCallback((): void => {
    const deletedConversation = currentConversationRef.current
    deleting.current = true
    pendingSave.current = undefined
    if (isWorking) void stop()
    void onDelete(deletedConversation).catch(() => {
      deleting.current = false
      pendingSave.current = deletedConversation
    })
  }, [isWorking, onDelete, stop])

  return {
    changeFavorite,
    currentConversation,
    deleteCurrentConversation,
    historyError,
    title,
  }
}

export { useConversationRecord }
