// Full-screen room settings, styled like the room/email/profile panels.
// Edit name + topic where you have power; leave the room. Opened from the room
// header's settings button.
import { useEffect, useState } from 'react';
import type { MatrixSource, RoomInfo } from './sources/matrix';

export function RoomSettings({
  matrix,
  roomId,
  onClose,
  onLeft,
  onOpenMembers,
}: {
  matrix: MatrixSource;
  roomId: string;
  onClose: () => void;
  onLeft: () => void;
  onOpenMembers?: () => void;
}) {
  const [info, setInfo] = useState<RoomInfo | null>(() => matrix.roomInfo(roomId));
  const [name, setName] = useState(info?.name ?? '');
  const [topic, setTopic] = useState(info?.topic ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    const i = matrix.roomInfo(roomId);
    setInfo(i);
    setName(i?.name ?? '');
    setTopic(i?.topic ?? '');
  }, [matrix, roomId]);

  if (!info) {
    return (
      <div className="issue-panel room-panel" role="region" aria-label="Room settings">
        <header className="issue-head">
          <md-icon-button onClick={onClose} aria-label="Close"><md-icon>close</md-icon></md-icon-button>
          <div className="issue-title">Room settings</div>
        </header>
        <div className="issue-body"><p style={{ color: 'var(--muted)' }}>Room not found.</p></div>
      </div>
    );
  }

  const dirtyName = name.trim() !== info.name;
  const dirtyTopic = topic.trim() !== info.topic;
  const canSave = (dirtyName && info.canEditName) || (dirtyTopic && info.canEditTopic);

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    setErr(null);
    setSavedMsg(null);
    try {
      if (dirtyName && info.canEditName) await matrix.setRoomName(roomId, name.trim());
      if (dirtyTopic && info.canEditTopic) await matrix.setRoomTopic(roomId, topic.trim());
      const i = matrix.roomInfo(roomId);
      setInfo(i);
      setSavedMsg('Saved.');
      setTimeout(() => setSavedMsg(null), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const leave = async () => {
    // eslint-disable-next-line no-alert
    if (!confirm('Leave this room? You can be re-invited but will stop receiving messages.')) return;
    try { await matrix.leaveRoom(roomId); onLeft(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const readOnly = !info.canEditName && !info.canEditTopic;

  return (
    <div className="issue-panel room-panel" role="region" aria-label={`Settings: ${info.name || 'room'}`}>
      <header className="issue-head">
        <md-icon-button onClick={onClose} aria-label="Close settings"><md-icon>close</md-icon></md-icon-button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="issue-title">Room settings</div>
          <div className="issue-subtitle">{info.memberCount} member{info.memberCount === 1 ? '' : 's'}</div>
        </div>
      </header>
      <div className="issue-body" style={{ maxWidth: 560, margin: '0 auto', width: '100%' }}>
        <div className="profile-hero">
          {info.avatarUrl
            ? <img className="profile-avatar" src={info.avatarUrl} alt="" />
            : <span className="profile-avatar profile-avatar-fallback" aria-hidden="true">{(info.name || '?').slice(0, 1).toUpperCase()}</span>}
        </div>

        {onOpenMembers && (
          <button type="button" className="config-btn" onClick={onOpenMembers}>
            <span aria-hidden="true" className="material-symbols-outlined">group</span> Members · {info.memberCount}
          </button>
        )}

        {readOnly && (
          <p style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center' }}>
            You don’t have permission to edit this room.
          </p>
        )}

        <label className="settings-field">
          <span className="settings-label">Name</span>
          <input
            type="text"
            value={name}
            disabled={!info.canEditName}
            onChange={(e) => setName(e.target.value)}
            placeholder="Room name"
          />
        </label>

        <label className="settings-field">
          <span className="settings-label">Topic</span>
          <textarea
            value={topic}
            disabled={!info.canEditTopic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What's this room about?"
            rows={3}
          />
        </label>

        {err && <p style={{ color: 'var(--md-sys-color-error)', fontSize: 13 }}>{err}</p>}
        {savedMsg && <p style={{ color: 'var(--md-sys-color-primary)', fontSize: 13 }}>{savedMsg}</p>}

        {!readOnly && (
          <button type="button" className="config-btn" disabled={!canSave || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        )}

        <button type="button" className="config-btn settings-danger" style={{ marginTop: 16 }} onClick={() => void leave()}>
          <span aria-hidden="true" className="material-symbols-outlined">logout</span> Leave room
        </button>
      </div>
    </div>
  );
}
