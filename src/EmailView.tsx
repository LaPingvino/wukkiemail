// Full-screen reader for a JMAP email. Fetches the message body on open and
// marks it $seen. HTML bodies are sanitized; remote images are stripped by
// default (tracking-pixel guard) and only loaded when the user opts in via the
// "Load images" toggle — then restricted to https + no-referrer + lazy.

import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import type { JmapSource, JmapEmailFull } from './sources/jmap';

function sanitizeEmailHtml(html: string, allowImages: boolean): string {
  const forbidTags = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'];
  if (!allowImages) forbidTags.push('img');
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: forbidTags,
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
  });
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  tpl.content.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  if (allowImages) {
    tpl.content.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') ?? '';
      // Only https remote images; drop cid:/data:/http: so the toggle can't be
      // a vector for mixed-content or inline-payload tricks. srcset stripped so
      // it can't smuggle a non-https source past this check.
      if (!/^https:\/\//i.test(src)) { img.remove(); return; }
      img.removeAttribute('srcset');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      img.style.maxWidth = '100%';
    });
  }
  return tpl.innerHTML;
}

// Does the raw HTML reference a remote image? Decides whether to offer the
// toggle at all (no point showing it for image-free mail).
function hasRemoteImages(html: string | undefined): boolean {
  return !!html && /<img\b[^>]*\bsrc\s*=\s*["']?https?:/i.test(html);
}

export function EmailView({ jmap, emailId, onClose }: { jmap: JmapSource; emailId: string; onClose: () => void }) {
  const [email, setEmail] = useState<JmapEmailFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [loadImages, setLoadImages] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadImages(false); // re-arm the tracking guard for each opened message
    jmap.getEmail(emailId)
      .then((e) => { if (!cancelled) setEmail(e); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    void jmap.markEmailSeen(emailId).catch(() => { /* best effort */ });
    return () => { cancelled = true; };
  }, [jmap, emailId]);

  // Sanitize once per (body, toggle) — not on every reply keystroke.
  const safeHtml = useMemo(
    () => (email?.html ? sanitizeEmailHtml(email.html, loadImages) : null),
    [email?.html, loadImages],
  );
  const offerImages = hasRemoteImages(email?.html);

  const fromStr = email?.from?.map((a) => a.name || a.email).join(', ') ?? '';
  const when = email?.receivedAt ? new Date(email.receivedAt).toLocaleString() : '';
  const replyTo = email?.from?.[0]?.email;

  const sendReply = async () => {
    if (!email || !replyTo || !reply.trim()) return;
    setSending(true); setSendError(null);
    try {
      const subject = /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`;
      await jmap.sendEmail({ to: [replyTo], subject, text: reply.trim() });
      setReply(''); setSent(true);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

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
        {email && offerImages && (
          <div className="email-images-bar">
            <span aria-hidden="true" className="material-symbols-outlined">{loadImages ? 'image' : 'hide_image'}</span>
            <span style={{ flex: 1 }}>
              {loadImages ? 'Remote images loaded.' : 'Remote images are hidden to protect your privacy.'}
            </span>
            {!loadImages && (
              <button type="button" className="config-btn" onClick={() => setLoadImages(true)}>Load images</button>
            )}
          </div>
        )}
        {email && (
          safeHtml !== null
            ? <div className="email-html" dangerouslySetInnerHTML={{ __html: safeHtml }} />
            : <pre className="email-text">{email.text ?? '(no body)'}</pre>
        )}
      </div>
      {email && replyTo && (
        <div className="composer">
          {sendError && <p style={{ color: 'var(--md-sys-color-error)', fontSize: 12, margin: '0 0 6px' }}>{sendError}</p>}
          {sent && <p style={{ color: 'var(--md-sys-color-primary)', fontSize: 12, margin: '0 0 6px' }}>Sent.</p>}
          <textarea
            className="reply-textarea"
            value={reply}
            onChange={(e) => { setReply(e.target.value); setSent(false); }}
            placeholder={`Reply to ${replyTo}…`}
            rows={2}
          />
          <button type="button" className="hamburger" aria-label="Send reply" disabled={sending || !reply.trim()} onClick={() => void sendReply()}>
            <span aria-hidden="true" className="material-symbols-outlined">{sending ? 'hourglass_empty' : 'send'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
