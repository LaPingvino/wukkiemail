// Full-screen user profile, styled like the room/email panels (issue-panel).
// Opened by tapping a sender's avatar or name in a conversation.
import { useEffect, useState } from 'react';
import type { MatrixSource, UserProfile } from './sources/matrix';

const PRESENCE_LABEL: Record<string, string> = {
  online: 'Online',
  unavailable: 'Away',
  offline: 'Offline',
};

export function ProfilePage({
  matrix,
  userId,
  roomId,
  onClose,
  onOpenRoom,
}: {
  matrix: MatrixSource;
  userId: string;
  roomId?: string;
  onClose: () => void;
  onOpenRoom?: (roomId: string) => void;
}) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Room-scoped name/avatar resolve instantly; the global profile fills in async.
    void matrix.getUserProfile(userId, roomId).then((p) => { if (!cancelled) setProfile(p); });
    return () => { cancelled = true; };
  }, [matrix, userId, roomId]);

  const dmRoom = matrix.findDirectMessage(userId);
  const name = profile?.displayName ?? userId;
  const presence = profile?.presence;
  const sharedRooms = profile?.sharedRooms ?? [];

  return (
    <div className="issue-panel room-panel" role="region" aria-label={`Profile: ${name}`}>
      <header className="issue-head">
        <md-icon-button onClick={onClose} aria-label="Close profile">
          <md-icon>close</md-icon>
        </md-icon-button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="issue-title">{name}</div>
          {presence && <div className="issue-subtitle">{PRESENCE_LABEL[presence] ?? presence}</div>}
        </div>
      </header>
      <div className="issue-body" style={{ maxWidth: 560, margin: '0 auto', width: '100%' }}>
        <div className="profile-hero">
          {profile?.avatarUrl
            ? <img className="profile-avatar" src={profile.avatarUrl} alt="" />
            : <span className="profile-avatar profile-avatar-fallback" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}
          <div className="profile-name">{name}</div>
          <button
            type="button"
            className="profile-mxid"
            title="Copy Matrix ID"
            onClick={() => {
              try { void navigator.clipboard?.writeText(userId); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
            }}
          >
            {userId}
            <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 14 }}>
              {copied ? 'check' : 'content_copy'}
            </span>
          </button>
        </div>

        {dmRoom && onOpenRoom && (
          <button type="button" className="config-btn" style={{ marginTop: 8 }} onClick={() => onOpenRoom(dmRoom)}>
            <span aria-hidden="true" className="material-symbols-outlined">chat</span> Message
          </button>
        )}

        {sharedRooms.length > 0 && (
          <section style={{ marginTop: 16 }}>
            <div className="section-header"><span className="section-header-label">Rooms in common</span><span className="bundle-count">{sharedRooms.length}</span></div>
            <ul className="profile-shared">
              {sharedRooms.map((r) => (<li key={r}>{r}</li>))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
