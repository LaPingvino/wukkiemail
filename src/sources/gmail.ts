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

  constructor(creds: GmailCreds) {
    this.client = new GmailClient(creds);
  }

  static tryRestore(): GmailSource | null {
    const creds = loadCreds();
    return creds ? new GmailSource(creds) : null;
  }

  async start(): Promise<void> {
    // Resolve the account email so we can build deep links into Gmail.
    // Failure here means the credentials are stale — let the caller
    // surface an error and trigger a re-login.
    const info = await this.client.userinfo();
    this.email = info.email;
    this.id = `gmail:${info.email}`;
  }

  async stop(): Promise<void> {
    // Nothing to dispose — the client is a stateless wrapper.
  }

  async listBundles(): Promise<BundleSpec[]> {
    return [{ id: 'gmail:inbox', label: 'Gmail', count: 0, flavor: 'gmail' }];
  }

  async listItems(_bundleId: string | null): Promise<InboxItem[]> {
    const threads = await this.client.listInboxThreads(30);
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
