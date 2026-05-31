// Device manager — list this account's sessions, verify, rename, or remove
// them. Deleting needs the account password (User-Interactive Auth).

import { useEffect, useState } from 'react';
import type { MatrixSource, DeviceEntry } from './sources/matrix';

export function DevicesSheet({ matrix, onClose }: { matrix: MatrixSource; onClose: () => void }) {
  const [devices, setDevices] = useState<DeviceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setDevices(await matrix.listDevices()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [matrix]);

  const doRename = async (id: string) => {
    const name = renameVal.trim();
    setRenaming(null);
    if (name) { try { await matrix.renameDevice(id, name); await load(); } catch (e) { setError(String(e)); } }
  };
  const doDelete = async (id: string) => {
    if (!password) return;
    setBusy(true); setError(null);
    try { await matrix.deleteDevice(id, password); setDeleting(null); setPassword(''); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const verify = async (id: string) => {
    try { await matrix.startDeviceVerification(id); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>Devices</div>
        </header>
        <div className="sheet-body">
          {error && <p style={{ color: 'var(--md-sys-color-error)', fontSize: 13, margin: 0 }}>{error}</p>}
          {!devices ? (
            <p style={{ color: 'var(--muted)' }}>Loading…</p>
          ) : devices.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>No devices.</p>
          ) : (
            <ul className="device-list">
              {devices.map((d) => (
                <li key={d.deviceId} className="device-row">
                  <span className={`material-symbols-outlined device-icon ${d.verified ? 'verified' : ''}`}>
                    {d.verified ? 'verified_user' : 'devices'}
                  </span>
                  <div className="device-main">
                    {renaming === d.deviceId ? (
                      <input
                        className="device-rename" autoFocus value={renameVal}
                        aria-label="Rename this device"
                        onChange={(e) => setRenameVal(e.target.value)}
                        onBlur={() => void doRename(d.deviceId)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void doRename(d.deviceId); if (e.key === 'Escape') setRenaming(null); }}
                      />
                    ) : (
                      <div className="device-name">
                        {d.displayName || '(unnamed device)'}
                        {d.isCurrent && <span className="device-tag current">This device</span>}
                        {d.verified
                          ? <span className="device-tag ok">Verified</span>
                          : <span className="device-tag warn">Unverified</span>}
                      </div>
                    )}
                    <div className="device-meta">
                      {d.deviceId}
                      {d.lastSeenTs ? ` · last seen ${new Date(d.lastSeenTs).toLocaleDateString()}` : ''}
                      {d.lastSeenIp ? ` · ${d.lastSeenIp}` : ''}
                    </div>
                    {deleting === d.deviceId && (
                      <div className="device-delete-confirm">
                        <input
                          type="password" autoFocus placeholder="Account password to confirm"
                          aria-label="Account password to confirm device removal"
                          value={password} onChange={(e) => setPassword(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void doDelete(d.deviceId); }}
                        />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button" className="device-btn danger" disabled={!password || busy} onClick={() => void doDelete(d.deviceId)}>
                            {busy ? 'Removing…' : 'Remove'}
                          </button>
                          <button type="button" className="device-btn" onClick={() => { setDeleting(null); setPassword(''); }}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                  {deleting !== d.deviceId && renaming !== d.deviceId && (
                    <div className="device-actions">
                      {!d.isCurrent && !d.verified && (
                        <button type="button" className="device-btn" title="Verify this device" onClick={() => void verify(d.deviceId)}>
                          <span className="material-symbols-outlined">verified_user</span>
                        </button>
                      )}
                      <button type="button" className="device-btn" title="Rename" onClick={() => { setRenameVal(d.displayName); setRenaming(d.deviceId); }}>
                        <span className="material-symbols-outlined">edit</span>
                      </button>
                      {!d.isCurrent && (
                        <button type="button" className="device-btn danger" title="Remove device" onClick={() => { setDeleting(d.deviceId); setPassword(''); }}>
                          <span className="material-symbols-outlined">delete</span>
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
