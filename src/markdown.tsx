// Tiny inline-only markdown renderer. We render:
//   - https?:// URLs as anchors
//   - **bold**, *italic*, `code`
// Everything else is plain text, so an unrecognised sequence falls
// through unchanged. We never render HTML — input is treated as
// plain text and decorated structurally, so there's no XSS risk.
//
// Block-level markdown (lists, code fences, blockquotes) is out of
// scope for this v0; Matrix messages that need rich layout will get
// formatted_body HTML support in a later iteration.

import React from 'react';
import DOMPurify from 'dompurify';

// Sanitize Matrix formatted_body HTML. We allow the inline subset most
// clients send (bold/italic/code/links/lists/blockquotes/headings/pre);
// strip scripts, styles, iframes, event handlers. Links open in a new tab.
export function renderFormattedHtml(html: string): React.ReactNode {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['a', 'b', 'strong', 'em', 'i', 'u', 'code', 'pre', 'br', 'p', 'span', 'blockquote',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'del', 's', 'sub', 'sup',
      'mx-reply', 'div'],
    ALLOWED_ATTR: ['href', 'title', 'name', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
  });
  // Force target=_blank rel=noopener on all anchors. DOMPurify's hooks
  // are global so we patch after sanitize using a tiny DOM pass.
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  tpl.content.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return <span dangerouslySetInnerHTML={{ __html: tpl.innerHTML }} />;
}

const URL_RE = /\b(https?:\/\/[^\s)]+[^\s.,;:!?)\]'"])/g;
const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;

// Cheap markdown → HTML for outgoing messages. Matches the inline-only
// subset we render on the way in (bold/italic/code/links); paragraphs
// become <br/>-separated text. Returns null if nothing markdown-looking
// is present, so callers can skip formatted_body when it'd be redundant.
export function markdownToHtml(text: string): string | null {
  const hasInline = /\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`/.test(text);
  const hasUrl = URL_RE.test(text);
  if (!hasInline && !hasUrl) return null;
  URL_RE.lastIndex = 0; // matchAll resets but the test() above moved it
  const esc = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  let out = '';
  let lastUrlEnd = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index === undefined) continue;
    if (m.index > lastUrlEnd) out += inlineMarksToHtml(text.slice(lastUrlEnd, m.index), esc);
    out += `<a href="${esc(m[1])}">${esc(m[1])}</a>`;
    lastUrlEnd = m.index + m[0].length;
  }
  if (lastUrlEnd < text.length) out += inlineMarksToHtml(text.slice(lastUrlEnd), esc);
  return out.replace(/\n/g, '<br/>');
}

function inlineMarksToHtml(text: string, esc: (s: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index === undefined) continue;
    if (m.index > last) out += esc(text.slice(last, m.index));
    const tok = m[1];
    if (tok.startsWith('**')) out += `<strong>${esc(tok.slice(2, -2))}</strong>`;
    else if (tok.startsWith('*')) out += `<em>${esc(tok.slice(1, -1))}</em>`;
    else out += `<code>${esc(tok.slice(1, -1))}</code>`;
    last = m.index + tok.length;
  }
  if (last < text.length) out += esc(text.slice(last));
  return out;
}

export function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let key = 0;
  // First pass: split out URLs (so we don't try to inline-mark them).
  let lastUrlEnd = 0;
  const urlMatches = [...text.matchAll(URL_RE)];
  for (const m of urlMatches) {
    if (m.index === undefined) continue;
    if (m.index > lastUrlEnd) {
      parts.push(...renderInlineMarks(text.slice(lastUrlEnd, m.index), key));
      key += 1;
    }
    parts.push(
      <a key={`u${key++}`} href={m[1]} target="_blank" rel="noopener noreferrer">{m[1]}</a>,
    );
    lastUrlEnd = m.index + m[0].length;
  }
  if (lastUrlEnd < text.length) {
    parts.push(...renderInlineMarks(text.slice(lastUrlEnd), key));
  }
  return parts;
}

function renderInlineMarks(text: string, baseKey: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = baseKey;
  const matches = [...text.matchAll(INLINE_RE)];
  for (const m of matches) {
    if (m.index === undefined) continue;
    if (m.index > last) out.push(<React.Fragment key={`t${key++}`}>{text.slice(last, m.index)}</React.Fragment>);
    const tok = m[1];
    if (tok.startsWith('**')) {
      out.push(<strong key={`b${key++}`}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={`i${key++}`}>{tok.slice(1, -1)}</em>);
    } else {
      out.push(<code key={`c${key++}`}>{tok.slice(1, -1)}</code>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<React.Fragment key={`t${key++}`}>{text.slice(last)}</React.Fragment>);
  return out;
}
