// Source adapter contract. Both Gmail and Matrix implement this.
// The inbox UI is source-agnostic — it consumes InboxItem and BundleSpec.

export type SourceKind = 'gmail' | 'matrix';

// For Matrix items we further tag provenance — bridged conversations get a sub-kind
// so the UI can render them naturally (WhatsApp green, IRC mono, etc).
export type ItemFlavor =
  | 'gmail'
  | 'matrix'
  | 'whatsapp'   // mautrix-whatsapp
  | 'meta'       // mautrix-meta (Messenger / Instagram)
  | 'signal'     // mautrix-signal
  | 'irc'        // mautrix-irc / heisenbridge
  | 'issue';     // eu.kiefte.issue activity

export interface InboxItem {
  id: string;            // stable across sessions; "<source>:<native-id>"
  flavor: ItemFlavor;
  bundles: string[];     // bundle keys this item belongs to (e.g. "flavor:matrix",
                         // "dm", "space:<roomId>", "issue"). 'all' is implicit.
  from: string;          // display name of the most recent contributor
  fromAddress?: string;  // mxid or email
  subject: string;       // for email = Subject; for chat = thread topic or last line
  snippet: string;
  ts: number;            // ms epoch of most recent activity
  unread: boolean;
  threadCount: number;
  priority: number;      // higher = more important; sorted desc with ts as tie-break
  snoozedUntil?: number; // ms epoch when this item wakes from snooze
  senderPresence?: 'online' | 'unavailable' | 'offline';
  avatarUrl?: string; // resolved HTTPS thumbnail; falls back to initials when absent
  statusValue?: string; // for issue items: their kanban_group status value
  userValues?: string[]; // for issue items: values of all schema user-typed fields (e.g. assignee), for the "assigned to me" filter
  eventCategory?: string; // coarse category of the room's latest event (message/image/membership/…), for per-type tuning
  // route the UI uses to open the thing:
  openPath: string;      // e.g. /m/!roomid/$eventid or /g/<gmail-thread-id>
}

export type BundleKind = 'all' | 'flavor' | 'dm' | 'space';

export interface BundleSpec {
  id: string;            // e.g. 'all' | 'flavor:matrix' | 'dm' | 'space:<id>'
  label: string;
  count: number;         // unread count
  flavor: ItemFlavor;    // representative flavor — drives the dot color
  kind: BundleKind;
}

// Lifecycle: callers create a source once it's connected; the source streams items.
export interface Source {
  readonly kind: SourceKind;
  readonly id: string;          // stable per account (mxid for matrix, email for gmail)
  start(): Promise<void>;       // start sync
  stop(): Promise<void>;
  // simple snapshot APIs for the v0 UI; later: subscribe(callback)
  listBundles(): Promise<BundleSpec[]>;
  listItems(bundleId: string | null): Promise<InboxItem[]>;
}

export interface SourceFactory {
  kind: SourceKind;
  tryRestore(): Promise<Source | null>;   // reconnect from persisted creds
}
