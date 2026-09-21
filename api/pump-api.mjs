// Vercel serverless port of the pumpApi middleware in vite.config.js.
// Read-only proxy for pump.fun's frontend API (frontend-api-v3.pump.fun) —
// powers the Token Monitor's pump.fun following panel. Same-origin POST
// {path, token?} style, because the API is CORS-locked to pump.fun's own
// origin (foreign origins get 403). Public reads (home-feed) need no auth;
// authed paths still 401 server-side (pump.fun authenticates only real
// browsers — see pump-fun-api.md).
import { json, readBody } from './_utils.mjs';

export default async function handler(req, res) {
  const body = await readBody(req);
  if (!body.path) {
    json(res, 400, { error: 'missing path' });
    return;
  }
  // % for URL-encoded query values (kinds=callout%2Cupdate), , and : for plain ones
  if (!/^\/[a-zA-Z0-9/_?=&.,%:-]*$/.test(body.path) || body.path.includes('..')) {
    json(res, 400, { error: 'bad path' });
    return;
  }
  const token =
    typeof body.token === 'string' && /^[A-Za-z0-9._-]{20,}$/.test(body.token) ? body.token : null;
  if (token) {
    // guard the classic copy-mistake: privy-id-token (ES256, iss privy.io) is
    // pump.fun's LOGIN material — the session cookie is auth_token (HS256)
    try {
      const [h, p] = token
        .split('.')
        .slice(0, 2)
        .map((s) =>
          JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()),
        );
      if (p.iss === 'privy.io' || h.alg === 'ES256') {
        json(res, 400, { error: 'privy-id-token passed — copy the auth_token cookie instead' });
        return;
      }
    } catch {
      /* not a decodable JWT — forward and let pump.fun judge */
    }
  }
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun${body.path}`, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'https://pump.fun',
        Referer: 'https://pump.fun/',
        ...(token ? { Cookie: `auth_token=${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    json(res, r.status, await r.json().catch(() => ({})));
  } catch (e) {
    json(res, 502, { error: `pump api proxy: ${e.message}` });
  }
}
