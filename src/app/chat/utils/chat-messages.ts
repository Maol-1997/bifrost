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

export { firstUserMessageText, messageText };
