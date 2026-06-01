// SAS (emoji) device verification UI. Driven entirely by the
// MatrixSource verification state channel — it appears whenever a
// verification is in flight, whether this device started it
// (Encryption sheet → "Verify with another device") or another device
// requested it (caught by the CryptoEvent listener in MatrixSource).

import { useEffect, useState } from 'react';
import type { MatrixSource, VerificationState } from './sources/matrix';

export function VerificationSheet({ matrix }: { matrix: MatrixSource }) {
  const [state, setState] = useState<VerificationState>(() => matrix.getVerificationState());
  const [busy, setBusy] = useState(false);
  useEffect(() => matrix.onVerification(setState), [matrix]);

  if (state.phase === 'idle') return null;

  const close = () => {
    if (state.phase === 'sas' || state.phase === 'requested') matrix.cancelVerification();
    else matrix.resetVerification();
  };

  const confirm = async () => {
    setBusy(true);
    try { await matrix.confirmVerification(); }
    finally { setBusy(false); }
  };

  const accept = async () => {
    setBusy(true);
    try { await matrix.acceptVerification(); }
    finally { setBusy(false); }
  };

  return (
    <div className="sheet-scrim" onClick={close}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Device verification" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={close}>
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>
            {state.incoming ? 'Verify this device' : 'Verify with another device'}
          </div>
        </header>
        <div className="sheet-body">
          {state.phase === 'requested' && state.incoming && !state.accepted && (
            <>
              <p style={{ margin: 0, color: 'var(--muted)' }}>
                Another device wants to verify this one. Accept to compare emoji.
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="sheet-submit"
                  style={{ background: 'transparent', color: 'var(--md-sys-color-error)', border: '1px solid var(--border)' }}
                  onClick={() => matrix.cancelVerification()}
                  disabled={busy}
                >
                  Reject
                </button>
                <button type="button" className="sheet-submit" onClick={() => void accept()} disabled={busy}>
                  {busy ? 'Accepting…' : 'Accept'}
                </button>
              </div>
            </>
          )}

          {state.phase === 'requested' && state.incoming && state.accepted && (
            <p style={{ textAlign: 'center', color: 'var(--muted)' }}>
              Waiting for the emoji…
            </p>
          )}

          {state.phase === 'requested' && !state.incoming && (
            <p style={{ textAlign: 'center', color: 'var(--muted)' }}>
              Waiting for your other device to accept. Open WukkieMail / Element there and accept the request…
            </p>
          )}

          {state.phase === 'sas' && (
            <>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                Confirm the same emoji appear in the same order on both devices,
                then press <strong>They match</strong>. If they differ, someone
                may be intercepting — press <strong>They don't match</strong>.
              </p>
              <div className="sas-grid">
                {(state.emoji ?? []).map(([glyph, name], i) => (
                  <div className="sas-emoji" key={`${name}-${i}`}>
                    <span className="sas-glyph">{glyph}</span>
                    <span className="sas-name">{name}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="sheet-submit"
                  style={{ background: 'transparent', color: 'var(--md-sys-color-error)', border: '1px solid var(--border)' }}
                  onClick={() => matrix.cancelVerification()}
                  disabled={busy}
                >
                  They don't match
                </button>
                <button type="button" className="sheet-submit" onClick={() => void confirm()} disabled={busy}>
                  {busy ? 'Confirming…' : 'They match'}
                </button>
              </div>
            </>
          )}

          {state.phase === 'done' && (
            <>
              <p style={{ margin: 0, color: 'var(--md-sys-color-primary)' }}>
                <strong>Verified.</strong> This device is now trusted; encrypted
                history should start decrypting.
              </p>
              <button type="button" className="sheet-submit" onClick={() => matrix.resetVerification()} style={{ justifySelf: 'end' }}>
                Done
              </button>
            </>
          )}

          {state.phase === 'cancelled' && (
            <>
              <p style={{ margin: 0, color: 'var(--md-sys-color-error)' }}>
                Verification was cancelled{state.error ? `: ${state.error}` : '.'}
              </p>
              <button type="button" className="sheet-submit" onClick={() => matrix.resetVerification()} style={{ justifySelf: 'end' }}>
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
