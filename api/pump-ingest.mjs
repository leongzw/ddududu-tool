// Vercel serverless port of the pumpIngest middleware in vite.config.js.
// Ingest for the pump.fun bridge userscript (scripts/pump-fun-bridge.user.js):
// the userscript polls /following-positions/alerts inside a logged-in
// pump.fun tab and POSTs the latest page here; the Token Monitor GETs it back
// and merges (dedupe by item key). Read-mostly, no credentials stored.
//
// SERVERLESS CAVEAT (vs the always-on dev server): state lives in the
// function instance's memory — Vercel may spin up multiple instances or
// recycle a cold one, so a POST right after a cold start can be missed by the
// next GET until the bridge POSTs again (it fires every 10s, so in practice
// the panel catches up on the next snapshot). For guaranteed cross-instance
// reads, back this with Vercel KV (Upstash Redis) instead.
import { json, readBody } from './_utils.mjs';

let pumpIngestState = { seq: 0, at: 0, items: [] };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === 'POST') {
    try {
      const b = await readBody(req);
      if (Array.isArray(b.items)) {
        // stamp `at` server-side — a skewed bridge machine's clock must never
        // make fresh pages look stale to the panel (keep client time as clientAt)
        pumpIngestState = {
          seq: pumpIngestState.seq + 1,
          at: Date.now(),
          clientAt: b.at || 0,
          items: b.items.slice(0, 50),
        };
        json(res, 200, { ok: true, seq: pumpIngestState.seq });
      } else {
        json(res, 400, { error: 'items[] required' });
      }
    } catch {
      json(res, 400, { error: 'bad body' });
    }
    return;
  }
  json(res, 200, pumpIngestState);
}
