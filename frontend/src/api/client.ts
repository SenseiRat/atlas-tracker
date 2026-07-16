/**
 * Thin fetch wrapper for the JSON API. Throws on non-2xx so callers can
 * surface errors; supports an optional AbortSignal via the standard RequestInit.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Request failed: ${response.status} ${details}`);
  }
  return response.json() as Promise<T>;
}
