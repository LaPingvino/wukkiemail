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
  - TRANSITIONAL: per-bundle chips still tune GLOBAL state (readFilter/status/mine); readFilter still global in `visible`.
  - NOT yet built: (e) search redesign on the filter engine + the search-index worker — reuse BundleSheet's composer. Pending UX ask: search is "extremely broken".

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
- Encryption banner needs `getSecretStorageKey` cryptoCallback wired in createClient (fixed)
- CF Pages 3.x wrangler needs `run_worker_first: true` (not array form)
- Material `<md-icon-button>` click events don't always bubble to React onClick — use plain `<button>` for those
- vite build: `dist/sw.js` lives in `public/` so it ships verbatim
- Sandbox blocks `/home/joop/.npm/_cacache` — npm install needs `--cache /tmp/claude/npm-cache`
