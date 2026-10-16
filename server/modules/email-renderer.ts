import sanitizeHtml from 'sanitize-html';

export type RenderChannel = 'email' | 'web';
export type RenderTier = 'Free' | 'Premium';

/** Plain data objects from Stored.data; no subscriber fields are inserted as HTML. */
export interface RenderPostInput {
  post: Record<string, unknown>;
  publication: Record<string, unknown>;
  subscriber?: Record<string, unknown>;
  channel: RenderChannel;
  tier: RenderTier;
  unsubscribeUrl?: string;
}

export interface RenderedPost {
  html: string;
  text: string;
  subject: string;
  /** UTF-8 bytes of the complete HTML message, including the email wrapper. */
  bytes: number;
  /** Warn before Gmail's approximately 102 KB clipping threshold. */
  clippedRisk: boolean;
}

const COLOR = /^(?:#[\da-f]{3,8}|(?:rgb|rgba)\([\d.,%\s]+\)|transparent|black|white|gray|grey|red|blue|green|yellow|orange|purple|pink|currentcolor)$/i;
const LENGTH = /^(?:0|\d{1,4}(?:\.\d{1,2})?(?:px|em|rem|%))$/i;
const SPACING = /^(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem))(?:\s+(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem))){0,3}$/i;
const PAYWALL = /<p\b[^>]*\bclass="premium-divider"[^>]*>[\s\S]*?<\/p\s*>/gi;
const EMAIL_STYLES: Record<string, string> = {
  p: 'margin:0 0 20px;line-height:1.65',
  h1: 'margin:28px 0 16px;font-size:32px;line-height:1.25;font-weight:700',
  h2: 'margin:28px 0 14px;font-size:25px;line-height:1.3;font-weight:700',
  h3: 'margin:24px 0 12px;font-size:21px;line-height:1.35;font-weight:700',
  h4: 'margin:20px 0 10px;font-size:18px;line-height:1.4;font-weight:700',
  h5: 'margin:18px 0 10px;font-size:16px;line-height:1.4;font-weight:700',
  h6: 'margin:18px 0 10px;font-size:14px;line-height:1.4;font-weight:700',
  a: 'color:#6941c6;text-decoration:underline',
  img: 'max-width:100%;height:auto;border:0;vertical-align:middle',
  table: 'width:100%;border-collapse:collapse;margin:16px 0',
  th: 'padding:12px;border:1px solid #e5e7eb;text-align:left;vertical-align:top;background-color:#f9fafb',
  td: 'padding:12px;border:1px solid #e5e7eb;vertical-align:top',
  blockquote: 'margin:24px 0;padding:12px 20px;border-left:4px solid #6941c6;color:#475467',
  pre: 'margin:20px 0;padding:16px;background-color:#f3f4f6;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:14px',
  code: 'font-family:monospace;font-size:14px',
  ul: 'margin:0 0 20px;padding-left:24px',
  ol: 'margin:0 0 20px;padding-left:24px',
  li: 'margin:0 0 8px;line-height:1.65',
  hr: 'margin:28px 0;border:0;border-top:1px solid #e5e7eb',
  figure: 'margin:20px 0',
  figcaption: 'margin:8px 0 20px;color:#667085;font-size:13px;line-height:1.5',
};

function valueText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** Absolute URLs only for loaded resources; links can also use local anchors. */
function safeUrl(value: string, kind: 'resource' | 'link' = 'resource'): string | undefined {
  const url = value.trim();
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url)) return undefined;
  if (kind === 'link' && /^#[\w:.-]+$/.test(url)) return url;
  if (kind === 'link' && /^(?:mailto:[^<>\s]+@[^<>\s]+|tel:\+?[\d().-]+)$/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

const allowedStyles: NonNullable<sanitizeHtml.IOptions['allowedStyles']> = {
  '*': {
    color: [COLOR], 'background-color': [COLOR], 'border-color': [COLOR],
    'border-left-color': [COLOR], 'border-right-color': [COLOR], 'border-top-color': [COLOR], 'border-bottom-color': [COLOR],
    'font-family': [/^[a-z\d\s,'"-]+$/i], 'font-size': [LENGTH],
    'font-weight': [/^(?:normal|bold|[1-9]00)$/], 'font-style': [/^(?:normal|italic)$/],
    'text-align': [/^(?:left|right|center|justify)$/], 'text-decoration': [/^(?:none|underline|line-through)$/],
    'line-height': [/^(?:\d(?:\.\d{1,2})?|\d{1,3}(?:\.\d{1,2})?(?:px|em|%))$/],
    margin: [SPACING], padding: [SPACING],
    'margin-top': [LENGTH], 'margin-bottom': [LENGTH], 'margin-left': [LENGTH], 'margin-right': [LENGTH],
    'padding-top': [LENGTH], 'padding-bottom': [LENGTH], 'padding-left': [LENGTH], 'padding-right': [LENGTH],
    width: [LENGTH], 'max-width': [LENGTH], height: [LENGTH, /^auto$/],
    'vertical-align': [/^(?:top|middle|bottom|baseline)$/],
    'border-width': [LENGTH], 'border-style': [/^(?:none|solid|dashed|dotted|double)$/],
    border: [/^(?:0|\d{1,2}px\s+(?:solid|dashed|dotted|double)\s+#[\da-f]{3,8})$/i],
    'border-left': [/^(?:0|\d{1,2}px\s+(?:solid|dashed|dotted|double)\s+#[\da-f]{3,8})$/i],
    'border-top': [/^(?:0|\d{1,2}px\s+(?:solid|dashed|dotted|double)\s+#[\da-f]{3,8})$/i],
    'border-radius': [LENGTH], 'border-collapse': [/^(?:collapse|separate)$/],
    'white-space': [/^(?:normal|pre|pre-wrap)$/], 'word-break': [/^(?:normal|break-word|break-all)$/],
  },
};

/**
 * Sanitize editor HTML for persistence or rendering. The default web mode preserves
 * safe audio/video; email mode removes unsupported media and supplies inline styles.
 * Both forms preserve paywall dividers so sanitizing a draft cannot remove its gate.
 */
export function sanitizePostHtml(html: string, channel: RenderChannel = 'web'): string {
  const source = valueText(html).replace(/<!--\s*paywall\s*-->/gi, '<p class="premium-divider">Premium content starts here</p>');
  const media = channel === 'web' ? ['video', 'audio', 'source'] : [];
  return sanitizeHtml(source, {
    allowedTags: [
      'p', 'br', 'div', 'section', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sub', 'sup', 'small', 'mark',
      'a', 'img', 'figure', 'figcaption', 'blockquote', 'pre', 'code', 'hr',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
      ...media,
    ],
    allowedAttributes: {
      '*': ['style', 'id', 'title', 'dir', 'lang'],
      p: ['class'], a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      table: ['width', 'align', 'cellpadding', 'cellspacing', 'border', 'role'],
      td: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign'],
      th: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'scope'],
      ol: ['start', 'type'], li: ['value'],
      video: ['src', 'poster', 'controls', 'preload', 'width', 'height'],
      audio: ['src', 'controls', 'preload'], source: ['src', 'type'],
    },
    allowedClasses: { p: ['premium-divider'] },
    allowedStyles,
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'], video: ['http', 'https'], audio: ['http', 'https'], source: ['http', 'https'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed', 'noscript', ...(channel === 'email' ? ['video', 'audio'] : [])],
    enforceHtmlBoundary: false,
    transformTags: {
      '*': (tagName, original) => {
        const attribs = { ...original };
        if ((attribs.class || '').split(/\s+/).includes('premium-divider')) {
          return { tagName: 'p', attribs: { class: 'premium-divider' }, text: 'Premium content starts here' };
        }
        if (attribs.href) {
          const href = safeUrl(attribs.href, 'link');
          if (href) attribs.href = href;
          else delete attribs.href;
        }
        for (const attr of ['src', 'poster']) {
          if (!attribs[attr]) continue;
          const url = safeUrl(attribs[attr]);
          if (url) attribs[attr] = url;
          else delete attribs[attr];
        }
        if (tagName === 'a') {
          attribs.rel = 'noopener noreferrer';
          if (attribs.target && attribs.target !== '_blank') delete attribs.target;
        }
        if (tagName === 'video' || tagName === 'audio') {
          attribs.controls = '';
          attribs.preload = 'none';
        }
        if (attribs.dir && !/^(?:ltr|rtl|auto)$/.test(attribs.dir)) delete attribs.dir;
        if (channel === 'email' && EMAIL_STYLES[tagName]) {
          attribs.style = `${EMAIL_STYLES[tagName]};${attribs.style || ''}`;
        }
        return { tagName, attribs };
      },
    },
    exclusiveFilter: frame => (frame.tag === 'img' || frame.tag === 'source') && !frame.attribs.src,
  });
}

function personalize(template: string, input: RenderPostInput, escape: boolean): string {
  const subscriber = input.subscriber || {};
  const fullName = valueText(subscriber.name).trim();
  const values: Record<string, string> = {
    first_name: valueText(subscriber.first_name || subscriber.firstName) || fullName.split(/\s+/)[0] || 'there',
    name: fullName || 'reader',
    email: valueText(subscriber.email),
    publication_name: valueText(input.publication.name) || 'Newsletter',
  };
  const fields = subscriber.customFields && typeof subscriber.customFields === 'object' && !Array.isArray(subscriber.customFields)
    ? subscriber.customFields as Record<string, unknown> : {};
  return template.replace(/\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/g, (tag, rawKey: string) => {
    const key = rawKey.replace(/^subscriber\./, '');
    const customKey = key.replace(/^(?:customFields|custom_fields|custom)\./, '');
    const value = Object.hasOwn(values, key) ? values[key]
      : Object.hasOwn(fields, customKey) && !['__proto__', 'constructor', 'prototype'].includes(customKey) ? valueText(fields[customKey]) : undefined;
    if (value === undefined) return tag;
    return escape ? escapeHtml(value) : value;
  });
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key: string) => {
    if (key[0] === '#') {
      const point = key[1].toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '\ufffd';
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[key.toLowerCase()] || entity;
  });
}

function plainText(html: string): string {
  const formatted = html
    .replace(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, content: string) => `${content}${href.startsWith('#') ? '' : ` (${href})`}`)
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, '[$1]')
    .replace(/<(?:p|div|section|h[1-6]|blockquote|pre|figure|figcaption)\b[^>]*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, '\t')
    .replace(/<\/(?:p|div|section|h[1-6]|blockquote|li|tr|pre|figure|figcaption)\s*>/gi, '\n\n');
  return decodeEntities(sanitizeHtml(formatted, { allowedTags: [], allowedAttributes: {} }))
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Render sanitized, personalized free/premium HTML and its plain-text alternative. */
export function renderPost(input: RenderPostInput): RenderedPost {
  let content = sanitizePostHtml(personalize(valueText(input.post.content), input, true), 'web');
  PAYWALL.lastIndex = 0;
  const divider = PAYWALL.exec(content);
  const hasPremiumContent = Boolean(divider);
  if (input.tier === 'Free' && divider) content = content.slice(0, divider.index);
  else content = content.replace(PAYWALL, '');
  content = sanitizePostHtml(content, input.channel);

  const title = personalize(valueText(input.post.title) || 'Untitled newsletter', input, false);
  const subtitle = personalize(valueText(input.post.subtitle), input, false);
  const publicationName = valueText(input.publication.name) || 'Newsletter';
  const subject = personalize(valueText(input.post.subject) || valueText(input.post.title) || publicationName, input, false)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  const image = safeUrl(personalize(valueText(input.post.image), input, false));
  const unsubscribe = safeUrl(input.unsubscribeUrl || '');
  const rawStyles = input.post.templateStyles && typeof input.post.templateStyles === 'object' && !Array.isArray(input.post.templateStyles)
    && (!input.post.templateChannel || input.post.templateChannel === 'both' || input.post.templateChannel === input.channel)
    ? input.post.templateStyles as Record<string, unknown> : {};
  const accent = COLOR.test(valueText(rawStyles.accent)) ? valueText(rawStyles.accent)
    : COLOR.test(valueText(input.publication.accent)) ? valueText(input.publication.accent) : '#6941c6';
  const background = /^#[\da-f]{6}$/i.test(valueText(rawStyles.background)) ? valueText(rawStyles.background) : '#ffffff';
  const color = /^#[\da-f]{6}$/i.test(valueText(rawStyles.color)) ? valueText(rawStyles.color) : '#101828';
  const fonts: Record<string, string> = { Arial: 'Arial,Helvetica,sans-serif', Georgia: 'Georgia,serif', Verdana: 'Verdana,Geneva,sans-serif', 'Times New Roman': 'Times New Roman,Times,serif' };
  const font = Object.hasOwn(fonts, valueText(rawStyles.font)) ? fonts[valueText(rawStyles.font)] : fonts.Arial;
  const fontSize = typeof rawStyles.fontSize === 'number' && Number.isFinite(rawStyles.fontSize) ? Math.min(32, Math.max(12, Math.round(rawStyles.fontSize))) : 16;
  const spacing = typeof rawStyles.spacing === 'number' && Number.isFinite(rawStyles.spacing) ? Math.min(80, Math.max(0, Math.round(rawStyles.spacing))) : 24;
  const address = valueText(input.publication.physicalAddress || input.publication.address);
  const premiumNotice = input.tier === 'Free' && hasPremiumContent
    ? '<p style="margin:28px 0;padding:16px;background-color:#f3f4f6;color:#475467;font-size:14px;line-height:1.6">The rest of this post is available to premium subscribers.</p>' : '';
  const article = `<h1 style="margin:0 0 16px;font-size:32px;line-height:1.25;color:${color}">${escapeHtml(title)}</h1>${subtitle ? `<p style="margin:0 0 28px;color:#667085;font-size:18px;line-height:1.5">${escapeHtml(subtitle)}</p>` : ''}${image ? `<p style="margin:0 0 24px"><img src="${escapeHtml(image)}" alt="${escapeHtml(title)}" width="552" style="width:100%;max-width:552px;height:auto;border:0"></p>` : ''}${content}${premiumNotice}`;
  const footer = `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#667085">${escapeHtml(publicationName)}${address ? `<br>${escapeHtml(address)}` : ''}</p>${unsubscribe ? `<p style="margin:0;font-size:13px;line-height:1.5"><a href="${escapeHtml(unsubscribe)}" style="color:#667085;text-decoration:underline">Unsubscribe</a></p>` : ''}`;
  const html = input.channel === 'email'
    ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;padding:0;background-color:#f4f4f5;font-family:${font};font-size:${fontSize}px;color:${color}">${subtitle ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(subtitle)}</div>` : ''}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;background-color:#f4f4f5"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;background-color:${background}"><tr><td style="padding:24px;border-top:4px solid ${escapeHtml(accent)};border-bottom:1px solid #eaecf0;font-size:15px;font-weight:700">${escapeHtml(publicationName)}</td></tr><tr><td style="padding:${spacing}px;font-family:${font};font-size:${fontSize}px;color:${color};line-height:1.65;word-break:break-word">${article}</td></tr><tr><td style="padding:24px;border-top:1px solid #eaecf0">${footer}</td></tr></table></td></tr></table></body></html>`
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${escapeHtml(publicationName)}</title></head><body style="margin:0;background-color:${background};font-family:${font};font-size:${fontSize}px;color:${color}"><main style="max-width:720px;margin:0 auto;padding:${spacing}px;line-height:1.65;overflow-wrap:break-word"><header style="margin-bottom:32px;padding-bottom:16px;border-bottom:3px solid ${escapeHtml(accent)}">${escapeHtml(publicationName)}</header><article>${article}</article><footer style="margin-top:40px;padding-top:24px;border-top:1px solid #eaecf0">${footer}</footer></main></body></html>`;
  const bytes = Buffer.byteLength(html, 'utf8');
  return { html, text: plainText(`${article}${footer}`), subject, bytes, clippedRisk: bytes >= 95 * 1024 };
}
