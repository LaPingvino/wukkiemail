// JmapSource — a JMAP (RFC 8620/8621) email backend behind the same
// Source contract the Matrix side uses. Its job here is twofold:
//   1. Keep the InboxItem / Source model honest — email must fit the same
//      shape as chat (sender, subject, snippet, ts, unread, bundles), so
//      the inbox stays source-agnostic rather than ossifying around Matrix.
//   2. Be the real read path once wired into the app's account UI.
//
// Auth is a bearer token + a JMAP session URL (the universal JMAP scheme;
// Fastmail and other providers issue API tokens this way). No OAuth dance
// required — the user pastes a token + session URL, same spirit as the
// Matrix mxid+password flow. Provider-agnostic via session discovery.
//
// NOT YET wired into App login/account storage — that's the follow-up
// (multiplex MatrixSource + JmapSource behind one inbox). This module is
// self-contained and type-checked so the contract is proven to fit.

import type { BundleSpec, InboxItem, ItemFlavor, Source } from './types';

export interface JmapCreds {
  sessionUrl: string; // e.g. https://api.fastmail.com/jmap/session
  bearerToken: string;
  email?: string;     // for display / the source id
}

const MAIL_CAP = 'urn:ietf:params:jmap:mail';
const CORE_CAP = 'urn:ietf:params:jmap:core';
const SUBMISSION_CAP = 'urn:ietf:params:jmap:submission';

interface JmapSession {
  apiUrl: string;
  accountId: string;
  username?: string;
}

interface JmapEmailAddress { name?: string; email: string }
interface JmapEmail {
  id: string;
  subject?: string;
  preview?: string;
  receivedAt?: string;
  from?: JmapEmailAddress[];
  keywords?: Record<string, boolean>;
  mailboxIds?: Record<string, boolean>;
}
export interface JmapEmailFull {
  id: string;
  subject: string;
  from: JmapEmailAddress[];
  to: JmapEmailAddress[];
  receivedAt?: string;
  html?: string;
  text?: string;
}

interface JmapMailbox {
  id: string;
  name: string;
  role?: string | null;
  totalEmails?: number;
  unreadEmails?: number;
}

const STORAGE_KEY = 'wukkiemail.jmap.creds.v1';

export function loadJmapCreds(): JmapCreds | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as JmapCreds) : null;
  } catch { return null; }
}

export function saveJmapCreds(c: JmapCreds): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
}

export function clearJmapCreds(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export class JmapSource implements Source {
  readonly kind = 'gmail' as const; // reuse the "Mail" flavor/color lane
  readonly id: string;
  private creds: JmapCreds;
  private session: JmapSession | null = null;
  private mailboxes: JmapMailbox[] = [];
  private listeners = new Set<() => void>();

  constructor(creds: JmapCreds) {
    this.creds = creds;
    this.id = creds.email ?? creds.sessionUrl;
  }

  static tryRestore(): JmapSource | null {
    const creds = loadJmapCreds();
    return creds ? new JmapSource(creds) : null;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  private notify() { for (const cb of this.listeners) cb(); }

  // Fetch the JMAP session resource → api url + primary mail account id.
  private async ensureSession(): Promise<JmapSession> {
    if (this.session) return this.session;
    const res = await fetch(this.creds.sessionUrl, {
      headers: { authorization: `Bearer ${this.creds.bearerToken}`, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`JMAP session ${res.status}`);
    const body = (await res.json()) as {
      apiUrl: string;
      primaryAccounts?: Record<string, string>;
      username?: string;
    };
    const accountId = body.primaryAccounts?.[MAIL_CAP];
    if (!accountId) throw new Error('JMAP account has no mail capability');
    this.session = { apiUrl: body.apiUrl, accountId, username: body.username };
    return this.session;
  }

  // One JMAP API request: array of [name, args, callId] method calls.
  private async request(methodCalls: unknown[][], using?: string[]): Promise<{ methodResponses: unknown[][] }> {
    const session = await this.ensureSession();
    const res = await fetch(session.apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.creds.bearerToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ using: using ?? [CORE_CAP, MAIL_CAP], methodCalls }),
    });
    if (!res.ok) throw new Error(`JMAP api ${res.status}`);
    return (await res.json()) as { methodResponses: unknown[][] };
  }

  // Send a new message (used for both fresh compose and replies). Builds a
  // draft, submits it via EmailSubmission, and on success files it in Sent.
  async sendEmail(params: { to: string[]; subject: string; text: string }): Promise<void> {
    const session = await this.ensureSession();
    if (this.mailboxes.length === 0) await this.refreshMailboxes();
    const using = [CORE_CAP, MAIL_CAP, SUBMISSION_CAP];
    const idResp = await this.request([['Identity/get', { accountId: session.accountId, ids: null }, '0']], using);
    const identities = (idResp.methodResponses[0]?.[1] as { list?: { id: string; email: string; name?: string }[] } | undefined)?.list ?? [];
    const identity = identities[0];
    if (!identity) throw new Error('no sending identity on this JMAP account');
    const drafts = this.mailboxes.find((m) => m.role === 'drafts');
    const sent = this.mailboxes.find((m) => m.role === 'sent');
    const draft = {
      from: [{ email: identity.email, name: identity.name }],
      to: params.to.map((email) => ({ email })),
      subject: params.subject,
      keywords: { $draft: true, $seen: true },
      mailboxIds: drafts ? { [drafts.id]: true } : {},
      bodyValues: { body: { value: params.text } },
      textBody: [{ partId: 'body', type: 'text/plain' }],
    };
    const resp = await this.request([
      ['Email/set', { accountId: session.accountId, create: { draft } }, '0'],
      ['EmailSubmission/set', {
        accountId: session.accountId,
        create: { sub: { emailId: '#draft', identityId: identity.id } },
        onSuccessUpdateEmail: sent ? { '#sub': { mailboxIds: { [sent.id]: true }, 'keywords/$draft': null } } : undefined,
      }, '1'],
    ], using);
    const emailSet = resp.methodResponses.find((r) => r[0] === 'Email/set')?.[1] as { notCreated?: Record<string, unknown> } | undefined;
    if (emailSet?.notCreated?.draft) throw new Error(`draft rejected: ${JSON.stringify(emailSet.notCreated.draft)}`);
    const subSet = resp.methodResponses.find((r) => r[0] === 'EmailSubmission/set')?.[1] as { notCreated?: Record<string, unknown> } | undefined;
    if (subSet?.notCreated?.sub) throw new Error(`send rejected: ${JSON.stringify(subSet.notCreated.sub)}`);
    this.notify();
  }

  async start(): Promise<void> {
    await this.ensureSession();
    await this.refreshMailboxes();
    this.notify();
  }

  async stop(): Promise<void> {
    this.session = null;
    this.mailboxes = [];
  }

  private async refreshMailboxes(): Promise<void> {
    const session = await this.ensureSession();
    const resp = await this.request([
      ['Mailbox/get', { accountId: session.accountId, ids: null }, '0'],
    ]);
    const args = resp.methodResponses[0]?.[1] as { list?: JmapMailbox[] } | undefined;
    this.mailboxes = args?.list ?? [];
  }

  // Fetch one email in full (headers + best body), for the viewer.
  async getEmail(id: string): Promise<JmapEmailFull | null> {
    const session = await this.ensureSession();
    const resp = await this.request([
      ['Email/get', {
        accountId: session.accountId,
        ids: [id],
        properties: ['id', 'subject', 'from', 'to', 'cc', 'receivedAt', 'bodyValues', 'textBody', 'htmlBody'],
        fetchHTMLBodyValues: true,
        fetchTextBodyValues: true,
        bodyProperties: ['partId', 'type'],
      }, '0'],
    ]);
    const args = resp.methodResponses.find((r) => r[0] === 'Email/get')?.[1] as
      { list?: (JmapEmail & { bodyValues?: Record<string, { value: string }>; textBody?: { partId?: string }[]; htmlBody?: { partId?: string }[]; to?: JmapEmailAddress[] })[] } | undefined;
    const e = args?.list?.[0];
    if (!e) return null;
    const bodyValues = e.bodyValues ?? {};
    const htmlPart = e.htmlBody?.find((p) => p.partId && bodyValues[p.partId]);
    const textPart = e.textBody?.find((p) => p.partId && bodyValues[p.partId]);
    return {
      id: e.id,
      subject: e.subject ?? '(no subject)',
      from: e.from ?? [],
      to: e.to ?? [],
      receivedAt: e.receivedAt,
      html: htmlPart?.partId ? bodyValues[htmlPart.partId]?.value : undefined,
      text: textPart?.partId ? bodyValues[textPart.partId]?.value : undefined,
    };
  }

  // Mark an email read ($seen) via Email/set.
  async markEmailSeen(id: string): Promise<void> {
    const session = await this.ensureSession();
    await this.request([
      ['Email/set', { accountId: session.accountId, update: { [id]: { 'keywords/$seen': true } } }, '0'],
    ]);
    this.notify();
  }

  async listBundles(): Promise<BundleSpec[]> {
    // One bundle per mailbox with unread, plus the implicit "all".
    return this.mailboxes
      .filter((m) => (m.totalEmails ?? 0) > 0)
      .map((m) => ({
        id: `mailbox:${m.id}`,
        label: m.name,
        count: m.unreadEmails ?? 0,
        flavor: 'gmail' as ItemFlavor,
        kind: 'flavor' as const,
      }));
  }

  async listItems(bundleId: string | null): Promise<InboxItem[]> {
    const session = await this.ensureSession();
    const mailboxId = bundleId?.startsWith('mailbox:') ? bundleId.slice('mailbox:'.length) : null;
    const filter = mailboxId ? { inMailbox: mailboxId } : undefined;
    const resp = await this.request([
      ['Email/query', {
        accountId: session.accountId,
        filter,
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: 100,
      }, '0'],
      ['Email/get', {
        accountId: session.accountId,
        '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
        properties: ['id', 'subject', 'preview', 'receivedAt', 'from', 'keywords', 'mailboxIds'],
      }, '1'],
    ]);
    const getArgs = resp.methodResponses.find((r) => r[0] === 'Email/get')?.[1] as { list?: JmapEmail[] } | undefined;
    const emails = getArgs?.list ?? [];
    return emails.map((e) => this.emailToItem(e));
  }

  private emailToItem(e: JmapEmail): InboxItem {
    const sender = e.from?.[0];
    const from = sender?.name || sender?.email || '(unknown sender)';
    const ts = e.receivedAt ? Date.parse(e.receivedAt) : 0;
    const unread = !(e.keywords?.['$seen'] === true);
    const flagged = e.keywords?.['$flagged'] === true;
    const bundles = ['flavor:gmail', ...Object.keys(e.mailboxIds ?? {}).map((id) => `mailbox:${id}`)];
    return {
      id: `jmap:${e.id}`,
      flavor: 'gmail',
      bundles,
      from,
      fromAddress: sender?.email,
      subject: e.subject || '(no subject)',
      snippet: e.preview ?? '',
      ts,
      unread,
      threadCount: 0,
      // Unread floats; flagged floats higher. Mirrors the Matrix weighting
      // spirit so email and chat interleave sanely in the All view.
      priority: (unread ? 1 : 0) + (flagged ? 3 : 0),
      accountId: this.id,
      originLabel: this.creds.email ?? 'Mail',
      openPath: `/mail/${encodeURIComponent(e.id)}`,
    };
  }
}
