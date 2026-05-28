// Cloudflare Pages Function — refresh a Gmail access token.
// Browser POSTs { refresh_token }; function exchanges it server-side
// (needs the client_secret) and returns the new access token + expiry.

interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = (await request.json()) as { refresh_token?: string };
  const refreshToken = body.refresh_token;
  if (!refreshToken) {
    return new Response(JSON.stringify({ error: 'missing refresh_token' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
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
      status: 502,
      headers: { 'content-type': 'application/json' },
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
};
