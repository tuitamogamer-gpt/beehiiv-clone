import type { Context } from 'hono';
import { ApiError, retryAfterSeconds } from './http.js';

// Small, dependency-free HTML pages for people who arrive from an email link
// (subscription confirmation, unsubscribe, reader sign-in) or visit a public
// publication page. API clients keep receiving JSON from the same routes.

export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Browser navigations (links and HTML form posts) ask for text/html; fetch() and API clients normally do not. */
export const prefersHtml = (headers: Headers): boolean => (headers.get('accept') || '').toLowerCase().includes('text/html');

/** HTML forms post urlencoded or multipart bodies; JSON clients send application/json. */
export const isFormPost = (headers: Headers): boolean => /application\/x-www-form-urlencoded|multipart\/form-data/i.test(headers.get('content-type') || '');

export const accentColor = (value: unknown): string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#ec73a4';

/** Only same-site paths and absolute http(s) URLs are rendered as links. */
export const safeHref = (value: string): string | null => /^(?:https?:\/\/[^\s"'<>]+|\/(?!\/)[^\s"'<>]*)$/i.test(value) ? value : null;

export const PUBLIC_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export type PageLink = { label: string; href: string };
export type PageForm = { button: string; action?: string; fields?: Record<string, string>; secondary?: boolean };
export type PublicPageOptions = {
  title: string;
  heading: string;
  message?: string;
  /** Trusted, already-escaped HTML placed after the message. */
  bodyHtml?: string;
  publication?: string;
  accent?: unknown;
  tone?: 'neutral' | 'success' | 'error';
  forms?: PageForm[];
  links?: PageLink[];
  note?: string;
  wide?: boolean;
  hideIcon?: boolean;
  /** Public publication pages may be indexed; link landing pages never are. */
  indexable?: boolean;
};

const icons = {
  neutral: '<path d="M4 6h16v12H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  success: '<path d="m5 12.5 4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  error: '<path d="M12 7v6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.3" fill="currentColor"/>',
};

function renderForm(form: PageForm): string {
  const action = form.action ? safeHref(form.action) : null;
  const fields = Object.entries(form.fields || {}).map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join('');
  return `<form method="post"${action ? ` action="${escapeHtml(action)}"` : ''}>${fields}<button type="submit"${form.secondary ? ' class="secondary"' : ''}>${escapeHtml(form.button)}</button></form>`;
}

export function renderPublicPage(options: PublicPageOptions): string {
  const tone = options.tone || 'neutral';
  const accent = accentColor(options.accent);
  const links = (options.links || []).map(link => ({ ...link, href: safeHref(link.href) })).filter(link => link.href);
  const title = options.publication ? `${options.title} · ${options.publication}` : options.title;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${options.indexable ? '' : '<meta name="robots" content="noindex">'}<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;--accent:${accent};--ink:#17202a;--muted:#5f6b7a;--line:#e4e7ec;--card:#fff;--page:#f6f5f2;--error:#b42318;--success:#067647}
@media (prefers-color-scheme:dark){:root{--ink:#f2f4f7;--muted:#a3adba;--line:#2f3540;--card:#191c22;--page:#101216;--error:#fda29b;--success:#75e0a7}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 16px;background:var(--page);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{width:100%;max-width:${options.wide ? 760 : 480}px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:36px 32px;box-shadow:0 12px 40px rgba(16,24,40,.08)}
.publication{display:flex;align-items:center;gap:10px;margin:0 0 28px;font-weight:700;font-size:15px}.publication:before{content:"";width:12px;height:12px;border-radius:50%;background:var(--accent)}
.icon{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;margin-bottom:18px;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--ink)}.icon svg{width:24px;height:24px}
.success .icon{color:var(--success);background:color-mix(in srgb,var(--success) 14%,transparent)}.error .icon{color:var(--error);background:color-mix(in srgb,var(--error) 14%,transparent)}
h1{margin:0 0 10px;font-size:28px;line-height:1.2;letter-spacing:-.02em}p{margin:0 0 18px;color:var(--muted)}a{color:inherit;text-underline-offset:3px}
form{margin:22px 0 0}button{appearance:none;width:100%;border:0;border-radius:10px;padding:13px 18px;background:var(--ink);color:var(--card);font:inherit;font-weight:650;cursor:pointer}button:hover{opacity:.9}button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
button.secondary{width:auto;padding:8px 14px;background:transparent;color:var(--ink);border:1px solid var(--line)}
.links{display:flex;flex-wrap:wrap;gap:16px;margin-top:22px;font-weight:600}.note{margin-top:26px;padding-top:18px;border-top:1px solid var(--line);font-size:13px}
.posts{list-style:none;margin:24px 0 0;padding:0;border-top:1px solid var(--line)}.posts li{padding:18px 0;border-bottom:1px solid var(--line)}.posts a{font-weight:700;font-size:18px;text-decoration:none}.posts a:hover{text-decoration:underline}.posts p{margin:4px 0 0;font-size:15px}.posts small{display:block;margin-top:6px;color:var(--muted);font-size:13px}
.reader{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin:0 0 8px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;font-size:14px}.reader form{margin:0}
body.list{align-items:flex-start;padding-top:56px}.list main{border-top:4px solid var(--accent)}
@media (max-width:520px){main{padding:28px 20px}h1{font-size:24px}body.list{padding-top:24px}}
</style></head><body${options.wide ? ' class="list"' : ''}><main class="${tone}">${options.publication ? `<div class="publication">${escapeHtml(options.publication)}</div>` : ''}${options.hideIcon ? '' : `<div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[tone]}</svg></div>`}<h1>${escapeHtml(options.heading)}</h1>${options.message ? `<p>${escapeHtml(options.message)}</p>` : ''}${options.bodyHtml || ''}${(options.forms || []).map(renderForm).join('')}${links.length ? `<div class="links">${links.map(link => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join('')}</div>` : ''}${options.note ? `<p class="note">${escapeHtml(options.note)}</p>` : ''}</main></body></html>`;
}

export function publicPage(c: Context<any>, options: PublicPageOptions, status = 200, headers: Record<string, string> = {}): Response {
  return c.html(renderPublicPage(options), status as 200, {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': PUBLIC_PAGE_CSP,
    'X-Frame-Options': 'DENY',
    ...(options.indexable ? {} : { 'X-Robots-Tag': 'noindex' }),
    ...headers,
  });
}

/** Renders an error as an HTML page, keeping the status code and any Retry-After hint. */
export function publicErrorPage(c: Context<any>, error: unknown, options: Partial<PublicPageOptions> & { fallbackMessage?: string } = {}): Response {
  const { fallbackMessage, ...page } = options;
  const known = error instanceof ApiError;
  if (!known) console.error(JSON.stringify({ requestId: c.get('requestId'), error: error instanceof Error ? error.name : 'Error', message: 'Public page failure' }));
  const status = known ? error.status : 500;
  const limited = status === 429;
  const retryAfter = known ? retryAfterSeconds(error) : undefined;
  return publicPage(c, {
    ...page,
    title: limited ? 'Please try again shortly' : page.title || 'This link can’t be used',
    heading: limited ? 'Please try again shortly.' : page.heading || 'This link can’t be used.',
    message: known && status < 500 ? error.message : fallbackMessage || 'Something went wrong on our side. Please try again later.',
    tone: 'error',
  }, status, retryAfter ? { 'Retry-After': String(retryAfter) } : {});
}

