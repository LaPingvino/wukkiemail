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

const URL_RE = /\b(https?:\/\/[^\s)]+[^\s.,;:!?)\]'"])/g;
const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;

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
