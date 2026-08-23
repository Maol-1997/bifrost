import { z } from 'zod';

const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

export async function fetchJson(url: string, init: RequestInit, signal: AbortSignal): Promise<JsonValue> {
  const response = await fetch(url, { ...init, signal });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Provider request failed with HTTP ${response.status}`);
  }
  return jsonValueSchema.parse(text.length === 0 ? {} : JSON.parse(text));
}
