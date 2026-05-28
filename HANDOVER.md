# Handover

Quick brief for any agent picking this up mid-stream.

## What it is

WukkieMail — Inbox-style triage on top of Matrix. Live at `wukkiemail.pages.dev` (CF Pages). Repo: `LaPingvino/wukkiemail`. Pushes auto-deploy. User: Joop (`@LaPingvino` on GitHub, mxid varies).

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

## What's queued

- **Inline filter chips under section headers**: replace top status chip bar with toggle-style multi-select chips inline with the Tasks / Messages headers (always visible)
- **Per-event-type priority + visibility tuning**: enumerate detected event types, surface in settings, let user dial each
- **SAS emoji verification**: device-to-device verification flow (matrix-js-sdk `requestDeviceVerification`)
- **Per-room done-values editor**: small UI to override which kanban values count as done per room (data layer already there: `triage.doneValuesByRoom`)
- **Mobile sync trace**: user said they'd paste console output if Matrix sync still misbehaves on their phone
- **Search secondary index**: full-text Web Worker + IndexedDB index for message bodies
- **@-mention autocomplete**: dropdown in composer for room members
- **Wally voice/video room creation**: extend FAB menu, mirror what Wally does

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
