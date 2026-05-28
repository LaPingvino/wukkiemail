// Settings sheet: tune the priority weights that drive the inbox sort.
// Each row is a slider 0–10. Save persists to account data so the new
// weights sync across devices (and the inbox re-sorts on the next tick).

import { useState } from 'react';
import type { MatrixSource } from './sources/matrix';
import type { PriorityWeights } from './sources/matrix';
import { DEFAULT_WEIGHTS } from './sources/matrix';

export function SettingsSheet({
  matrix, onClose,
}: {
  matrix: MatrixSource;
  onClose: () => void;
}) {
  const [w, setW] = useState<PriorityWeights>(() => matrix.getWeights());
  const [saving, setSaving] = useState(false);

  const slider = (key: keyof PriorityWeights, label: string, hint: string) => (
    <label className="slider-row" key={key}>
      <div className="slider-head">
        <strong>{label}</strong>
        <span className="value">{w[key]}</span>
      </div>
      <input
        type="range"
        min={0} max={10} step={1}
        value={w[key]}
        onChange={(e) => setW({ ...w, [key]: Number(e.target.value) })}
      />
      <div className="hint">{hint}</div>
    </label>
  );

  const save = async () => {
    setSaving(true);
    try { await matrix.setWeights(w); onClose(); }
    catch (e) { console.warn('[wukkiemail] setWeights failed', e); }
    finally { setSaving(false); }
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>Priority tuning</div>
          <button type="button" className="sheet-submit" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </header>
        <div className="sheet-body">
          <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
            Higher = the inbox stream pulls this kind of item up; lower = it
            sinks. 0 turns that signal off. Bridge & bot are penalties.
          </p>
          {slider('mention', 'Mention / highlight', 'When you were directly mentioned or a keyword fired')}
          {slider('unread', 'Unread', 'Any unread item without a highlight')}
          {slider('dm', 'DM', 'One-on-one conversations')}
          {slider('recent', 'Recent', 'Activity within the last 24 hours')}
          {slider('bridgeChat', 'Bridge group penalty', 'How much group chats from bridges (WhatsApp/IRC/etc.) are demoted')}
          {slider('bot', 'Bot sender penalty', 'How much bot-looking senders are demoted')}
          <button
            type="button"
            onClick={() => setW(DEFAULT_WEIGHTS)}
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              padding: '8px 12px', borderRadius: 999, cursor: 'pointer',
              color: 'var(--muted)', font: 'inherit',
            }}
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}
