// Auto-collapses content taller than ~10 lines, with a "Show more" button.
// We measure after mount; if scrollHeight exceeds the collapsed cap we
// add a fade and the toggle. Re-measure when children change so a
// pasted long URL inside a comment thread doesn't escape the clamp.

import { useEffect, useRef, useState } from 'react';
import type React from 'react';

const COLLAPSED_MAX = 240; // px — roughly 10–12 lines at 14px

export function CollapsibleBody({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOverflows(el.scrollHeight > COLLAPSED_MAX + 16);
  }, [children]);

  const collapsed = !expanded && overflows;
  return (
    <div className={`collapsible ${collapsed ? 'collapsed' : ''} ${className}`}>
      <div
        ref={ref}
        className="collapsible-inner"
        style={collapsed ? { maxHeight: COLLAPSED_MAX, overflow: 'hidden' } : undefined}
      >
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          className="collapsible-toggle"
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
