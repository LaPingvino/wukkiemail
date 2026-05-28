// Cloudflare Pages Function — Gmail OAuth code → token exchange.
// The browser sends ?code=...&state=... after Google's consent screen.
// We swap the code for access+refresh tokens using the client_secret (server-side only)
// and bounce back to the app with the tokens in a fragment so they never hit a server log.
//
// Env (configured in Cloudflare Pages → Settings → Environment Variables):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI

interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_OAUTH_REDIRECT_URI: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  const error = url.searchParams.get('error');

  if (error) return redirectToApp(url, `error=${encodeURIComponent(error)}`);
  if (!code) return new Response('missing code', { status: 400 });

  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return new Response(`token exchange failed: ${text}`, { status: 502 });
  }
  const tokens = await tokenRes.json<Record<string, unknown>>();
  // Hand tokens to the app via URL fragment (never hits HTTP logs).
  const frag = new URLSearchParams({
    access_token: String(tokens.access_token ?? ''),
    refresh_token: String(tokens.refresh_token ?? ''),
    expires_in: String(tokens.expires_in ?? ''),
    scope: String(tokens.scope ?? ''),
    state,
  });
  return redirectToApp(url, frag.toString(), '#');
};

function redirectToApp(reqUrl: URL, payload: string, sep: '?' | '#' = '#') {
  const target = `${reqUrl.origin}/auth/gmail/return${sep}${payload}`;
  return Response.redirect(target, 302);
}
