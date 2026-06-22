import { ClientPrefix, MatrixClient, Method } from 'matrix-js-sdk';

/**
 * Sliding-sync wake heartbeat.
 *
 * Continuwuity's sliding-sync long-poll does NOT wake on new data — it holds the
 * connection for the full `timeout` (~3s) and only then returns, so every live
 * update (a new message, the room jumping to the top of the inbox, an unread
 * badge, a read tick) is bounded by that interval: things appear up to ~3s late.
 *
 * Classic `/sync`, by contrast, DOES wake-and-return promptly on activity on every
 * server. So we run an UNCONSUMED classic `/sync` long-poll purely as an activity
 * signal: the instant it returns (i.e. something happened), we `poke()` the sliding
 * connection to re-poll immediately instead of waiting out its slow timeout. Net:
 * updates land near-instantly while keeping sliding sync as the real transport.
 *
 * This is a deliberately simpler version of Wally's `slidingSyncHealth.ts`: Wally
 * probes the server and only runs the heartbeat when the sliding poll is measured
 * "degraded" (to avoid the extra connection on servers that DO wake on data).
 * WukkieMail targets Continuwuity, which is always the slow case, so we skip the
 * probe (it would always say "degraded") — and skipping it avoids a self-to-device
 * round-trip during WukkieMail's crypto bootstrap. Known tradeoff: against a
 * hypothetical wake-on-data server this runs one redundant (cheap, idle) long-poll.
 */

const HEARTBEAT_TIMEOUT_MS = 30000;
// Leading-edge: the first poke after idle fires IMMEDIATELY (no added latency).
// Further activity within the cooldown coalesces into a single trailing poke, so a
// burst doesn't issue one sliding request per event.
const POKE_COOLDOWN_MS = 150;

// First request returns immediately (timeout 0) just to obtain a `since` token.
const BOOTSTRAP_FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: { rooms: [] },
});
// Subsequent long-polls: minimal payload — we only care THAT it returned, not what
// it contains (the sliding connection fetches the actual data once poked).
const WAKE_FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    timeline: { limit: 1 },
    state: { types: [] },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
});

type SlidingSyncLike = { poke?: () => void };
const getSlidingSync = (mx: MatrixClient): SlidingSyncLike | undefined =>
  (mx as unknown as { getSlidingSync?: () => SlidingSyncLike | undefined }).getSlidingSync?.();

interface SyncWakeResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: unknown[] } }>;
    invite?: Record<string, unknown>;
    leave?: Record<string, unknown>;
  };
}

// Did this /sync return actually carry a ROOM change worth re-polling the sliding
// connection for — a new timeline event in a joined room, or any invite/leave? A
// to-device-only wake (key shares during a crypto handshake) does NOT need the room
// connection re-polled (the dedicated encryption sync owns to-device), so we skip
// those. Server-agnostic: every homeserver's /sync names the changed rooms here.
const hasRoomChange = (resp: SyncWakeResponse): boolean => {
  const r = resp.rooms;
  if (!r) return false;
  if (r.invite && Object.keys(r.invite).length > 0) return true;
  if (r.leave && Object.keys(r.leave).length > 0) return true;
  if (r.join && Object.values(r.join).some((j) => (j.timeline?.events?.length ?? 0) > 0)) return true;
  return false;
};

class SyncWakeHeartbeat {
  private stopped = false;

  private abort?: AbortController;

  private pokeCooldown?: ReturnType<typeof setTimeout>;

  private pokeQueued = false;

  private readonly mx: MatrixClient;

  public constructor(mx: MatrixClient) {
    this.mx = mx;
  }

  public start(): void {
    this.loop().catch(() => undefined);
  }

  public stop(): void {
    this.stopped = true;
    this.abort?.abort();
    if (this.pokeCooldown) clearTimeout(this.pokeCooldown);
  }

  private pokeSliding(): void {
    if (this.pokeCooldown) {
      this.pokeQueued = true; // activity during cooldown → one trailing poke when it ends
      return;
    }
    getSlidingSync(this.mx)?.poke?.(); // leading edge: poke NOW, no added latency
    this.pokeCooldown = setTimeout(() => {
      this.pokeCooldown = undefined;
      if (this.pokeQueued) {
        this.pokeQueued = false;
        this.pokeSliding();
      }
    }, POKE_COOLDOWN_MS);
  }

  private async loop(): Promise<void> {
    let since: string | undefined;
    while (!this.stopped) {
      this.abort = new AbortController();
      const bootstrap = since === undefined;
      const query: Record<string, string> = {
        timeout: String(bootstrap ? 0 : HEARTBEAT_TIMEOUT_MS),
        filter: bootstrap ? BOOTSTRAP_FILTER : WAKE_FILTER,
      };
      if (since) query.since = since;
      try {
        // eslint-disable-next-line no-await-in-loop
        const resp = await this.mx.http.authedRequest<SyncWakeResponse>(
          Method.Get,
          '/sync',
          query,
          undefined,
          {
            prefix: ClientPrefix.V3,
            localTimeoutMs: HEARTBEAT_TIMEOUT_MS + 10000,
            abortSignal: this.abort.signal,
          }
        );
        since = resp.next_batch;
        // The bootstrap request returns immediately with no activity signal. After
        // that, only poke when the wake actually carries a room change — skip
        // to-device-only wakes (key shares) that don't need the room connection.
        if (!bootstrap && !this.stopped && hasRoomChange(resp)) this.pokeSliding();
      } catch {
        if (this.stopped) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, 2000);
        });
      }
    }
  }
}

/**
 * Start the wake heartbeat for a started client. No-op (and returns a no-op stop)
 * when sliding sync isn't active — classic `/sync` IS the sync, so there's nothing
 * to poke. Returns a stop function to call from the client's stop().
 */
export const startSyncWakeHeartbeat = (mx: MatrixClient): (() => void) => {
  if (!getSlidingSync(mx)) return () => undefined;
  const heartbeat = new SyncWakeHeartbeat(mx);
  heartbeat.start();
  return () => heartbeat.stop();
};
