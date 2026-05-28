// Setup wizard for self-hosters.
//
// Triggered when `VITE_GOOGLE_CLIENT_ID` isn't set at build time
// — which is what happens to anyone who forks the repo and deploys
// their own copy without configuring the Google client first. The
// screen shows the exact values to paste into Google Cloud Console
// and Cloudflare Pages, derived from the current origin so the
// instructions are specific to *this* deployment.

import { useState } from 'react';

export function gmailIsConfigured(): boolean {
  return Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID);
}

export function SetupScreen({ onBack }: { onBack: () => void }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-app.pages.dev';
  const redirectUri = `${origin}/api/gmail/oauth/callback`;

  return (
    <div style={{ maxWidth: 720, margin: '32px auto', padding: 24 }}>
      <button
        onClick={onBack}
        style={{
          background: 'transparent', border: '1px solid var(--border)',
          borderRadius: 8, padding: '6px 12px', color: 'var(--fg)', marginBottom: 16,
        }}
      >
        ← Back
      </button>

      <h2 style={{ marginTop: 0 }}>Set up Gmail on your copy of WukkieMail</h2>
      <p style={{ color: 'var(--muted)' }}>
        WukkieMail's Gmail integration uses your own Google OAuth client, so each
        instance is its own application as far as Google is concerned. Takes
        about 5 minutes the first time.
      </p>

      <Step n={1} title="Create the Google OAuth client">
        <ol style={{ lineHeight: 1.7 }}>
          <li>
            Open <ExternalLink href="https://console.cloud.google.com/apis/credentials">
              Google Cloud Console → APIs & Services → Credentials
            </ExternalLink>.
          </li>
          <li>Pick or create a project (e.g. "WukkieMail").</li>
          <li>
            Configure the <strong>OAuth consent screen</strong> — External user type,
            fill the bare minimum (app name, your email twice).
          </li>
          <li>
            <strong>Add yourself as a Test User.</strong>{' '}
            Open <ExternalLink href="https://console.cloud.google.com/auth/audience">
              OAuth → Audience
            </ExternalLink>{' '}
            (it's a separate page from the consent screen wizard). Scroll to
            "Test users" → "+ Add users" → paste your Gmail address → Save. Repeat for
            anyone else who'll use this instance. Without this, Google rejects sign-in
            with an "app doesn't comply with OAuth 2.0 policy" error.
          </li>
          <li>
            <ExternalLink href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">
              Enable the Gmail API
            </ExternalLink>.
          </li>
          <li>
            <strong>Add the scope to the consent screen.</strong>{' '}
            On the consent screen edit flow, step "Scopes" → "Add or Remove Scopes",
            paste <Copy value="https://www.googleapis.com/auth/gmail.metadata" /> into
            the filter, check it (Sensitive), Update, Save. Without this step Google
            refuses the token exchange with a "doesn't comply with OAuth 2.0 policy"
            error.
          </li>
          <li>
            Back in Credentials → <strong>Create credentials → OAuth client ID</strong>.
            Application type: <strong>Web application</strong>.
          </li>
          <li>
            Paste this exactly under <strong>Authorized redirect URIs</strong>:
            <Copy value={redirectUri} />
          </li>
          <li>Save. Note the Client ID and Client secret — you'll need them next.</li>
        </ol>
      </Step>

      <Step n={2} title="Set Cloudflare Pages environment variables">
        <p style={{ color: 'var(--muted)' }}>
          Pages dashboard → your project → Settings → Environment variables → Production
          (and Preview if you use those). Then trigger a redeploy.
        </p>
        <table style={tableStyle}>
          <thead>
            <tr><th>Variable</th><th>Value</th><th>Notes</th></tr>
          </thead>
          <tbody>
            <Row name="VITE_GOOGLE_CLIENT_ID" value="(your client ID)" note="Plain text — baked into the JS bundle. Vite only inlines vars prefixed VITE_." />
            <Row name="GOOGLE_CLIENT_ID" value="(same client ID)" note="Used by the Pages Function during OAuth." />
            <Row name="GOOGLE_CLIENT_SECRET" value="(your client secret)" note="Mark as Secret in the dashboard." />
            <Row name="GOOGLE_OAUTH_REDIRECT_URI" value={redirectUri} note="Must match what you pasted in Google exactly." />
          </tbody>
        </table>
      </Step>

      <Step n={3} title="Redeploy">
        <p>
          Env vars only apply to new builds. Push a commit, or in the Pages dashboard
          → Deployments → Retry the latest deployment.
        </p>
      </Step>

      <Step n={4} title="About the &quot;unverified app&quot; warning">
        <p style={{ color: 'var(--muted)' }}>
          The first time you (or any of your Test Users) sign in, Google shows
          a scary "Google hasn't verified this app" screen. That's expected
          while your OAuth client is in <strong>Testing</strong> mode —
          click <strong>Advanced → Continue (unsafe)</strong>.
        </p>
        <p style={{ color: 'var(--muted)' }}>
          You only need to go through Google's verification process if you want
          to let arbitrary strangers (not on your Test Users list) sign in.
          For personal or small-group use, Testing mode is enough.
        </p>
      </Step>

      <Step n={5} title="Notes on scope">
        <p style={{ color: 'var(--muted)' }}>
          WukkieMail requests only the <code>gmail.metadata</code> scope — headers,
          labels, threading. No message bodies. Clicking a thread opens it in
          mail.google.com so you can read it there. This means your Google client
          stays at "basic" verification (no expensive security assessment) if you
          ever do submit for verification.
        </p>
      </Step>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section style={{
      border: '1px solid var(--border)', borderRadius: 12,
      padding: '16px 20px', marginBottom: 16, background: 'var(--card)',
    }}>
      <h3 style={{ marginTop: 0, fontSize: 16 }}>{n}. {title}</h3>
      {children}
    </section>
  );
}

function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
      <code style={{
        background: 'var(--bg)', padding: '6px 10px', borderRadius: 6,
        border: '1px solid var(--border)', flex: 1, fontSize: 13, wordBreak: 'break-all',
      }}>{value}</code>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        style={{
          background: 'var(--accent)', color: 'white', border: 'none',
          borderRadius: 6, padding: '6px 12px', fontSize: 12,
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

function Row({ name, value, note }: { name: string; value: string; note: string }) {
  return (
    <tr>
      <td><code style={{ fontSize: 12 }}>{name}</code></td>
      <td style={{ fontSize: 12, wordBreak: 'break-all' }}>{value}</td>
      <td style={{ fontSize: 12, color: 'var(--muted)' }}>{note}</td>
    </tr>
  );
}

const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse', marginTop: 8,
};

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
      {children}
    </a>
  );
}
