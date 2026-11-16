import type { UIMessage } from 'ai';

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function firstUserMessageText(messages: readonly UIMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  return firstUserMessage ? messageText(firstUserMessage).trim() : '';
}

/**
 * The server records the model's finish reason in the message metadata. Claude
 * reports a declined request as `content-filter`, after the server-side fallback
 * model declined it as well.
 */
function wasDeclined(message: UIMessage): boolean {
  const metadata = message.metadata;
  return (
    message.role === 'assistant' &&
    typeof metadata === 'object' &&
    metadata !== null &&
    'finishReason' in metadata &&
    metadata.finishReason === 'content-filter'
  );
}

export { firstUserMessageText, messageText, wasDeclined };
