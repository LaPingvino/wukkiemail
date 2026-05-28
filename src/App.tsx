import { useState } from 'react';

type Connection = 'none' | 'gmail' | 'matrix' | 'both';

export function App() {
  // v0: nothing actually connects yet. The connect screen is the entire app.
  const [conn] = useState<Connection>('none');

  if (conn === 'none') return <ConnectScreen />;
  return <Inbox />;
}

function ConnectScreen() {
  return (
    <div className="connect">
      <h2>WukkieMail</h2>
      <p style={{ color: 'var(--muted)', margin: 0 }}>
        A Google Inbox revival. Connect Gmail, Matrix, or both — features adapt to what you add.
      </p>
      <button onClick={() => alert('OAuth wiring not implemented yet — see README.')}>
        Connect Gmail
      </button>
      <button className="secondary" onClick={() => alert('Matrix login not implemented yet.')}>
        Connect Matrix
      </button>
      <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>
        Nothing here yet. Bootstrapping commit — UI shell only.
      </p>
    </div>
  );
}

function Inbox() {
  return (
    <div className="app">
      <aside className="sidebar">
        <h1>WukkieMail</h1>
        <div className="bundle active">
          <span>Inbox</span>
          <span className="count">0</span>
        </div>
      </aside>
      <main className="main">
        <div className="empty">No items yet.</div>
      </main>
    </div>
  );
}
