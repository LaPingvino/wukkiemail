# Handover

Quick brief for any agent picking this up mid-stream.

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
- Per-event-type tuning: each room's latest event → `eventCategory` (message/image/membership/roomstate/call/sticker/…). Settings "By event type" section enumerates detected categories (counts) with a -5..+5 priority slider + Hide toggle each. Stored in synced weights `eventTypeAdjust`. Hiding is by latest event (room reappears when a real message lands); pinned rooms always stay. (`eventCategory`/`EVENT_CATEGORY_LABELS`/`getDetectedEventCategories` in matrix.ts)
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
- **Remaining follow-ups** (smaller, optional): per-bundle read zero-unread edge (documented tradeoff), account-level widgets, SDK auto-enable sliding sync, and the pending SPACES diagnosis (awaiting user `wmSpaces()` output — highest value).
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
