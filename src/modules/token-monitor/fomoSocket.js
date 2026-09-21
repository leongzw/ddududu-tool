// Minimal client for fomo.family's WebSocket API (wss://prod-api.fomo.family/ws).
//
// Protocol (reverse-engineered — see fomo-ws-protocol.md in the repo root):
//   server -> {"type":"challenge"}                         immediately after connect
//   client -> {"type":"challengeResponse","jwt":"<jwt>"}   must answer or server closes 1008
//   server -> {"type":"challengeAccepted"}                 only then are subscribes allowed
//   client -> {"type":"subscribe","topicType":T,"topicId":I}
//   server -> {"type":"subscribed",...} / {"type":"unsubscribed",...}
//   server -> {"type":"data","topicType":T,"topicId":I,"payload":{...}}
//   server -> {"type":"error","code":...,"message":...}
//
// The JWT is a Privy access token (grab it from a logged-in fomo.family browser
// session); it expires ~1h after issue, so it is editable in the UI.

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30000;

export class FomoSocket {
  constructor(url = 'wss://prod-api.fomo.family/ws') {
    this.url = url;
    this.ws = null;
    this.jwt = '';
    this.authenticated = false;
    this.manualClose = false;
    this.reconnectDelay = RECONNECT_MIN;
    this.reconnectTimer = null;
    this.statusListeners = new Set();
    this.subscriptions = new Map(); // "type:id" -> { refCount }
    this.listeners = new Map(); // "type:id" -> Map(listenerId -> callback(payload, msg))
    this._status = { state: 'idle', detail: '' };
  }

  onStatus(cb) {
    this.statusListeners.add(cb);
    cb(this._status);
    return () => this.statusListeners.delete(cb);
  }

  _setStatus(state, detail = '') {
    this._status = { state, detail, at: Date.now() };
    for (const cb of this.statusListeners) cb(this._status);
  }

  setJwt(jwt) {
    this.jwt = jwt || '';
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.manualClose = false;
    clearTimeout(this.reconnectTimer);
    this._setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._scheduleReconnect(`connect error: ${err.message}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.authenticated = false;
      this._setStatus('authenticating', 'answering challenge…');
    };
    ws.onmessage = (ev) => this._handleMessage(ev.data);
    ws.onclose = (ev) => {
      this.authenticated = false;
      if (this.manualClose) {
        this._setStatus('closed');
        return;
      }
      const detail = ev.reason ? `code ${ev.code}: ${ev.reason}` : `code ${ev.code}`;
      if (ev.code === 1008) this._setStatus('error', detail); // bad/expired jwt
      this._scheduleReconnect(detail);
    };
    ws.onerror = () => {
      /* onclose always follows */
    };
  }

  disconnect() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    this.authenticated = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
    }
    this.ws = null;
    this._setStatus('closed');
  }

  reconnectNow() {
    this.disconnect();
    this.reconnectDelay = RECONNECT_MIN;
    this.connect();
  }

  _scheduleReconnect(detail) {
    if (this.manualClose) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(Math.round(this.reconnectDelay * 1.6), RECONNECT_MAX);
    const state = this._status.state === 'error' ? 'error' : 'reconnecting';
    this._setStatus(state, `${detail} · retrying in ${Math.round(delay / 1000)}s`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'challenge':
        this._send({ type: 'challengeResponse', jwt: this.jwt });
        break;
      case 'challengeAccepted':
        this.authenticated = true;
        this.reconnectDelay = RECONNECT_MIN;
        this._setStatus('connected', `${this._activeCount()} active topic(s)`);
        this._resubscribeAll();
        break;
      case 'data': {
        const cbs = this.listeners.get(`${msg.topicType}:${msg.topicId}`);
        if (cbs) for (const cb of cbs.values()) cb(msg.payload, msg);
        break;
      }
      case 'error':
        this._setStatus('error', `server error ${msg.code}: ${msg.message}`);
        break;
      default:
        break; // subscribed / unsubscribed acks
    }
  }

  _activeCount() {
    let n = 0;
    for (const s of this.subscriptions.values()) if (s.refCount > 0) n += 1;
    return n;
  }

  _resubscribeAll() {
    for (const [key, s] of this.subscriptions) {
      if (s.refCount <= 0) continue;
      const i = key.indexOf(':');
      this._send({ type: 'subscribe', topicType: key.slice(0, i), topicId: key.slice(i + 1) });
    }
  }

  /** subscribe(topicType, topicId, { id, callback }) -> unsubscribe() (refcounted) */
  subscribe(topicType, topicId, { id, callback } = {}) {
    const key = `${topicType}:${topicId}`;
    if (id && callback) {
      let m = this.listeners.get(key);
      if (!m) {
        m = new Map();
        this.listeners.set(key, m);
      }
      m.set(id, callback);
    }
    const s = this.subscriptions.get(key);
    if (s) s.refCount += 1;
    else this.subscriptions.set(key, { refCount: 1 });
    this._send({ type: 'subscribe', topicType, topicId });
    return () => this.unsubscribe(topicType, topicId, id);
  }

  unsubscribe(topicType, topicId, id) {
    const key = `${topicType}:${topicId}`;
    if (id) {
      const m = this.listeners.get(key);
      if (m) {
        m.delete(id);
        if (!m.size) this.listeners.delete(key);
      }
    }
    const s = this.subscriptions.get(key);
    if (s && --s.refCount <= 0) {
      this.subscriptions.delete(key);
      this._send({ type: 'unsubscribe', topicType, topicId });
    }
  }
}
