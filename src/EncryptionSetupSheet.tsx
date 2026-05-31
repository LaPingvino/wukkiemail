// Encryption bootstrap / verification. The body (EncryptionSetup) is shared
// between a modal sheet and an inline block in the settings bundle — when the
// device isn't verified we surface it inline at the top of settings so the
// recovery-key step is obvious, not buried behind a dialog.
//
// Three modes:
//   - bootstrap: fresh account → create cross-signing + secret storage + key
//     backup, hand back a recovery key to save.
//   - verify: paste an existing recovery key → trust this device + restore
//     key backup so encrypted history decrypts.
//   - sas: compare emoji with another signed-in device.

import { useState } from 'react';
import type { MatrixSource } from './sources/matrix';

export function EncryptionSetup({ matrix, onDone }: { matrix: MatrixSource; onDone?: () => void }) {
  const [mode, setMode] = useState<'bootstrap' | 'verify' | 'sas'>('verify');
  const [password, setPassword] = useState('');
  const [existingKey, setExistingKey] = useState('');
  const [phase, setPhase] = useState<'enter' | 'working' | 'done' | 'error'>('enter');
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const verify = async () => {
    if (!existingKey.trim()) return;
    setPhase('working');
    setError(null);
    try {
      await matrix.verifyWithRecoveryKey(existingKey);
      setPhase('done');
      setRecoveryKey(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  const startSas = async () => {
    try { await matrix.startSelfVerification(); onDone?.(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setPhase('error'); }
  };

  const run = async () => {
    if (!password) return;
    setPhase('working');
    setError(null);
    try {
      const key = await matrix.bootstrapEncryption(password);
      setRecoveryKey(key);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  return (
    <>
      {phase === 'enter' && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className={`chip ${mode === 'verify' ? 'active' : ''}`} onClick={() => setMode('verify')}>I have a recovery key</button>
            <button type="button" className={`chip ${mode === 'sas' ? 'active' : ''}`} onClick={() => setMode('sas')}>Verify with another device</button>
            <button type="button" className={`chip ${mode === 'bootstrap' ? 'active' : ''}`} onClick={() => setMode('bootstrap')}>Set up fresh</button>
          </div>
          {mode === 'bootstrap' && (
            <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
              Your account password is needed to upload signing keys to your
              homeserver. We bootstrap cross-signing + secret storage in one
              go and hand you a recovery key to save somewhere safe.
            </p>)}
          {mode === 'verify' && (
            <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
              Paste the recovery key from another device. We use it to fetch
              your cross-signing keys, trust this device, and restore the key
              backup so encrypted history decrypts.
            </p>)}
          {mode === 'sas' && (
            <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
              Verify by comparing emoji with another device that's already
              signed in (WukkieMail or Element). Have it open and ready.
            </p>)}
          {mode === 'sas' ? (
            <button type="button" className="sheet-submit" onClick={() => void startSas()} style={{ justifySelf: 'end' }}>
              Start emoji verification
            </button>
          ) : mode === 'bootstrap' ? (
            <>
              <label className="sheet-label">
                <span>Account password</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && password) void run(); }} />
              </label>
              <button type="button" className="sheet-submit" onClick={() => void run()} disabled={!password} style={{ justifySelf: 'end' }}>Set up</button>
            </>
          ) : (
            <>
              <label className="sheet-label">
                <span>Recovery key</span>
                <input type="text" value={existingKey} onChange={(e) => setExistingKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && existingKey) void verify(); }} placeholder="EsTk … " />
              </label>
              <button type="button" className="sheet-submit" onClick={() => void verify()} disabled={!existingKey.trim()} style={{ justifySelf: 'end' }}>Verify</button>
            </>
          )}
        </>
      )}
      {phase === 'working' && (
        <p style={{ textAlign: 'center', color: 'var(--muted)' }}>Generating keys and uploading… (this can take a few seconds)</p>
      )}
      {phase === 'done' && !recoveryKey && (
        <>
          <p style={{ margin: 0, color: 'var(--md-sys-color-primary)' }}><strong>This device is verified.</strong></p>
          <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>Encrypted history should start decrypting as the SDK catches up.</p>
          {onDone && <button type="button" className="sheet-submit" onClick={onDone} style={{ justifySelf: 'end' }}>Done</button>}
        </>
      )}
      {phase === 'done' && recoveryKey && (
        <>
          <p style={{ margin: 0 }}><strong>Recovery key</strong> — save this somewhere safe. You'll need it to read encrypted history on a new device.</p>
          <code style={{ display: 'block', padding: '14px', background: 'var(--md-sys-color-surface-container)', border: '1px solid var(--border)', borderRadius: 8, fontFamily: 'JetBrains Mono, Menlo, monospace', fontSize: 14, wordBreak: 'break-all' }}>{recoveryKey}</code>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="sheet-submit" onClick={() => navigator.clipboard.writeText(recoveryKey)}>Copy</button>
            <button type="button" className="sheet-submit" style={{ background: 'transparent', color: 'var(--fg)', border: '1px solid var(--border)' }} onClick={onDone}>I've saved it</button>
          </div>
        </>
      )}
      {phase === 'error' && (
        <>
          <p style={{ color: 'var(--md-sys-color-error)', margin: 0 }}>{error}</p>
          <button type="button" className="sheet-submit" onClick={() => setPhase('enter')} style={{ justifySelf: 'end' }}>Try again</button>
        </>
      )}
    </>
  );
}

export function EncryptionSetupSheet({ matrix, onClose }: { matrix: MatrixSource; onClose: () => void }) {
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Encryption setup" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>Set up encryption</div>
        </header>
        <div className="sheet-body">
          <EncryptionSetup matrix={matrix} onDone={onClose} />
        </div>
      </div>
    </div>
  );
}
