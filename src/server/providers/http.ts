import { jsonValueSchema, type JsonValue } from './types.js';

export async function fetchJson(url: string, init: RequestInit, signal: AbortSignal): Promise<JsonValue> {
  const response = await fetch(url, { ...init, signal });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Provider request failed with HTTP ${response.status}`);
  }
  return jsonValueSchema.parse(text.length === 0 ? {} : JSON.parse(text));
}

export async function fetchText(url: string, init: RequestInit, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { ...init, signal });
  const text = await response.text();
  if (!response.ok) throw new Error(`Provider request failed with HTTP ${response.status}`);
  return text;
}
