// Full-screen in-app call panel — embeds Element Call for the room. Keyboard
// accessible (Escape ends/closes, focus moves to the close button on open).

import { useEffect, useRef } from 'react';
import { buildCallUrl } from './call';

export function CallPanel({ roomId, roomName, onClose }: {
  roomId: string;
  roomName: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const url = buildCallUrl(roomId, roomName);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="call-panel" role="dialog" aria-modal="true" aria-label={`Call in ${roomName}`}>
      <header className="call-head">
        <button ref={closeRef} type="button" className="hamburger" aria-label="Leave call" onClick={onClose}>
          <span aria-hidden="true" className="material-symbols-outlined">call_end</span>
        </button>
        <div className="call-title">Call · {roomName}</div>
        <a className="hamburger" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open call in a new tab" title="Open in a new tab">
          <span aria-hidden="true" className="material-symbols-outlined">open_in_new</span>
        </a>
      </header>
      <iframe
        className="call-frame"
        src={url}
        title={`Call in ${roomName}`}
        allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write; speaker-selection"
      />
    </div>
  );
}
