// Room detail — slide-in panel with the most recent messages of a room.
// Subscribes to the source's change events so new messages appear as
// they arrive. No compose/reply yet — this is the read-side preview.

import { Fragment, useEffect, useRef, useState } from 'react';
import type { MatrixSource } from './sources/matrix';
import type { RoomTimelineSnapshot } from './sources/matrix';
import { renderInline, renderFormattedHtml, markdownToHtml } from './markdown';
import { expandShortcodes } from './emoji';
import { loadEmojis, searchEmojis, type EmojiEntry } from './emojiData';
import { EmojiPicker, type EmojiPick } from './EmojiPicker';
import type { CustomEmoji } from './sources/matrix';
import { CollapsibleBody } from './CollapsibleBody';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Day-separator label: Today / Yesterday / weekday (this week) / full date.
function dayLabel(ts: number): string {
  const d = new Date(ts);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// "geo:52.52,13.40;u=35" → an OpenStreetMap link so m.location shares open a map
// instead of rendering as junk text.
function geoUriToMapUrl(geo: string): string {
  const m = /geo:([-\d.]+),([-\d.]+)/.exec(geo);
  if (!m) return geo;
  const [, lat, lon] = m;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
}

// Shared look for the muted, full-width "tap to retry" timeline markers (start
// of room / empty room). Under sliding sync an empty or bottomed-out view is
// often just a not-yet-arrived pagination token, so both are clickable retries.
const RETRY_MARKER_STYLE: React.CSSProperties = {
  display: 'block',
  width: '100%',
  background: 'none',
  border: 'none',
  color: 'var(--muted)',
  fontSize: 12,
  textAlign: 'center',
  margin: '8px 0',
  padding: 4,
};

// Lazily fetch + decrypt an E2EE image into a blob URL, revoking on unmount.
function EncryptedImage({ matrix, file, alt, sticker }: { matrix: MatrixSource; file: import('./media').EncryptedFile; alt: string; sticker?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true; let made: string | null = null;
    matrix.decryptMedia(file).then((u) => {
      if (!live) { if (u) URL.revokeObjectURL(u); return; }
      if (u) { made = u; setUrl(u); } else setFailed(true);
    });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [matrix, file]);
  if (failed) return <span className="msg-file"><span aria-hidden="true" className="material-symbols-outlined">image</span> (couldn't decrypt image)</span>;
  if (!url) return <span className="msg-file"><span aria-hidden="true" className="material-symbols-outlined">lock</span> decrypting image…</span>;
  // Stickers render small and inline (no click-to-open lightbox).
  if (sticker) return <img src={url} alt={alt} className="msg-image msg-sticker" loading="lazy" />;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      <img src={url} alt={alt} className="msg-image" loading="lazy" />
    </a>
  );
}

// Encrypted file / video / audio. Unlike images we decrypt LAZILY on click —
// these can be large (a video) and we don't want to fetch+decrypt every
// attachment in a scrollback. Once decrypted, A/V plays inline; anything else
// becomes a download link with the original filename.
function EncryptedFileLink({ matrix, file, name, mimetype, size, fmtBytes }: {
  matrix: MatrixSource;
  file: import('./media').EncryptedFile;
  name: string;
  mimetype?: string;
  size?: number;
  fmtBytes: (n: number) => string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const madeRef = useRef<string | null>(null);
  useEffect(() => () => { if (madeRef.current) URL.revokeObjectURL(madeRef.current); }, []);
  const decrypt = async () => {
    if (url || busy) return;
    setBusy(true); setFailed(false);
    const u = await matrix.decryptMedia(file, mimetype);
    setBusy(false);
    if (u) { madeRef.current = u; setUrl(u); } else setFailed(true);
  };
  if (url && mimetype?.startsWith('video/')) {
    return <video src={url} controls className="msg-image" />;
  }
  if (url && mimetype?.startsWith('audio/')) {
    return <audio src={url} controls style={{ maxWidth: '100%' }} />;
  }
  if (url) {
    return (
      <a href={url} download={name} className="msg-file">
        <span aria-hidden="true" className="material-symbols-outlined">download</span>
        <span>{name}</span>
        {size != null && <span style={{ color: 'var(--muted)' }}>· {fmtBytes(size)}</span>}
      </a>
    );
  }
  return (
    <button type="button" className="msg-file" onClick={() => void decrypt()} disabled={busy} style={{ cursor: 'pointer' }}>
      <span aria-hidden="true" className="material-symbols-outlined">{failed ? 'error' : 'lock'}</span>
      <span>{failed ? "Couldn't decrypt" : busy ? 'Decrypting…' : name}</span>
      {size != null && <span style={{ color: 'var(--muted)' }}>· {fmtBytes(size)}</span>}
    </button>
  );
}

export function RoomPanel({
  matrix,
  roomId,
  onClose,
  onBack,
  backLabel,
  onNext,
  nextLabel,
  onStartCall,
  onOpenWidgets,
  incomingCall,
  onPickUp,
  threadRootId,
  onOpenThread,
  onOpenProfile,
  onOpenSettings,
}: {
  matrix: MatrixSource;
  roomId: string;
  onClose: () => void;
  onBack?: () => void;
  backLabel?: string;
  onNext?: () => void;
  nextLabel?: string;
  onStartCall?: (roomName: string) => void;
  // Open the room's widgets panel. Undefined hides the button.
  onOpenWidgets?: (roomName: string) => void;
  // An incoming call ringing somewhere — shows a "pick up" button in the header
  // while you're reading a chat (like the Next button). Undefined = no call.
  incomingCall?: { roomId: string; roomName: string };
  onPickUp?: (roomId: string, roomName: string) => void;
  // When set, this panel is a thread view: the timeline is filtered to the
  // thread, the composer threads new messages, and there is no "N replies"
  // affordance (we're already inside the thread).
  threadRootId?: string;
  // Open the thread hanging off a given message (main timeline only).
  onOpenThread?: (rootEventId: string) => void;
  // Open a user's profile (tap a sender avatar/name).
  onOpenProfile?: (userId: string) => void;
  // Open this room's settings (header button). Undefined in thread view.
  onOpenSettings?: () => void;
}) {
  const [snap, setSnap] = useState<RoomTimelineSnapshot | null>(() => matrix.getRoomTimeline(roomId, 200, threadRootId));
  const [composeText, setComposeText] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<{ eventId: string; senderName: string; body: string } | null>(null);
  const [editing, setEditing] = useState<{ eventId: string; originalBody: string } | null>(null);
  const selfId = matrix.id;
  const canRedactOthers = matrix.canRedactOthers(roomId);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  // Keyboard message cursor (Up/Down through the timeline; -1 = none). The
  // panel root ref lets ONLY the topmost room panel (main vs thread overlay)
  // handle nav, so they don't both move on a single keypress.
  const [msgCursor, setMsgCursor] = useState(-1);
  const panelRootRef = useRef<HTMLDivElement>(null);

  const pickFile = () => fileInputRef.current?.click();
  const onFileSelected = async (file: File) => {
    setUploading(true);
    setSendError(null);
    try {
      await matrix.uploadAndSendFile(roomId, file);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
      // Drop the failed echo so it doesn't look sent and doesn't block the queue.
      matrix.cancelFailedEvents(roomId);
    } finally {
      setUploading(false);
    }
  };
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // ── @-mention autocomplete ──
  // `mention` is the active trailing "@query" being typed (null when none).
  // We keep refs in sync so the imperative composer listeners (attached
  // once) always read the latest values without stale closures.
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);
  const membersRef = useRef<{ userId: string; name: string; avatarUrl?: string }[]>([]);
  const mentionRef = useRef<{ query: string; index: number } | null>(null);
  mentionRef.current = mention;
  const composeTextRef = useRef('');
  composeTextRef.current = composeText;
  // Per-room (per-thread) composer draft, persisted so navigating away and back
  // keeps a half-typed message. The key lives in a ref so the once-attached
  // input listener always saves under the CURRENT room, never a stale closure.
  const draftKey = `wukkiemail:draft:${roomId}${threadRootId ? ':' + threadRootId : ''}`;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  // This panel's own composer field (set in its ref callback), so the draft
  // restore targets the right one even when a thread overlay adds a 2nd composer.
  const composerFieldRef = useRef<(HTMLElement & { value: string }) | null>(null);
  // Display name → userId for mentions the user picked, so send() can build
  // matrix.to pills + m.mentions even though the composer is plain text.
  const acceptedMentions = useRef<Map<string, string>>(new Map());

  // ── emoji ──
  // Full picker open state, the loaded room custom emoji, the emojibase set
  // (for the ":" autocomplete), and the shortcode→mxc map for custom emoji the
  // user inserted as ":shortcode:" text (converted to <img data-mx-emoticon> at
  // send, exactly like the mention pills).
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
  const [customEmojis, setCustomEmojis] = useState<CustomEmoji[]>(() => matrix.getCustomEmojis(roomId));
  const [stickers, setStickers] = useState<CustomEmoji[]>(() => matrix.getStickers(roomId));
  const usedCustomEmojis = useRef<Map<string, string>>(new Map()); // shortcode -> mxc
  const emojiListRef = useRef<EmojiEntry[]>([]);
  // ":word" autocomplete (parallel to the @-mention menu). Never triggers on
  // :P / :D / :) — see EMOJI_TRIGGER below (needs ≥2 word chars after the colon).
  const [emojiAc, setEmojiAc] = useState<{ query: string; index: number } | null>(null);
  const emojiAcRef = useRef<{ query: string; index: number } | null>(null);
  emojiAcRef.current = emojiAc;

  useEffect(() => { void loadEmojis().then((l) => { emojiListRef.current = l; }); }, []);
  useEffect(() => {
    setCustomEmojis(matrix.getCustomEmojis(roomId));
    setStickers(matrix.getStickers(roomId));
    const unsub = matrix.subscribe(() => {
      setCustomEmojis(matrix.getCustomEmojis(roomId));
      setStickers(matrix.getStickers(roomId));
    });
    return unsub;
  }, [matrix, roomId]);

  useEffect(() => {
    let cancelled = false;
    // Seed with whatever's already known, then fetch the full roster — with
    // lazyLoadMembers the synchronous list is only the members seen so far,
    // so autocomplete would otherwise miss people who haven't spoken.
    membersRef.current = matrix.getRoomMembers(roomId);
    void matrix.loadRoomMembers(roomId).then((mem) => { if (!cancelled && mem.length) membersRef.current = mem; });
    return () => { cancelled = true; };
  }, [matrix, roomId]);

  // Restore this room/thread's saved draft when it opens. Sets both React state
  // and the Material field imperatively (its value doesn't track state across
  // renders). Skips while editing a message (that text is not a draft).
  useEffect(() => {
    if (editing) return;
    let saved = '';
    try { saved = localStorage.getItem(draftKey) || ''; } catch { /* ignore */ }
    setComposeText(saved);
    composeTextRef.current = saved;
    if (composerFieldRef.current) composerFieldRef.current.value = saved;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const TRAILING_MENTION = /(^|\s)@([^\s@]{0,30})$/;
  const computeMatches = (query: string) => {
    const q = query.toLowerCase();
    return membersRef.current
      .filter((m) => m.name.toLowerCase().includes(q) || m.userId.slice(1).toLowerCase().includes(q))
      .slice(0, 8);
  };
  const mentionMatches = mention ? computeMatches(mention.query) : [];

  const acceptMention = (member: { userId: string; name: string }, fieldEl: { value: string } & HTMLElement) => {
    const v = composeTextRef.current;
    const newV = v.replace(TRAILING_MENTION, (_full, lead: string) => `${lead}@${member.name} `);
    acceptedMentions.current.set(member.name, member.userId);
    fieldEl.value = newV;
    setComposeText(newV);
    try { if (newV) localStorage.setItem(draftKeyRef.current, newV); } catch { /* ignore */ }
    setMention(null);
    fieldEl.focus();
  };

  // ":word" with ≥2 word chars at the end, the colon preceded by start/space.
  // This is what keeps :P / :D / :) / :-) from popping the menu (1 char, or a
  // non-word char after the colon → no match).
  const EMOJI_TRIGGER = /(^|\s):([a-z0-9_+]{2,})$/i;
  type EmojiMatch = { kind: 'unicode'; char: string; label: string } | { kind: 'custom'; shortcode: string; mxc: string };
  const computeEmojiMatches = (query: string): EmojiMatch[] => {
    const ql = query.toLowerCase();
    const custom: EmojiMatch[] = customEmojis
      .filter((c) => c.shortcode.toLowerCase().includes(ql))
      .slice(0, 4)
      .map((c) => ({ kind: 'custom', shortcode: c.shortcode, mxc: c.mxc }));
    const uni: EmojiMatch[] = searchEmojis(emojiListRef.current, query, 8)
      .map((e) => ({ kind: 'unicode', char: e.char, label: e.shortcodes[0] ?? e.label }));
    return [...custom, ...uni].slice(0, 8);
  };
  const emojiMatches = emojiAc ? computeEmojiMatches(emojiAc.query) : [];

  // Insert a unicode char or a custom :shortcode: at the caret position,
  // replacing whatever the user has typed so far. `replaceTrigger` swaps the
  // trailing ":query" (autocomplete path); otherwise we append.
  const insertEmoji = (pick: EmojiPick, fieldEl: (HTMLElement & { value: string }) | null, replaceTrigger: boolean) => {
    const v = composeTextRef.current;
    const piece = 'char' in pick ? pick.char : `:${pick.custom.shortcode}:`;
    if ('custom' in pick) usedCustomEmojis.current.set(pick.custom.shortcode, pick.custom.mxc);
    const newV = replaceTrigger
      ? v.replace(EMOJI_TRIGGER, (_f, lead: string) => `${lead}${piece}`)
      : v + piece;
    setComposeText(newV);
    try { if (newV) localStorage.setItem(draftKeyRef.current, newV); } catch { /* ignore */ }
    if (fieldEl) { fieldEl.value = newV; fieldEl.focus(); }
    setEmojiAc(null);
  };

  useEffect(() => {
    // Under sliding sync the room may be outside the window — subscribe so its
    // full timeline loads (no-op on classic sync).
    matrix.subscribeRoom(roomId);
    const unsub = matrix.subscribe(() => {
      setSnap(matrix.getRoomTimeline(roomId, 200, threadRootId));
    });
    void matrix.markRoomRead(roomId);
    return unsub;
  }, [matrix, roomId, threadRootId]);

  // Auto-scroll: on initial open jump to the bottom; on subsequent
  // updates, stay glued to the bottom only if we were already there.
  const stuckRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [snap]);

  const loadOlder = async () => {
    if (loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    try {
      const { more } = await matrix.loadOlder(roomId, 50);
      setHasMore(more);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] loadOlder failed', e);
    } finally {
      setLoadingOlder(false);
    }
  };

  // Force a back-pagination even when we believe we're at the start. Under
  // sliding sync the backward token often isn't ready when the room first
  // opens, so the SDK reports "no more history" prematurely and we strand the
  // user at a false "start of room". This bypasses the hasMore guard so the
  // clickable marker can retry once the token has landed (usually by the time
  // the user reads the marker and taps it).
  const retryOlder = async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      const { more } = await matrix.loadOlder(roomId, 50);
      if (more) setHasMore(true); // history appeared → the normal button returns
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] retry loadOlder failed', e);
    } finally {
      setLoadingOlder(false);
    }
  };

  // Auto-backfill on open when the timeline is sparse — under sliding sync the
  // live timeline is just ~1 event until paginated, so an already-read chat
  // would otherwise open near-empty and force a manual "Load older" click.
  // Capped so a genuinely short room doesn't loop, and reset per room.
  const autoLoadCount = useRef(0);
  useEffect(() => { autoLoadCount.current = 0; }, [roomId, threadRootId]);
  useEffect(() => {
    if (!snap || threadRootId) return;             // threads scan the live timeline, no backfill
    // Count only real messages — a window full of folded join/leave blocks
    // shouldn't satisfy "enough to fill the view" and stop backfill early.
    const realCount = snap.messages.reduce((n, m) => n + (m.kind === 'state' ? 0 : 1), 0);
    if (realCount >= 15) return;                    // enough actual content to fill the view
    if (loadingOlder || !hasMore) return;
    if (autoLoadCount.current >= 4) return;         // ~200 events max, then stop
    autoLoadCount.current += 1;
    void loadOlder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, loadingOlder, hasMore, roomId, threadRootId]);

  // Auto-load when the message list is scrolled near the top.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 80) void loadOlder();
      // Track stickiness: if we're within ~80px of the bottom we stay
      // glued; otherwise we don't yank the user back when new events arrive.
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stuckRef.current = distFromBottom < 80;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingOlder, hasMore]);

  const send = async () => {
    const body = composeText.trim();
    if (!body) return;
    // The composer stays focusable during send (disabling it dropped focus
    // after Enter), so guard re-entrancy here against a fast double-Enter.
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      // Turn accepted @mentions still present in the body into matrix.to
      // pills and collect their user ids for m.mentions.
      const mentionIds: string[] = [];
      const used: Array<[string, string]> = [];
      for (const [name, uid] of acceptedMentions.current) {
        if (!body.includes(`@${name}`)) continue;
        mentionIds.push(uid);
        used.push([name, uid]);
      }
      // Build formatted_body. If there's no markdown but there ARE mentions, we
      // still need HTML so the pills are sent as proper <a> mentions — some
      // bots (and clients) only recognise mentions in formatted_body. Fall back
      // to an escaped plain body in that case.
      let html = markdownToHtml(body);
      if (!html && used.length) html = escapeHtml(body).replace(/\n/g, '<br/>');
      if (html) {
        for (const [name, uid] of used) {
          const pill = `<a href="https://matrix.to/#/${uid}">${escapeHtml(`@${name}`)}</a>`;
          html = html.split(escapeHtml(`@${name}`)).join(pill);
        }
      }
      // Custom emoji: any inserted :shortcode: we tracked becomes a
      // data-mx-emoticon image in formatted_body; the plain body keeps the
      // :shortcode: text as the spec-mandated fallback.
      const usedEmoji: Array<[string, string]> = [];
      for (const [sc, mxc] of usedCustomEmojis.current) {
        if (body.includes(`:${sc}:`)) usedEmoji.push([sc, mxc]);
      }
      if (usedEmoji.length && !html) html = escapeHtml(body).replace(/\n/g, '<br/>');
      if (html) {
        for (const [sc, mxc] of usedEmoji) {
          const img = `<img data-mx-emoticon src="${mxc}" alt="${escapeHtml(`:${sc}:`)}" title="${escapeHtml(`:${sc}:`)}" height="20" />`;
          html = html.split(escapeHtml(`:${sc}:`)).join(img);
        }
      }
      if (editing) {
        await matrix.editMessage(roomId, editing.eventId, body, html);
        setEditing(null);
      } else {
        await matrix.sendMessage(roomId, body, html, replyTo, mentionIds, threadRootId);
        setReplyTo(null);
      }
      acceptedMentions.current.clear();
      usedCustomEmojis.current.clear();
      setComposeText('');
      try { localStorage.removeItem(draftKeyRef.current); } catch { /* ignore */ }
      // Imperatively clear the Material field too — its `value` property
      // doesn't track React state directly across renders.
      const field = document.querySelector('.composer md-outlined-text-field') as HTMLElement | null;
      if (field) { (field as unknown as { value: string }).value = ''; field.focus(); }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
      // Remove the failed echo (so it doesn't look sent / block the queue).
      // The composer still holds `body`, so the user can edit and retry.
      matrix.cancelFailedEvents(roomId);
      setComposeText(body);
      const field = document.querySelector('.composer md-outlined-text-field') as (HTMLElement & { value: string }) | null;
      if (field) { field.value = body; field.focus(); }
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  };
  // The composer listeners are attached once (guarded), so route send()
  // through a ref to always invoke the latest closure.
  const sendRef = useRef(send);
  sendRef.current = send;

  // Chat-page keyboard navigation (built for a sighted keyboard user):
  //   Up/Down    — move a message cursor through the timeline; stepping past
  //                the bottom focuses the composer so you can type.
  //   Left/Right — previous/next CONVERSATION (the Back/Next buttons); main
  //                panel only, since a thread overlay has no prev/next chat.
  // Never hijacks arrows while a text field is focused (composing or EDITING a
  // message), and only the topmost panel acts so a thread overlay and the main
  // panel underneath don't both move on one press.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isArrow = e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      // Enter/Space activate the cursored row — used to expand/collapse a folded
      // room-changes block so its toggle is reachable from the same arrow-nav
      // (not only via Tab to the native <summary>).
      const isActivate = e.key === 'Enter' || e.key === ' ';
      if (!isArrow && !isActivate) return;
      const panels = document.querySelectorAll('.room-panel');
      if (!panelRootRef.current || panels[panels.length - 1] !== panelRootRef.current) return;
      // Don't steal keys from an input / textarea / Material field / editor.
      let node: Element | null = (e.target as Element | null) ?? document.activeElement;
      while (node) {
        const tag = node.tagName?.toLowerCase() ?? '';
        if (tag === 'input' || tag === 'textarea' || (node as HTMLElement).isContentEditable) return;
        if (tag.includes('text-field')) return;
        const root = (node as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (root?.activeElement) { node = root.activeElement; continue; }
        break;
      }
      if (isActivate) {
        // Toggle a folded room-changes block when the cursor is on it; otherwise
        // leave the key alone (so it doesn't swallow Enter elsewhere).
        const details = panelRootRef.current.querySelector<HTMLDetailsElement>('.comment-list > li.msg-cursor details');
        if (details) { e.preventDefault(); details.open = !details.open; }
        return;
      }
      const count = panelRootRef.current.querySelectorAll('.comment-list > li[data-msg-idx]').length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMsgCursor((c) => {
          const next = c + 1;
          if (next >= count) { composerFieldRef.current?.focus(); return Math.max(count - 1, -1); }
          return next;
        });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMsgCursor((c) => Math.max((c < 0 ? count : c) - 1, 0));
        return;
      }
      if (e.key === 'ArrowLeft') { if (!threadRootId && onBack) { e.preventDefault(); onBack(); } return; }
      if (e.key === 'ArrowRight') { if (!threadRootId && onNext) { e.preventDefault(); onNext(); } return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [threadRootId, onBack, onNext]);

  // Reset the cursor when the conversation (or thread) changes.
  useEffect(() => { setMsgCursor(-1); }, [roomId, threadRootId]);

  // Keep the cursored message in view.
  useEffect(() => {
    if (msgCursor < 0) return;
    panelRootRef.current
      ?.querySelector(`.comment-list > li[data-msg-idx="${msgCursor}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [msgCursor]);

  if (!snap) {
    // Full-screen even while loading — on a hash refresh the timeline isn't
    // hydrated yet, and a bare .issue-panel here is the old narrow side
    // overlay flashing before the room-panel takes over.
    return (
      <div className="issue-panel room-panel" role="region" aria-label="Conversation">
        <Header title="Loading…" onClose={onClose} onBack={onBack} backLabel={backLabel} onNext={onNext} nextLabel={nextLabel} />
        <div className="empty">
          <p>Loading conversation…</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={panelRootRef} className="issue-panel room-panel" role="region" aria-label={threadRootId ? `Thread in ${snap.roomName}` : snap.roomName}>
      <Header
        title={threadRootId ? 'Thread' : snap.roomName}
        subtitle={threadRootId ? snap.roomName : `${snap.memberCount} member${snap.memberCount === 1 ? '' : 's'}`}
        onClose={onClose}
        onBack={threadRootId ? undefined : onBack}
        backLabel={backLabel}
        onNext={threadRootId ? undefined : onNext}
        nextLabel={nextLabel}
        onStartCall={!threadRootId && onStartCall ? () => onStartCall(snap.roomName) : undefined}
        onOpenWidgets={!threadRootId && onOpenWidgets ? () => onOpenWidgets(snap.roomName) : undefined}
        onOpenThreads={!threadRootId && onOpenThread && snap.messages.some((m) => m.threadSummary) ? () => setThreadsOpen(true) : undefined}
        onOpenSettings={!threadRootId ? onOpenSettings : undefined}
        incomingCall={!threadRootId ? incomingCall : undefined}
        onPickUp={onPickUp}
      />
      {threadsOpen && onOpenThread && (
        <ThreadsDrawer
          messages={snap.messages}
          onClose={() => setThreadsOpen(false)}
          onOpen={(rootId) => { setThreadsOpen(false); onOpenThread(rootId); }}
        />
      )}
      <div
        className={`issue-body ${dragOver ? 'drag-over' : ''}`}
        ref={bodyRef}
        onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void onFileSelected(f);
        }}
      >
        {hasMore && (
          <button
            type="button"
            className="show-read"
            onClick={() => void loadOlder()}
            disabled={loadingOlder}
          >
            {loadingOlder ? 'Loading older…' : 'Load older messages'}
          </button>
        )}
        {!hasMore && snap.messages.length > 0 && (
          <button
            type="button"
            onClick={() => void retryOlder()}
            disabled={loadingOlder}
            title="Sliding sync may not have loaded all history yet — tap to check for earlier messages"
            style={{ ...RETRY_MARKER_STYLE, cursor: loadingOlder ? 'default' : 'pointer' }}
          >
            {loadingOlder ? 'Checking for earlier messages…' : '— start of room — (tap to retry)'}
          </button>
        )}
        {snap.messages.length === 0 ? (
          <button
            type="button"
            onClick={() => void retryOlder()}
            disabled={loadingOlder}
            title="Sliding sync may not have loaded this room's messages yet — tap to retry"
            style={{ ...RETRY_MARKER_STYLE, cursor: loadingOlder ? 'default' : 'pointer' }}
          >
            {loadingOlder ? 'Checking for messages…' : 'No messages — tap to retry'}
          </button>
        ) : (
          <ul className="comment-list">
            {snap.messages.map((m, i) => {
              const prev = i > 0 ? snap.messages[i - 1] : null;
              const showDate = !prev || new Date(m.ts).toDateString() !== new Date(prev.ts).toDateString();
              const dateSep = showDate
                ? <li className="date-sep"><span>{dayLabel(m.ts)}</span></li>
                : null;
              if (m.kind === 'state') {
                return (
                  <Fragment key={m.id}>
                    {dateSep}
                    <li className={`state-fold${i === msgCursor ? ' msg-cursor' : ''}`} data-msg-idx={i}>
                      {(m.stateCount ?? 1) <= 1 ? (
                        <p className="state-line">{m.stateLines?.[0]}</p>
                      ) : (
                        <details className="state-details">
                          <summary className="state-line">{m.stateCount} room changes</summary>
                          <ul className="state-list">
                            {m.stateLines?.map((line, j) => (
                              // eslint-disable-next-line react/no-array-index-key
                              <li key={j}>{line}</li>
                            ))}
                            {(m.stateCount ?? 0) > (m.stateLines?.length ?? 0) && (
                              <li className="state-more">
                                +{(m.stateCount ?? 0) - (m.stateLines?.length ?? 0)} more
                              </li>
                            )}
                          </ul>
                        </details>
                      )}
                    </li>
                  </Fragment>
                );
              }
              // Group consecutive messages from the same sender within 5 min
              // (not across a date break, and replies always show their head).
              const grouped = !!prev && prev.kind !== 'state' && prev.senderId === m.senderId
                && !m.replyTo && !showDate && (m.ts - prev.ts) < 5 * 60 * 1000;
              return (
              <Fragment key={m.id}>
              {dateSep}
              <li
                data-msg-idx={i}
                className={[i === msgCursor ? 'msg-cursor' : '', m.pending ? 'msg-pending' : '', grouped ? 'msg-grouped' : ''].filter(Boolean).join(' ') || undefined}
                style={m.pending ? { opacity: 0.55 } : undefined}
              >
                {!grouped && (
                <div className="comment-head">
                  <button
                    type="button"
                    className="sender-link"
                    disabled={!onOpenProfile}
                    title={onOpenProfile ? `View ${m.senderName}'s profile` : undefined}
                    onClick={() => onOpenProfile?.(m.senderId)}
                  >
                    {m.senderAvatarUrl
                      ? <img className="msg-avatar" src={m.senderAvatarUrl} alt="" loading="lazy" />
                      : <span className="msg-avatar msg-avatar-fallback" aria-hidden="true">{(m.senderName || '?').slice(0, 1).toUpperCase()}</span>}
                    <strong>{m.senderName}</strong>
                  </button>
                  <span className="ts">{m.pending ? 'Sending…' : new Date(m.ts).toLocaleString()}</span>
                </div>
                )}
                {m.replyTo && (
                  <button
                    type="button"
                    className="reply-quote"
                    title={m.replyTo.senderName ? `In reply to ${m.replyTo.senderName}` : 'In reply to a message'}
                    onClick={() => {
                      const rid = m.replyTo?.eventId;
                      if (!rid) return;
                      const j = snap.messages.findIndex((x) => x.id === rid);
                      if (j < 0) return; // original not loaded into view
                      setMsgCursor(j);
                      panelRootRef.current
                        ?.querySelector(`.comment-list > li[data-msg-idx="${j}"]`)
                        ?.scrollIntoView({ block: 'center' });
                    }}
                  >
                    <span aria-hidden="true" className="material-symbols-outlined reply-quote-icon">reply</span>
                    <span className="reply-quote-sender">{m.replyTo.senderName || 'Reply'}</span>
                    {m.replyTo.body && <span className="reply-quote-body">{m.replyTo.body}</span>}
                  </button>
                )}
                {m.utd ? (
                  <div className="comment-body msg-utd">
                    <span aria-hidden="true" className="material-symbols-outlined">lock</span>
                    Unable to decrypt — this device is missing the keys for this message.
                  </div>
                ) : m.geoUri ? (
                  <a
                    className="msg-file"
                    href={geoUriToMapUrl(m.geoUri)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span aria-hidden="true" className="material-symbols-outlined">location_on</span>
                    <span>{m.body && !m.body.startsWith('[') ? m.body : 'Shared location'}</span>
                  </a>
                ) : m.image && m.image.encrypted ? (
                  <EncryptedImage matrix={matrix} file={m.image.encrypted} alt={m.image.alt} sticker={m.image.sticker} />
                ) : m.image && m.image.sticker ? (
                  <img src={m.image.url} alt={m.image.alt} className="msg-image msg-sticker" loading="lazy" />
                ) : m.image ? (
                  <a href={m.image.url} target="_blank" rel="noopener noreferrer">
                    <img
                      src={m.image.url}
                      alt={m.image.alt}
                      className="msg-image"
                      loading="lazy"
                    />
                  </a>
                ) : m.file && m.file.encrypted ? (
                  <EncryptedFileLink matrix={matrix} file={m.file.encrypted} name={m.file.name} mimetype={m.file.mimetype} size={m.file.size} fmtBytes={formatBytes} />
                ) : m.file ? (
                  <a href={m.file.url} target="_blank" rel="noopener noreferrer" className="msg-file">
                    <span aria-hidden="true" className="material-symbols-outlined">attach_file</span>
                    <span>{m.file.name}</span>
                    {m.file.size && <span style={{ color: 'var(--muted)' }}>· {formatBytes(m.file.size)}</span>}
                  </a>
                ) : m.html ? (
                  <CollapsibleBody className={`comment-body${m.notice ? ' msg-notice' : ''}${m.emote ? ' msg-emote' : ''}`}>
                    {m.emote && <span className="emote-actor">* {m.senderName} </span>}
                    {renderFormattedHtml(m.html, { mxcToHttp: (mxc) => matrix.mxcToHttp(mxc, 64, 64) })}
                  </CollapsibleBody>
                ) : (
                  <CollapsibleBody className={`comment-body${m.notice ? ' msg-notice' : ''}${m.emote ? ' msg-emote' : ''}`}>
                    {m.emote && <span className="emote-actor">* {m.senderName} </span>}
                    {renderInline(m.body)}
                  </CollapsibleBody>
                )}
                {m.edited && (
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}> (edited)</span>
                )}
                {!threadRootId && m.threadSummary && onOpenThread && (
                  <button
                    type="button"
                    className="thread-summary"
                    onClick={() => onOpenThread(m.id)}
                    aria-label={`Open thread, ${m.threadSummary.count} repl${m.threadSummary.count === 1 ? 'y' : 'ies'}`}
                  >
                    <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 16 }}>forum</span>
                    <span>{m.threadSummary.count} repl{m.threadSummary.count === 1 ? 'y' : 'ies'}</span>
                    <span className="thread-summary-ts">{new Date(m.threadSummary.latestTs).toLocaleString()}</span>
                  </button>
                )}
                <div className="reactions">
                  {m.reactions?.map((r) => (
                    <button
                      key={r.key}
                      type="button"
                      className={`reaction ${r.selfReacted ? 'self' : ''}`}
                      onClick={() => void matrix.toggleReaction(roomId, m.id, r.key)}
                      title={r.reactors && r.reactors.length > 0
                        ? `${r.reactors.join(', ')}${r.count > r.reactors.length ? ` +${r.count - r.reactors.length} more` : ''}`
                        : (r.selfReacted ? 'Remove your reaction' : 'Add your reaction')}
                    >
                      {r.key.startsWith('mxc://')
                        ? <img className="reaction-emoji" src={matrix.mxcToHttp(r.key, 32, 32) ?? ''} alt="reaction" />
                        : <span>{r.key}</span>}
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{r.count}</span>
                    </button>
                  ))}
                  <ReactionAdder
                    onAdd={(key) => void matrix.toggleReaction(roomId, m.id, key)}
                    customEmojis={customEmojis}
                    mxcToHttp={(mxc) => matrix.mxcToHttp(mxc, 32, 32)}
                  />
                  {/* Reply / edit / delete: after the react button, always shown
                      (no hover reveal, so the message never reflows). */}
                  <button
                    type="button"
                    className="msg-reply"
                    aria-label="Reply"
                    title="Reply"
                    onClick={() => setReplyTo({ eventId: m.id, senderName: m.senderName, body: m.body })}
                  >
                    <span aria-hidden="true" className="material-symbols-outlined">reply</span>
                  </button>
                  {!m.image && !m.file && !m.utd && m.body && (
                    <button
                      type="button"
                      className="msg-reply"
                      aria-label="Copy text"
                      title="Copy text"
                      onClick={() => { try { void navigator.clipboard?.writeText(m.body); } catch { /* clipboard blocked */ } }}
                    >
                      <span aria-hidden="true" className="material-symbols-outlined">content_copy</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="msg-reply"
                    aria-label="Copy link to message"
                    title="Copy link to message"
                    onClick={() => { try { void navigator.clipboard?.writeText(`https://matrix.to/#/${roomId}/${m.id}`); } catch { /* clipboard blocked */ } }}
                  >
                    <span aria-hidden="true" className="material-symbols-outlined">link</span>
                  </button>
                  {!threadRootId && onOpenThread && (
                    <button
                      type="button"
                      className="msg-reply"
                      aria-label="Reply in thread"
                      title="Reply in thread"
                      onClick={() => onOpenThread(m.id)}
                    >
                      <span aria-hidden="true" className="material-symbols-outlined">forum</span>
                    </button>
                  )}
                  {m.senderId === selfId && (
                    <button
                      type="button"
                      className="msg-reply"
                      aria-label="Edit"
                      title="Edit"
                      onClick={() => {
                        setEditing({ eventId: m.id, originalBody: m.body });
                        setComposeText(m.body);
                        setReplyTo(null);
                      }}
                    >
                      <span aria-hidden="true" className="material-symbols-outlined">edit</span>
                    </button>
                  )}
                  {(m.senderId === selfId || canRedactOthers) && (
                    <button
                      type="button"
                      className="msg-reply"
                      aria-label={m.senderId === selfId ? 'Delete' : 'Remove message (moderator)'}
                      title={m.senderId === selfId ? 'Delete' : 'Remove (moderator)'}
                      onClick={async () => {
                        // eslint-disable-next-line no-alert
                        if (!confirm(m.senderId === selfId ? 'Delete this message?' : 'Remove this message?')) return;
                        try { await matrix.redactMessage(roomId, m.id); }
                        catch (e) { console.warn('[wukkiemail] redact failed', e); }
                      }}
                    >
                      <span aria-hidden="true" className="material-symbols-outlined">delete</span>
                    </button>
                  )}
                </div>
                {m.readBy && m.readBy.length > 0 && (
                  <div className="read-by" aria-label={`Read by ${m.readBy.map((r) => r.name).join(', ')}`}>
                    {m.readBy.slice(0, 5).map((r) => (
                      <span key={r.userId} title={r.name} className="read-by-avatar">
                        {r.avatarUrl
                          ? <img src={r.avatarUrl} alt="" />
                          : <span>{r.name.slice(0, 1).toUpperCase()}</span>}
                      </span>
                    ))}
                    {m.readBy.length > 5 && (
                      <span className="read-by-more">+{m.readBy.length - 5}</span>
                    )}
                  </div>
                )}
              </li>
              </Fragment>
              );
            })}
          </ul>
        )}
      </div>
      <TypingLine matrix={matrix} roomId={roomId} />
      {replyTo && (
        <div className="reply-chip">
          <div className="reply-chip-inner">
            <div className="reply-chip-label">Replying to {replyTo.senderName}</div>
            <div className="reply-chip-body">{replyTo.body.slice(0, 200)}</div>
          </div>
          <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
        </div>
      )}
      {editing && (
        <div className="reply-chip">
          <div className="reply-chip-inner">
            <div className="reply-chip-label">Editing</div>
            <div className="reply-chip-body">{editing.originalBody.slice(0, 200)}</div>
          </div>
          <button
            type="button"
            onClick={() => { setEditing(null); setComposeText(''); }}
            aria-label="Cancel edit"
          >
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
        </div>
      )}
      <div className="composer">
        {sendError && (
          <div className="send-error">
            <span aria-hidden="true" className="material-symbols-outlined send-error-icon">error</span>
            <span className="send-error-text">Send failed: {sendError}</span>
            <button type="button" className="send-error-x" aria-label="Dismiss error" onClick={() => setSendError(null)}>
              <span aria-hidden="true" className="material-symbols-outlined">close</span>
            </button>
          </div>
        )}
        {mention && mentionMatches.length > 0 && (
          <div className="mention-menu" role="listbox">
            {mentionMatches.map((m, i) => (
              <button
                key={m.userId}
                type="button"
                role="option"
                aria-selected={i === mention.index}
                className={`mention-item ${i === mention.index ? 'active' : ''}`}
                // Use mousedown so it fires before the field's blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  const field = document.querySelector('.composer md-outlined-text-field') as (HTMLElement & { value: string }) | null;
                  if (field) acceptMention(m, field);
                }}
              >
                {m.avatarUrl
                  ? <img className="mention-avatar" src={m.avatarUrl} alt="" />
                  : <span className="mention-avatar mention-avatar-fallback">{m.name.slice(0, 1).toUpperCase()}</span>}
                <span className="mention-name">{m.name}</span>
                <span className="mention-mxid">{m.userId}</span>
              </button>
            ))}
          </div>
        )}
        {emojiAc && emojiMatches.length > 0 && (
          <div className="mention-menu emoji-menu" role="listbox">
            {emojiMatches.map((m, i) => (
              <button
                key={(m.kind === 'unicode' ? m.char : m.mxc) + i}
                type="button"
                role="option"
                aria-selected={i === emojiAc.index}
                className={`mention-item ${i === emojiAc.index ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  const field = document.querySelector('.composer md-outlined-text-field') as (HTMLElement & { value: string }) | null;
                  insertEmoji(m.kind === 'unicode' ? { char: m.char } : { custom: { shortcode: m.shortcode, mxc: m.mxc } }, field, true);
                }}
              >
                <span className="emoji-menu-glyph">
                  {m.kind === 'unicode'
                    ? m.char
                    : <img src={matrix.mxcToHttp(m.mxc, 32, 32) ?? ''} alt={m.shortcode} />}
                </span>
                <span className="mention-name">:{m.kind === 'unicode' ? m.label : m.shortcode}:</span>
              </button>
            ))}
          </div>
        )}
        {emojiOpen && (
          <EmojiPicker
            customEmojis={customEmojis}
            mxcToHttp={(mxc) => matrix.mxcToHttp(mxc, 32, 32)}
            onClose={() => setEmojiOpen(false)}
            onPick={(pick) => {
              const field = document.querySelector('.composer md-outlined-text-field') as (HTMLElement & { value: string }) | null;
              insertEmoji(pick, field, false);
            }}
          />
        )}
        {stickerOpen && (
          <StickerPicker
            stickers={stickers}
            mxcToHttp={(mxc) => matrix.mxcToHttp(mxc, 128, 128)}
            onClose={() => setStickerOpen(false)}
            onPick={(s) => { setStickerOpen(false); void matrix.sendSticker(roomId, s.shortcode, s.mxc); }}
          />
        )}
        <md-outlined-text-field
          label="Reply"
          placeholder="Type a message…"
          value={composeText}
          ref={(el: HTMLElement | null) => {
            if (!el) return;
            composerFieldRef.current = el as HTMLElement & { value: string };
            // Attach listeners ONCE per element; re-running on every render
            // would stack duplicates (and double-fire send). Handlers read
            // live state through refs, so a single attach stays correct.
            const guard = el as unknown as { _wmComposerInit?: boolean };
            if (guard._wmComposerInit) return;
            guard._wmComposerInit = true;
            el.addEventListener('input', (ev) => {
              const target = ev.target as HTMLInputElement & { value: string };
              let v = target.value;
              const expanded = expandShortcodes(v);
              if (expanded !== v) {
                v = expanded;
                target.value = v;
              }
              setComposeText(v);
              // Persist the draft under the CURRENT room (ref, not a stale
              // closure) so it survives navigating away. Cleared when empty.
              try { if (v) localStorage.setItem(draftKeyRef.current, v); else localStorage.removeItem(draftKeyRef.current); } catch { /* ignore */ }
              // Detect a trailing "@query" to drive the mention dropdown.
              const m = v.match(TRAILING_MENTION);
              setMention(m ? { query: m[2], index: 0 } : null);
              // …and a trailing ":word" (≥2 chars) for the emoji menu. Never
              // matches :P / :D / :) so those emoticons type through untouched.
              const em = v.match(EMOJI_TRIGGER);
              setEmojiAc(em ? { query: em[2], index: 0 } : null);
              void matrix.sendTyping(roomId, v.length > 0, 30_000);
            });
            el.addEventListener('keydown', (ev: Event) => {
              const ke = ev as KeyboardEvent;
              const target = ev.target as HTMLInputElement & { value: string };
              // Mention navigation takes precedence over send / newline.
              const men = mentionRef.current;
              if (men) {
                const matches = computeMatches(men.query);
                if (matches.length > 0) {
                  if (ke.key === 'ArrowDown') {
                    ev.preventDefault();
                    setMention({ ...men, index: (men.index + 1) % matches.length });
                    return;
                  }
                  if (ke.key === 'ArrowUp') {
                    ev.preventDefault();
                    setMention({ ...men, index: (men.index - 1 + matches.length) % matches.length });
                    return;
                  }
                  if (ke.key === 'Enter' || ke.key === 'Tab') {
                    ev.preventDefault();
                    acceptMention(matches[men.index], target);
                    return;
                  }
                  if (ke.key === 'Escape') {
                    ev.preventDefault();
                    setMention(null);
                    return;
                  }
                }
              }
              // Emoji autocomplete navigation (same gestures as mentions).
              const em = emojiAcRef.current;
              if (em) {
                const matches = computeEmojiMatches(em.query);
                if (matches.length > 0) {
                  if (ke.key === 'ArrowDown') {
                    ev.preventDefault();
                    setEmojiAc({ ...em, index: (em.index + 1) % matches.length });
                    return;
                  }
                  if (ke.key === 'ArrowUp') {
                    ev.preventDefault();
                    setEmojiAc({ ...em, index: (em.index - 1 + matches.length) % matches.length });
                    return;
                  }
                  if (ke.key === 'Enter' || ke.key === 'Tab') {
                    ev.preventDefault();
                    const m2 = matches[em.index];
                    insertEmoji(m2.kind === 'unicode' ? { char: m2.char } : { custom: { shortcode: m2.shortcode, mxc: m2.mxc } }, target, true);
                    return;
                  }
                  if (ke.key === 'Escape') {
                    ev.preventDefault();
                    setEmojiAc(null);
                    return;
                  }
                }
              }
              if (ke.key === 'Enter' && !ke.shiftKey) {
                ev.preventDefault();
                void sendRef.current();
                void matrix.sendTyping(roomId, false);
              }
            });
            el.addEventListener('blur', () => { void matrix.sendTyping(roomId, false); });
            el.addEventListener('paste', (ev: Event) => {
              const pe = ev as ClipboardEvent;
              const items = pe.clipboardData?.items;
              if (!items) return;
              for (const item of items) {
                if (item.kind === 'file' && item.type.startsWith('image/')) {
                  const file = item.getAsFile();
                  if (file) {
                    ev.preventDefault();
                    void onFileSelected(file);
                    return;
                  }
                }
              }
            });
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          className="hamburger"
          aria-label="Emoji"
          title="Emoji"
          onClick={() => setEmojiOpen((o) => !o)}
        >
          <span aria-hidden="true" className="material-symbols-outlined">mood</span>
        </button>
        {stickers.length > 0 && (
          <button
            type="button"
            className="hamburger"
            aria-label="Sticker"
            title="Sticker"
            onClick={() => setStickerOpen((o) => !o)}
          >
            <span aria-hidden="true" className="material-symbols-outlined">imagesmode</span>
          </button>
        )}
        <button
          type="button"
          className="hamburger"
          aria-label="Attach file"
          onClick={pickFile}
          disabled={uploading}
        >
          <span aria-hidden="true" className="material-symbols-outlined">attach_file</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFileSelected(f);
            e.target.value = '';
          }}
        />
        <md-icon-button
          aria-label="Send"
          onClick={() => void send()}
          disabled={sending || uploading || !composeText.trim() || undefined}
        >
          <md-icon>send</md-icon>
        </md-icon-button>
      </div>
    </div>
  );
}

function ReactionAdder({ onAdd, customEmojis, mxcToHttp }: {
  onAdd: (key: string) => void;
  customEmojis: CustomEmoji[];
  mxcToHttp: (mxc: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  // Tiny built-in palette for the common case; "more" opens the full picker
  // (incl. custom mxc emoji). Custom reactions send the mxc as the key —
  // toggleReaction + the timeline renderer already handle mxc keys.
  const palette = ['👍', '👎', '❤️', '😂', '🎉', '✅', '❌', '🙏', '🤔'];
  return (
    <span style={{ position: 'relative' }}>
      <button
        type="button"
        className="reaction-add"
        onClick={() => setOpen((o) => !o)}
        aria-label="Add reaction"
      >
        <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 14 }}>add_reaction</span>
      </button>
      {open && !full && (
        <div className="reaction-popover" onMouseLeave={() => setOpen(false)}>
          {palette.map((e) => (
            <button key={e} type="button" onClick={() => { onAdd(e); setOpen(false); }}>{e}</button>
          ))}
          <button type="button" aria-label="More emoji" title="More emoji" onClick={() => setFull(true)}>
            <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 16 }}>add_reaction</span>
          </button>
          {/* Free-text reaction key — kept so any string/emoji can be sent, not
              just palette + picker entries (the full picker replaced this once
              and dropped the ability to type an arbitrary reaction). */}
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              const input = (ev.currentTarget.elements.namedItem('k') as HTMLInputElement);
              const v = input.value.trim();
              if (v) { onAdd(v); setOpen(false); input.value = ''; }
            }}
          >
            <input name="k" placeholder="…" aria-label="Custom reaction emoji" maxLength={32} style={{ width: 40, padding: 2, font: 'inherit' }} />
          </form>
        </div>
      )}
      {open && full && (
        <EmojiPicker
          customEmojis={customEmojis}
          mxcToHttp={mxcToHttp}
          title="React with emoji"
          onClose={() => { setFull(false); setOpen(false); }}
          onPick={(pick) => {
            onAdd('char' in pick ? pick.char : pick.custom.mxc);
            setFull(false); setOpen(false);
          }}
        />
      )}
    </span>
  );
}

function TypingLine({ matrix, roomId }: { matrix: MatrixSource; roomId: string }) {
  const [names, setNames] = useState<string[]>(() => matrix.getTypingUsers(roomId));
  useEffect(() => {
    const unsub = matrix.subscribe(() => setNames(matrix.getTypingUsers(roomId)));
    return unsub;
  }, [matrix, roomId]);
  if (names.length === 0) return null;
  const summary = names.length === 1
    ? `${names[0]} is typing…`
    : names.length === 2
      ? `${names[0]} and ${names[1]} are typing…`
      : `${names[0]} and ${names.length - 1} others are typing…`;
  return <div className="typing-line">{summary}</div>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// A grid of the room's available stickers (im.ponies usage=sticker). Picking
// one sends it immediately as an m.sticker event. Outside-click / Escape close.
function StickerPicker({ stickers, mxcToHttp, onClose, onPick }: {
  stickers: CustomEmoji[];
  mxcToHttp: (mxc: string) => string | null;
  onClose: () => void;
  onPick: (s: CustomEmoji) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div className="sticker-picker" ref={ref}>
      <div className="sticker-grid">
        {stickers.map((s) => {
          const url = mxcToHttp(s.mxc);
          return (
            <button key={s.shortcode + s.mxc} type="button" className="sticker-cell" title={s.shortcode} onClick={() => onPick(s)}>
              {url ? <img src={url} alt={s.shortcode} loading="lazy" /> : <span>{s.shortcode}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Lists every thread in the room (its root messages, newest activity first) so
// you can jump to one without scrolling the timeline to find its root. Reads
// the snapshot's thread roots — those messages already carry a threadSummary
// (count + latest activity) computed in getRoomTimeline.
function ThreadsDrawer({ messages, onClose, onOpen }: {
  messages: RoomTimelineSnapshot['messages'];
  onClose: () => void;
  onOpen: (rootId: string) => void;
}) {
  const roots = messages
    .filter((m) => m.threadSummary)
    .sort((a, b) => (b.threadSummary!.latestTs - a.threadSummary!.latestTs));
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>Threads · {roots.length}</div>
        </header>
        <div className="sheet-body" style={{ gap: 0 }}>
          {roots.map((m) => (
            <button key={m.id} type="button" className="thread-row" onClick={() => onOpen(m.id)}>
              <span aria-hidden="true" className="material-symbols-outlined" style={{ color: 'var(--muted)' }}>forum</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="thread-row-from">{m.senderName}</span>
                <span className="thread-row-body">{m.body || '(no text)'}</span>
              </span>
              <span className="thread-row-meta">{m.threadSummary!.count} repl{m.threadSummary!.count === 1 ? 'y' : 'ies'} · {new Date(m.threadSummary!.latestTs).toLocaleString()}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Header({ title, subtitle, onClose, onBack, backLabel, onNext, nextLabel, onStartCall, onOpenWidgets, onOpenThreads, onOpenSettings, incomingCall, onPickUp }: { title: string; subtitle?: string; onClose: () => void; onBack?: () => void; backLabel?: string; onNext?: () => void; nextLabel?: string; onStartCall?: () => void; onOpenWidgets?: () => void; onOpenThreads?: () => void; onOpenSettings?: () => void; incomingCall?: { roomId: string; roomName: string }; onPickUp?: (roomId: string, roomName: string) => void }) {
  return (
    <header className="issue-head">
      <md-icon-button onClick={onClose} aria-label="Close">
        <md-icon>close</md-icon>
      </md-icon-button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="issue-title">{title}</div>
        {subtitle && <div className="issue-subtitle">{subtitle}</div>}
      </div>
      {incomingCall && onPickUp && (
        <button
          type="button"
          className="pickup-btn"
          title={incomingCall.roomId === '' ? 'Join call' : `Pick up call in ${incomingCall.roomName}`}
          onClick={() => onPickUp(incomingCall.roomId, incomingCall.roomName)}
        >
          <span aria-hidden="true" className="material-symbols-outlined">call</span>
          <span className="pickup-btn-text">Pick up · {incomingCall.roomName}</span>
        </button>
      )}
      {onOpenThreads && (
        <button type="button" className="hamburger" aria-label="Threads" title="Threads in this room" onClick={onOpenThreads}>
          <span aria-hidden="true" className="material-symbols-outlined">forum</span>
        </button>
      )}
      {onOpenWidgets && (
        <button type="button" className="hamburger" aria-label="Widgets" title="Widgets" onClick={onOpenWidgets}>
          <span aria-hidden="true" className="material-symbols-outlined">widgets</span>
        </button>
      )}
      {onOpenSettings && (
        <button type="button" className="hamburger" aria-label="Room settings" title="Room settings" onClick={onOpenSettings}>
          <span aria-hidden="true" className="material-symbols-outlined">settings</span>
        </button>
      )}
      {onStartCall && (
        <button type="button" className="hamburger" aria-label="Start voice or video call" title="Start call" onClick={onStartCall}>
          <span aria-hidden="true" className="material-symbols-outlined">videocam</span>
        </button>
      )}
      {onBack && (
        <button type="button" className="next-btn next-btn-back" title={backLabel ? `Back: ${backLabel}` : 'Back to previous chat'} onClick={onBack}>
          <span aria-hidden="true" className="material-symbols-outlined">chevron_left</span>
          <span className="next-btn-text">
            <span className="next-btn-label">Back</span>
            {backLabel && <span className="next-btn-sub">{backLabel}</span>}
          </span>
        </button>
      )}
      {onNext && (
        <button type="button" className="next-btn" title={nextLabel ? `Next: ${nextLabel}` : 'Next conversation'} onClick={onNext}>
          <span className="next-btn-text">
            <span className="next-btn-label">Next</span>
            {nextLabel && <span className="next-btn-sub">{nextLabel}</span>}
          </span>
          <span aria-hidden="true" className="material-symbols-outlined">chevron_right</span>
        </button>
      )}
    </header>
  );
}
