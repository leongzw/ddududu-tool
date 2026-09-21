// Vercel serverless port of the privyRefresh middleware in vite.config.js.
// fomo.family Privy token plumbing for the Token Monitor: the browser can't
// call Privy directly (CORS only allows Origin: https://fomo.family), so this
// same-origin endpoint proxies a Privy session refresh and lets the Token
// Monitor page keep its own JWT fresh (server-side, no CORS).
import { json, readBody } from './_utils.mjs';

const PRIVY_BASE = process.env.FOMO_AUTH_BASE || 'https://privy.fomo.family';
const PRIVY_APP_ID = 'cm6h485o300n3zj9yl6vpedq7';
const PRIVY_CLIENT = 'react-auth:3.34.0';

export default async function handler(req, res) {
  const body = await readBody(req);
  if (!body.refreshToken) {
    json(res, 400, { error: 'missing refreshToken' });
    return;
  }
  try {
    const r = await fetch(`${PRIVY_BASE}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'privy-app-id': PRIVY_APP_ID,
        'privy-client': PRIVY_CLIENT,
        'privy-ca-id': body.caId || '00000000-0000-4000-8000-000000000000',
        Origin: 'https://fomo.family',
      },
      body: JSON.stringify({ refresh_token: body.refreshToken }),
      signal: AbortSignal.timeout(20_000),
    });
    const out = await r.json().catch(() => ({}));
    // fomo uses server-cookies mode: the rotated refresh token may arrive as a
    // set-cookie instead of in the body — surface it either way (never any
    // other cookie material)
    let rotated = out.refresh_token || null;
    if (!rotated && typeof r.headers.getSetCookie === 'function') {
      for (const c of r.headers.getSetCookie()) {
        const m = c.match(/^privy-refresh-token=([^;]+)/);
        if (m && m[1] !== 'deleted') rotated = decodeURIComponent(m[1]);
      }
    }
    json(res, r.status, {
      session_update_action: out.session_update_action || null,
      token: out.token || out.privy_access_token || null,
      refreshToken: rotated,
      error: out.error || null,
      code: out.code || null,
    });
  } catch (e) {
    json(res, 502, { error: `privy proxy: ${e.message}` });
  }
}
