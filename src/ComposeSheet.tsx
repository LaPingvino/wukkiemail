// Compose a new email over JMAP (plain text). Recipients are comma/space
// separated. Sends via JmapSource.sendEmail (draft + EmailSubmission).

import { useState } from 'react';
import type { JmapSource } from './sources/jmap';

export function ComposeSheet({ jmap, onClose }: { jmap: JmapSource; onClose: () => void }) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const recipients = to.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (recipients.length === 0 || !body.trim()) return;
    setBusy(true); setError(null);
    try {
      await jmap.sendEmail({ to: recipients, subject: subject.trim() || '(no subject)', text: body });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New mail" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>New mail</div>
        </header>
        <div className="sheet-body">
          <label className="sheet-label">
            <span>To</span>
            <input type="text" autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="someone@example.com" />
          </label>
          <label className="sheet-label">
            <span>Subject</span>
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
          </label>
          <label className="sheet-label">
            <span>Message</span>
            <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)}
              style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', color: 'var(--fg)', font: 'inherit', fontSize: 14 }} />
          </label>
          {error && <p style={{ color: 'var(--md-sys-color-error)', fontSize: 13, margin: 0 }}>{error}</p>}
          <button type="button" className="sheet-submit" onClick={() => void send()} disabled={busy || !to.trim() || !body.trim()} style={{ justifySelf: 'end' }}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
