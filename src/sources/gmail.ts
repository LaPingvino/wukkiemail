// GmailSource — stub. Auth lands tokens in localStorage; this adapter
// will consume them once the Gmail REST client is wired. For now it
// exposes the contract so the inbox UI can co-render Gmail items
// once they exist.

import { loadCreds, type GmailCreds } from '../auth/gmail';
import type { BundleSpec, InboxItem, Source } from './types';

export class GmailSource implements Source {
  readonly kind = 'gmail' as const;
  readonly id: string;
  private creds: GmailCreds;

  constructor(creds: GmailCreds) {
    this.creds = creds;
    // The id should be the user's email — we'll pull it from a /userinfo
    // call once the client is wired. Placeholder for now.
    this.id = 'gmail:pending';
  }

  static tryRestore(): GmailSource | null {
    const creds = loadCreds();
    return creds ? new GmailSource(creds) : null;
  }

  async start(): Promise<void> {
    // No-op until we wire the Gmail REST client. The token sits in
    // this.creds; we'll refresh it lazily on first call.
  }

  async stop(): Promise<void> {
    // No-op.
  }

  async listBundles(): Promise<BundleSpec[]> {
    return [
      { id: 'gmail:inbox', label: 'Gmail · Inbox', count: 0, flavor: 'gmail' },
    ];
  }

  async listItems(_bundleId: string | null): Promise<InboxItem[]> {
    // Returning empty until the Gmail messages.list call is implemented.
    void this.creds;
    return [];
  }
}
