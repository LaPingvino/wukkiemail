import React from 'react';

// React error boundaries must be class components. WukkieMail had none, so any
// throw during render — e.g. when a component dereferences sync/crypto state
// that went stale while the tab was frozen/discarded by Chrome's Memory Saver —
// would unmount the ENTIRE root and leave a blank white screen with no way back.
// This catches that case and shows a recoverable message instead. It does NOT
// help if the entry bundle itself failed to load (React never ran); the inline
// boot watchdog in index.html covers that path.
type Props = { children: React.ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[wukkiemail] render crash caught by ErrorBoundary', error, info);
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          display: 'grid',
          gap: 12,
          placeContent: 'center',
          minHeight: '100dvh',
          padding: 24,
          textAlign: 'center',
          color: 'var(--fg, #e6e6e6)',
          background: 'var(--bg, #111)',
          font: '14px/1.5 system-ui, sans-serif',
        }}
      >
        <strong style={{ fontSize: 18 }}>WukkieMail hit a snag</strong>
        <p style={{ margin: 0, color: 'var(--muted, #999)' }}>
          The view crashed while restoring. Your session is intact — reload to recover.
        </p>
        <pre
          style={{
            margin: 0,
            maxWidth: 480,
            overflow: 'auto',
            fontSize: 12,
            color: 'var(--muted, #888)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {error.message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            justifySelf: 'center',
            padding: '8px 20px',
            borderRadius: 999,
            border: 'none',
            cursor: 'pointer',
            background: '#14b8a6',
            color: '#04201c',
            fontWeight: 600,
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
