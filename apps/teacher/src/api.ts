/** The teacher server's API, on this origin under /api, with the session cookie. */

export type Me = { email: string; school: string };
export type DraftInfo = { id: string; package: string; title: string; created: string };
export type Publication = { id: string; url: string; manifest: string; updated: string; revoked: string | null; warnings: string[] };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly problems: string[] = []) {
    super(message);
  }
}

async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const r = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    ...(json === undefined ? {} : { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } }),
  });
  if (r.status === 204) return undefined as T;
  const body = (await r.json().catch(() => ({}))) as { error?: string; problems?: string[] };
  if (!r.ok) throw new ApiError(body.error ?? `the server answered ${r.status}`, r.status, body.problems ?? []);
  return body as T;
}

export const me = () => api<Me>('/me');
export const login = (email: string, password: string) => api<Me>('/login', { method: 'POST', json: { email, password } });
export const logout = () => api<void>('/logout', { method: 'POST' });
export const drafts = () => api<DraftInfo[]>('/drafts');
export const newDraft = (title: string) => api<DraftInfo>('/drafts', { method: 'POST', json: { title } });
export const deleteDraft = (id: string) => api<void>(`/drafts/${id}`, { method: 'DELETE' });
export const publication = (id: string) => api<Publication | null>(`/drafts/${id}/publication`);
export const publish = (id: string) => api<Publication>(`/drafts/${id}/publish`, { method: 'POST' });
export const unpublish = (id: string) => api<void>(`/drafts/${id}/publication`, { method: 'DELETE' });

/** Bundles a view's npm imports at the pinned versions; where each is served, as absolute URLs (the frame's origin is `null`). */
export async function resolveNpm(imports: string[], versions: Record<string, string>): Promise<Record<string, string>> {
  const paths = await api<Record<string, string>>('/npm', { method: 'POST', json: { npm: versions, imports } });
  return Object.fromEntries(Object.entries(paths).map(([spec, path]) => [spec, new URL(path, location.origin).href]));
}

/** The repo folder a draft syncs with. */
export const draftUrl = (id: string) => `${location.origin}/api/drafts/${id}`;
