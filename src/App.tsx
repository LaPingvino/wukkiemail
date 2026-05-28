import { useEffect, useState } from 'react';
import { loginWithPassword, saveCreds, clearCreds } from './auth/matrix';
import { MatrixSource } from './sources/matrix';
import type { InboxItem } from './sources/types';

type AppState =
  | { kind: 'booting' }
  | { kind: 'connect' }
  | { kind: 'connecting' }
  | { kind: 'ready'; matrix: MatrixSource };

export function App() {
  const [state, setState] = useState<AppState>({ kind: 'booting' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const restored = MatrixSource.tryRestore();
    if (!restored) {
      setState({ kind: 'connect' });
      return;
    }
    restored.start().then(
      () => { if (!cancelled) setState({ kind: 'ready', matrix: restored }); },
      (e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setState({ kind: 'connect' });
      },
    );
    return () => { cancelled = true; };
  }, []);

  if (state.kind === 'booting') {
    return <div className="empty">Restoring session…</div>;
  }
  if (state.kind === 'connecting') {
    return <div className="empty">Signing in…</div>;
  }
  if (state.kind === 'connect') {
    return (
      <ConnectScreen
        error={error}
        onMatrixLogin={async (mxid, pw) => {
          setError(null);
          setState({ kind: 'connecting' });
          try {
            const creds = await loginWithPassword(mxid, pw);
            saveCreds(creds);
            const src = new MatrixSource(creds);
            await src.start();
            setState({ kind: 'ready', matrix: src });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setState({ kind: 'connect' });
          }
        }}
      />
    );
  }
  return (
    <Inbox
      matrix={state.matrix}
      onSignOut={async () => {
        await state.matrix.stop();
        clearCreds();
        setState({ kind: 'connect' });
      }}
    />
  );
}

function ConnectScreen({
  error,
  onMatrixLogin,
}: {
  error: string | null;
  onMatrixLogin: (mxid: string, password: string) => Promise<void>;
}) {
  const [mxid, setMxid] = useState('');
  const [pw, setPw] = useState('');
  return (
    <div className="connect">
      <h2>WukkieMail</h2>
      <p style={{ color: 'var(--muted)', margin: 0 }}>
        Connect Gmail, Matrix, or both — features adapt to what you add.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (mxid && pw) void onMatrixLogin(mxid, pw);
        }}
        style={{ display: 'grid', gap: 8 }}
      >
        <input
          type="text"
          placeholder="@you:matrix.org"
          value={mxid}
          onChange={(e) => setMxid(e.target.value)}
          autoComplete="username"
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="Password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoComplete="current-password"
          style={inputStyle}
        />
        <button type="submit">Connect Matrix</button>
      </form>
      <button className="secondary" onClick={() => alert('Gmail OAuth wiring next iteration.')}>
        Connect Gmail
      </button>
      {error && <p style={{ color: '#e57373', margin: 0, fontSize: 13 }}>{error}</p>}
      <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>
        Matrix-only for now. Gmail click-through coming next iteration.
      </p>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--bg)',
  color: 'var(--fg)',
  font: 'inherit',
};

function Inbox({ matrix, onSignOut }: { matrix: MatrixSource; onSignOut: () => void }) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    matrix.listItems(null).then((xs) => {
      if (!cancelled) {
        setItems(xs);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [matrix]);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>WukkieMail</h1>
        <div className="bundle active">
          <span>Inbox</span>
          <span className="count">{items.length}</span>
        </div>
        <button
          onClick={onSignOut}
          style={{
            marginTop: 24, width: '100%', padding: '8px',
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 8, color: 'var(--muted)',
          }}
        >
          Sign out
        </button>
      </aside>
      <main className="main">
        {loading ? (
          <div className="empty">Loading rooms…</div>
        ) : items.length === 0 ? (
          <div className="empty">No items.</div>
        ) : (
          <div className="item-list">
            {items.slice(0, 200).map((it) => (
              <div key={it.id} className="item">
                <div className={`src ${it.flavor}`} />
                <div className="from">{it.from}</div>
                <div className="subj">
                  <strong>{it.subject}</strong> — {it.snippet}
                </div>
                <div className="ts">{formatTs(it.ts)}</div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
