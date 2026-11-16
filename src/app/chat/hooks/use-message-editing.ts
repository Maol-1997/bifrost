import { useMemo, useState } from 'react';
import type { UIMessage } from 'ai';

import { messageText } from '../utils/chat-messages';

type MessageEditingOptions = {
  isWorking: boolean;
  messages: UIMessage[];
  regenerate: (options: { messageId: string }) => Promise<unknown>;
  setMessages: (messages: UIMessage[]) => void;
  stop: () => Promise<unknown>;
};

function useMessageEditing({ isWorking, messages, regenerate, setMessages, stop }: MessageEditingOptions) {
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const editingMessageIndex = editingMessageId ? messages.findIndex((message) => message.id === editingMessageId) : -1;
  const visibleMessages = useMemo(
    () => (editingMessageIndex >= 0 ? messages.slice(0, editingMessageIndex) : messages),
    [editingMessageIndex, messages],
  );

  function beginEditingMessage(message: UIMessage): string | undefined {
    if (message.role !== 'user') return undefined;
    if (isWorking) void stop();
    setEditingMessageId(message.id);
    return messageText(message);
  }

  function cancelEditingMessage(): void {
    setEditingMessageId(undefined);
  }

  function submitEditedMessage(value: string): boolean {
    if (!editingMessageId) return false;

    const messageIndex = messages.findIndex((message) => message.id === editingMessageId);
    const message = messages[messageIndex];
    if (!message || message.role !== 'user') {
      cancelEditingMessage();
      return true;
    }

    const editedMessage: UIMessage = {
      ...message,
      parts: [{ type: 'text', text: value }],
    };
    setMessages([...messages.slice(0, messageIndex), editedMessage]);
    setEditingMessageId(undefined);
    void regenerate({ messageId: editingMessageId });
    return true;
  }

  return {
    beginEditingMessage,
    cancelEditingMessage,
    editingMessageId,
    submitEditedMessage,
    visibleMessages,
  };
}

export { useMessageEditing };
