// Gateway connection: pairing, WebSocket lifecycle, reconnect with backoff.
// Emits server events (parsed NDJSON) and local phase events to `onEvent`.

const DEFAULT_PORT = 7643;

export function gatewayBase(host, port = DEFAULT_PORT, secure = false) {
  const h = host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const hasPort = /:\d+$/.test(h);
  return `${secure ? "https" : "http"}://${hasPort ? h : `${h}:${port}`}`;
}

export async function checkHealth(base, timeoutMs = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/health`, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, ...(await r.json()) };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timed out" : "unreachable" };
  } finally {
    clearTimeout(t);
  }
}

export async function pair(base, code, deviceId, deviceName) {
  const r = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: String(code).replace(/\D/g, ""), device_id: deviceId, device_name: deviceName }),
  });
  const text = await r.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* plain-text error */
  }
  if (!r.ok || !body.token) {
    const msg = body.error || body.message || text || `HTTP ${r.status}`;
    throw new Error(/expired|invalid|not found|unknown/i.test(msg) ? "That code is invalid or expired. Run `jcode pair` for a fresh one." : msg);
  }
  return body; // { token, server_name, server_version }
}

export class Connection {
  constructor({ base, token, instanceId, onEvent }) {
    this.base = base;
    this.token = token;
    this.instanceId = instanceId;
    this.onEvent = onEvent;
    this.ws = null;
    this.nextId = 1;
    this.attempt = 0;
    this.stopped = true;
    this.sessionId = null; // session to (re)attach to
    this.workingDir = null;
    this.hasHistory = false;
    this.fastFails = 0;
    this.timer = null;
    this.pingTimer = null;
    this.outbox = []; // requests sent while offline, flushed on connect
    this.sentTypes = new Map(); // request id -> request type (bounded)
    this.metaOnly = new Set(); // get_history ids sent just to refresh the session list
  }

  emit(ev) {
    this.onEvent(ev);
  }

  phase(phase, detail = "") {
    this.emit({ type: "local:phase", phase, detail });
  }

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.phase("idle");
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // Force an immediate reconnect attempt (e.g. app returned to foreground).
  kick() {
    if (this.stopped) return;
    if (this.connected) {
      this.send({ type: "ping" });
      return;
    }
    clearTimeout(this.timer);
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.open();
  }

  open() {
    clearTimeout(this.timer);
    const wsBase = this.base.replace(/^http/, "ws");
    this.phase(this.attempt ? "reconnecting" : "connecting", this.attempt ? `attempt ${this.attempt}` : "");
    const openedAt = Date.now();
    let ws;
    try {
      ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(this.token)}`);
    } catch (e) {
      this.phase("failed", String(e.message || e));
      return;
    }
    this.ws = ws;
    let wasOpen = false;
    let buffer = "";

    ws.onopen = () => {
      wasOpen = true;
      this.attempt = 0;
      this.fastFails = 0;
      this.phase("connected");
      this.subscribe();
      const queued = this.outbox.splice(0);
      for (const q of queued) this.rawSend(q);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.connected && this.send({ type: "ping" }), 25000);
    };

    ws.onmessage = (m) => {
      buffer += typeof m.data === "string" ? m.data : "";
      const lines = buffer.split("\n");
      buffer = lines.pop();
      // A frame may also be a complete JSON object without trailing newline.
      if (buffer && buffer.trim().startsWith("{")) {
        try {
          lines.push(JSON.stringify(JSON.parse(buffer)));
          buffer = "";
        } catch {
          /* partial line, wait for more */
        }
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "session" && ev.session_id) this.sessionId = ev.session_id;
        if (ev.type === "history") this.hasHistory = true;
        if (ev.type === "reloading") this.expectReload = true;
        // Tag acks with the request type so the reducer can tell a turn's
        // completion from a side request (history, rename, ...).
        if ((ev.type === "done" || ev.type === "error") && this.sentTypes.has(ev.id)) ev.req_type = this.sentTypes.get(ev.id);
        if (ev.type === "history" && this.metaOnly.delete(ev.id)) {
          ev.req_type = "get_history";
          ev.meta_only = true;
        }
        this.emit(ev);
      }
    };

    ws.onclose = async () => {
      clearInterval(this.pingTimer);
      this.ws = null;
      if (this.stopped) return;
      // Closing within ~1.5s without ever opening twice in a row usually means
      // the token was rejected (browsers hide the 401). Confirm via /health.
      if (!wasOpen && Date.now() - openedAt < 1500) {
        this.fastFails++;
        if (this.fastFails >= 2) {
          const h = await checkHealth(this.base);
          if (h.ok && h.gateway) {
            this.phase("unpaired", "This phone is no longer paired with your Mac.");
            this.stopped = true;
            return;
          }
        }
      }
      this.attempt++;
      const delay = this.expectReload ? 500 : Math.min(30000, 800 * 2 ** Math.min(this.attempt - 1, 6));
      this.expectReload = false;
      this.phase("reconnecting", `retrying in ${Math.round(delay / 1000)}s`);
      this.timer = setTimeout(() => this.open(), delay);
    };
  }

  subscribe() {
    const req = {
      type: "subscribe",
      client_instance_id: this.instanceId,
      continue_on_disconnect: true, // keep the turn running if the phone sleeps
    };
    if (this.workingDir) req.working_dir = this.workingDir;
    if (this.sessionId) {
      req.target_session_id = this.sessionId;
      req.allow_session_takeover = true;
      req.client_has_local_history = this.hasHistory;
    }
    this.send(req);
    this.send({ type: "get_history" });
    // Is a turn still running (e.g. phone slept mid-task)? Answered with a `state` event.
    this.send({ type: "state" });
  }

  // Ask for fresh metadata (open sessions, model list) without reloading the transcript.
  refreshMeta() {
    const id = this.send({ type: "get_history" });
    if (id != null) this.metaOnly.add(id);
    return id;
  }

  rawSend(obj) {
    this.ws.send(JSON.stringify(obj) + "\n");
  }

  // Returns the request id. Queues while offline (only user-meaningful requests).
  send(obj) {
    const req = { ...obj, id: obj.id ?? this.nextId++ };
    this.sentTypes.set(req.id, req.type);
    if (this.sentTypes.size > 500) this.sentTypes.delete(this.sentTypes.keys().next().value);
    if (this.connected) this.rawSend(req);
    else if (obj.type === "message" || obj.type === "soft_interrupt") this.outbox.push(req);
    else return null;
    return req.id;
  }

  // Switch to a session (or null = new session) by re-subscribing on a fresh socket.
  switchSession(sessionId) {
    this.sessionId = sessionId;
    this.hasHistory = false;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    clearInterval(this.pingTimer);
    this.attempt = 0;
    this.open();
  }
}
