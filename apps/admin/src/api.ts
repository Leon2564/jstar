/** Thin API client for the admin console. Every response shape comes from @jstar/shared. */
const BASE = import.meta.env.VITE_API_BASE ?? '';
const TOKEN_KEY = 'jstar.admin.token';
/** Behind the hosted admin's Basic auth, Authorization carries the site password; the Worker maps this header back. */
const SESSION_HEADER: string = import.meta.env.VITE_SESSION_HEADER ?? 'authorization';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { [SESSION_HEADER]: `Bearer ${getToken()}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `http_${res.status}`);
  return body as T;
}
