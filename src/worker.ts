// Cloudflare Worker entry — handles /api/* and delegates everything
// else to the SPA's static assets (configured via the ASSETS binding
// in wrangler.jsonc).
//
// We previously had these as Cloudflare Pages Functions under
// `functions/api/…`, but the project is deployed via
// `npx wrangler deploy` (Workers-with-assets unified model), which
// doesn't pick up the `functions/` directory. So the same logic
// lives here as Worker routes.

interface Env {
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_OAUTH_REDIRECT_URI: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/gmail/oauth/callback' && request.method === 'GET') {
      return handleOAuthCallback(url, env);
    }
    if (url.pathname === '/api/gmail/refresh' && request.method === 'POST') {
      return handleRefresh(request, env);
    }

    // Everything else: hand off to the static assets bundle (the SPA).
    return env.ASSETS.fetch(request);
  },
};

async function handleOAuthCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  const error = url.searchParams.get('error');

  if (error) return redirectToReturn(url, `error=${encodeURIComponent(error)}`);
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
  const tokens = (await tokenRes.json()) as Record<string, unknown>;
  const frag = new URLSearchParams({
    access_token: String(tokens.access_token ?? ''),
    refresh_token: String(tokens.refresh_token ?? ''),
    expires_in: String(tokens.expires_in ?? ''),
    scope: String(tokens.scope ?? ''),
    state,
  });
  return redirectToReturn(url, frag.toString());
}

function redirectToReturn(reqUrl: URL, payload: string): Response {
  return Response.redirect(`${reqUrl.origin}/auth/gmail/return#${payload}`, 302);
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { refresh_token?: string };
  const refreshToken = body.refresh_token;
  if (!refreshToken) {
    return new Response(JSON.stringify({ error: 'missing refresh_token' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  const form = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) {
    return new Response(JSON.stringify({ error: await res.text() }), {
      status: 502, headers: { 'content-type': 'application/json' },
    });
  }
  const tokens = (await res.json()) as Record<string, unknown>;
  return new Response(
    JSON.stringify({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
