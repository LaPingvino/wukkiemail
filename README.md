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
| Matrix | `matrix-js-sdk` (LaPingvino fork, `wally/v38.2.0`) | Same SDK Wally uses, so fixes flow both ways. Direct client login, homeserver-agnostic. |
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

## Deploy

Cloudflare Pages — point it at this repo, build command `npm run build`, output dir `dist`. Set Pages env vars:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET` (secret)
- `GOOGLE_OAUTH_REDIRECT_URI` — e.g. `https://wukkiemail.pages.dev/api/gmail/oauth/callback`

## Status

Bootstrapping. Scaffolding only — no working sign-in yet. Tracked work lives in beads (`bd list -t wukkiemail`).
