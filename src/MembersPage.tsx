// Full-screen room member list, styled like the other panels. Each row opens
// that member's profile.
import type { MatrixSource } from './sources/matrix';

function powerLabel(pl: number): string | null {
  if (pl >= 100) return 'Admin';
  if (pl >= 50) return 'Mod';
  return null;
}

export function MembersPage({
  matrix,
  roomId,
  onClose,
  onOpenProfile,
}: {
  matrix: MatrixSource;
  roomId: string;
  onClose: () => void;
  onOpenProfile: (userId: string) => void;
}) {
  const members = matrix.getRoomMemberList(roomId);
  return (
    <div className="issue-panel room-panel" role="region" aria-label="Room members">
      <header className="issue-head">
        <md-icon-button onClick={onClose} aria-label="Close members"><md-icon>close</md-icon></md-icon-button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="issue-title">Members</div>
          <div className="issue-subtitle">{members.length}</div>
        </div>
      </header>
      <div className="issue-body" style={{ maxWidth: 560, margin: '0 auto', width: '100%' }}>
        <ul className="member-list">
          {members.map((m) => {
            const badge = powerLabel(m.powerLevel);
            return (
              <li key={m.userId}>
                <button type="button" className="member-row" onClick={() => onOpenProfile(m.userId)}>
                  {m.avatarUrl
                    ? <img className="msg-avatar" src={m.avatarUrl} alt="" loading="lazy" />
                    : <span className="msg-avatar msg-avatar-fallback" aria-hidden="true">{m.name.slice(0, 1).toUpperCase()}</span>}
                  <span className="member-name">{m.name}</span>
                  {badge && <span className="member-power">{badge}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
