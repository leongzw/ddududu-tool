// Authenticated protocol test for wss://prod-api.fomo.family/ws
// Protocol (reverse-engineered from fomo.family's FomoWS client):
//   1. connect -> server sends {"type":"challenge"}
//   2. client replies {"type":"challengeResponse","jwt":"<Privy access token>"}
//   3. server replies {"type":"challengeAccepted"} -> now authenticated
//   4. client sends {"type":"subscribe","topicType":T,"topicId":I}
//   5. server sends {"type":"subscribed"} ack, then {"type":"data",...} payloads
// Usage: node ws-test.mjs [jwt]   (or set FOMO_JWT env var)
const URL = 'wss://prod-api.fomo.family/ws';
const JWT = process.argv[2] || process.env.FOMO_JWT || '';

if (!JWT) {
  console.error('No JWT provided. Pass it as an argument: node ws-test.mjs <jwt>');
  process.exit(1);
}

// Show token exp so stale tokens are obvious
try {
  const p = JSON.parse(Buffer.from(JWT.split('.')[1], 'base64url').toString());
  const expIn = Math.round(p.exp - Date.now() / 1000);
  console.log(`[TOKEN] sub=${p.sub} expires in ${expIn}s${expIn <= 0 ? ' (EXPIRED!)' : ''}`);
} catch { console.log('[TOKEN] could not parse JWT payload'); }

const ws = new WebSocket(URL, {
  headers: {
    'Origin': 'https://fomo.family',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
  },
});

let msgCount = 0;
let dataCount = 0;

const send = (obj) => ws.send(JSON.stringify(obj));

ws.onopen = () => console.log('[OPEN] Handshake succeeded.');

ws.onmessage = (ev) => {
  msgCount++;
  const raw = typeof ev.data === 'string' ? ev.data : '<binary>';
  let m = null;
  try { m = JSON.parse(raw); } catch {}
  // Print trading_activity frames in full — that's what we're hunting for
  if (m && m.type === 'data' && m.topicType === 'trading_activity') {
    dataCount++;
    console.log(`[ACTIVITY #${dataCount}] ${raw}`);
    return;
  }
  if (m && m.type === 'data') {
    dataCount++;
    const s = raw.length > 600 && dataCount > 3
      ? raw.slice(0, 300) + ` … (+${raw.length - 300} bytes)`
      : raw.slice(0, 1200);
    console.log(`[DATA #${dataCount} @${m.topicType}/${m.topicId}] ${s}`);
    return;
  }
  console.log(`[MSG #${msgCount}] ${raw.slice(0, 800)}`);
  if (m && m.type === 'challenge') {
    console.log('-> replying to challenge with provided JWT');
    send({ type: 'challengeResponse', jwt: JWT });
  } else if (m && m.type === 'challengeAccepted') {
    console.log('[AUTH] challengeAccepted! subscribing to topics...');
    const ts = () => new Date().toISOString().slice(11, 19);
    // Defaults to the captured alerts-feed topic; override via env:
    //   TOPIC_TYPE / TOPIC_ID   (e.g. TOPIC_TYPE=trending_tokens TOPIC_ID=1399811149)
    const topicType = process.env.TOPIC_TYPE || 'trading_activity';
    const topicId = process.env.TOPIC_ID || '25597e33-fee6-5d58-8ba4-2f3d4469ec3f';
    send({ type: 'subscribe', topicType, topicId });
    console.log(`[${ts()}] subscribe sent: ${topicType}/${topicId}`);
  }
};

ws.onerror = (ev) => console.log(`[ERROR] ${ev.message || (ev.error && ev.error.message) || 'unknown'}`);

ws.onclose = (ev) => {
  console.log(`[CLOSE] code=${ev.code} reason=${JSON.stringify(ev.reason)} clean=${ev.wasClean}`);
  process.exit(0);
};

setTimeout(() => {
  console.log(`[DONE] ${msgCount} message(s) total, ${dataCount} activity/data frame(s) in 60s.`);
  try { ws.close(); } catch {}
  process.exit(0);
}, 60000);

