import type { ApiErrorBody } from '@deployforge/contracts';

/** Error thrown for non-2xx API responses. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message || `Request failed (${status})`);
  }
  get code(): string | undefined {
    return this.body.code;
  }
}

let csrfToken: string | undefined;
export function setCsrfToken(token: string | undefined): void {
  csrfToken = token;
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
/** Notified when any request returns 401 (session ended elsewhere). */
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export async function api<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', ...init });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { statusCode: res.status, error: res.statusText, message: text.slice(0, 200) };
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) unauthorizedListeners.forEach((l) => l());
    throw new ApiError(res.status, (json as ApiErrorBody) ?? { statusCode: res.status, error: res.statusText, message: res.statusText });
  }
  return json as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const del = <T>(path: string, body?: unknown) => api<T>('DELETE', path, body);

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return 'The server could not be reached.';
    return e.body.issues?.length ? `${e.message}` : e.message;
  }
  if (e instanceof TypeError) return 'Network error: the DeployForge server could not be reached.';
  return (e as Error)?.message ?? 'Something went wrong';
}
