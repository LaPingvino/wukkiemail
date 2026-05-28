// Full-screen reader for a JMAP email. Fetches the message body on open and
// marks it $seen. HTML bodies are sanitized; remote images are stripped for
// v1 (tracking-pixel guard) — a "load images" toggle can come later.

import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import type { JmapSource, JmapEmailFull } from './sources/jmap';

function sanitizeEmailHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'img', 'link', 'meta'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
  });
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  tpl.content.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return tpl.innerHTML;
}

export function EmailView({ jmap, emailId, onClose }: { jmap: JmapSource; emailId: string; onClose: () => void }) {
  const [email, setEmail] = useState<JmapEmailFull | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    jmap.getEmail(emailId)
      .then((e) => { if (!cancelled) setEmail(e); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    void jmap.markEmailSeen(emailId).catch(() => { /* best effort */ });
    return () => { cancelled = true; };
  }, [jmap, emailId]);

  const fromStr = email?.from?.map((a) => a.name || a.email).join(', ') ?? '';
  const when = email?.receivedAt ? new Date(email.receivedAt).toLocaleString() : '';

  return (
    <div className="issue-panel room-panel">
      <header className="issue-head">
        <md-icon-button onClick={onClose} aria-label="Close">
          <md-icon>close</md-icon>
        </md-icon-button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="issue-title">{email?.subject ?? (error ? 'Failed to load' : 'Loading…')}</div>
          {fromStr && <div className="issue-subtitle">{fromStr}{when ? ` · ${when}` : ''}</div>}
        </div>
      </header>
      <div className="issue-body" style={{ maxWidth: 820, margin: '0 auto', width: '100%' }}>
        {error && <p style={{ color: 'var(--md-sys-color-error)' }}>{error}</p>}
        {!email && !error && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
        {email && (
          email.html
            ? <div className="email-html" dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(email.html) }} />
            : <pre className="email-text">{email.text ?? '(no body)'}</pre>
        )}
      </div>
    </div>
  );
}
