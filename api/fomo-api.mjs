// Vercel serverless port of the fomoApi middleware in vite.config.js.
// Read-only proxy for fomo's REST API (prod-api.fomo.family) — powers the
// Token Monitor's "Check" feed diagnostics. GET-only with a strict path
// charset; the caller supplies the (auto-refreshed) Privy JWT.
import { json, readBody } from './_utils.mjs';

export default async function handler(req, res) {
  const body = await readBody(req);
  if (!body.path || !body.jwt) {
    json(res, 400, { error: 'missing path or jwt' });
    return;
  }
  if (!/^\/[a-zA-Z0-9/_?=&.-]*$/.test(body.path)) {
    json(res, 400, { error: 'bad path' });
    return;
  }
  try {
    const r = await fetch(`https://prod-api.fomo.family${body.path}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${body.jwt}`,
        Origin: 'https://fomo.family',
        Referer: 'https://fomo.family/',
      },
      signal: AbortSignal.timeout(20_000),
    });
    json(res, r.status, await r.json().catch(() => ({})));
  } catch (e) {
    json(res, 502, { error: `fomo api proxy: ${e.message}` });
  }
}
