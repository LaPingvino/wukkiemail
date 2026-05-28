# WukkieMail

A unified inbox that brings back the *spirit of Google Inbox* — bundles, snooze, "done", reminders — and lets it eat Matrix too. Connect Gmail, a Matrix account, or both; features adapt to what you've added.

Working title: **WukkieMail**. Suggestions welcome.

## Why

Inbox-by-Google was killed in 2019. Email is still the universal sink (bills, shipping, newsletters, password resets) but a lot of conversational traffic has moved to chat. With Matrix and the mautrix bridge family, WhatsApp / IRC / Signal / Meta conversations show up as Matrix rooms — so a chat-aware inbox is suddenly possible without giving up email.

## Architecture

| Layer | Tech | Notes |
|-------|------|-------|
| UI | React + Vite + TypeScript | SPA, deployed as static assets |
| Hosting | Cloudflare Pages | Same shape as `devotional-pwa` |
| Server-side glue | Cloudflare Pages Functions | Only what the browser *can't* do — Gmail OAuth token exchange (client secret), refresh |
| Sources | adapter interface in `src/sources/` | `GmailSource`, `MatrixSource`. Both optional. UI features turn on/off based on what's connected. |
| Matrix | `matrix-js-sdk` (LaPingvino fork, `wally-dist` branch) | Same SDK Wally uses, so fixes flow both ways. `wally-dist` is a build-artifact branch with `lib/` committed so consumers don't need yarn at install time (Wally builds from `wally/vX.Y.Z`; WukkieMail and any other consumer pulls `wally-dist`). |
| Bridges | client-side detection of `mautrix-*` users / rooms | WhatsApp / IRC / Signal / Meta surface with native-looking avatars + provenance tags |
| Issues | `eu.kiefte.issues` state events | Same primitives as the cinny widget — inbox shows issue activity as first-class items |
| Storage | IndexedDB | Local cache for offline; nothing about your accounts touches Cloudflare except the OAuth code↔token swap |

### Why a Cloudflare Pages Function (and not pure-static)

Gmail OAuth needs a `client_secret` for the code → token exchange. Browsers can't hold secrets, and PKCE alone doesn't fully replace `client_secret` for installed-app flows (Google still requires it for "Web" client types, which is what we need for hosted JS). One small function: `/api/gmail/oauth/callback`. That's it. The access/refresh tokens are stored client-side (IndexedDB) — the function is stateless.

Matrix has no equivalent need: SSO/password login goes browser ↔ homeserver directly.

## Adaptive features

| Connected | What you get |
|---|---|
| Gmail only | Inbox / bundles / snooze / done over IMAP-style threading |
| Matrix only | Rooms-as-conversations, bridges as bundles, issues as items |
| Both | One stream, single-keypress triage across email & chat |

Bundles map naturally:
- Gmail labels → bundles
- Matrix spaces → bundles
- Bridged networks (mautrix-whatsapp, mautrix-irc, mautrix-meta, mautrix-signal) → auto-bundles per network
- `eu.kiefte.issues` rooms → "Issues" bundle, with per-room sub-bundles

## eu.kiefte.issues primitives

Mirrored from the cinny issue board widget (`cinny-wally/src/app/widget/IssueBoardWidget.tsx`):

- `eu.kiefte.issues.schema` — state event, defines field set (text / enum / user / date / follow)
- `eu.kiefte.issue` — state event keyed by issue id, holds the issue content
- Timeline events with `eu.kiefte.issue_id` in their content are issue comments

WukkieMail reads these read-only first (notifications + triage), with create/edit landing later.

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in Google OAuth client id + secret
npm run dev                       # vite dev server
```

For local Pages Functions: `npx wrangler pages dev -- npm run dev` (or use Vite dev for UI work and the deployed Pages Function for OAuth).

## Deploy your own

WukkieMail is designed so each user/org runs their own copy. Gmail integration uses your own Google OAuth client, so you're not stuck behind anyone else's verification status. About 10 minutes the first time.

### 1. Fork & connect Cloudflare Pages

1. Fork this repo to your GitHub.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick your fork.
3. Build settings: framework "None", build command `npm run build`, output dir `dist`. CF auto-detects bun.

### 2. Visit the deployed site and follow the in-app setup wizard

Once it's live (you'll get a `*.pages.dev` URL), open it and click **"Set up Gmail integration…"** on the connect screen — or go straight to `/setup`. The wizard shows the exact redirect URI to paste into Google Cloud Console (specific to your deployment's origin) and the four env vars to set on Pages. Copy buttons next to each value.

You can also do it from the docs below if you prefer not to deploy first.

### Manual variant of step 2

In Google Cloud Console:
- Enable the Gmail API.
- Configure the OAuth consent screen (External; add yourself + intended users as Test Users).
- Create an **OAuth client ID** of type **Web application**.
- Add authorized redirect URI: `https://<your-domain>/api/gmail/oauth/callback`.

In Cloudflare Pages → Settings → Environment variables (Production + Preview):

| Variable | Notes |
|---|---|
| `VITE_GOOGLE_CLIENT_ID` | Plain text — baked into the JS bundle. Vite only inlines `VITE_*` vars. |
| `GOOGLE_CLIENT_ID` | Same value, used server-side by the Pages Function. |
| `GOOGLE_CLIENT_SECRET` | **Mark as Secret.** |
| `GOOGLE_OAUTH_REDIRECT_URI` | Must match what you pasted into Google exactly. |

Then redeploy (env vars don't apply to existing builds — push a commit or hit Retry on the latest deployment).

### Scope note

We only request `gmail.metadata` (headers, labels, threading — no message bodies). That keeps OAuth verification at the cheap tier (no Cloud Application Security Assessment). Clicking a thread opens `mail.google.com` so the body shows up there.

## Status

Bootstrapping. Scaffolding only — no working sign-in yet. Tracked work lives in beads (`bd list -t wukkiemail`).
