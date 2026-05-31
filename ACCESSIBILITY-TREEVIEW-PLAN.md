# WukkieMail Uniform ARIA Treeview — Implementation Plan

Goal (from a blind screenreader user): spaces, rooms, threads, and messages are all
collapsible/expandable levels of ONE ARIA tree, the smallest unit being a message you can
interact with. Keep the current look — this is a structural/semantic change (ARIA roles +
roving-tabindex keyboard model + lazy expansion), not a visual redesign. The triage brain
(the `bundled` memo) and all visuals stay untouched.

> Note: `src/sources/matrix.ts` has non-ASCII bytes — use `grep -a` (Read/Edit tools are fine).

## What exists today
The inbox (`src/App.tsx`) is already a de-facto two-level tree without ARIA semantics:
- Top level: loose items + bundle rows, built by the `bundled` memo (`App.tsx:938-1104`).
  Bundles nest (spaces in spaces) via `BundleNode.children`. Rendered by `renderBundleNode`
  (`App.tsx:1416-1516`) and `renderItem` (`App.tsx:1156-1282`).
- Expand/collapse exists per bundle: `expandedBundles: Set<string>` (`App.tsx:364`), toggled
  in `renderBundleNode` (`App.tsx:1418-1431`), lazy space-room load via
  `matrixSrc.syncSpaceRooms(...)` (`App.tsx:1428` → `matrix.ts:1508`).
- Keyboard is a FLAT cursor: window `onKeyDown` (`App.tsx:820-910`) drives `cursor` (a number)
  over `.item[data-idx]` leaf rows only (bundle rows are NOT in the cursor).
- Partial a11y already done: `bundle-head` has `aria-expanded`; icon spans `aria-hidden`;
  kebab/sweep buttons have `aria-label`.
- Rooms/threads/messages live in `RoomPanel.tsx`. Thread roots carry `threadSummary`
  (`matrix.ts:2959`); `getRoomTimeline(roomId, limit, threadRootId?)` (`matrix.ts:2609`)
  returns main timeline (thread replies filtered, `:2702`) or one thread's messages (`:2700`).
  `TimelineMessage` shape at `matrix.ts:2946`; `subscribeRoom` at `matrix.ts:306`.

The data for all four levels already exists; the work is structural/semantic.

## 1. Uniform node model
A `TreeNode` view-model the renderer walks — a PROJECTION over the existing `bundled` tree +
lazily-loaded room/thread/message data, not a new source of truth.

```ts
type TreeKind = 'bundle' | 'space' | 'room' | 'thread' | 'message';
interface TreeNode {
  id: string; kind: TreeKind; label: string; level: number;       // 1-based ARIA level
  parentId: string | null; expandable: boolean; childrenLoaded: boolean;
  bundleNode?: BundleNode; item?: InboxItem; roomId?: string;
  threadRootId?: string; message?: TimelineMessage;
}
```
Mapping: bundle/space ← `BundleNode`; room ← `InboxItem` (expandable iff
`itemRoomId(it.id)!=null` — issues/mail leaves are NOT); thread ← `TimelineMessage` with
`threadSummary`; message ← `TimelineMessage` (leaf).

Lazy children on expand: bundle/space → rooms (already in `BundleNode.items`/`.children`;
spaces also call `syncSpaceRooms`); room → `getRoomTimeline(roomId, 30)` + `subscribeRoom`,
split into thread nodes (have `threadSummary`) then message nodes (cap ~30 + "load older");
thread → `getRoomTimeline(roomId, 50, rootId)`.

**Performance (must-do):** only emit `TreeNode`s for EXPANDED branches. Build a flat
`visibleNodes: TreeNode[]` in render order by descending only into expanded nodes
(`expandedBundles` + new `expandedRooms`/`expandedThreads`). Fully-collapsed inbox = today's
cost. Virtualize later if deep expansion grows large.

## 2. ARIA contract (WAI-ARIA APG Tree View)
- Container (`.item-list`, `App.tsx:1609`): `role="tree"`, `aria-label="Inbox"`,
  `aria-multiselectable="false"`, single tab stop.
- Each node (the `.item` anchor / the `.bundle-head` button): `role="treeitem"`,
  `aria-level` (1-based), `aria-setsize`/`aria-posinset` (REQUIRED — children load
  dynamically), `aria-expanded` on expandables only (omit on leaves), `aria-selected` on the
  roving-focus node, `tabIndex={isCursor?0:-1}`.
- Child containers (`.bundle-body` + new room/thread containers): `role="group"`.
- Layer roles onto existing DOM; do NOT restructure. Count text (`bundle-count`) stays inside
  the treeitem so it's part of the accessible name.

## 3. Keyboard model (roving tabindex, single numeric cursor over `visibleNodes`)
Adapt the existing window `onKeyDown` (`App.tsx:820-910`). KEEP: shadow-DOM focus guard
(`:825-836`), `?`/`/`/`Escape` (`:838-855`), triage e/u/s/p (`:896-906`) — retarget them to
`visibleNodes[cursor]`. REPLACE: the j/k/↑/↓ block (`:867-876`) + DOM-scraping `cursoredItem`
(`:861-866`).
Bindings: ↑/k prev, ↓/j next; → expand-or-firstchild; ← collapse-or-parent (via `parentId`);
Enter/Space activate (bundle→toggle, room→open RoomPanel, thread→open/expand, message→open
room at event); Home/End first/last; typeahead (label-prefix, ~500ms debounce); optional `*`
expand-siblings. Move DOM focus on cursor change (replace the `scrollIntoView` effect
`:912-915`). Early-return arrow keys while a panel/modal is open (extend the Escape cascade).

## 4. Preserve triage + look
`visibleNodes` is built by walking `bundled.loose` then `bundled.groups` in the EXACT current
order (`App.tsx:1736-1751`); priority/unread sort stays in the `bundled` memo. `renderItem`/
`renderBundleNode` keep producing the same DOM (avatars/badges/counts/chips) — only ARIA +
tabindex added, no CSS change. Filter chips/bundle actions stay as controls within the group
(not treeitems). Loose important items = level-1 `room` treeitems with no bundle parent.

## 5. Incremental roadmap (each shippable; `npx tsc --noEmit && npx vite build`)
- **Step 1 — tree roles + roving tabindex on the EXISTING two levels (no visual change).**
  Add `role="tree"` to `.item-list`; `role="treeitem"`+level+selected+roving-tabindex to
  `renderItem`/`renderBundleNode`; `role="group"` to `.bundle-body`; build `visibleNodes`
  alongside the render walk; retarget `onKeyDown` to it (+ →/←/Home/End/activate). Accept: Tab
  lands once; ↑/↓ walk all bundles+rooms announcing "treeitem, level N, X of Y,
  collapsed/expanded"; → expands, Enter opens. Visuals unchanged.
- **Step 2 — correct depth + setsize/posinset + nested spaces.** `aria-level` from true
  nesting (`BundleNode.children`/`depth`); compute setsize/posinset in the walk.
- **Step 3 — rooms expand to threads + recent messages.** `expandedRooms`,
  `roomSnaps: Map<roomId, RoomTimelineSnapshot>`; on expand `subscribeRoom` +
  `getRoomTimeline(roomId, 30)`; emit thread then message nodes (cap + "load older"); new
  compact `renderTreeMessage` leaf.
- **Step 4 — threads expand to their messages.** `expandedThreads`;
  `getRoomTimeline(roomId, 50, rootId)`; emit message children. Full spaces→rooms→threads→
  messages is one continuous ↑/↓ walk; Enter on a message = smallest interactive unit.
- **Step 5 — typeahead, `*`, aria-live for async child loads** ("Loading messages…" announced
  when a lazy timeline lands; reuse the announcer at `App.tsx:1846-1851`).

## Key file:line targets
Container `App.tsx:1609`; leaf `renderItem` `:1156`; bundle `renderBundleNode` `:1416-1516`
(lazy space `:1428`→`matrix.ts:1508`); tree-build walk `:1610-1772`; keyboard `:820-915`
(+ cursor effect `:912-915`); `bundled` memo (leave intact) `:938-1104`; data
`getRoomTimeline` `matrix.ts:2609` / thread mode `:2700-2704` / `subscribeRoom` `:306` /
`TimelineMessage`+`threadSummary` `:2946-2959` / `RoomTimelineSnapshot` `:2933`; leaf DOM to
mirror `RoomPanel.tsx:495-540`; `InboxItem` shape `src/sources/types.ts:17`.
