export async function fetchJson<T>(url: string, init: RequestInit, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...init, signal });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Provider request failed with HTTP ${response.status}`);
  }
  return (text.length === 0 ? {} : JSON.parse(text)) as T;
}

export async function fetchText(url: string, init: RequestInit, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { ...init, signal });
  const text = await response.text();
  if (!response.ok) throw new Error(`Provider request failed with HTTP ${response.status}`);
  return text;
}
