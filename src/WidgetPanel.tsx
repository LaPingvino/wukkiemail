// WidgetPanel — lists a room's im.vector.modular.widgets and embeds the
// selected one in an iframe, driven by SmallWidget + SmallWidgetDriver (our
// MatrixClient is wired in). Plain-React port of cinny-wally's WidgetsDrawer;
// the issue-board widget is the concrete use case but any widget URL works.
import { useEffect, useRef, useState } from 'react';
import type { MatrixSource, RoomWidget } from './sources/matrix';
import { SmallWidget, createVirtualWidget } from './SmallWidget';

// Substitute Matrix widget template variables in a URL (subset Element uses).
function substituteTemplateVars(url: string, matrix: MatrixSource, roomId: string, widgetId: string): string {
  const mx = matrix.getClient();
  const userId = mx?.getUserId() ?? '';
  const displayName = mx?.getUser(userId)?.displayName ?? userId;
  const avatarUrl = mx?.getUser(userId)?.avatarUrl ?? '';
  return url
    .replace(/\$matrix_room_id/g, encodeURIComponent(roomId))
    .replace(/\$matrix_user_id/g, encodeURIComponent(userId))
    .replace(/\$matrix_display_name/g, encodeURIComponent(displayName))
    .replace(/\$matrix_avatar_url/g, encodeURIComponent(avatarUrl))
    .replace(/\$matrix_widget_id/g, encodeURIComponent(widgetId))
    .replace(/\$matrix_client_origin/g, encodeURIComponent(window.location.origin))
    .replace(/\$org\.matrix\.msc2873\.client_id/g, encodeURIComponent(userId))
    .replace(/\$org\.matrix\.msc2873\.client_origin/g, encodeURIComponent(window.location.origin));
}

function WidgetView({ matrix, roomId, widget }: { matrix: MatrixSource; roomId: string; widget: RoomWidget }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const smallWidgetRef = useRef<SmallWidget | null>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    const mx = matrix.getClient();
    if (!iframe || !mx) return undefined;

    if (smallWidgetRef.current) {
      smallWidgetRef.current.stopMessaging();
      smallWidgetRef.current = null;
    }

    const resolvedUrl = new URL(substituteTemplateVars(widget.url, matrix, roomId, widget.id));
    resolvedUrl.searchParams.set('widgetId', widget.id);
    resolvedUrl.searchParams.set('parentUrl', window.location.origin);

    const userId = mx.getUserId() ?? '';
    const app = createVirtualWidget(
      mx, widget.id, userId, widget.name, widget.type, resolvedUrl,
      false, widget.data ?? {}, roomId,
    );

    const sw = new SmallWidget(app);
    smallWidgetRef.current = sw;
    // Start messaging BEFORE setting src so the widget's ContentLoaded handshake
    // isn't missed.
    sw.startMessaging(iframe);
    iframe.src = resolvedUrl.toString();

    return () => {
      sw.stopMessaging();
      if (smallWidgetRef.current === sw) smallWidgetRef.current = null;
    };
    // Depend on id+url only: the source emits new RoomWidget objects on every
    // state change, and tearing down a live iframe would lose its handshake.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matrix, roomId, widget.id, widget.url]);

  return (
    <iframe
      ref={iframeRef}
      title={widget.name}
      className="widget-iframe"
      sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-modals allow-downloads"
      allow="microphone; camera; fullscreen; clipboard-write"
    />
  );
}

export function WidgetPanel({ matrix, roomId, roomName, onClose }: {
  matrix: MatrixSource;
  roomId: string;
  roomName: string;
  onClose: () => void;
}) {
  const [widgets, setWidgets] = useState<RoomWidget[]>(() => matrix.getRoomWidgets(roomId));
  const [selectedId, setSelectedId] = useState<string | null>(() => matrix.getRoomWidgets(roomId)[0]?.id ?? null);
  const [adding, setAdding] = useState(false);
  const [addUrl, setAddUrl] = useState('');
  const [addName, setAddName] = useState('');
  const [busy, setBusy] = useState(false);
  const canManage = matrix.canManageWidgets(roomId);

  // Keep the list live as widget state events change.
  useEffect(() => {
    const unsub = matrix.subscribe(() => setWidgets(matrix.getRoomWidgets(roomId)));
    return unsub;
  }, [matrix, roomId]);

  // Keep a valid selection.
  useEffect(() => {
    setSelectedId((prev) => {
      if (prev && widgets.some((w) => w.id === prev)) return prev;
      return widgets[0]?.id ?? null;
    });
  }, [widgets]);

  const selected = widgets.find((w) => w.id === selectedId) ?? null;

  const add = async () => {
    const url = addUrl.trim();
    if (!url) return;
    let name = addName.trim();
    if (!name) { try { name = new URL(url).hostname; } catch { name = 'Widget'; } }
    setBusy(true);
    try {
      await matrix.addWidget(roomId, url, name);
      setAddUrl(''); setAddName(''); setAdding(false);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] addWidget failed', e);
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Remove this widget from the room?')) return;
    try { await matrix.removeWidget(roomId, id); }
    catch (e) { console.warn('[wukkiemail] removeWidget failed', e); }
  };

  return (
    <div className="call-panel widget-panel" role="dialog" aria-modal="true" aria-label={`Widgets in ${roomName}`}>
      <header className="call-head">
        <button type="button" className="hamburger" aria-label="Close widgets" onClick={onClose}>
          <span className="material-symbols-outlined">close</span>
        </button>
        <div className="call-title">Widgets · {roomName}</div>
        {canManage && (
          <button type="button" className="hamburger" aria-label="Add widget" title="Add widget" onClick={() => setAdding((a) => !a)}>
            <span className="material-symbols-outlined">add</span>
          </button>
        )}
      </header>

      {widgets.length > 0 && (
        <div className="widget-tabs" role="tablist">
          {widgets.map((w) => (
            <span key={w.id} className="widget-tab-wrap">
              <button
                type="button"
                role="tab"
                aria-selected={selectedId === w.id}
                className={`widget-tab ${selectedId === w.id ? 'active' : ''}`}
                onClick={() => setSelectedId(w.id)}
              >{w.name}</button>
              {canManage && (
                <button type="button" className="widget-tab-x" aria-label={`Remove ${w.name}`} title="Remove" onClick={() => void remove(w.id)}>
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {adding && (
        <div className="widget-add">
          <input type="url" placeholder="Widget URL (required)" aria-label="Widget URL" value={addUrl} autoFocus
            onChange={(e) => setAddUrl(e.target.value)} />
          <input type="text" placeholder="Name (defaults to hostname)" aria-label="Widget name" value={addName}
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
          <div className="widget-add-actions">
            <button type="button" className="sheet-submit" disabled={!addUrl.trim() || busy} onClick={() => void add()}>
              {busy ? 'Adding…' : 'Add'}
            </button>
            <button type="button" className="hamburger" onClick={() => { setAdding(false); setAddUrl(''); setAddName(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {selected ? (
        <WidgetView key={selected.id} matrix={matrix} roomId={roomId} widget={selected} />
      ) : !adding ? (
        <div className="call-empty">
          <p>No widgets in this room.</p>
          {canManage && (
            <button type="button" className="sheet-submit" onClick={() => setAdding(true)} style={{ marginTop: 12 }}>
              Add a widget
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
