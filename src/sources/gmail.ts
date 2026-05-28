// GmailSource — turns the Gmail REST client into InboxItems.
// Metadata scope only, so subjects and headers are real but bodies
// aren't fetched. Clicking an item opens mail.google.com to the thread.

import { loadCreds, gmailThreadUrl, type GmailCreds } from '../auth/gmail';
import { GmailClient } from './gmailClient';
import type { BundleSpec, InboxItem, Source } from './types';

export class GmailSource implements Source {
  readonly kind = 'gmail' as const;
  id = 'gmail:pending';
  private client: GmailClient;
  private email: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private status: 'idle' | 'syncing' | 'error' = 'idle';

  constructor(creds: GmailCreds) {
    this.client = new GmailClient(creds);
  }

  static tryRestore(): GmailSource | null {
    const creds = loadCreds();
    return creds ? new GmailSource(creds) : null;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  private notify() { for (const cb of this.listeners) cb(); }
  getStatus(): 'idle' | 'syncing' | 'error' { return this.status; }

  async start(): Promise<void> {
    const info = await this.client.userinfo();
    this.email = info.email;
    this.id = `gmail:${info.email}`;
    // Auto-refresh inbox every 60s. Gmail metadata scope doesn't get push
    // notifications, so polling is the simplest path. Pause when the tab
    // is hidden so we don't waste tokens on background tabs.
    // Just notify; the App's listItems() call sets status via listItems().
    this.pollTimer = setInterval(() => {
      if (document.hidden) return;
      this.notify();
    }, 60_000);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async listBundles(): Promise<BundleSpec[]> {
    return [{ id: 'gmail:inbox', label: 'Gmail', count: 0, flavor: 'gmail' }];
  }

  async listItems(_bundleId: string | null): Promise<InboxItem[]> {
    this.status = 'syncing';
    this.notify();
    let threads;
    try {
      threads = await this.client.listInboxThreads(30);
      this.status = 'idle';
    } catch (e) {
      this.status = 'error';
      this.notify();
      throw e;
    }
    this.notify();
    const email = this.email ?? '';
    return threads.map((t) => ({
      id: `gmail:${t.id}`,
      flavor: 'gmail' as const,
      bundleId: null,
      from: stripAddress(t.from),
      fromAddress: extractAddress(t.from),
      subject: t.subject,
      snippet: t.snippet,
      ts: t.ts,
      unread: t.labelIds.includes('UNREAD'),
      threadCount: t.messageCount,
      openPath: gmailThreadUrl(t.id, email),
    }));
  }
}

// "Jane Doe <jane@example.com>" → "Jane Doe"; bare addresses unchanged.
function stripAddress(from: string): string {
  const m = from.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  return (m?.[1] ?? from).trim();
}

function extractAddress(from: string): string {
  const m = from.match(/<([^>]+)>$/);
  return m?.[1] ?? from.trim();
}
