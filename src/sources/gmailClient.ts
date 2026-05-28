// Minimal authenticated fetch wrapper for the Gmail REST API.
// - Auto-refreshes the access token via /api/gmail/refresh on 401 (or
//   when we know the token has expired).
// - Persists the new access token back to localStorage so the next
//   page load picks up the longer-lived state.

import { loadCreds, saveCreds, type GmailCreds } from '../auth/gmail';

export interface GmailUserInfo {
  email: string;
  name?: string;
  picture?: string;
}

export class GmailClient {
  private creds: GmailCreds;

  constructor(creds: GmailCreds) {
    this.creds = creds;
  }

  private async ensureFreshToken(): Promise<void> {
    // Refresh a minute before actual expiry to absorb clock skew.
    if (this.creds.expiresAt - 60_000 > Date.now()) return;
    const res = await fetch('/api/gmail/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.creds.refreshToken }),
    });
    if (!res.ok) {
      throw new Error(`Gmail refresh failed: ${res.status} ${await res.text()}`);
    }
    const tok = (await res.json()) as { access_token: string; expires_in: number; scope?: string };
    this.creds = {
      ...this.creds,
      accessToken: tok.access_token,
      expiresAt: Date.now() + tok.expires_in * 1000,
      scope: tok.scope ?? this.creds.scope,
    };
    saveCreds(this.creds);
  }

  private async authedFetch(path: string, init?: RequestInit): Promise<Response> {
    await this.ensureFreshToken();
    const doFetch = () =>
      fetch(`https://gmail.googleapis.com${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          authorization: `Bearer ${this.creds.accessToken}`,
        },
      });
    let res = await doFetch();
    if (res.status === 401) {
      // Force a refresh and retry once.
      this.creds = { ...this.creds, expiresAt: 0 };
      await this.ensureFreshToken();
      res = await doFetch();
    }
    return res;
  }

  async userinfo(): Promise<GmailUserInfo> {
    await this.ensureFreshToken();
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${this.creds.accessToken}` },
    });
    if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
    return (await res.json()) as GmailUserInfo;
  }

  // List recent threads in INBOX, returning their metadata in a single
  // batched-via-Promise.all step. Gmail doesn't offer a single endpoint
  // that returns headers for many threads — we issue one threads.get per
  // listed id, in parallel. Cap at 30 to keep cost down.
  async listInboxThreads(max = 30): Promise<GmailThreadMeta[]> {
    const listRes = await this.authedFetch(
      `/gmail/v1/users/me/threads?labelIds=INBOX&maxResults=${max}`,
    );
    if (!listRes.ok) throw new Error(`threads.list failed: ${listRes.status}`);
    const list = (await listRes.json()) as { threads?: { id: string }[] };
    const ids = list.threads?.map((t) => t.id) ?? [];
    const details = await Promise.all(ids.map((id) => this.threadMeta(id)));
    return details.filter((d): d is GmailThreadMeta => d !== null);
  }

  private async threadMeta(id: string): Promise<GmailThreadMeta | null> {
    const res = await this.authedFetch(
      `/gmail/v1/users/me/threads/${id}?format=METADATA` +
        `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as RawThread;
    const first = body.messages?.[0];
    const last = body.messages?.[body.messages.length - 1] ?? first;
    if (!last) return null;
    return {
      id: body.id,
      from: header(last, 'From') ?? '(unknown)',
      subject: header(first ?? last, 'Subject') ?? '(no subject)',
      snippet: body.messages?.[0]?.snippet ?? last.snippet ?? '',
      ts: Number(last.internalDate) || Date.now(),
      messageCount: body.messages?.length ?? 1,
      labelIds: last.labelIds ?? [],
    };
  }
}

export interface GmailThreadMeta {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  ts: number;
  messageCount: number;
  labelIds: string[];
}

interface RawMessage {
  id: string;
  internalDate?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: { headers?: { name: string; value: string }[] };
}
interface RawThread {
  id: string;
  messages?: RawMessage[];
}

function header(msg: RawMessage, name: string): string | undefined {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

export function makeClientFromStorage(): GmailClient | null {
  const c = loadCreds();
  return c ? new GmailClient(c) : null;
}
