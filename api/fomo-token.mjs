// Vercel serverless port of the serveTokenFile middleware in vite.config.js.
// The dev-server version reads scripts/.fomo-session.json (written by the
// optional `npm run fomo-token` daemon) — that file is gitignored/local-only
// by design, so on Vercel this instead serves the same shape from the
// FOMO_SESSION_JSON env var (set it to the JSON contents of
// scripts/.fomo-session.json if you want the deployed panel to see the
// daemon's token). Without the env var it reports "no session", which the
// Token Monitor treats the same as a dev box without the daemon.
import { json } from './_utils.mjs';

export default function handler(_req, res) {
  let out = { token: '', exp: 0, at: 0, lastError: '' };
  try {
    const s = JSON.parse(process.env.FOMO_SESSION_JSON || '');
    out = { token: s.token || '', exp: s.exp || 0, at: s.at || 0, lastError: s.lastError || '' };
  } catch {
    out.lastError = 'no session — set FOMO_SESSION_JSON (or run the dev server)';
  }
  json(res, 200, out);
}
