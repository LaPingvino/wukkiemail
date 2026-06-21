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
const POKE_DEBOUNCE_MS = 150;

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

class SyncWakeHeartbeat {
  private stopped = false;

  private abort?: AbortController;

  private pokeTimer?: ReturnType<typeof setTimeout>;

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
    if (this.pokeTimer) clearTimeout(this.pokeTimer);
  }

  private pokeSliding(): void {
    if (this.pokeTimer) return; // debounce a burst of activity into one poke
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = undefined;
      getSlidingSync(this.mx)?.poke?.();
    }, POKE_DEBOUNCE_MS);
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
        const resp = await this.mx.http.authedRequest<{ next_batch: string }>(
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
        // The bootstrap request returns immediately with no activity signal; only
        // poke on the long-poll returns (which mean "something changed").
        if (!bootstrap && !this.stopped) this.pokeSliding();
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
