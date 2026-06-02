# Handover

Quick brief for any agent picking this up mid-stream.

> **Working principle for these repos lives in `/home/joop/matrix-stuff/CLAUDE.md`** (bias to
> daring, derive from principle, presence≠correctness, surface-don't-silently-preserve). Apply it.

## 🟢 STATUS at compaction 2026-06-02 (the two issues we were deep in)
Both root-caused; the DM-naming chain is SHIPPED, verification has a captured cancelCode + a
parked plan (NOT applied — Joop said prepare for compaction).

**DM names (Wally) — SHIPPED, deployed `ef79b2c` (`main` bundle past CWrpx00h).** Chain of fixes:
m.direct clobber → server-authoritative writes; always force-load DM members (classic sync too);
group-name guard (`dmRealHumans>1 → room.name`); and the final "too early" fix — `getDmName`
returns `room.name` until the joined roster is fully loaded (`getJoinedMembers().length >=
getJoinedMemberCount()`) so a group never flickers to its m.direct partner before enough members
load to reveal it's a group. Plus shared one-fetch-per-room dedup + direct (non-rAF) refresh on
load. Reshaper ("Guess & convert DMs") removes the non-DM mistags; Joop confirmed it works.
Remaining: only an unnamed bridged 1:1 might briefly show a rough name (rare).

**Verification (WukkieMail) — root cause = `m.mismatched_sas`, fix PARKED.** Full analysis in
memory `reference_wukkiemail_sas_crosssigning.md`. Short version: WukkieMail confirms correctly
(sends the mac), but the REMOTE (Wally) emits `m.mismatched_sas` in a flow Joop MATCHED. Not a
key/MAC problem; `verificationMethods:['m.sas.v1']` shipped (`1801657`) didn't fix it. Leading
fixable suspect: the confirm→mismatch trap — after "They match", WukkieMail's sheet stays on phase
`'sas'` with buttons live and `cancelVerification` calls `sasCallbacks.mismatch()` while
sasCallbacks is set, so a stray click fires mismatch (same race likely on the Wally side too, or a
stale duplicate dialog from many retries). NEXT: move to a 'confirming/waiting' phase post-confirm
(disable the mismatch path), add SAS-value logging both sides, then one clean re-test. crypto state
is fine — recovery-key path bootstraps it; SAS *should* gossip the keys once it completes.

Separate noted bug: WukkieMail console floods with `threadRootId`/`compareEventOrdering` recursion.

## 🔧 OPEN — found, NOT yet fixed (compaction 2026-06-01) — a sliding-sync "completeness/correction" run

Joop's framing: these are all the same theme — **completeness under sliding sync**. Two live
regressions + the standing audit backlog. Joop tests on **wukkie.uk (= latest)**; cinny.kiefte.eu
is just the VPS the agent runs on. Both apps deploy from the SDK fork (`matrix-js-sdk-jj`,
`wally-dist`); cinny via `cinny-web-git/push-to-codeberg.sh` (FOREGROUND — bg deploys die), both
via `deploy-sdk.sh` (FOREGROUND). cinny commits need a kebab family (`ux-fixes:`).

### Live regressions (priority)
NOTE (2026-06-01): cinny exposes NO `mx` global — Joop's DM console line failed with
`mx is not defined`. Fixed by exposing **`window.wallyClient`** (deploy `934b34c42`/`01f3359`,
bundle `main-CNBl2Sfb.js`). Re-run the DM line with `wallyClient` instead of `mx`.
1. **DM list doesn't populate** (Wally/wukkie.uk) — ROOT-CAUSED + FIXED 2026-06-01. NOT the lean-DM
   materialization (that's exonerated — the one tagged DM materialized + joined fine, keep it). Real
   cause: **`addRoomIdToMDirect`/`removeRoomIdFromMDirect` (`utils/matrix.ts`) merged against the
   LOCAL `m.direct`.** Under sliding sync the local copy is stale (Continuwuity only re-pushes
   account data changed since pos — none on a restored pos; setAccountData reflects locally only on
   the later echo), so a `/converttodm` read a stale/empty base and **PUT it back, overwriting the
   server's full m.direct down to that one entry** — active server-side data loss, which is why Joop's
   many prior tags vanished to 1. FIX (`58ab12724`, deployed `f1fd121`): `readMDirect` fetches the
   authoritative server value before merging; `commitMDirect` writes back + reflects locally + emits
   so the list inflates immediately. RECOVERY (`f58780d2d`, same deploy): **"Guess & convert DMs"**
   menu item on the Direct page (`guessAndConvertDMs`) rebuilds m.direct from joined 2-member
   non-space rooms (the rooms survived; only the mapping was wiped) in ONE merged write. VERIFY: run
   it, DM list inflates; bridged 1:1s that show as 3-member (bridge bot present) won't be caught —
   if Joop's Signal DMs are missed, relax the `getJoinedMemberCount()===2` gate.
2. **Emoji SAS verification stalls — emoji NEVER show** (Wally). CONFIRMED by Joop: emoji never
   appear. Per the routing, that means the stall is BEFORE the SAS key exchange → it's a
   **to-device `m.key.verification.*` flow** problem, **NOT** the secret-storage seed (`78bf3d74`,
   already shipped — that was the wrong tree for THIS symptom; it's still correct for the post-emoji
   cross-signing/MAC step, keep it). Audited the SDK two-connection design end-to-end and it looks
   correct: to-device isolated on the encryption sync, incoming → OlmMachine via
   `preprocessToDeviceMessages`, outgoing pumped by `onSyncCompleted` on the e2ee extension, poll
   loop fast-polls (`boostPolls`) during a handshake + never silently dies. So it needs a LIVE
   TRACE. Shipped **`installVerificationTracer`** (`verifyTrace.ts`, deploy `934b34c42`): logs every
   `m.key.verification.*` to-device event RECEIVED + `window.wallyVerify()` dumps the ring.
   **NEXT: on wukkie.uk start a verification, then run `wallyVerify()` and read the `[Wally][verify]`
   lines.** Decision tree: see `.request/.ready/.start` but never the peer's `.key` ⇒ incoming
   to-device not delivered past handshake (Continuwuity/encryption-sync gap — check for an
   "encryption sliding sync failed" error too); see peer's `.key` but no emoji ⇒ verifier/UI
   (cinny `DeviceVerification.tsx` ShowSas); nothing after `.request` ⇒ to-device dead after the
   initial batch (encryption sync stalled).

### Account-data clobber sweep (2026-06-01) — DONE
The cinny m.direct clobber (read-local-modify-write overwriting the server with a
stale base under sliding sync) was a CLASS bug. Swept both apps:
- **cinny** (`58ab12724`): `addRoomIdToMDirect`/`removeRoomIdFromMDirect` → `readMDirect`
  (server-authoritative) + `commitMDirect` (local reflect). Plus "Guess & convert DMs"
  recovery feature (`f58780d2d`, bridge-aware `1bb1bf646` — excludes bot + your puppet).
- **WukkieMail** (`25dd8b1`): every config write (m.direct create-DM, saved views, manual
  bundles, weights, triage) routed through new `readAccountData`/`commitAccountData`
  helpers (server-authoritative read for m.direct; local-reflect for all). With
  `seedConfigAccountData` (startup seed) this closes the in-session clobber. RESIDUAL
  (surfaced, acceptable): true cross-device concurrent edits of the same type are
  last-writer-wins — config setters read a local base (kept fresh by seed + reflect),
  only m.direct reads server-authoritative per-write.

### Already fixed today — DON'T redo
- **cinny `seedAccountData.ts`** (`78bf3d74`/`f14a48a`, DEPLOYED): seeds secret-storage +
  cross-signing + megolm-backup + `in.cinny.spaces` + `eu.kiefte.wally.settings` + `im.ponies.*` +
  `io.element.recent_emoji` on the sliding path. Covers audit D#1/D#3 + cinny settings/emoji.
- **cinny cross-signing enum** `self_signing`/`user_signing` (`9c8ebe5ed`, committed, rides next
  cinny deploy — unused at runtime so no urgency).

### Audit backlog — sliding-sync completeness (A–F), STILL OPEN
SDK fork is clean (lean lists, window growth, forceLoadMembers, account-data seed). Category B
(classic-sync-opts feature-detection) is fully clean both apps. Remaining, prioritized:
- **[C, wukkiemail, HIGH] DONE (`85321f7`, pushed → CF rebuild)** — `loadRoomMembers` now branches
  to `room.forceLoadMembers()` when `this.slidingSync` is set (cast, same idiom as cinny
  `useRoomMembers.ts`); `getRoomMembers`/`searchUsers` inherit it. NOTE while here: WukkieMail's
  `package-lock.json` is **git-ignored**, so CF always re-resolves `#wally-dist` to branch HEAD —
  the npm git-dep pin-trap does NOT bite WukkieMail (it does bite Wally, handled in
  push-to-codeberg.sh). Also de-binaried matrix.ts: `reactionKey` held a raw NUL byte delimiter
  (made git/grep/diff treat the file as binary); replaced with the `\u0000` escape, runtime-identical
  (`c6085db`). VERIFY live: @-mention autocomplete + person picker now list everyone in a bridged
  Signal group, not just recent senders.
- **[D, wukkiemail, HIGH] DONE (`03e4ecd`, pushed → CF rebuild)** — added `seedConfigAccountData()`
  (matrix.ts, gated on `this.slidingSync`, called after startClient): pulls triage/views/bundles/
  weights + `im.ponies.user_emotes`/`emote_rooms` from the server via `ensureAccountData`, emits
  `ClientEvent.AccountData`, then `notify()`. VERIFY live: saved views / manual bundles / sort
  weights / custom emoji all survive a hard reload (were reverting to defaults).
- **[A, wukkiemail, MED] `matrix.ts:1525-1531`** — `syncSpaceRooms` bulk-subscribes every space
  child via the HEAVY default sub. Use a lean custom subscription (mirror the SDK `lean-materialize`).
- **[A, both, LOW-MED]** — subscription sets only grow, never shrink: WM `subscribeRoom`
  (`matrix.ts:306`/`roomSubs`), cinny `slidingSyncRooms.ts:20-29` (`subscribed` Set). Every opened
  room stays subscribed heavy forever. Evict/downgrade on room close.
- **[C, cinny, MED]** — `useRoomMeta.ts:25,108` group-DM names via no-op `loadMembersIfNeeded`
  (2-person DMs survive via heroes; group DMs degrade). `utils/matrix.ts:189` `getDMRoomFor` +
  `:218` trust `getMembers().length`. `utils/bridges.ts:56,114` bot detection. `CallProvider.tsx:208`
  DM call-notify. Fix: `forceLoadMembers()` when sliding+DM, or heroes for group DMs.
- **[E, both, MED] cold thread-open doesn't inflate** — WM `RoomPanel.tsx:328` SKIPS backfill when
  `threadRootId` set (`getRoomTimeline` `matrix.ts:2700` only scans live timeline); cinny
  `ThreadView.tsx:143` `findEventById` with no `fetchRoomEvent` fallback. A cold/deep-linked thread
  comes up empty. Fix: fetch root + thread relations on thread open before scanning.
- **[F, cinny, LOW-MED] `RoomSummaryLoader.tsx:19`** — `getRoomSummary` (MSC3266) which Continuwuity
  404s → Explore/Featured (`Featured.tsx:63-99`) empty, no fallback. (`useSpaceHierarchy.ts:277`
  already uses `getRoomHierarchy` MSC2946 — port that pattern.)

Recommended order: live #1+#2 first (Joop's console answers gate them) → WM C#2 (slam dunk) →
WM D#4 → the rest by impact. "Reduce to the previously-solved problem": most fixes are ports of
patterns already proven in the other app.

## ⚠️ CHECK-LATER with Joop (~2026-06-01, when he lands) — shipped boldly, needs live verification
Joop OK'd being bold + reviewing together on arrival. Verify these and adjust:
- **Initial-load weight cut** (SDK `69c390aa8`, DEPLOYED both apps): the spaces LIST + DM
  materialization were hauling the heavy opened-room required_state (power/widget/emoji) in BULK.
  Split out a lean `DEFAULT_SLIDING_SYNC_SPACES_LIST_REQUIRED_STATE` for the list, and the DM
  materialization now uses a lean custom subscription (`lean-materialize`, timeline_limit 1).
  VERIFY: spaces come in fast + complete (not the slow trickle), overall initial load lighter,
  DMs still appear with names. Watch: an opened DM is lean-subscribed (timeline 1) — the on-open
  backfill should fill it; confirm opening a DM still shows full history. CONFIRMED GOOD already:
  chat history + usernames in Wally (subscribe-on-open + forceLoadMembers) — Joop saw it live.
- **Inbox unified cursor** (WM `1ad60a1`): ↑/↓ walk bundles+entries, Enter folds a bundle / opens
  an entry, e/u/s/p skip bundles. Check: cursor starts on the Settings header (idx 0) — is that
  ok or should it skip to the first entry? Visual highlight on headers clear?
- **Chat-page arrow nav** (WM `f74690e`): ↑/↓ messages + focus composer past the bottom; ←/→
  prev/next conversation; arrows NOT hijacked while composing/editing; topmost-panel-only. Check:
  does ←/→ feel right (vs left/right doing something else), thread-overlay coordination, and that
  the inbox cursor underneath truly stays put.
- **a11y sweep** (WM `f124839`..`4b63166`): tree roles, aria-labels, dialog/aria-modal on sheets,
  Escape-closes-sheets, aria-hidden on ALL Material icons, panel landmark roles. Check with a
  screenreader; confirm Escape two-step (blur field → close) feels ok.
- **Wally sliding-sync** (cinny `33aac9897`/`8bfa47df7`, SDK `90a43fc92`): fullLazyLoading-gating,
  subscribe-on-open, m.direct DM subs, B3 backfill simplification. Check: Signal family GROUP
  loads complete (messages + names), DM list fills, no perf regression / no double-fetch storms.
- **B3 backfill simplification** (cinny, this session): current room no longer deep-prefetched to
  200 — relies on subscribe-on-open (50) + top scheduler priority. Check chat opens feel populated.
- **B4 SDK forceLoadMembers** (SDK `5cc33e42a`, cinny `674b50a65`, DEPLOYED — Wally
  `v4.99.0-48-g8bf2f8210`): `Room.forceLoadMembers()` hits `/members` regardless of
  `lazyLoadMembers`; cinny's `useRoomMembers` calls it under sliding sync. VERIFY: open a big
  bridged Signal group — member names resolve (not mxids) and @-mention autocomplete lists
  everyone, no `/members` hammering. (Did NOT also fire `invalidateLoadedMembers` for unencrypted
  rooms — left the encrypted-only UTD path alone; on-open forceLoadMembers covers the display case.)

**AUTONOMOUS QUEUE COMPLETE (2026-05-31):** Phase A (keyboard nav: inbox unified cursor + chat-page
arrow nav) + Phase B (sliding-sync renewal: fullLazyLoading-gating, subscribe-on-open, m.direct DM
subs, backfill simplification, forceLoadMembers) all shipped + deployed. Everything to verify is in
the CHECK-LATER list above. **On-open backfill SHIPPED (cinny `2bc097504`):** Joop wanted it —
done via the fork's `backgroundBackfill` primitive in RoomView's open effect (target 80), NOT
the virtual paginator, so no rendering risk. VERIFY: opening a cold room fills immediately
instead of flashing the 1-event lean view; scrollback ready. Still not-done (dead weight):
`invalidateLoadedMembers` for unencrypted rooms — redundant with forceLoadMembers.
**SDK babel gotcha:** `babel -d lib --extensions ".ts,.js" src/models/room.ts` FLATTENS a nested
file to `lib/room.js` (wrong). For a nested src file compile into the matching dir:
`babel --extensions ".ts,.js" src/models/room.ts -d lib/models`. Always `grep -c forceLoadMembers
lib/models/room.js` (or your symbol) after, since a stale lib silently ships old SDK.

## SESSION 2026-05-31 — sliding-sync + crypto hardening (latest)

Marathon session dogfooding **sliding sync** (default for WukkieMail; opt-in toggle in Wally,
which defaults to classic). All fixes shipped to BOTH apps via `../deploy-sdk.sh`. SDK fork
HEAD: **`849bc0c2b`** (`wally-dist`). Full architecture + Continuwuity quirks in memory:
`reference_sliding_sync_architecture.md`.

Shipped this session (SDK = matrix-js-sdk-jj, WM = wukkiemail):
- **Late-joiner UTDs** (SDK): `Room.invalidateLoadedMembers()` re-fetches `/members` when
  `joined_count` exceeds loaded roster (lean required_state missed silent joiners).
- **Crypto hang** (WM `matrix.ts`): a re-login mints a new device id; the shared-prefix Rust
  crypto store mismatched → fell to **in-memory crypto** → keyless device → UTD flood that
  hangs load. Fix: on "account in the store doesn't match", retry under a **per-device**
  `cryptoDatabasePrefix`, never silently in-memory.
- **Backup crash** (SDK): guarded `getBackupDecryptor` against undefined backupInfo.
- **Recovery-key "no secret storage"** (WM): `ensureAccountData()` fetches `m.secret_storage.*`
  / `m.cross_signing.*` from the server before `verifyWithRecoveryKey` (sliding sync starves it).
- **DM mxid labels** (SDK): `Room.getDirectUserId()` reads `m.direct`; `dmNameFromHeroes` uses
  member-event displaynames + excludes self.
- **No DMs in list** (SDK): `SlidingSyncSdk.sync()` fire-and-forget-seeds `m.direct` /
  `m.ignored_user_list` / `m.push_rules` from server (Continuwuity doesn't resend on restored pos).
- **Slow / out-of-order** (SDK + WM): bump_stamp split (ms recency), pos persistence,
  exponential backoff, **two-connection sync** (dedicated 3s encryption sync for to_device/e2ee),
  **timeout=0 initial** (instant priority paint), **3s room poll** (Continuwuity holds full timeout).
- **A11y** (WM): inbox list + chat view screenreader-clean (icon ligatures `aria-hidden`,
  bundle `aria-expanded`, mention loading). Next: **`ACCESSIBILITY-TREEVIEW-PLAN.md`** (full
  build plan for a uniform ARIA tree — spaces/rooms/threads/messages as one navigable tree).

**Chat-page keyboard nav SHIPPED (2026-05-31):** RoomPanel now has its own arrow nav — ↑/↓ move
a `msgCursor` through the timeline (`.comment-list > li`, highlighted via `.msg-cursor`, scrolled
into view); stepping past the bottom focuses the composer. ←/→ = prev/next conversation
(`onBack`/`onNext`), main panel only (not thread overlays). Gated by the same text-field focus
guard, so arrows edit text normally while composing/editing. Only the TOPMOST `.room-panel`
acts (main vs thread overlay) via `panelRootRef`. App's inbox keydown now early-returns when a
panel/modal is open, so the two cursors never fight. NEXT (Phase B): cinny sliding-sync renewal
(B3 on-open backfill + simplify useBackgroundBackfill; B4 SDK Room.forceLoadMembers).

**Chat-page keyboard nav — DESIGN (was NEXT, now done above):** on the chat page (RoomPanel),
- **↑/↓** move a visible message cursor through the timeline; past the bottom edge, focus the
  compose box (so you can ↓ into typing). Highlight the cursored message visibly.
- **←/→** go to previous/next CONVERSATION — wire to the existing `onBack`/`onNext` (the header
  Back/Next buttons that already step conversations in inbox order).
- **Hard rule:** all of this is gated by the existing text-field focus guard, so when a message
  is being EDITED (or the compose box is focused), the arrows edit text normally — never hijack
  arrows inside an input/textarea/contenteditable. Only fire nav when focus is NOT in a field.
Implement in RoomPanel's own keydown (or extend the guard) — do NOT collide with App's inbox
cursor (that handler should early-return while a chat panel is open, which it already does for
some keys via the Escape cascade / panel-open checks).

**Unified inbox cursor (bundles + entries) SHIPPED (2026-05-31):** j/k/↑/↓ now walk bundle
headers AND entries uniformly (Joop is a sighted keyboard user — visual cursor matters as much
as ARIA). Every navigable row carries `data-nav` + a sequential `data-idx` in render order
(config header = 0, then inline/loose entries, then each bundle header + its items recursively);
the keyboard handler walks `[data-nav]`, caps on its count, and resolves the cursored element.
Enter on a header folds it (shared `toggleBundle(key)` helper, `__config__` for the settings
header); Enter on an entry opens it; e/u/s/p triage no-op on headers (resolve to no item).
`.bundle-head.cursor` CSS gives headers the same highlight as `.item.cursor`. NOT done yet:
roving tabindex / setsize-posinset (the full managed-focus tree) — virtual cursor is enough for
keyboard nav. NEXT: arrow-nav for messages + compose on the chat page (RoomPanel).

**Panel landmarks + EmailView Escape SHIPPED (2026-05-31):** the three full-screen panels now
declare `role="region"` with a real name — RoomPanel = room name (or "Thread in X"), EmailView
= "Email: <subject>", IssuePanel = "Task: <title>" — so a screenreader announces the region it
landed in and can jump to it via landmark nav. Also added `selectedEmail` to App's Escape
cascade (EmailView was the one panel that didn't close on Escape; RoomPanel/IssuePanel already
did). NOT done (needs a screenreader test): making the dimmed inbox behind a panel inert
(aria-hidden / aria-modal) so AT can't wander into it.

**Decorative icons aria-hidden app-wide SHIPPED (2026-05-31):** RoomPanel had hidden all 27 of
its Material-symbol glyphs but the convention was never extended — so ~100 icon ligatures
across App.tsx + every sheet were read aloud as their raw name ("push_pin", "mark_email_read",
"chevron_right" — exactly bgtlover's original complaint). Audit first confirmed NO button is
named solely by its icon (all have aria-label / title / visible text), so hiding decorative
glyphs is safe. Applied an idempotent transform giving every `material-symbols-outlined` span
`aria-hidden="true"` (consumes any pre-existing one → no duplicates). 18 files, 124 spans.

**Escape-closes-sheets SHIPPED (2026-05-31):** keyboard-only users previously could not
dismiss any sheet — they closed on scrim-CLICK or browser-back only. The global keydown Escape
branch now does `history.back()` when `anyModalOpen`, which fires the existing tested `onPop`
modal cascade (each open sheet pushes a history entry) — exact parity with browser-back, no new
close path. (Escape still blurs a focused field first via the early-return guard, so it's a
natural two-step inside a sheet with an autofocused input.) Not covered: EmailView/RoomPanel/
IssuePanel full-screen panels (they have hash routing + close buttons) and a true focus trap.

**Modal dialog semantics SHIPPED (2026-05-31):** every sheet/action-sheet that overlays a
scrim now has `role="dialog"` + `aria-modal="true"` + an `aria-label` — without aria-modal a
screenreader's virtual cursor wanders into the dimmed background behind the dialog. Covered the
9 standalone *Sheet.tsx (Compose/Bundle/JmapLogin/NewTask/DoneValues/EncryptionSetup/Devices/
Verification/Settings) + the 5 App.tsx inline sheets (New DM/group/call room, Keyboard
shortcuts, Add account) + the 2 action sheets. (WidgetPanel/CallView/CallPanel/EmojiPicker
already had it.) NOT yet done: a focus trap + Escape-to-close on every sheet (heavier; some
rely on scrim-click only), and role/label on the full-screen panels (EmailView/RoomPanel/
IssuePanel) which replace rather than overlay the view.

**Unlabeled form controls SHIPPED (2026-05-31):** swept the modal/inline inputs that relied
on a placeholder (or nothing) for their name — placeholders aren't accessible names. Added
`aria-label` to: PersonPicker's combobox (was nameless once a chip was picked — a combobox
MUST have a name), WidgetPanel URL+name, RoomPanel custom-reaction-emoji input, DevicesSheet
rename + delete-password. (The `<label className="sheet-label"><span>…</span><input></label>`
sheets were already correctly label-wrapped — left alone.)

**Bundle-head aria-label SHIPPED (2026-05-31):** bundle treeitems get a clean spoken name
("Spaces, 3 unread, 12 items" + ", pinned"); the config bundle reads "Settings and accounts"
(+ ", encryption needs attention" when unverified with an encrypted room). collapsed/expanded
stays on aria-expanded, not duplicated in the label.

**Row aria-label SHIPPED (2026-05-31):** each inbox treeitem now gets a composed `aria-label`
(unread · invite/join · subject · from · snippet · time · pinned · draft) so a screenreader
reads one clean sentence instead of fragmented avatar/badge/span pieces. Pure label override —
no visual/keyboard change. `renderItem` is now a block body computing `hasDraft`/`ariaLabel`.

**Treeview Step 1a SHIPPED (2026-05-31):** additive ARIA tree roles on the inbox stream —
`.item-list` `role=tree`; item rows + bundle heads + config bundle `role=treeitem` with
`aria-level` + `aria-selected` (mirrors cursor) + `aria-expanded`; bundle/config bodies
`role=group`. Zero keyboard/focus change (safe, untested-in-browser). Next: Step 1b = the
managed-focus keyboard model (roving tabindex, setsize/posinset, →/← expand, bundle heads in
the cursor walk) — needs a screenreader smoke-test. See `ACCESSIBILITY-TREEVIEW-PLAN.md`.

Open / next: (1) the treeview plan above; (2) Continuwuity should wake long-polls on new data
(server-side — would let us raise the 3s poll); (3) presence absent under sliding sync.
Verify after deploy: DMs load, sent messages echo within ~3s, names resolve, verify is snappy.

## What it is

WukkieMail — Inbox-style triage on top of Matrix. Live at `mail.wukkie.uk` (custom domain) and `wukkiemail.pages.dev` (CF Pages). Repo: `LaPingvino/wukkiemail`. Pushes auto-deploy. User: Joop (`@LaPingvino` on GitHub, mxid varies).

## Architecture in one paragraph

Vite + React + TS SPA. Single `MatrixSource` adapter abstraction over `matrix-js-sdk` (LaPingvino fork, `wally-dist` branch — same fork Wally uses). IndexedDB-backed via `IndexedDBStore`. Rust crypto via `initRustCrypto`. Material Web Components for buttons/text-fields/icons + Material Symbols Outlined for glyphs. Cloudflare Pages with `wrangler.jsonc` (`run_worker_first: true`, no Worker entry — assets-only). No backend.

## What's shipped (v0+)

- Matrix login (mxid + password, `.well-known` discovery), persisted creds, IndexedDB sync, lazy member loading
- Multi-account: slot-keyed creds (`wukkiemail.matrix.creds.v1.<userId>`), `listSlots/getActiveSlot/setActiveSlot`, sidebar switcher, `+ Add account` sheet
- Inbox stream: priority-sorted items (unread/mention/recent/dm/bridge/bot weights, all sliders in settings sheet), priority floats important, sinks bridge/bot noise
- Section headers (Tasks / Messages) when both groups present in the All view
- Bundles: per-flavor (Matrix/WhatsApp/Meta/Signal/IRC/Issues), `dm` from `m.direct`, `space:*` from `m.space.child`, `snoozed` (synthetic), `pinned` (synthetic)
- Chip bar hides bundles with no active items (active = unread OR not-done issue)
- Saved filtered views (account data `eu.kiefte.wukkiemail.views`)
- Per-row actions: Pin / Snooze (1h/evening/tomorrow/week) / Mark read/unread / Done; mobile = kebab → action sheet; desktop = hover chip; account-data-synced via `eu.kiefte.wukkiemail.triage`
- Sweep: confirm + mark-all-read for the current bundle
- Inline-editable issue panel (status chip bar at top + click-to-edit fields), eu.kiefte.issues schema; new-task FAB → NewTaskSheet that bootstraps the default schema for rooms missing one
- FAB menu expanded to: New Task / New DM / New Group (encrypted private rooms)
- RoomPanel: scrollback, read receipts (small avatar row), reactions (read + write toggle + emoji picker), typing indicators (read + write), inline media (m.image/file/audio/video), formatted_body via DOMPurify, light inline markdown for plain bodies, reply (m.in_reply_to with mx-reply quote), edit own messages (m.replace) + (edited) marker, delete own messages (redact), drag-drop + paste-image upload, auto-scroll to bottom, collapsible long messages
- Outgoing: markdown → formatted_body, emoji shortcodes (`:smile:` → 😄)
- In-tab notifications (DMs + highlights), favicon dot, tab-title unread count
- PWA: manifest + teal-recolored SVG/PNG icons, minimal SW (network-first, SPA fallback, hashed-assets cache)
- Android back closes the topmost modal layer
- Encryption: foundation banner in sidebar; EncryptionSetupSheet with two modes — Set up fresh (bootstrap cross-signing + secret storage with UIA password, returns recovery key) and I have a recovery key (verify existing). `getSecretStorageKey` callback wired via `window._wukkieKey` Uint8Array stash.
- Per-schema done detection: defaults to LAST kanban value, per-room override in `triage.doneValuesByRoom`
- Non-text last-event snippets show humanized labels (🖼️ image, joined, etc.) instead of `[m.foo]`
- Inline filter chips: Tasks header carries multi-select status chips (counts span the whole bundle, ignore the active filter, incl. a "None" chip for unset-status tasks), Messages header carries an Unread/All toggle. Headers + controls show in every view, not just All. Replaced the floating chip-bar that covered mobile content. (`.mini-chip` / `.section-filters` in styles.css)
- Per-event-type tuning: each room's latest event → `eventCategory` (message/image/membership/roomstate/call/sticker/…). Settings "By event type" section enumerates detected categories (counts) with a -5..+5 priority slider + Hide toggle each. Stored in synced weights `eventTypeAdjust`. **Hide is a DISPLAY/COUNTER filter, NOT a visibility filter (redesigned per Joop):** a hidden category never makes a room appear/disappear. `roomToItem` instead picks the latest NON-hidden event to define the row (snippet/timestamp/category), so a trailing "joined"/call.member doesn't resurface a room or turn its preview into noise; unread stays driven by real notifications (membership/state events don't notify). A room whose only recent activity is hidden-category becomes read → hidden in Unread mode, shown in All — never dropped. (Earlier `isHidden` visibility-drop + the `d100bd5` in-space exemption were removed; superseded by this.) (`eventCategory`/`hiddenCatSet` in roomToItem)
- Tri-state read filter on the Messages header: Unread / Read / All (was a boolean). Saved views carry `readFilter` (legacy `showRead` kept in sync).
- SAS emoji verification (both directions): MatrixSource verification controller (`startSelfVerification`/`confirmVerification`/`cancelVerification`/`resetVerification`/`onVerification`), inbound caught via `CryptoEvent.VerificationRequestReceived`. `VerificationSheet` renders whenever a verification is in flight; EncryptionSetupSheet has a third "Verify with another device" mode. NB: verification enums/types imported from deep `matrix-js-sdk/lib/crypto-api/*` paths — NOT re-exported from the package root.
- Per-room done-values editor: `DoneValuesSheet` (sidebar → "Task \"done\" statuses…") lists rooms with a kanban schema, toggles which status values count as done per room; empty = schema default (last value). `listIssueRoomsWithStatus` / `setDoneValuesForRoom` in matrix.ts, writes synced `triage.doneValuesByRoom`. Applies immediately, no Save.
- Full-text message search (off-thread): `src/search/worker.ts` owns a `wukkiemail-search` IndexedDB of message docs, cursor-scan substring search; `src/search/index.ts` is the `SearchIndex` client wrapper. MatrixSource harvests loaded bodies (debounced on first sync + incremental on Room.timeline + after loadOlder), exposes `searchMessages`. App shows an "In messages" section under room results (250ms debounce). Coverage grows with sync/scrollback; future: token/inverted index instead of linear scan.
- @-mention autocomplete in the composer: trailing `@query` → member dropdown (name/mxid/avatar), arrows/Enter/Tab/click, accepted mentions become matrix.to pills + `m.mentions.user_ids` on send. `getRoomMembers` + `mentionUserIds` param on sendMessage. Also fixed a latent bug: composer imperative listeners were re-attached every render — now once-per-element with refs.
- Section-header sweep (replaced the bundle sweep-bar): Messages header "Mark all read", Tasks header "Mark all done" (`markIssueDone` resolves room done value). Selected bundle chip now always stays visible so finishing the last task doesn't yank the view (user-reported).
- "None" status chip for tasks with no kanban value (user-reported: they vanished when any status chip was toggled).
- JMAP email source FOUNDATION (`src/sources/jmap.ts`): `JmapSource implements Source`, session discovery + bearer token, Mailbox/get → bundles, Email/query+get → InboxItem (reuses 'gmail'/'Mail' flavor). NOT wired into App login yet — follow-up is account multiplexing (MatrixSource + JmapSource behind one inbox) + a JMAP login UI + compose/EmailSubmission. Built to keep the InboxItem/Source model honest for email.
- Tasks "Mine" filter: Tasks-header chip hides tasks not referencing me in ANY schema user-typed field (not just 'assignee'). `InboxItem.userValues` (all user-field values) populated by issueItemsForRoom; loose self-match (mxid/localpart/display name). Chip only shows when tasks carry user fields.
- Item provenance for combined inbox: `InboxItem.accountId` + `originLabel`, stamped by MatrixSource (mxid + localpart) and JmapSource (email). App renders a per-row origin tag, gated on >1 distinct account present (hidden for single-account). Groundwork for the combined view.
- **Shared filter system** (`src/filter.ts`): `parseQuery` → structured `Filter` (free text + `is:` / `flavor:` / `from:` / `status:` / `in:` predicates, quoted phrases; OR within a group, AND across), `matchItem(filter, item, ctx)`. Search box now runs through it (`is:unread flavor:whatsapp from:bob status:"in progress" is:mine` + text). `Bundle = {id,label,query}`. `PriorityWeights.topLevel` added (loose-vs-bundle threshold). This is the core the whole bundling redesign builds on.

## ACTIVE REDESIGN — Bundled inbox (Joop's vision, in progress)
The big direction, captured so it survives. Build it ON the filter system — do NOT regress to ad-hoc bundle keys (that was the shortcut being undone).
- **One filter system for everything**: bundles, top-level filtering, manual bundles, and the redesigned search are all the same `Filter`. A bundle = a named filter (`{id,label,query}`). Auto-bundles derive from what's present (`flavor:x`, `in:space:!id`, `is:dm`); manual bundles are user-authored saved filters (generalize the existing `SavedView` account-data into this).
- **Stream model (replaces sidebar + top chip bar + space bubbles)**: the main view is one stream of: (1) a **config bundle** at top (folds open to the old sidebar's non-space controls: account switcher, Priority tuning, Task done statuses, encryption, notifications, sign out); (2) **loose items** — those with `priority >= weights.topLevel` (configurable, add a slider) or pinned — shown directly; (3) **bundles** — everything else grouped, each rendered as a single list-item-like row that **folds open in place** (accordion, not navigation). When open it shows that bundle's filter chips (status/read-unread/mine) + sweep + its items.
- **Group assignment**: each non-loose item → one primary bundle. Precedence: manual-bundle match → space → dm → flavor. (`primaryKey` helper, to add.)
- **Kill the sidebar** entirely (and `BundleChips`, `BundleRow`, space bubbles, hamburger). Keep toolbar search + FAB + modals.
- **Search is "extremely broken"** per user — to be redesigned on the same filter engine (the search-index worker should be queried via the filter too). Don't deep-polish the old box; the redesign subsumes it.
- Status as of now: filter core + search wiring landed. **Steps (a)+(b) DONE.**
  - (a) Bundled stream is the All view — loose items (priority>=topLevel or pinned) + fold-open bundles grouped by primaryKey (space→dm→flavor). Extracted `renderItem` + `renderFilterChips` (shared by stream, opened bundles, flat fallback). `bundled` memo + `expandedBundles` + `primaryKey`; `.bundle-row`/`-head`/`-body` CSS.
  - (b) Config bundle at top of stream (`configOpen`) folds open to accounts switcher + encryption banner + Priority tuning + Task done statuses + notifications + sign out. New `topLevel` slider in SettingsSheet (`weights.topLevel`). `.config-account`/`.config-btn` CSS.
  - Status + Mine are now **render-time displayFilter** (not global), so toggling them never makes a bundle/its chips vanish (was a trap). readFilter is still global in `visible`.
  - Rows now lead with chat/title name, then sender + text (was sender-first).
  - Chat (RoomPanel) is now **full-screen** with a sticky bottom composer (`.room-panel`), not a side bar. IssuePanel stays a side panel.
  - Fixed: `decodeRecoveryKey` import (deep crypto-api path; not re-exported from root) — recovery-key verification works.
  - **Step (c) DONE**: sidebar/chip-bar/space-bubbles/hamburger all removed. Bundled stream + config bundle ARE the navigation. Deleted BundleChips/BundleRow/SourceStatus/FLAVOR_ORDER/flavorBundleKey. `bundle` is now a constant 'all'. Toolbar = brand glyph + search. Spaces are ordinary bundles. Also done this run: jump-to-chat button in IssuePanel header; chat full-screen; row order chat→sender→text; status/Mine display-filter trap fix; decodeRecoveryKey fix.
  - **Step (d) DONE**: manual bundles = saved filters. `ManualBundle {id,label,query}` in account data (`eu.kiefte.wukkiemail.bundles`); `getManualBundles`/`setManualBundles`. They take precedence over auto-grouping in the stream, render first (user order), always show even when empty. `BundleSheet.tsx` is the create/edit UI AND the reusable compose-search helper (query field + quick predicate chips + live match count) — reuse it for the search redesign. "New bundle" button at end of stream (prefills from current search); edit pencil on manual rows.
  - Also done: chat header "Next" button (`onNext`) steps through message conversations in inbox order (unread-first).
  - **Step (e) DONE**: search runs entirely on the filter engine. Worker takes parsed {text, from} (text→body/room AND, from→sender AND); App post-filters hits by room-level predicates (is:/flavor:/status:/in:) against live items. `QueryChips` extracted as the reusable composer; toolbar has a `tune` toggle revealing it under the search box; BundleSheet uses the same component. `searchMessages` now takes {text, from}.
  - **Bundle-level bulk actions DONE**: bundle-head kebab → action sheet (mark all read/unread, all tasks done, pin all, snooze all). Per-item actions were already wired (row hover + mobile kebab → action sheet).
  - **CORE REDESIGN ARC (a–e) COMPLETE.**
  - TRANSITIONAL: per-bundle chips still tune GLOBAL state (readFilter/status/mine); readFilter still global in `visible`.

## What's queued (post-redesign)
- **DONE: Nested bundles** — `getSpaceTree()` in matrix.ts; App builds a `BundleNode` tree, `renderBundleNode` recurses; spaces nest sub-spaces + rooms, counts roll up. Manual/dm/flavor are flat leaves.
- **DONE: dynamic source chips** (from present flavors), **bundle-level bulk actions**, **search on filter engine**.
- **DONE: "Other" bundle + removable/editable default bundles** — bundle kebab → Hide (move to Other) / Make editable (convert to manual filter). Hidden keys in bundles account-data `{bundles,hidden}` (`getHiddenBundles`/`setHiddenBundles`); items collect in the bottom-pinned Other bundle, which lists hidden bundles as restore chips. Convert derives a query (is:dm / flavor:x / in:space:id) and opens the editor. Hidden spaces skipped in nest; children re-parent.
- **DONE: Pinned bundle (top) + Snoozed bundle (bottom)** — pins/snoozed get synthetic nodes; snoozed items were previously hidden entirely. Snooze popover/action-bar clipping fixed (bundle-row overflow visible). Chat "Next" button walks `roomNavOrder` (real stream order) and shows the next conversation's name. Custom emoji render (mxc imgs in formatted_body via `mxcToHttp`; remote imgs dropped).
- **DONE (first cut): JMAP combined inbox** — JmapLoginSheet (sessionUrl+token) → saveJmapCreds; App restores+starts JmapSource, merges its items with Matrix via `applyExternalTriage` (shared pin/snooze/unread, id-keyed triage); origin-tag auto-shows. Connect/disconnect in config bundle. Mail groups under the Mail flavor bundle.
- **DONE: JMAP mail viewer** — clicking a jmap item opens `EmailView` (full-screen); `getEmail` fetches body, `markEmailSeen` sets $seen. HTML sanitized, remote images stripped (v1 tracking guard).
- **DONE: JMAP compose/reply** — `JmapSource.sendEmail` (draft → EmailSubmission → Sent); EmailView reply box; ComposeSheet via "New mail" FAB entry (shown when mail connected).
- **DONE: Pin = Wally favourite** — `setPinned` on a Matrix room sets/clears the `m.favourite` room tag (shared with Wally/Element); roomToItem marks favourited rooms pinned. Issues/jmap fall back to triage.pinned.
- **DONE: mxc media** — message custom emoji (mxc imgs in formatted_body), custom/image reactions (mxc-key reactions render as images), unencrypted pictures (m.image), AND encrypted-room images (src/media.ts AES-CTR decrypt via Web Crypto → MatrixSource.decryptMedia → EncryptedImage component). Still TODO: encrypted m.file/video download, sending custom-emoji reactions (needs emoji-pack picker).
- **DONE: UX fixes** — message reply/edit/delete moved inline after the react button, always-on (was hover-reveal that reflowed the timeline); reload shows "Syncing…" not "No items yet" until rooms hydrate; **hash routing** for chat/task/mail panels (#/m/room, #/m/room/issue/id, #/mail/id) so refresh restores the open view from IndexedDB cache and back/forward navigate (panels removed from the sheet pushState cascade).
- **DONE: mailbox-as-bundle** — JMAP mail now groups by mailbox, nested under a synthetic "Mail" parent (mirrors space→room nesting). App fetches `jmapSrc.listBundles()` into `mailBundles` state; `primaryKey` routes a jmap item to its first `mailbox:<id>` (mail with no mailbox stays as the Mail parent's direct items); the bundled memo pulls `mailbox:*` groups into `mailNode.children`. `bundleLabel` + `queryForBundleKey` handle `mailbox:` keys (label from mailBundles, bulk-action query `in:mailbox:<id>`).
- **DONE: load-images toggle in EmailView** — remote images still stripped by default (tracking-pixel guard); a privacy bar offers "Load images" when the body references remote imgs. `sanitizeEmailHtml(html, allowImages)` keeps `img` only when opted in, then restricts each to https src + strips srcset + sets referrerpolicy=no-referrer/loading=lazy/decoding=async (cid:/data:/http: dropped). `loadImages` re-arms to false per opened message; sanitize memoized so reply keystrokes don't re-run it. `.email-images-bar` CSS.
- **DONE: index JMAP bodies into search** — JmapSource now owns a `SearchIndex` pointing at the SAME `wukkiemail-search` IndexedDB as the Matrix side, so the Matrix-owned cursor scan already returns mail hits — no merge step. listItems harvests subject+preview (id/roomId = `jmap:<emailId>`, roomName = subject); getEmail upserts the same id with the full body (text, or html stripped to text, capped 100k) when a message is opened. App routes a `jmap:` hit to the mail viewer (setSelectedEmail), looks the item up by `jmap:<id>` in the search post-filter, and renders the gmail avatar.
- **DONE: per-bundle filter state (status + mine + read)** — an opened bundle's status chips, Mine toggle AND Unread/Read/All toggle each drive a per-bundle override (`bundleFilters` keyed by node key), independent of the global All-view section headers and of other bundles. `renderFilterChips`/`displayFilter` take a `scopeKey` (undefined = global section headers, node key = that bundle); status-chip counts come from the passed `scope`. Dropped the global `issueStatusCounts` memo.
  - Read was the tricky one (it drove `visible`, which feeds counts + bundle visibility). Solution: `visible` stays global-read-filtered (keyboard nav, flat search, empty check unchanged); a new read-INCLUSIVE `visibleStream` feeds the bundled accordion, and the memo narrows each node's items by that bundle's effective read filter via `readF(key, xs)` (default = global `readFilter`, so unset bundles reproduce the old output exactly). Loose items use the global read filter. Bundles emptied by the read filter are dropped (count>0), same as before. `scopedRead`/`setScopedRead`/`passesRead` helpers. KNOWN edge: a bundle with zero unread is hidden in global Unread mode, so you can't open it to set its read override to All — use the global All/Read toggle to reveal it (predictable tradeoff).
- **DONE: (6) Wally voice/video in FAB** — was already shipped: FAB "New call room" → `NewCallRoomSheet` (video/voice toggle + invites) → `MatrixSource.createCallRoom` (MSC3417 `org.matrix.msc3417.call` room, megolm encryption, call.member/m.rtc.member power levels at 0, `eu.kiefte.wally.call_room` state) → opens `CallView` (LiveKit via useLiveKitRoom/sfu/ring). The earlier "NEXT" note was stale.
- **PRIORITY QUEUE (1–6) COMPLETE.** Compose/reply, mailbox-as-bundle, load-images toggle, JMAP search indexing, per-bundle filter state (status+mine+read), and the call FAB are all shipped.
- **DONE: encrypted m.file/video/audio download** — E2EE rooms carry `content.file` (EncryptedFile) with no plain URL, so file/video/audio messages previously showed as `[m.file]` text. matrix.ts now parses `content.file` for those msgtypes into `msg.file.encrypted`; RoomPanel renders an `EncryptedFileLink` that decrypts LAZILY on click (videos can be large) via `decryptMedia(file, mimetype)`, then plays A/V inline (`<video>`/`<audio>`) or offers a download link with the original filename. Images already decrypted eagerly via EncryptedImage.
- **DONE: threads drawer** — RoomPanel header now has a forum button (shown when the room has any thread roots) opening a `ThreadsDrawer` that lists every thread (root sender + snippet + reply count + latest activity, newest first) and jumps to one via the existing `onOpenThread`. Built entirely from the snapshot's `threadSummary` roots — no matrix.ts change. `.thread-row` CSS.
- **DONE: stickers (receive AND send)** — incoming: `m.sticker` events were dropped by the timeline type filter; now allowed through and parsed as a small image (`msg.image.sticker`, plain mxc thumbnail or encrypted via the decrypt path), rendered inline at ≤160px with no lightbox (`.msg-sticker`). Sending: `MatrixSource.getStickers(roomId)` (im.ponies usage=sticker, same pack sources as getCustomEmojis) + `sendSticker(roomId, body, mxc)` (m.sticker event referencing the pack's existing mxc — no upload). RoomPanel composer has a sticker button (shown when stickers exist) opening `StickerPicker` (image grid, outside-click/Escape close); picking sends immediately. `.sticker-picker`/`.sticker-grid`/`.sticker-cell` CSS.
- **DONE: emoji skin-tone variants** — emojiData captures each emoji's single-person `skins` (tone 1-5 → toned char) from emojibase compact; EmojiPicker has a 6-swatch tone selector (default + 5) persisted in `wukkiemail:emoji-tone`, and `toned(e)` applies the chosen tone to the displayed + picked char (emoji without that tone fall back to base). Multi-person tone combos skipped. `.emoji-tones`/`.emoji-tone` CSS.
- **DONE: composer draft persistence** — a half-typed message survives navigating away (and no longer leaks across rooms). Per-room/per-thread draft in localStorage (`wukkiemail:draft:<roomId>[:<threadRootId>]`); saved from the composer input listener under a draftKey REF (not a stale closure), restored on open via an effect that sets state + the Material field through this panel's own `composerFieldRef` (so a thread overlay's 2nd composer isn't targeted), cleared on send. Emoji and mention insertions now also persist the draft (gap closed).
- **DONE: inbox draft badge** — rows whose room has an unsent draft show a quiet "Draft" pill (App `draftRooms` memo reads `wukkiemail:draft:<roomId>` per item; recomputed on items change + `draftTick`, which bumps when a room opens/closes since same-tab localStorage writes fire no storage event). Room-level drafts only (thread drafts not badged). `.draft-badge` CSS.
- **DONE: keyboard triage shortcuts** — the core Google-Inbox interaction was missing (only j/k/Enter/`/`/Esc existed). Added single-key actions on the cursored row in App's keydown handler: `e` = archive/done (mark a message read, or a task done), `u` = toggle unread, `s` = snooze to tomorrow 9am, `p` = pin/unpin. Reuses the same MatrixSource methods the row action sheet uses; the existing focus guard means they don't fire while typing in a field. Discoverability (a `?` shortcuts legend) is a noted follow-up.
- **DONE: `?` keyboard-shortcuts legend** — `?` toggles a `ShortcutsSheet` listing j/k, Enter, e/u/s/p, /, ?, Esc, so the keyboard triage is discoverable. Escape/scrim close it. `.shortcuts-table`/`kbd` CSS.
- **DONE: fixed keyboard nav targeting the wrong row** — latent bug: j/k/Enter (and the new e/u/s/p) acted on `visible[cursor]`, but the default BUNDLED view renders rows in a different order than the global `visible` array (loose-then-expanded-bundles, collapsed bundles hidden), so the highlighted row and the acted item were different items. Now rows carry `data-item-id`, the j/k cap uses the rendered `.item[data-idx]` count, and the cursored item is resolved from the highlighted DOM row via `itemById` — so highlight and action always agree in every view. Also made Enter open JMAP emails (previously fell through).
- **Remaining follow-ups** (smaller, optional): per-bundle read zero-unread edge (documented tradeoff), account-level widgets, SDK auto-enable sliding sync. The SPACES fix is shipped (SDK d19580eb0); awaiting user reload/`wmSpaces()` to confirm.
- **Wire JMAP + combined view**: login UI (sessionUrl+token), multiplex MatrixSource + JmapSource behind one inbox (merge listItems/listBundles, route subscribe/triage by item-id prefix); provenance fields + origin-tag already exist. Then compose via EmailSubmission.
- **Per-bundle filter state**: chips inside a bundle currently tune global readFilter/status/mine; make them per-bundle.
- **Wally voice/video room creation** in the FAB.
- **Mobile sync trace** if it recurs.

## What's queued
- **Wire JMAP + combined multi-account view** (user wants this): login UI (sessionUrl + token), then run multiple sources (Matrix slots + JMAP) behind ONE merged inbox. Design the user asked for: a combined view where every element makes clear which inbox/chat/account it came from — the provenance fields (`accountId`/`originLabel`) + `.origin-tag` rendering already exist and auto-activate once >1 source feeds `items`. The multiplexer is the missing piece: a top-level component that merges `listItems()` across sources, fans `subscribe`/triage to the right one by item id prefix, and merges `listBundles`. Then JMAP compose via EmailSubmission. Foundation in `src/sources/jmap.ts`.
- **Wally voice/video room creation**: extend FAB menu, mirror what Wally does
- **Mobile sync trace**: user said they'd paste console output if Matrix sync still misbehaves on their phone

## Recent user feedback patterns

- Wants the Inbox-Reborn / original Google Inbox model — center column, no permanent sidebar, hamburger drawer (shipped)
- Triage-list framing: important up, noise down, reorganizable, full-text search (mostly shipped)
- Strong preference for Matrix-only over Gmail; bridges provide the multi-source feel
- "Don't repeat what's already shipped in queue summaries"
- Likes the Wally aesthetic; WukkieMail recolored to teal to distinguish

## Working style

- 1-minute self-paced /loop. Each iteration: pick ONE thing from the queue, ship it (build + commit + push), brief response, ScheduleWakeup again. Commit messages are detailed (`why`, not `what`).
- Push frequently; don't sit on changes. CF Pages auto-deploys.
- Verify builds with `npx tsc --noEmit && npx vite build` before committing.
- Use `bd` (beads) for any task tracking — never Claude's built-in TaskCreate.
- Auto-fix harmless lint stuff (unused vars) inline; don't ask.
- For multi-account / encryption / anything that touches account state, ship the data layer first as a separate commit even if no UI yet.

## Gotchas already hit

- `IndexedDBStore.startup()` must be called AFTER createClient (was the smoking gun for `sync=null`)
- IndexedDBStore.startup can throw "Query failed: UnknownError". buildClient closes+deletes+rebuilds the DB once on failure. On Joop's faulty Chromebook IDB is broken at the DEVICE level (even a fresh DB fails; Wally hits it too) → MemoryStore + full re-sync every reload, unavoidable from code. Mitigation: App caches the inbox item list in localStorage (`wukkiemail.items.cache.v1.<slot>`, capped 300) and hydrates instantly on reload (items state seeds from it, loading starts false). NOTE: only the inbox list is cached, not room timelines — opening a chat still waits for that room to re-sync on such devices. matrix-js-sdk has no small persistent store (localStorage too small for sync data), so there's no SDK-level alternative to IndexedDB.
- Full-screen panels: RoomPanel/EmailView use `.issue-panel.room-panel`. The RoomPanel !snap loading branch ALSO needs `room-panel` or it flashes the old 560px side overlay on hash-refresh. IssuePanel stays a side panel by design.
- Hash routing (#/m/room, #/m/room/issue/id, #/mail/id) drives the content panels; they're NOT in the sheet pushState cascade. applyHash on mount + hashchange; a state→hash effect mirrors them.
- Encryption banner needs `getSecretStorageKey` cryptoCallback wired in createClient (fixed)
- CF Pages 3.x wrangler needs `run_worker_first: true` (not array form)
- Material `<md-icon-button>` click events don't always bubble to React onClick — use plain `<button>` for those
- vite build: `dist/sw.js` lives in `public/` so it ships verbatim
- Sandbox blocks `/home/joop/.npm/_cacache` — npm install needs `--cache /tmp/claude/npm-cache` (or run with sandbox disabled)
- `src/sources/matrix.ts` has a NUL byte (reactionKey) → grep with `-a`; tsc/vite via `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/vite build`
- **`tsc --noEmit` + `vite build` do NOT catch temporal-dead-zone (use-before-init) errors** — those are runtime-only and white-screen the app. A `const` helper (arrow fn) used INSIDE a `useMemo`/render path must be declared ABOVE that memo, since the memo factory runs during render. This bit us: the scoped-filter helpers (scopedRead/passesRead) were declared after the `bundled` memo that calls them via readF → white screen since the per-bundle-read deploy (fixed in 4a28176 by hoisting them above the `visible` memo). When adding helpers used by memos, declare them before the memos, and ideally smoke-test in a browser, not just build.

## NEXT (planned ports from Wally — cinny-wally is the reference, our own code)

Wally repo: `/home/joop/matrix-stuff/cinny-wally`. Same matrix-js-sdk fork, so SDK-level logic ports cleanly; only the cinny UI (jotai/Box/folds) needs rewriting in wukkiemail's plain-React style. We already ported calls this way (CallView/useLiveKitRoom/sfu/MatrixKeyProvider from PersistentCallContainer).

### 1. Threads port — DONE (2026-05-29)
- `threadSupport: true` is set in `startClient` (NOT createClient — it's a `IStartClientOpts` field in this SDK fork; createClient rejects it).
- `getRoomTimeline(roomId, limit, threadRootId?)`: builds a thread index (root -> count/latestTs/latestEventId). Main timeline hides `m.thread` replies and annotates root messages with `threadSummary`. Thread mode returns only the root + its replies.
- `sendMessage(..., threadRootId?)`: plain thread msg falls back to a reply to the latest thread event (`is_falling_back: true`); in-thread reply targets the chosen message (`is_falling_back: false`). `latestThreadEventId` helper picks the fallback target.
- `RoomPanel` reused for the thread view via `threadRootId` + `onOpenThread` props (header "Thread"). Each main message has a forum "reply in thread" button; roots with replies show a "N replies" chip. App layers a second RoomPanel as the overlay; Escape closes thread first, auto-closes on room change.
- NOT yet done: a threads *drawer* (list of all threads in a room). Current UX is per-message entry only — add a drawer later if wanted.

### 2. Widgets port — DONE (2026-05-29)
- Ported: `src/SmallWidgetDriver.ts` (full WidgetDriver: send/read events+state, to-device w/ E2EE batching, OpenID, relations, user search, media, TURN streaming), `src/SmallWidget.ts` (binds IApp -> iframe via ClientWidgetApi, read-up-to marker), `src/CinnyWidget.ts`. Dropped EC URL builders and the node EventEmitter base (TS in this repo can't construct `events`; UI doesn't consume the lifecycle events anyway).
- `MatrixSource`: `getRoomWidgets` / `canManageWidgets` / `addWidget` / `removeWidget` over `im.vector.modular.widgets` state events; `RoomWidget` type.
- `src/WidgetPanel.tsx`: full-screen panel (like CallView) — widget tabs, embedded iframe (template-var substitution, widgetId/parentUrl params, **start messaging BEFORE setting src**, depend on id+url only so a live iframe isn't torn down on every state echo), add/remove gated on `state_default` power.
- RoomPanel header `widgets` button (shown when room has widgets OR user can manage); App renders WidgetPanel via `widgetRoom` state.
- `matrix-widget-api ^1.17.0` declared explicitly (was transitive; lockfile already had it as root dep).
- NOT done: account-level widgets (`m.widget` in account data), toolbar-pin shortcuts, the IssueBoardWidget itself (that's hosted widget content, separate). Capabilities are broad (trusted) — fine since widgets come from room state, but if we ever embed untrusted widgets, gate capabilities per-widget.

### 3. Proper emoji picker (incl. custom emoji) — DONE (2026-05-29)
- `src/emojiData.ts`: lazy-loads `emojibase-data` (compact set + emojibase shortcodes), **code-split** (separate `compact`/`emojibase` chunks, only fetched on first picker/autocomplete use — main bundle grew ~27kB). Grouped + searchable list; registers the full shortcode->char map into emoji.ts so typed `:shortcode:` expansion covers the whole set (built-in table is the pre-load fallback). Deps `emojibase ^15.3.1` + `emojibase-data ^15.3.2` (package-lock is gitignored; CI installs from package.json).
- `MatrixSource.getCustomEmojis(roomId?)`: im.ponies packs — user pack (account data `im.ponies.user_emotes`), current room `im.ponies.room_emotes`, globally-enabled packs via `im.ponies.emote_rooms`. Deduped by shortcode, honours `emoticon` usage. Added `CustomEmoji` type.
- `src/EmojiPicker.tsx`: search + recent (localStorage) + custom section + grouped unicode grid. Outside-click/Escape close. Reused by composer (insert) and reaction adder ("more" -> full picker).
- Composer (RoomPanel): `mood` button opens the picker. `:word` autocomplete mirrors the @-mention menu (shared keydown). **Trigger guard** `/(^|\s):([a-z0-9_+]{2,})$/i` — needs ≥2 word chars after a colon at a word boundary, so `:P` `:D` `:)` `:-)` and `10:30` never pop the menu. Inserted custom `:shortcode:` tracked in a ref and converted to `<img data-mx-emoticon>` at send (plain body keeps the shortcode as fallback), exactly like mention pills.
- Reactions: custom emoji react sends the mxc as the key (renderer + toggleReaction already handle mxc keys).

---

## All three post-compaction ports are DONE (threads, widgets, emoji). Plus an interrupt fix: sync notice no longer covers the cached inbox on reload (App.tsx — keep cache during initial sync, bottom `.sync-banner` instead of full-screen cover).

### Not yet done / possible follow-ups
- Threads: a threads *drawer* (list every thread in a room) — current UX is per-message entry only.
- Widgets: account-level widgets (`m.widget` account data), toolbar-pin shortcuts, the hosted IssueBoardWidget itself.
- Emoji: sticker packs (im.ponies usage `sticker`), per-emoji skin-tone variants (component group is filtered out).
- None of threads/widgets/emoji could be tested live this session (no peers/widgets/packs to hand) — flag for the user to smoke-test on mail.wukkie.uk.

## ===> SESSION 2026-05-30: SDK sliding-sync HARDENING (Wally + WukkieMail, both live) <===
A long debugging arc that started from "ganza shows 1 unread / floats" and turned
into a broad resilience pass on the matrix-js-sdk fork (`wally-dist`). **Current
SDK pin / branch HEAD: `3333bb7a1`.** Both consumers deploy from it.

**Deploy tooling:** `/home/joop/matrix-stuff/deploy-sdk.sh` — ONE command pushes
the SDK (`wally-dist`) to BOTH consumers: triggers WukkieMail's Cloudflare rebuild
FIRST (runs in parallel), then re-pins cinny-wally + runs `push-to-codeberg.sh`.
`push-to-codeberg.sh` now FORCE-refreshes the git-pinned fork (`rm -rf
node_modules/matrix-js-sdk` before `npm install`) — npm does NOT re-fetch a
github: dep on a pin bump, and `--package-lock-only` poisons any metadata check,
so a pin bump silently shipped stale SDK twice before this. ALWAYS grep the built
`main-*.js` for an SDK string marker after a Wally deploy.

**SDK fixes landed this session (all on `wally-dist`):**
- **Auto-enable** (40739a711): `startClient()` feature-detects MSC4186/3575 and
  builds `SlidingSync.create` itself when no instance/opt-out. New opts
  `autoSlidingSync`(default true)+`slidingSyncOpts`; `getSlidingSync()` accessor;
  baked-in lean `DEFAULT_SLIDING_SYNC_REQUIRED_STATE` (NOT `[*,*]`; Continuwuity
  ignores wildcard). WukkieMail dropped `maybeBuildSlidingSync`.
  - GOTCHA fixed (WukkieMail 9fb3fde): `lazyLoadMembers`/`initialSyncLimit` must
    NOT be passed on the sliding-sync path (they reach Room creation and broke
    timelines) — feature-detect upfront, apply classic tuning only when classic.
- **Window grows to FULL coverage in one step** (97b598375 `growStep`): was
  +growBy/sync, stalled on flaky links → incomplete spaces. Jump to `[0,joinedCount]`.
- **DM names from heroes** (32e79784d): `ensureNameEvent` fabricates the name from
  `heroes` excluding functional (bridge-bot) members (`dmNameFromHeroes`), not the
  server `name` (which folded in self + WhatsApp bot). Added
  `io.element.functional_members` to required_state (without it
  getFunctionalMembers()/getAvatarFallbackMember can't exclude bots). cinny's
  `getDmName` patch (useRoomMeta.ts) restored as the client-side guaranteed path.
- **Recency from `bump_stamp`** (ecf5b10ee): `getLastActiveTimestamp()` prefers the
  MSC4186 `bump_stamp` — the server's last-MEANINGFUL-activity signal that EXCLUDES
  trailing state events (member/eu.kiefte.issue). This is the float fix: a read
  room with a trailing issue edit no longer floats. WukkieMail `roomToItem` uses
  `getLastActiveTimestamp` for the row recency (not the event ts). cinny inherits
  via `factoryRoomIdByActivity`/`getLastMeaningfulTimestamp`.
- **Read-receipt clears unread regardless of sender** (3333bb7a1): the
  mark-read-on-receipt shortcut required us to be the SENDER of the last event;
  dropped — our receipt landing on the last event is itself proof it's read.
  Smooths the "count shows high then disappears" flicker.
- (Earlier this session: membership-from-state e6082f841, spaces-list window
  growth d19580eb0, per-room sync resilience 47114d3d6/c79bb3b2a, log quieting.)

**App-side:**
- WukkieMail **Back button + nav history** (793f9f6): browser-style back/forward in
  the chat panel; Back returns to the previous chat, Next prefers the chat you
  backed away from. `navHistory`/`forwardRoom` in App.tsx; `onBack`/`backLabel` on
  RoomPanel.
- cinny **backfill prioritises the read marker** (b6d88eb92, useBackgroundBackfill):
  rooms showing unread whose read marker isn't in the lean timeline get a score
  boost so the scheduler loads back to the marker → `getUnreadInfo` can verify true
  unread vs a stale count. ("marker-not-loaded in the priority approach.")
- WukkieMail mark-read receipts the actual LAST event (52fa4b5) + zeros counts
  first; and **clears the `manuallyUnread` triage flag** (8373948).

**THE ACTUAL ganza "1 unread" bug:** NOT a count/SDK issue at all — ganza was stuck
in WukkieMail's `manuallyUnread` triage set (account data `eu.kiefte.wukkiemail.triage`,
forces unreadCount>=1 via App.tsx ~L1031 + matrix.ts ~L994). `markRoomRead` never
removed it, so opening couldn't unstick it; it looped in next/previous. Fixed:
markRoomRead clears the flag (8373948). Joop manually cleared the stale entry.

**Diagnostics added to WukkieMail (window globals):** `wmRooms()`, `wmSpaces()`,
`wmRaw(filter)` (server summary vs SDK: name/heroes/counts), `wmEvents(filter)`
(last timeline events + ts), and `window.wmClient` (raw MatrixClient for ad-hoc
console work). Used heavily to root-cause via the API (e.g. `bump_stamp` discovery).

**Remaining OPTIONAL polish (not a bug):** move cinny's verify-from-marker
(getUnreadInfo: walk timeline back to read receipt, recount notifying events) INTO
the SDK's `getRoomUnreadNotificationCount` (cache by readUpToId+timelineLen) so
`getUnreadNotificationCount` self-corrects stale server counts for BOTH apps. Data
showed stale counts mostly self-heal, so deferred. The "read but still shows" set
is the 75 `marker-not-loaded` rooms (read elsewhere, outside the sliding window).

## SDK PORT PROJECT (in progress) — transparent sliding sync for Wally
Goal: fold the load-bearing sliding-sync handling into the matrix-js-sdk fork so
Wally (and any consumer) gets it without app glue. (bd not installed in this env;
tracked here.) Key finding from reading the fork's SlidingSyncSdk: rooms are
stored once and NEVER removed (no store-removal code), and processRoomData set
membership unconditionally to Join — so the "flicker/disappear" we chased was
NOT an SDK store bug, it was the app-side event-category VISIBILITY drop (fixed
0718e7e) + the getRoomSummary joinable mislabel (everJoined guard). The heavy SDK
pieces (SlidingSync.create window growth, per-room resilience, log demotions) are
already in the fork.
- **DONE #3 (SDK, wally-dist e6082f841):** processRoomData now derives our
  membership from the injected m.room.member state instead of hardcoding Join
  (falls back to Join when the self member event is absent). Confirmed clean in
  WukkieMail (inbox loads normally).

### ===> TWO PREPARED ITEMS FOR AFTER COMPACTION (Joop asked to queue these) <===

**ITEM A — DONE (2026-05-30, SDK wally-dist 40739a711 + 1c66e2df8).** Sliding
sync now AUTO-ENABLES in the SDK: `startClient()` feature-detects
MSC4186/MSC3575 (`serverSupportsSimplifiedSlidingSync()`) and, when the caller
passed no explicit `slidingSync` and not `autoSlidingSync:false`, builds one via
`SlidingSync.create`. The lean required_state + heavier spaces/subscription set
are baked into `DEFAULT_SLIDING_SYNC_REQUIRED_STATE` /
`DEFAULT_SLIDING_SYNC_SPACES_REQUIRED_STATE` (replacing the `[*,*]` default
Continuwuity ignores); `SlidingSync.create` opts extracted to exported
`SlidingSyncCreateOpts`. New `IStartClientOpts.autoSlidingSync` (default true) +
`slidingSyncOpts`. New `MatrixClient.getSlidingSync()` accessor so consumers
reach the auto-built instance for room subscriptions. WukkieMail
(`MatrixSource.start`) DROPPED `maybeBuildSlidingSync` and now just passes
`autoSlidingSync` + grabs `client.getSlidingSync()`; toggles preserved
(`?classicsync`/settings → `autoSlidingSync:false`; `?slidingsync` → explicit
forced instance). Builds clean both sides.
  - **Regression caught + fixed (WukkieMail 9fb3fde):** the auto-enable wiring
    initially passed `initialSyncLimit:1`/`lazyLoadMembers:true` unconditionally;
    `lazyLoadMembers` flows into Room creation under sliding sync
    (`SlidingSyncSdk.createRoom`), which the old sliding-sync branch never did →
    rooms briefly showed the latest event as the start of the room. Fix:
    feature-detect (`serverSupportsSimplifiedSlidingSync`) upfront and apply
    those classic-only opts ONLY when sliding sync will NOT run. Joop confirmed
    the auto path feels MORE stable than the hand-rolled one (one consistent set
    of assumptions inside the SDK, no app-side tuning to drift).
  - **WALLY TRANSPARENT TEST DEPLOYED (2026-05-30):** cinny-wally `sdk-pin:`
    bump `d466a1c3e → 1c66e2df8` (commit e54d90065), pushed to Codeberg + built +
    deployed to wukkie.uk via push-to-codeberg.sh. This is the first live cinny
    test: plain `startClient()`, no app glue, should auto-enable sliding sync.
    **NEXT: Joop smoke-tests Wally on wukkie.uk** (rooms/spaces populate, no
    start-of-room glitch, console says sliding sync). If clean, the port is
    proven and the SDK auto-enable can be considered the default for all
    consumers.

<details><summary>Original ITEM A spec</summary>

**ITEM A — SDK #1: auto-enable sliding sync on MSC4186 (transparent for Wally).**
Where: matrix-js-sdk fork `/home/joop/matrix-stuff/matrix-js-sdk-jj`, `src/client.ts`
`startClient` / sync init. Today consumers must build + pass `{ slidingSync }`
(WukkieMail does this in `MatrixSource.maybeBuildSlidingSync`). Goal: if the
caller did NOT pass a slidingSync AND the server advertises simplified sliding
sync, auto-build one via `SlidingSync.create` and use it — so Wally just calls
`startClient()` and gets it.
  - Feature detect: `client.getVersions()` → `unstable_features` keys
    `org.matrix.simplified_msc3575` || `org.matrix.msc3575` || `org.matrix.msc4186`
    (same check WukkieMail already does).
  - Opt-out: honor an explicit `startClient({ slidingSync: false })` or a flag to
    force classic /sync (WukkieMail uses `?classicsync`).
  - Config caveat: `SlidingSync.create` defaults `required_state` to `[["*","*"]]`,
    which Continuwuity does NOT honour — so the auto path needs a sensible EXPLICIT
    default lean required_state baked into the SDK (mirror WukkieMail's `leanState`:
    create/name/avatar/topic/canonical_alias/encryption/member $ME+$LAZY/space.parent/
    call.member/rtc.member, plus a spaces list with m.space.child). Decide how
    opinionated to be; expose overrides.
  - Then: WukkieMail drops `maybeBuildSlidingSync` and relies on auto-enable;
    verify identical behavior; THEN test Wally's cinny UI (the real "transparent"
    proof). Wally repo: `/home/joop/matrix-stuff/cinny-wally`.
  - Also fold in: `SlidingSync.create` default `timeline_limit` is 1 — fine as a
    base (WukkieMail inflates adaptively, see below), but document it.

</details>

### ===> PROGRESSIVE LOADING PRIORITY — "seamless hydration" (Joop's directive, IN PROGRESS) <===
Goal (Joop): "if we get this right it will look seamless." Under lean sliding sync
(timeline_limit 1, lean required_state) the inbox first-paints fast but is
INCOMPLETE — and critically **a DM's name IS its people**, so a DM with no loaded
members shows no/wrong name. The fix is a single importance-ordered loader that
inflates the smallest set resolving what the user can currently perceive, then
widens. Self-correcting (retry on flaky net, mark-tried-only-on-success, backoff)
and map-merged so corrections fill in without churn.

**TIER ORDER (load/inflate in this sequence; each tier throttled, batched):**
0. **Structure** — ALL spaces + their `m.space.child` hierarchy. [DONE: SDK
   `SlidingSync.create` now grows the spaces list to full coverage in one step
   — commit 97b598375.]
1. **Identity of what's visible without opening** (the inbox rows the user sees):
   - **DM names = the other member.** Resolve via heroes if Continuwuity sends
     hero displaynames; ELSE actively load members for DM rooms (via the
     `/members` endpoint — works regardless of sync mode). *(Pending: wmRaw
     diagnostic tells us which — heroes-carry-names vs must-load-members.)*
   - room name/avatar/preview + unread/highlight for rooms in the current window.
2. **Currently-open context** (top interactive priority when something is open):
   - opened space → its child rooms + names/previews.
   - opened room → fuller timeline (inflate past 1) + its members (sender
     names/avatars) + receipts.
3. **Attention** — rooms with unread/highlight (mentions) + invites: load their
   preview + members so the inbox is accurate.
4. **Recency** — recently-active rooms by last activity.
5. **Long tail** — everything else by the existing perceived-priority weights
   (DM > mention > recent > bridge/bot noise).

**Cross-cutting mechanics:**
- Variable timeline limit: base 1, inflate (back-paginate) only rooms whose
  preview is a hidden category / uninformative — importance-ordered. (Have:
  `inflateLackingRooms`; extend to obey the tier order above.)
- Member inflation is TARGETED: DMs (names) + opened room (senders), NOT all
  rooms. `["m.room.member","*"]` in required_state would bloat big rooms; use the
  `/members` endpoint per room instead.
- Self-correction + map-merge (see ITEM B) so it heals on flaky links seamlessly.
- **NEXT STEP: ship wmRaw diagnostic (DONE this session), get Joop's dump for a
  mis-named DM + a mention room, then build the tiered loader accordingly.** If
  heroes carry names → Tier 1 names are free (SDK handling bug); if not → Tier 1
  must load DM members. Mentions: if `srvHl` is blank/0 on a known mention →
  Continuwuity omits `highlight_count` → SDK must compute highlight badges
  client-side from push actions (it already computes push actions for the notif
  timeline at sliding-sync-sdk.ts:966, just doesn't set the room Highlight count).

**ITEM B — map-merge + memoized Row (seamless partial updates), WukkieMail App.tsx.**
Problem: `setItems(sorted)` hands React a fresh array of fresh item objects every
refresh, so EVERY row re-renders and ts changes reshuffle — visible churn as the
adaptive inflation corrects rooms. Two-part fix (need BOTH; part 1 alone is inert
without part 2):
  1. **Map-merge in the refresh** (App.tsx, the `refresh()` in the big effect,
     ~where `setItems(sorted)`/`saveCachedItems` are): keep a `useRef<Map<string,
     InboxItem>>` of the last items. Map new items → reuse the PREVIOUS object when
     deep-equal (write a `sameItem(a,b)` comparing subject, snippet, ts, unread,
     unreadCount, priority, avatarUrl, invite/joinable, bundles joined, statusValue,
     etc.). `setItems(merged)`; refresh the ref. Preserves identity for unchanged
     rooms.
  2. **Extract `renderItem` (App.tsx ~L1075) into `const Row = React.memo(...)`**
     so only changed rooms re-render. The row closes over: `it`, `idx`/`cursor`
     (highlight), `setSelectedRoom/Email/Issue`, `draftRooms` (→ `hasDraft` prop),
     `showOrigin`, `matrixSrc` (invite accept/decline), `formatTs`. Convert to
     props. CURSOR IS THE TRAP: passing `cursor` to every Row re-renders all on
     arrow-key nav — instead drive the highlight via a data attribute + CSS, or
     only pass a boolean `isCursor` and accept that 2 rows update. Keyboard nav is
     separate from the data-update seamlessness, which is the actual goal.

- **TODO #2 (minor):** make SlidingSync.create the default config path.
- **TODO #4 (optional):** SDK-level space-child loader to retire the app's
  syncSpaceRooms glue (could use MSC2946 /hierarchy — Continuwuity supports it —
  which also restores not-joined "joinable" discovery dropped in 4e010d2).

### Display-layer model shipped THIS session (the foundation B builds on)
Event-type hiding is a DISPLAY/COUNTER filter, never visibility (see the
By-event-type note above). `roomToItem` picks the latest NON-hidden event for the
row; `unread = notifs > 0` (joins/state never notify, so they don't inflate it).
Adaptive timeline inflation (`inflateLackingRooms` in matrix.ts): base
`timeline_limit: 1`, then back-paginate (limit 20) only rooms whose every loaded
event is hidden — importance-ordered (unread → recent), batch 8, debounced,
one-shot per room, mark-tried-only-on-success (network failures retry; 5s backoff
on a dead batch) for self-correction over flaky links. eventCategory now has
'call' (incl. msc3401.call.member/m.rtc.member) and 'issue' (eu.kiefte.issue).
getRoomSummary path REMOVED (404-stormed on Continuwuity). NaN ts guarded
(formatTs renders '' for missing ts, not "Invalid Date").
- **NEXT:** validate against Wally's cinny UI once #1 lands.

## SDK fix (2026-05-29): missing joined rooms

Root cause of "joined rooms missing from the inbox/spaces" was in the
matrix-js-sdk fork (LaPingvino/matrix-js-sdk#wally-dist), not the app:
`processSyncResponse` processes each room batch with `promiseMapSeries`
(sequential for/await). One room throwing (e.g. an unsupported/too-new room
version) aborted the whole loop, so every room AFTER it was never
`storeRoom()`'d and stayed permanently absent from `getRooms()`. Fixed by
wrapping per-room processing in try/catch in all four loops (join, invite,
leave, knock) — fork commits 47114d3d6 / d5df99ae3 on wally-dist. Affects Wally
too. Consumers pick it up on a fresh install (lockfile is gitignored, dep
tracks the wally-dist branch). App-side mitigations remain: syncSpaceRooms on
space-open + the Force-full-resync settings button.

## Sliding sync (2026-05-29)

WukkieMail uses simplified sliding sync (MSC4186) when the server advertises it
(MatrixSource.maybeBuildSlidingSync -> SlidingSync.create), else classic /sync.
Toggle: settings "Sync: sliding/classic" or ?classicsync / ?slidingsync.
Two lists: dedicated spaces list (room_types m.space) + recency "all" list whose
window auto-grows to cover all rooms. required_state is EXPLICIT (Continuwuity
doesn't honour the ["*","*"] wildcard, which had left spaces with no
m.space.child). Rooms opened in RoomPanel get a per-room subscription.

SPACE-CHILDREN-MISSING fix (app, matrix.ts): opening a space showed only the
already-synced child rooms; the rest were missing. `syncSpaceRooms` backfilled
missing `m.space.child` rooms ONLY via `getRoomSummary` (MSC3266 / im.nheko.summary),
which Continuwuity lacks → 404 for every child → all skipped. Now the PRIMARY
path subscribes to each missing child via sliding-sync room subscriptions
(`modifyRoomSubscriptions`), so joined children stream into the store without
MSC3266 (same mechanism as opening a room); they arrive async and render once
synced. getRoomSummary stays as best-effort joinable discovery, with a
`roomSummarySupported` flag that flips off after the first 404/M_UNRECOGNIZED so
we stop hammering the absent endpoint, and its failure is now console.debug not a
warn. NB: confirmed live via Joop's console (404s on getRoomSummary during
syncSpaceRooms, only 1 of N Wally Community rooms showing).

CALL-BUTTON fix (app, matrix.ts): the VC button was hidden on a dedicated call
room (createType org.matrix.msc3417.call) because canStartCall only checked
maySendStateEvent(m.rtc.member / msc3401.call.member), which needs m.room.power_levels
loaded — under sliding sync that state can be absent, so it fell back to the
default state_default (50) and read as not-allowed. canStartCall now short-circuits
true for a dedicated call room (msc3417.call create type OR eu.kiefte.wally.call_room
state), since offering the call affordance is that room's whole purpose.
(Confirmed via Joop's wmRooms table: the space-children SUBSCRIPTION fix worked —
all 5 Wally Community children show membership 'join' and bundle under the space;
the VC room had createType org.matrix.msc3417.call + 50 timeline events.)

SPACES-MISSING fix (SDK, wally-dist d19580eb0): the create() factory grew only
the all list, leaving the spaces list pinned at [[0,199]]. On a server that
doesn't honour the room_types filter the spaces list degrades to a recency list,
so low-sorting space rooms sat beyond the window and never arrived (user: "missing
a lot of spaces"). The Lifecycle growth handler now grows BOTH lists until each
covers every room the server reports. Helps under both hypotheses (filter honoured
or not). If spaces are still missing after this, get wmSpaces() output to tell
heldSpaces vs serverSpacesCount apart.

SDK fork carries the load-bearing pieces (wally-dist): SlidingSync.create
factory, per-room sync resilience (join/invite/leave/knock + onRoomData),
storeRoom listener-leak guard (don't re-store on window growth), push-rules
re-applied only on change, and demoted log spam. NB: SDK-only fixes need a
WukkieMail redeploy so CF reinstalls the fork.

Console-flood fixes (all SDK, wally-dist): under sliding sync, state events are
re-emitted before the room is registered in the store, so several handlers fired
errors/warns per room (hundreds of times each):
- MatrixRTCSessionManager.onRoomState "Got room state event for unknown room"
  -> demoted to debug (commit 6dc4b27f7). RTC sessions still register via
  ClientEvent.Room -> onRoom -> refreshRoom once the room is added.
- MatrixRTCSession membership filtering "Ignoring expired device membership"
  (+ different-session / not-in-room) re-ran every sync pass per stale device
  -> demoted info to debug (commit bb7eedafe).
- EventTimelineSet canContain / "does not belong in timeline" -> debug.
- SlidingSyncSdk account-data / ephemeral "room doesn't exist" -> debug.
- push-rules Missing/Adding default rule storm -> guarded (commit e52a5c9dc).
