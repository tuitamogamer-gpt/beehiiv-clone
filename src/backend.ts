import type { AppData, Post, Subscriber } from './types';

export type Account = {
  user: { id: string; email: string; name: string };
  tenantId: string; publicationId: string; role: 'admin' | 'member' | 'contributor';
  memberships: { id: string; tenantId: string; publicationId: string; name: string; role: string }[];
};
export type Capabilities = {
  mode: string; database: string; authentication: boolean; email: boolean; payments: boolean;
  botProtection: boolean; ai: boolean; media: boolean; scheduler: boolean; publicUrlConfigured: boolean;
};
export type LivePost = Post & { version: number };
export type LiveSubscriber = Subscriber & { version: number; customFields?: Record<string, string | number | boolean | null> };
export type WorkspaceResponse = { data: AppData; capabilities: Capabilities; versions: { publication: number }; limits: { perCollection: number; truncated: boolean } };
export type RenderedPost = { html: string; text: string; subject: string; bytes: number; clippedRisk: boolean };
export type TeamMember = { id: string; userId: string; email: string; name: string; role: 'admin' | 'member' | 'contributor' };
export type ApiKeyInfo = { id: string; name: string; prefix: string; scopes: string[]; expiresAt: string | null };

export class BackendError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin', cache: 'no-store', method: options.method || (options.body === undefined ? 'GET' : 'POST'),
      headers: { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: options.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new BackendError('The server could not be reached. Check your connection and try again.', 503, 'server_unavailable');
  }
  if (response.status === 204) return undefined as T;
  if (!response.headers.get('content-type')?.includes('application/json')) throw new BackendError('The live workspace API is not available on this server. Start or deploy the backend, then try again.', 503, 'backend_unavailable');
  const result = await response.json();
  if (!response.ok) {
    const error = result.error;
    const details = Array.isArray(error?.details) ? error.details.map((item: { path?: string; message?: string }) => `${item.path ? item.path + ': ' : ''}${item.message || ''}`).join(' ') : '';
    const message = (typeof error === 'string' ? error : error?.message) || result.message || 'The request could not be completed.';
    throw new BackendError(details ? `${message} ${details}` : message, response.status, error?.code || 'request_failed');
  }
  return result as T;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
export const getStatus = async () => (await api<{ capabilities: Capabilities }>('/status')).capabilities;
export const getWorkspace = () => api<WorkspaceResponse>('/workspace');
export function savePost(post: Partial<LivePost> & { title: string; content: string }): Promise<LivePost> {
  const body = { title: post.title, subtitle: post.subtitle || '', content: post.content, audience: post.audience || 'All subscribers', image: post.image || '', subjectB: post.subjectB || '', ...(post.id ? { version: post.version } : {}) };
  return api<LivePost>(post.id ? `/posts/${encodeURIComponent(post.id)}` : '/posts', { method: post.id ? 'PATCH' : 'POST', body });
}
export function saveSubscriber(subscriber: Partial<LiveSubscriber> & { email: string }): Promise<LiveSubscriber> {
  const body = { email: subscriber.email, name: subscriber.name || '', source: subscriber.source || 'Manual', status: subscriber.status || 'Active', tags: subscriber.tags || [], ...(subscriber.id ? { version: subscriber.version } : { consent: { source: 'manual_import', timestamp: new Date().toISOString() } }) };
  return api<LiveSubscriber>(subscriber.id ? `/subscribers/${encodeURIComponent(subscriber.id)}` : '/subscribers', { method: subscriber.id ? 'PATCH' : 'POST', body });
}
