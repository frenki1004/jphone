// jPhone app shell: state store, rendering, interactions.
import { initialState, reduce, friendlyName, sessionCreatedAt, toolSummary, fmtTokens } from "./lib/reducer.js";
import { Connection, gatewayBase, checkHealth, pair } from "./lib/connection.js";
import { render as renderMd, esc } from "./lib/markdown.js";
import { parsePairFragment } from "./lib/pairlink.js";
import { turnNotice } from "./lib/notify.js";
import { prepareImage, MAX_IMAGES } from "./lib/images.js";
import { fileChanges } from "./lib/changes.js";
import { touchDir, forgetDir, seedDirs, cleanDir } from "./lib/recent.js";
import { lockAvailable, lockToken, unlockToken, lockoutSeconds, validPin, RELOCK_AFTER_MS } from "./lib/lock.js";
import { urlB64ToBytes, subscriptionBody, sameKey } from "./lib/push.js";

const $ = (id) => document.getElementById(id);
const app = $("app");

// --- persistence -----------------------------------------------------------

const STORE_KEY = "jphone.v1";
// One in-memory copy is the source of truth. localStorage is only a mirror,
// so a read never clobbers state that has not been written yet.
let memo = null;
let persist = true;
const store = {
  load() {
    if (!memo) {
      try {
        memo = (persist && JSON.parse(localStorage.getItem(STORE_KEY))) || {};
      } catch {
        memo = {};
      }
    }
    return memo;
  },
  save(patch) {
    memo = { ...this.load(), ...patch };
    if (persist) {
      try {
        // With an app lock, the token only lives in memory; storage has it encrypted.
        localStorage.setItem(STORE_KEY, JSON.stringify(memo.lock ? { ...memo, token: undefined } : memo));
      } catch {
        /* private mode / quota: keep working in memory */
      }
    }
    return memo;
  },
  clear() {
    memo = {};
    if (persist) localStorage.removeItem(STORE_KEY);
  },
  ephemeral(initial) {
    persist = false;
    memo = { ...initial };
    return memo;
  },
};

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID(); // needs https; fallback below for http
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let cfg = store.load();
if (!cfg.deviceId) cfg = store.save({ deviceId: uuid() });
if (!cfg.instanceId) cfg = store.save({ instanceId: `jphone-${cfg.deviceId.slice(0, 8)}` });
if (!cfg.recentDirs) cfg = store.save({ recentDirs: seedDirs(cfg.sessions, cfg.workingDir) });

// --- state -----------------------------------------------------------------

let state = initialState();
let conn = null;
let renderQueued = false;
const drafts = cfg.drafts || {}; // per-session unsent input

const eventLog = []; // last 200 event types, for debugging (window.__jphone.events)
const clearedTitles = new Set();

function dispatch(ev) {
  eventLog.push(ev.type === "local:phase" ? `phase:${ev.phase}` : ev.type + (ev.id != null ? `#${ev.id}` : "") + (ev.message ? `:${ev.message}` : ""));
  if (eventLog.length > 200) eventLog.shift();
  const before = state.sessionId;
  const wasProcessing = state.processing;
  state = reduce(state, ev);
  if (ev.type === "history") skipEnterAnim = true; // history appears instantly
  if (ev.type === "history" && state.sessionId) rememberSession(state.sessionId);
  if (ev.type === "local:user" && !ev.queued && state.sessionId) rememberSession(state.sessionId);
  if (ev.type === "session_renamed" && ev.session_id) {
    if (ev.title) clearedTitles.delete(ev.session_id);
    else clearedTitles.add(ev.session_id);
    rememberSession(ev.session_id);
  }
  if (state.sessionId !== before && state.sessionId) {
    store.save({ sessionId: state.sessionId });
    restoreDraft();
    if (state.processing) pushWatch(); // first message of a new session: the id arrives after it
  }
  if (ev.type === "local:phase") onPhase(ev);
  if (ev.type === "done" || ev.type === "error" || ev.type === "interrupted") onTurnMaybeEnded(wasProcessing, ev);
  scheduleRender();
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => {
    if (!renderQueued) return;
    renderQueued = false;
    renderAll();
  };
  // rAF batches streaming deltas into one paint per frame. It is paused in
  // background tabs, so a timer guarantees the DOM still catches up.
  requestAnimationFrame(run);
  setTimeout(run, 100);
}

// --- sessions memory --------------------------------------------------------

function rememberSession(id) {
  const prevList = store.load().sessions || [];
  const prev = prevList.find((s) => s.id === id) || {};
  const list = prevList.filter((s) => s.id !== id);
  const firstUser = id === state.sessionId ? state.entries.find((e) => e.role === "user" && !e.queued) : null;
  list.unshift({
    id,
    dir: prev.dir || cfg.workingDir,
    title: id in state.sessionTitles ? state.sessionTitles[id] : prev.title && !clearedTitles.has(id) ? prev.title : null,
    preview: (firstUser && firstUser.text.replace(/\s+/g, " ").slice(0, 80)) || prev.preview || null,
    at: Date.now(),
  });
  cfg = store.save({ sessions: list.slice(0, 40) });
}

// --- view switching ----------------------------------------------------------

function setView(v) {
  app.dataset.view = v;
}

// --- pairing ------------------------------------------------------------------

const pairForm = $("pair-form");
const pairHost = $("pair-host");
const pairCode = $("pair-code");
const pairPort = $("pair-port");
const pairErr = $("pair-error");
const pairBtn = $("pair-submit");
const pairHealth = $("pair-health");

function initPairing(message, link = null) {
  setView("pair");
  pairErr.textContent = message || "";
  const note = $("pair-note");
  note.hidden = !link;
  $("pair-back").hidden = !(link && cfg.token);
  if (link) {
    // Prefill, but let the person confirm with one tap: a link could come from
    // anyone, and pairing points this phone at whatever host it names.
    pairHost.value = link.host;
    pairPort.value = link.port;
    pairCode.value = `${link.code.slice(0, 3)} ${link.code.slice(3)}`;
    note.textContent = `Pairing link for ${link.host}. Check that this is your Mac, then tap Pair.` + (cfg.token ? " This replaces the current pairing." : "");
    if (link.port !== "7643") pairPort.closest("details").open = true;
    probeHost();
    setTimeout(() => pairBtn.focus(), 50);
    return;
  }
  // Default host: whatever served this page (works over Tailscale / LAN), never loopback.
  const servedFrom = location.hostname;
  const loopback = !servedFrom || servedFrom === "localhost" || servedFrom.startsWith("127.") || servedFrom === "::1";
  if (!pairHost.value) pairHost.value = cfg.host || (loopback ? "" : servedFrom);
  if (cfg.port) pairPort.value = cfg.port;
  probeHost();
  setTimeout(() => (pairHost.value ? pairCode : pairHost).focus(), 50);
}

let probeTimer = null;
let probeSeq = 0;
function probeHost() {
  clearTimeout(probeTimer);
  const host = pairHost.value.trim();
  if (!host) {
    pairHealth.dataset.state = "";
    return;
  }
  pairHealth.dataset.state = "checking";
  const seq = ++probeSeq;
  probeTimer = setTimeout(async () => {
    const h = await checkHealth(gatewayBase(host, pairPort.value || 7643, location.protocol === "https:"));
    if (seq !== probeSeq) return;
    pairHealth.dataset.state = h.ok && h.gateway ? "ok" : "bad";
    pairHealth.title = h.ok ? `jcode ${h.version || ""}` : h.error;
  }, 350);
}
pairHost.addEventListener("input", probeHost);
pairPort.addEventListener("input", probeHost);

pairCode.addEventListener("input", () => {
  const digits = pairCode.value.replace(/\D/g, "").slice(0, 6);
  pairCode.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
  pairErr.textContent = "";
  if (digits.length === 6 && pairHost.value.trim()) pairForm.requestSubmit();
});

pairForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const host = pairHost.value.trim();
  const code = pairCode.value.replace(/\D/g, "");
  if (!host) return void (pairErr.textContent = "Enter your Mac's Tailscale name or IP.");
  if (code.length !== 6) return void (pairErr.textContent = "The pairing code has 6 digits.");
  // An https page may only talk to an https/wss gateway (mixed content is blocked).
  const base = gatewayBase(host, pairPort.value || 7643, location.protocol === "https:");
  pairBtn.classList.add("busy");
  pairBtn.disabled = true;
  pairErr.textContent = "";
  try {
    const h = await checkHealth(base);
    if (!h.ok) throw new Error(`Can't reach jcode at ${host} (${h.error}). Is Tailscale on and the gateway enabled?`);
    const res = await pair(base, code, cfg.deviceId, deviceName());
    const hadLock = !!cfg.lock; // a new token cannot reuse the old PIN's encryption
    cfg = store.save({ host, port: pairPort.value || "7643", base, token: res.token, serverName: res.server_name, serverVersion: res.server_version, lock: null, lockFails: 0, lockUntil: 0 });
    if (hadLock) setTimeout(() => toast("App lock is off after re-pairing. Set a PIN in Settings."), 600);
    haptic(15);
    pairCode.value = "";
    $("pair-note").hidden = true;
    startChat();
    if (!cfg.workingDir) setTimeout(() => openFolderSheet(true), 400);
  } catch (err) {
    pairErr.textContent = err.message || String(err);
    haptic([10, 40, 10]);
  } finally {
    pairBtn.classList.remove("busy");
    pairBtn.disabled = false;
  }
});

$("pair-back").addEventListener("click", () => {
  $("pair-note").hidden = true;
  pairCode.value = "";
  startChat();
});

function deviceName() {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : "browser";
  return `jPhone (${kind})`;
}

// --- app lock -------------------------------------------------------------------

const lockForm = $("lock-form");
const lockPin = $("lock-pin");
const lockErr = $("lock-error");

function showLock() {
  setView("lock");
  lockPin.value = "";
  const wait = Math.ceil(((cfg.lockUntil || 0) - Date.now()) / 1000);
  lockErr.textContent = wait > 0 ? `Too many wrong PINs. Try again in ${wait}s.` : "";
  setTimeout(() => lockPin.focus(), 50);
}

lockForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const wait = Math.ceil(((cfg.lockUntil || 0) - Date.now()) / 1000);
  if (wait > 0) return void (lockErr.textContent = `Too many wrong PINs. Try again in ${wait}s.`);
  const btn = $("lock-submit");
  btn.classList.add("busy");
  btn.disabled = true;
  try {
    const token = await unlockToken(cfg.lock, lockPin.value);
    cfg = store.save({ token, lockFails: 0, lockUntil: 0 });
    lockPin.value = "";
    startChat();
    if (!cfg.workingDir) setTimeout(() => openFolderSheet(true), 300);
  } catch {
    const fails = (cfg.lockFails || 0) + 1;
    const secs = lockoutSeconds(fails);
    cfg = store.save({ lockFails: fails, lockUntil: secs ? Date.now() + secs * 1000 : 0 });
    lockErr.textContent = secs ? `Wrong PIN. Try again in ${secs}s.` : "Wrong PIN.";
    lockPin.value = "";
    haptic([10, 40, 10]);
  } finally {
    btn.classList.remove("busy");
    btn.disabled = false;
  }
});

$("lock-forget").addEventListener("click", () => {
  if (confirm("Forget this Mac? This removes the pairing from this phone. You'll need a new code from `jcode pair`.")) forget();
});

// Lock now: drop the token and everything on screen.
function relock() {
  if (!cfg.lock) return;
  if (conn) conn.stop();
  conn = null;
  cfg = store.save({ token: undefined });
  state = initialState();
  nodes.clear();
  transcriptEl.innerHTML = "";
  if (sheet.open) sheet.close();
  closeDrawer();
  hideBanner();
  showLock();
}

let hiddenAt = 0;

function openPinSheet() {
  openSheet(
    cfg.lock ? "Change PIN" : "Set a PIN",
    `<p class="muted small flush">jPhone will ask for it when it starts and after ${RELOCK_AFTER_MS / 60000} minutes in the background. Your device token is stored encrypted with it.</p>
     <label class="field"><span>New PIN (4–12 digits)</span><input id="pin1" type="password" inputmode="numeric" autocomplete="off" maxlength="12"/></label>
     <label class="field"><span>Repeat PIN</span><input id="pin2" type="password" inputmode="numeric" autocomplete="off" maxlength="12"/></label>
     <p id="pin-err" class="error-text"></p>
     <div class="sheet-actions"><button class="btn" value="cancel">Cancel</button><button id="pin-ok" class="btn btn-primary" type="button">Save PIN</button></div>`,
    (body) => {
      const [p1, p2, err] = ["#pin1", "#pin2", "#pin-err"].map((q) => body.querySelector(q));
      body.querySelector("#pin-ok").onclick = async () => {
        if (!validPin(p1.value)) return void (err.textContent = "Use 4 to 12 digits.");
        if (p1.value !== p2.value) return void (err.textContent = "The two PINs differ.");
        if (!cfg.token) return void (err.textContent = "Pair first.");
        err.textContent = "";
        const lock = await lockToken(p1.value, cfg.token);
        cfg = store.save({ lock, lockFails: 0, lockUntil: 0 });
        sheet.close();
        toast("App lock is on");
      };
      setTimeout(() => p1.focus(), 60);
    }
  );
}

// --- chat startup ------------------------------------------------------------

function startChat() {
  setView("chat");
  state = initialState();
  if (conn) conn.stop();
  conn = new Connection({ base: cfg.base, token: cfg.token, instanceId: cfg.instanceId, onEvent: dispatch });
  conn.workingDir = cfg.workingDir || null;
  conn.sessionId = cfg.sessionId || null;
  state.sessionId = conn.sessionId;
  if (!conn.workingDir) {
    // Gateway requires an absolute working dir. Ask for it before connecting.
    renderAll();
    return;
  }
  conn.start();
  restoreDraft();
  renderAll();
}

// --- phases / banners -------------------------------------------------------

let bannerTimer = null;
function onPhase(ev) {
  clearTimeout(bannerTimer);
  if (ev.phase === "unpaired") {
    showBanner("This phone is no longer paired with your Mac.", "error", "Re-pair", () => forget());
  } else if (ev.phase === "reconnecting") {
    // Avoid flashing the banner for blips: show only if it lasts.
    bannerTimer = setTimeout(() => showBanner(`Reconnecting to ${cfg.serverName || "jcode"}... ${ev.detail || ""}`, "warn", "Retry", () => conn && conn.kick()), 1200);
  } else if (ev.phase === "failed") {
    showBanner(ev.detail || "Connection failed.", "error", "Retry", () => conn && conn.start());
  } else if (ev.phase === "connected") {
    hideBanner();
  }
}

function showBanner(text, kind, actLabel, act) {
  const b = $("banner");
  b.dataset.kind = kind;
  b.innerHTML = `<span class="banner-text">${esc(text)}</span>${actLabel ? `<button class="banner-act" type="button">${esc(actLabel)}</button>` : ""}`;
  if (act) b.querySelector(".banner-act").onclick = act;
  b.hidden = false;
}
function hideBanner() {
  $("banner").hidden = true;
}

// --- rendering ----------------------------------------------------------------

const transcriptEl = $("transcript");
const scroller = $("scroller");
const nodes = new Map(); // entry id -> { el, v }
let stickToBottom = true;
let skipEnterAnim = true;

function renderAll() {
  if (app.dataset.view !== "chat") return;
  renderHeader();
  renderTranscript();
  renderComposer();
  renderStatus();
  renderDrawer();
  // Status line and composer can change height after the transcript scrolled.
  if (stickToBottom) scrollToBottom(false);
}

function sessionLabel(id = state.sessionId) {
  if (!id) return "new session";
  return state.sessionTitles[id] || (cfg.sessions || []).find((s) => s.id === id)?.title || friendlyName(id);
}

function shortDir(d) {
  if (!d) return "";
  return d.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

function renderHeader() {
  $("server-icon").textContent = state.serverIcon || "";
  $("session-name").textContent = sessionLabel();
  $("conn-dot").dataset.phase = state.phase;
  const model = state.model ? state.model.replace(/^claude-/, "") : "";
  $("session-sub").textContent = [shortDir(cfg.workingDir), model].filter(Boolean).join(" · ");
}

function renderTranscript() {
  const entries = state.entries;
  const empty = $("empty");
  const showEmpty = entries.length === 0 && state.phase === "connected";
  empty.hidden = !showEmpty;
  if (showEmpty) {
    $("empty-dir").textContent = shortDir(cfg.workingDir);
    renderSuggestions();
  }
  renderRecentDirs(showEmpty);
  if (!cfg.workingDir && entries.length === 0) {
    empty.hidden = false;
    $("empty-dir").textContent = "";
    $("suggestions").innerHTML = `<button class="chip" type="button" data-act="folder">Choose a project folder</button>`;
  }

  const wasNearBottom = stickToBottom || isNearBottom();
  const seen = new Set();
  let prev = null;
  for (const e of entries) {
    seen.add(e.id);
    let n = nodes.get(e.id);
    if (!n) {
      n = { el: document.createElement("div"), v: -1, fresh: !skipEnterAnim };
      nodes.set(e.id, n);
    }
    if (n.v !== e.v || n.role !== e.role || n.queued !== e.queued || n.dropped !== e.dropped) {
      paintEntry(n.el, e);
      if (n.fresh) n.el.classList.add("enter");
      n.v = e.v;
      n.role = e.role;
      n.queued = e.queued;
      n.dropped = e.dropped;
    }
    const expectedNext = prev ? prev.nextSibling : transcriptEl.firstChild;
    if (n.el !== expectedNext) transcriptEl.insertBefore(n.el, expectedNext);
    prev = n.el;
  }
  for (const [id, n] of nodes) {
    if (!seen.has(id)) {
      n.el.remove();
      nodes.delete(id);
    }
  }
  skipEnterAnim = false;
  if (stickToBottom || wasNearBottom) scrollToBottom(false);
  else if (entries.length) $("jump").classList.add("has-new");
}

function paintEntry(el, e) {
  if (e.role === "user") {
    el.className = `msg msg-user${e.queued ? " queued" : ""}${e.dropped ? " dropped" : ""}${e.peer ? " peer" : ""}`;
    const meta = e.queued ? "queued · sends after current step" : e.dropped ? "not sent · tap to edit" : e.peer ? "from another device" : "";
    const imgs = e.images && e.images.length ? `<div class="msg-images">${e.images.map((src) => `<img src="${esc(src)}" alt="Attached photo" />`).join("")}</div>` : "";
    el.innerHTML = imgs + esc(e.text) + (meta ? `<span class="meta">${meta}</span>` : "");
    if (e.dropped) el.dataset.retry = e.text;
    else delete el.dataset.retry;
    return;
  }
  if (e.role === "system") {
    el.className = "msg msg-system";
    el.dataset.kind = e.kind || "info";
    el.textContent = e.text;
    return;
  }
  // assistant: keep <details> open-state across re-renders
  const openIds = new Set([...el.querySelectorAll("details[open][data-key]")].map((d) => d.dataset.key));
  el.className = `msg msg-assistant${e.streaming ? " streaming" : ""}`;
  let html = "";
  if (e.reasoning) {
    const live = e.streaming && !e.reasoningDone;
    const open = openIds.has("reasoning") ? " open" : "";
    html += `<details class="reasoning" data-key="reasoning"${open}><summary>${chev()}${live ? `<span class="braille" data-spin>${FRAMES[tick]}</span> thinking` : "thought"}<span class="muted"> · ${e.reasoning.trim().split(/\s+/).length} words</span></summary><div class="reasoning-body">${esc(e.reasoning)}</div></details>`;
  }
  const parts = e.parts && e.parts.length ? e.parts : [];
  // group consecutive tools
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (p.kind === "text") {
      const isLast = i === parts.length - 1;
      html += `<div class="md">${renderMd(p.text, { streaming: e.streaming && isLast })}</div>`;
      i++;
      continue;
    }
    const group = [];
    while (i < parts.length && parts[i].kind === "tool") group.push(parts[i++].tool);
    html += renderToolGroup(group, openIds);
  }
  if (!e.streaming) html += renderChanges(fileChanges(e.tools), openIds, e.id);
  if (!e.streaming && e.stats && (e.stats.output_tokens || e.stats.input_tokens)) {
    html += `<div class="turn-meta"><span>↑${fmtTokens(e.stats.input_tokens)}</span><span>↓${fmtTokens(e.stats.output_tokens)}</span></div>`;
  }
  el.innerHTML = html;
}

const chev = () => `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;

function toolIcon(t) {
  switch (t.status) {
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "⊘";
    default:
      return `<span class="braille" data-spin>${FRAMES[tick]}</span>`;
  }
}

function toolTime(t) {
  if (!t.startedAt) return "";
  const ms = (t.endedAt || Date.now()) - t.startedAt;
  if (t.status !== "running" && t.status !== "pending" && ms < 1000) return "";
  return ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function renderTool(t, openIds) {
  const sum = toolSummary(t) || t.intent || "";
  const open = openIds.has(t.id) ? " open" : "";
  const input = t.input ? Object.fromEntries(Object.entries(t.input).filter(([k]) => k !== "intent")) : null;
  let body = "";
  if (t.intent && t.intent !== sum) body += `<div class="muted small">${esc(t.intent)}</div>`;
  if (t.name === "bash" && input && input.command) body += `<div><div class="label">command</div><pre>${esc(input.command)}</pre></div>`;
  else if (input && Object.keys(input).length) body += `<div><div class="label">input</div><pre>${esc(JSON.stringify(input, null, 2))}</pre></div>`;
  if (t.error) body += `<div><div class="label">error</div><pre class="err">${esc(t.error)}</pre></div>`;
  if (t.output) body += `<div><div class="label">output</div><pre>${esc(truncate(t.output, 20000))}</pre></div>`;
  else if (t.status === "running" || t.status === "pending") body += `<div class="muted small">running…</div>`;
  return `<details class="tool" data-key="${esc(t.id)}" data-status="${t.status}"${open}><summary><span class="t-icon">${toolIcon(t)}</span><span class="t-name">${esc(t.name)}</span><span class="t-sum">${esc(sum)}</span><span class="t-time" data-tool-time="${esc(t.id)}">${toolTime(t)}</span></summary><div class="tool-body">${body}</div></details>`;
}

function renderToolGroup(tools, openIds) {
  // Collapse long finished runs of tools into one expandable line.
  const allDone = tools.every((t) => t.status === "done");
  if (tools.length > 4 && allDone) {
    const key = `g-${tools[0].id}`;
    const open = openIds.has(key) ? " open" : "";
    const names = [...new Set(tools.map((t) => t.name))].slice(0, 4).join(", ");
    return `<details class="tool tool-group" data-key="${esc(key)}" data-status="done"${open}><summary><span class="t-icon">✓</span><span class="t-name">${tools.length} tool calls</span><span class="t-sum">${esc(names)}</span></summary><div class="tools">${tools.map((t) => renderTool(t, openIds)).join("")}</div></details>`;
  }
  return `<div class="tools">${tools.map((t) => renderTool(t, openIds)).join("")}</div>`;
}

// "N files changed" card under a finished reply, from its edit/write/patch calls.
const MAX_DIFF_LINES = 400;
function renderChanges(files, openIds, key) {
  if (!files.length) return "";
  const rel = (p) => (cfg.workingDir && p.startsWith(cfg.workingDir + "/") ? p.slice(cfg.workingDir.length + 1) : shortDir(p));
  const counts = (a, r) => `<span class="cf-n"><span class="d-add">+${a}</span><span class="d-del">−${r}</span></span>`;
  const label = (f) => ({ added: "new", deleted: "deleted", written: "rewritten", moved: `→ ${rel(f.to || "")}` })[f.status] || "";
  const ck = `c-${key}`;
  const rows = files
    .map((f) => {
      const fk = `cf-${key}-${f.path}`;
      const shown = f.diff.slice(0, MAX_DIFF_LINES);
      const diff = shown.map((l) => (l.t === "@" ? `<span class="d-sep">⋯</span>` : `<span class="d-${l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx"}">${esc(l.t + l.s)}</span>`)).join("\n");
      const more = f.diff.length > shown.length ? `\n<span class="d-sep">… ${f.diff.length - shown.length} more lines</span>` : "";
      return `<details class="cfile" data-key="${esc(fk)}"${openIds.has(fk) ? " open" : ""}><summary><span class="cf-path">${esc(rel(f.path))}</span>${label(f) ? `<span class="cf-tag">${esc(label(f))}</span>` : ""}${counts(f.added, f.removed)}</summary>${f.diff.length ? `<pre class="diff">${diff}${more}</pre>` : ""}</details>`;
    })
    .join("");
  const add = files.reduce((n, f) => n + f.added, 0);
  const del = files.reduce((n, f) => n + f.removed, 0);
  return `<details class="changes" data-key="${esc(ck)}"${openIds.has(ck) ? " open" : ""}><summary>${chev()}<span class="cf-title">${files.length} file${files.length === 1 ? "" : "s"} changed</span>${counts(add, del)}</summary><div class="changes-body">${rows}</div></details>`;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
}

// --- braille spinners + running timers (one ticker for all) ------------------

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let tick = 0;
let turnStartedAt = 0;
setInterval(() => {
  if (document.hidden) return;
  tick = (tick + 1) % FRAMES.length;
  for (const s of document.querySelectorAll("[data-spin]")) s.textContent = FRAMES[tick];
  if (tick % 3 === 0) {
    for (const el of document.querySelectorAll("[data-tool-time]")) {
      const f = findToolById(el.dataset.toolTime);
      if (f && (f.status === "running" || f.status === "pending")) el.textContent = toolTime(f);
    }
    renderStatusTime();
  }
}, 80);

function findToolById(id) {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const t = state.entries[i].tools && state.entries[i].tools.find((x) => x.id === id);
    if (t) return t;
  }
  return null;
}

// --- status line + composer ---------------------------------------------------

const input = $("input");
const sendBtn = $("send");

function renderStatus() {
  const el = $("status");
  const on = state.processing;
  if (on && !turnStartedAt) turnStartedAt = Date.now();
  if (!on) turnStartedAt = 0;
  el.classList.toggle("on", on);
  if (on) {
    if (!el.querySelector(".s-text")) el.innerHTML = `<span class="braille" data-spin>${FRAMES[tick]}</span><span class="s-text"></span><span class="s-time"></span>`;
    el.querySelector(".s-text").textContent = state.status || "working";
    renderStatusTime();
  }
}

function renderStatusTime() {
  const t = $("status").querySelector(".s-time");
  if (!t || !turnStartedAt) return;
  const s = Math.floor((Date.now() - turnStartedAt) / 1000);
  t.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function composerMode() {
  const hasText = input.value.trim().length > 0 || attachments.length > 0;
  if (state.processing) return hasText ? "queue" : "stop";
  return "send";
}

function renderComposer() {
  const mode = composerMode();
  sendBtn.dataset.mode = mode;
  sendBtn.setAttribute("aria-label", mode === "stop" ? "Stop" : mode === "queue" ? "Queue message" : "Send");
  sendBtn.disabled = mode === "send" && ((!input.value.trim() && !attachments.length) || !cfg.workingDir);
  input.placeholder = state.processing ? "Add a follow-up…" : cfg.workingDir ? "Message jcode" : "Choose a project folder first";
}

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px";
}

input.addEventListener("input", () => {
  autosize();
  saveDraft();
  renderComposer();
});

input.addEventListener("keydown", (e) => {
  // Enter sends on hardware keyboards; on phones Enter inserts a newline.
  const coarse = matchMedia("(pointer: coarse)").matches;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) {
    e.preventDefault();
    submit();
  }
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  submit();
});

function submit() {
  const mode = composerMode();
  if (mode === "stop") return stop();
  const typed = input.value.trim();
  if ((!typed && !attachments.length) || !conn || !cfg.workingDir) return;
  if (attachments.some((a) => a.pending)) return void toast("Still preparing the photo…");
  // jcode puts images in front of the text; a photo alone still needs a little text.
  const text = typed || (attachments.length > 1 ? "See the attached images." : "See the attached image.");
  const extra = attachments.length ? { images: attachments.map((a) => [a.mediaType, a.data]) } : {};
  const previews = attachments.map((a) => a.previewUrl);
  if (mode === "queue") {
    conn.send({ type: "soft_interrupt", content: text, urgent: false, ...extra });
    dispatch({ type: "local:user", text, images: previews, queued: true });
  } else {
    const id = conn.send({ type: "message", content: text, ...extra });
    pushWatch();
    cfg = store.save({ recentDirs: touchDir(cfg.recentDirs, cfg.workingDir) });
    dispatch({ type: "local:user", text, images: previews, requestId: id });
    if (!conn.connected) toast("Offline: will send when reconnected");
  }
  attachments = []; // previews stay alive: the sent bubble shows them
  renderAttachments();
  input.value = "";
  saveDraft();
  autosize();
  stickToBottom = true;
  scrollToBottom(true);
  haptic(8);
  renderComposer();
}

// --- photo attachments --------------------------------------------------------

let attachments = []; // { id, pending?, mediaType, data, previewUrl }
let attSeq = 0;
const fileInput = $("file");

$("attach").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  addImages([...fileInput.files]);
  fileInput.value = "";
});
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    e.preventDefault();
    addImages(files);
  }
});

async function addImages(files) {
  const room = MAX_IMAGES - attachments.length;
  if (files.length > room) toast(`Up to ${MAX_IMAGES} photos per message`);
  for (const file of files.slice(0, Math.max(0, room))) {
    const a = { id: ++attSeq, pending: true };
    attachments.push(a);
    renderAttachments();
    try {
      Object.assign(a, await prepareImage(file), { pending: false });
    } catch {
      attachments = attachments.filter((x) => x !== a);
      toast("Couldn't read that image");
    }
    renderAttachments();
  }
}

function renderAttachments() {
  const el = $("attachments");
  el.hidden = !attachments.length;
  el.innerHTML = attachments
    .map((a) => `<div class="att${a.pending ? " pending" : ""}">${a.previewUrl ? `<img src="${esc(a.previewUrl)}" alt="Photo to send" />` : `<span class="braille" data-spin>${FRAMES[tick]}</span>`}<button type="button" class="att-x" data-att-remove="${a.id}" aria-label="Remove photo">×</button></div>`)
    .join("");
  renderComposer();
}

$("attachments").addEventListener("click", (e) => {
  const b = e.target.closest("[data-att-remove]");
  if (!b) return;
  const a = attachments.find((x) => String(x.id) === b.dataset.attRemove);
  if (a && a.previewUrl) URL.revokeObjectURL(a.previewUrl);
  attachments = attachments.filter((x) => x !== a);
  renderAttachments();
});

function stop() {
  if (!conn) return;
  conn.send({ type: "cancel" });
  haptic([12, 30, 12]);
  toast("Stopping…");
}

// --- notifications ---------------------------------------------------------------
// Only while the page is alive: open, or in the background until the OS
// suspends it. A closed app is reached only through the optional push relay (below).

const notifyOn = () => !!cfg.notify && notifyStatus() === "granted";
const notifyHide = () => cfg.notifyHide !== false; // content hidden unless turned off

function notifyStatus() {
  if (!("Notification" in window)) return window.isSecureContext ? "unsupported" : "needs-https";
  return Notification.permission; // "granted" | "denied" | "default"
}

function onTurnMaybeEnded(wasProcessing, ev) {
  if (!document.hidden && document.hasFocus()) return; // you are looking at it
  const n = turnNotice(wasProcessing, state, ev, { hideContent: notifyHide(), label: sessionLabel() });
  if (!n) return;
  if (navigator.setAppBadge) navigator.setAppBadge(1).catch(() => {});
  if (notifyOn() && !cfg.push) showNotification(n); // with push on, the relay sends it (no duplicates)
}

async function showNotification({ title, body, tag }) {
  const opts = { body, tag, renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: location.href.split("#")[0] } };
  // Android Chrome only allows notifications from the service worker
  // (`new Notification` throws there); desktop browsers allow both.
  try {
    const reg = "serviceWorker" in navigator && (await Promise.race([navigator.serviceWorker.getRegistration(), new Promise((r) => setTimeout(r, 1000))]));
    if (reg && reg.showNotification) return await reg.showNotification(title, opts);
  } catch {
    /* fall through */
  }
  try {
    const note = new Notification(title, opts);
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    /* not allowed here */
  }
}

function clearAttention() {
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
}

// --- push (optional) ----------------------------------------------------------------
// With tools/push-relay.py running on the Mac, notifications also arrive when
// jPhone is closed. The relay sits behind serve.py at /push/ (same origin, no
// CSP change) and checks our device token against jcode before doing anything.

const pushCapable = () => window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let pushEndpoint = null; // this browser's subscription endpoint, once known

async function pushApi(path, body) {
  const r = await fetch(`push/${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token || ""}` } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  let j = {};
  try {
    j = await r.json();
  } catch {
    /* not json: no relay behind this server */
  }
  if (!r.ok) throw new Error(j.error || (r.status === 404 || r.status === 405 ? "No push relay behind this server (tools/push-relay.py)." : `HTTP ${r.status}`));
  return j;
}

async function pushEnable() {
  const info = await pushApi("info");
  if (!info.vapid_key) throw new Error("The push relay did not send its key.");
  const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (p !== "granted") throw new Error("Notifications are not allowed for jPhone.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, info.vapid_key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub = sub || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(info.vapid_key) }));
  await pushApi("subscribe", subscriptionBody(sub, notifyHide()));
  pushEndpoint = sub.endpoint;
  cfg = store.save({ push: true });
  pushWatch();
  pushSeen(true);
}

async function pushDisable() {
  cfg = store.save({ push: false });
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await pushApi("unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {
    /* already gone */
  }
  pushEndpoint = null;
}

// Re-send the subscription (the hide setting changed, or the relay restarted fresh).
async function pushResync() {
  if (!cfg.push || !pushCapable()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return void (cfg = store.save({ push: false }));
    pushEndpoint = sub.endpoint;
    await pushApi("subscribe", subscriptionBody(sub, notifyHide()));
  } catch {
    /* relay offline: try again next start */
  }
}

// Ask the relay to watch the session we just wrote in. Best effort.
function pushWatch() {
  if (!cfg.push || !state.sessionId) return;
  pushApi("watch", { session_id: state.sessionId }).catch(() => {});
}

// On screen -> the relay holds pushes for this phone (you are looking at it).
let seenTimer = null;
function pushSeen(visible) {
  clearInterval(seenTimer);
  if (!cfg.push || !pushEndpoint) return;
  const ping = (v) => pushApi("seen", { endpoint: pushEndpoint, visible: v }).catch(() => {});
  ping(visible);
  if (visible) seenTimer = setInterval(() => !document.hidden && ping(true), 30000);
}

function clearAttentionAndSeen() {
  clearAttention();
  pushSeen(true);
}

// drafts
function saveDraft() {
  const key = state.sessionId || "new";
  if (input.value) drafts[key] = input.value;
  else delete drafts[key];
  store.save({ drafts });
}
function restoreDraft() {
  const key = state.sessionId || "new";
  if (document.activeElement === input && input.value) return;
  input.value = drafts[key] || "";
  autosize();
}

// --- scrolling ---------------------------------------------------------------

function isNearBottom() {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
}
function scrollToBottom(smooth) {
  // `scroll-behavior` may be smooth; force an instant jump unless asked.
  if (smooth) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  else scroller.scrollTop = scroller.scrollHeight;
  $("jump").hidden = true;
  $("jump").classList.remove("has-new");
}
scroller.addEventListener(
  "scroll",
  () => {
    const near = isNearBottom();
    // Only a user scroll can unstick; content growing below must not.
    if (userScrolling) stickToBottom = near;
    $("jump").hidden = near;
    if (near) $("jump").classList.remove("has-new");
  },
  { passive: true }
);
let userScrolling = false;
let userScrollTimer = null;
for (const evName of ["touchstart", "wheel", "mousedown"]) {
  scroller.addEventListener(
    evName,
    () => {
      userScrolling = true;
      clearTimeout(userScrollTimer);
    },
    { passive: true }
  );
}
for (const evName of ["touchend", "mouseup"]) {
  scroller.addEventListener(evName, () => {
    clearTimeout(userScrollTimer);
    // momentum scrolling keeps going briefly after the finger lifts
    userScrollTimer = setTimeout(() => (userScrolling = false), 700);
  });
}
scroller.addEventListener("wheel", () => {
  clearTimeout(userScrollTimer);
  userScrollTimer = setTimeout(() => (userScrolling = false), 300);
}, { passive: true });
$("jump").addEventListener("click", () => {
  stickToBottom = true;
  scrollToBottom(true);
});

// keep the latest message visible when the keyboard opens or the footer grows.
// iOS Safari does not shrink the layout for the keyboard (it pans the page
// instead), so size the app to the *visual* viewport and undo the pan.
if (window.visualViewport) {
  const fit = () => {
    const vv = visualViewport;
    app.style.height = `${vv.height}px`;
    app.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : "";
    // safe-area bottom inset is under the keyboard while it is open
    document.documentElement.classList.toggle("kb-open", window.innerHeight - vv.height > 120);
    if (stickToBottom) scrollToBottom(false);
  };
  visualViewport.addEventListener("resize", fit);
  visualViewport.addEventListener("scroll", fit);
  fit();
}
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => {
    document.documentElement.style.setProperty("--composer-h", `${document.querySelector(".composer-wrap").offsetHeight}px`);
    if (stickToBottom && app.dataset.view === "chat") scrollToBottom(false);
  });
  ro.observe(document.querySelector(".composer-wrap"));
  ro.observe(transcriptEl);
  ro.observe(scroller); // its own height shrinks when the footer or keyboard grows
}

// --- copy buttons + chips ------------------------------------------------------

document.addEventListener("click", async (e) => {
  const copyBtn = e.target.closest("[data-copy]");
  if (copyBtn) {
    const code = copyBtn.closest(".code")?.querySelector("code")?.textContent || "";
    await copyText(code);
    copyBtn.textContent = "copied";
    copyBtn.classList.add("done");
    setTimeout(() => {
      copyBtn.textContent = "copy";
      copyBtn.classList.remove("done");
    }, 1400);
    return;
  }
  const copyText2 = e.target.closest("[data-copy-text]");
  if (copyText2) {
    await copyText(copyText2.dataset.copyText);
    toast("Copied");
    return;
  }
  const act = e.target.closest("[data-act]");
  const retry = !act && e.target.closest("[data-retry]");
  if (retry) {
    input.value = retry.dataset.retry;
    autosize();
    input.focus();
    renderComposer();
    return;
  }
  if (act) {
    if (act.dataset.act === "folder") openFolderSheet(!cfg.workingDir);
    if (act.dataset.act === "use-dir") useFolder(act.dataset.dir);
    if (act.dataset.act === "suggest") {
      input.value = act.dataset.text;
      autosize();
      input.focus();
      renderComposer();
    }
  }
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // http fallback (clipboard API needs https)
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    try {
      document.execCommand("copy");
    } catch {
      /* ignore */
    }
    ta.remove();
  }
  haptic(6);
}

// Other recent folders, one tap away while a session is still empty.
function renderRecentDirs(show) {
  const el = $("recent-dirs");
  const others = show ? (cfg.recentDirs || []).filter((d) => d.dir !== cfg.workingDir).slice(0, 4) : [];
  const html = others.length ? `<div class="section-label">Recent projects</div>${others.map((d) => `<button class="chip chip-dir" type="button" data-act="use-dir" data-dir="${esc(d.dir)}">${esc(shortDir(d.dir))}</button>`).join("")}` : "";
  if (el.innerHTML !== html) el.innerHTML = html;
  el.hidden = !html;
}

const SUGGESTIONS = ["What's in this project?", "Run the tests and fix failures", "Summarize recent git changes", "Find TODOs worth doing"];
function renderSuggestions() {
  const el = $("suggestions");
  if (el.dataset.filled) return;
  el.dataset.filled = "1";
  el.innerHTML = SUGGESTIONS.map((s) => `<button class="chip" type="button" data-act="suggest" data-text="${esc(s)}">${esc(s)}</button>`).join("");
}

// --- drawer ---------------------------------------------------------------------

const drawer = $("drawer");
const scrim = $("scrim");
function openDrawer() {
  renderDrawer();
  scrim.hidden = false;
  void drawer.offsetWidth; // commit the closed position so the slide animates
  scrim.classList.add("on");
  drawer.classList.add("on");
  drawer.setAttribute("aria-hidden", "false");
  if (conn && conn.connected && conn.refreshMeta) conn.refreshMeta(); // which sessions are open on the Mac
  clearInterval(drawerRefresh);
  drawerRefresh = setInterval(() => conn && conn.connected && conn.refreshMeta && conn.refreshMeta(), 5000);
}
let drawerRefresh = null;
function closeDrawer() {
  clearInterval(drawerRefresh);
  scrim.classList.remove("on");
  drawer.classList.remove("on");
  drawer.setAttribute("aria-hidden", "true");
  setTimeout(() => (scrim.hidden = true), 250);
}
$("btn-sessions").addEventListener("click", openDrawer);
$("btn-title").addEventListener("click", openSessionSheet);
scrim.addEventListener("click", closeDrawer);

// swipe: from left edge to open, left on drawer to close
let touchStart = null;
document.addEventListener(
  "touchstart",
  (e) => {
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY, open: drawer.classList.contains("on") };
  },
  { passive: true }
);
document.addEventListener(
  "touchend",
  (e) => {
    if (!touchStart || app.dataset.view !== "chat") return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = Math.abs(t.clientY - touchStart.y);
    if (!touchStart.open && touchStart.x < 28 && dx > 60 && dy < 50) openDrawer();
    else if (touchStart.open && dx < -60 && dy < 50) closeDrawer();
    touchStart = null;
  },
  { passive: true }
);

function relTime(ms) {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function renderDrawer() {
  $("drawer-server").textContent = `${state.serverIcon || ""} ${state.serverName || cfg.serverName || "jcode"}`.trim();
  $("drawer-version").textContent = [cfg.host, (state.serverVersion || cfg.serverVersion || "").replace(/\s*\(unknown\)/g, "")].filter(Boolean).join(" · ");
  $("drawer-dir").textContent = shortDir(cfg.workingDir) || "Choose a folder…";
  $("drawer-model-name").textContent = state.model || "";

  // Merge live sessions from the server with sessions this phone remembers.
  const live = new Set(state.allSessions);
  const known = new Map((cfg.sessions || []).map((s) => [s.id, s]));
  const ids = [...new Set([...(state.sessionId ? [state.sessionId] : []), ...state.allSessions, ...known.keys()])];
  // Sessions currently loaded in jcode on the Mac come first, then most recent.
  ids.sort((a, b) => (live.has(b) - live.has(a)) || (known.get(b)?.at || sessionCreatedAt(b) || 0) - (known.get(a)?.at || sessionCreatedAt(a) || 0));
  const list = $("session-list");
  if (!ids.length) {
    list.innerHTML = `<li class="empty-row">No sessions yet.</li>`;
    return;
  }
  list.innerHTML = ids
    .slice(0, 50)
    .map((id) => {
      const k = known.get(id);
      const when = relTime(k?.at || sessionCreatedAt(id));
      const where = [live.has(id) ? "open on Mac" : "", k?.dir ? shortDir(k.dir) : ""].filter(Boolean).join(" · ");
      const titled = state.sessionTitles[id] || k?.title;
      const sub = !titled && k?.preview ? [when, live.has(id) ? "open on Mac" : "", k.preview].filter(Boolean).join(" · ") : [when, where].filter(Boolean).join(" · ");
      return `<li class="${id === state.sessionId ? "current" : ""}${live.has(id) ? " live" : ""}"><button type="button" data-session="${esc(id)}"><span class="s-dot"></span><span class="s-main"><span class="s-name">${esc(sessionLabel(id))}</span><span class="s-when">${esc(sub)}</span></span></button></li>`;
    })
    .join("");
}

$("session-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-session]");
  if (!b) return;
  const id = b.dataset.session;
  closeDrawer();
  if (id === state.sessionId) return;
  const k = (cfg.sessions || []).find((s) => s.id === id);
  if (k && k.dir && k.dir !== cfg.workingDir) {
    cfg = store.save({ workingDir: k.dir });
    conn.workingDir = k.dir;
  }
  switchTo(id);
});

function switchTo(sessionId) {
  saveDraft();
  nodes.clear();
  skipEnterAnim = true;
  transcriptEl.innerHTML = "";
  dispatch({ type: "local:reset", sessionId });
  cfg = store.save({ sessionId });
  conn.switchSession(sessionId);
  restoreDraft();
  haptic(8);
}

function newSession() {
  closeDrawer();
  switchTo(null);
  setTimeout(() => input.focus(), 50);
}
$("btn-new").addEventListener("click", newSession);
$("drawer-new").addEventListener("click", newSession);
$("drawer-dir").addEventListener("click", () => {
  closeDrawer();
  openFolderSheet(false);
});
$("drawer-model").addEventListener("click", () => {
  closeDrawer();
  openModelSheet();
});
$("drawer-settings").addEventListener("click", () => {
  closeDrawer();
  openSettingsSheet();
});
$("drawer-unpair").addEventListener("click", () => {
  if (confirm("Forget this Mac? You'll need a new code from `jcode pair` to reconnect.")) forget();
});

function forget() {
  if (conn) conn.stop();
  conn = null;
  const { deviceId, instanceId, host, port } = store.load();
  store.clear();
  cfg = store.save({ deviceId, instanceId, host, port });
  for (const k of Object.keys(drafts)) delete drafts[k];
  nodes.clear();
  transcriptEl.innerHTML = "";
  state = initialState();
  closeDrawer();
  hideBanner();
  initPairing();
}

// --- sheets ----------------------------------------------------------------------

const sheet = $("sheet");
function openSheet(title, bodyHtml, onMount) {
  $("sheet-title").textContent = title;
  $("sheet-body").innerHTML = bodyHtml;
  if (!sheet.open) sheet.showModal();
  onMount && onMount($("sheet-body"));
}
sheet.addEventListener("click", (e) => {
  if (e.target === sheet) sheet.close(); // tap backdrop
});

// Switch jcode to a project folder. jcode takes it as `working_dir` when a
// session starts, so a different folder means a new session.
function useFolder(dir) {
  const changed = dir !== cfg.workingDir;
  cfg = store.save({ workingDir: dir, recentDirs: touchDir(cfg.recentDirs, dir) });
  if (sheet.open) sheet.close();
  if (!conn) return;
  conn.workingDir = dir;
  if (conn.stopped) conn.start();
  else if (changed) switchTo(null);
  renderAll();
  toast(`Working in ${shortDir(dir)}`);
}

function openFolderSheet(required) {
  const recent = (cfg.recentDirs || []).map((d) => d.dir);
  const guess = cfg.workingDir || (recent[0] ? recent[0].replace(/[^/]+$/, "") : "/Users/");
  openSheet(
    "Project folder",
    `<p class="muted small flush">jcode works inside this folder on your Mac. Use the full path.</p>
     <label class="field"><span>Absolute path</span><input id="dir-input" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url" value="${esc(guess)}" placeholder="/Users/you/code/project"/></label>
     ${recent.length ? `<div class="section-label tight">Recent</div><ul class="opt-list dir-list">${recent.map((d) => `<li><button type="button" data-dir="${esc(d)}" class="${d === cfg.workingDir ? "current" : ""}"><span>${esc(shortDir(d))}</span></button><button type="button" class="x-btn" data-forget-dir="${esc(d)}" aria-label="Remove ${esc(shortDir(d))} from recent">×</button></li>`).join("")}</ul>` : ""}
     <p id="dir-err" class="error-text"></p>
     <div class="sheet-actions">${required ? "" : `<button class="btn" value="cancel">Cancel</button>`}<button id="dir-ok" class="btn btn-primary" type="button">Use folder</button></div>`,
    (body) => {
      const inp = body.querySelector("#dir-input");
      const commit = (raw) => {
        const dir = cleanDir(raw);
        if (!dir) return void (body.querySelector("#dir-err").textContent = "Use an absolute path, starting with /");
        useFolder(dir);
      };
      body.querySelector("#dir-ok").onclick = () => commit(inp.value);
      inp.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), commit(inp.value)));
      body.querySelectorAll("[data-dir]").forEach((b) => (b.onclick = () => commit(b.dataset.dir)));
      body.querySelectorAll("[data-forget-dir]").forEach(
        (b) =>
          (b.onclick = () => {
            cfg = store.save({ recentDirs: forgetDir(cfg.recentDirs, b.dataset.forgetDir) });
            b.closest("li").remove();
          })
      );
      setTimeout(() => {
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }, 60);
    }
  );
}

// Tapping the title: details + actions for the current session.
function openSessionSheet() {
  if (!state.sessionId) return openDrawer();
  const title = sessionLabel();
  const t = state.tokens;
  openSheet(
    "This session",
    `<label class="field"><span>Name</span><input id="rename-input" value="${esc(state.sessionTitles[state.sessionId] || "")}" placeholder="${esc(title)}" maxlength="80" autocapitalize="sentences" enterkeyhint="done"/></label>
     <ul class="opt-list">
       <li><button type="button" data-sact="model"><span>Model</span><span class="muted">${esc(state.model || "—")}</span></button></li>
       <li><button type="button" data-sact="folder"><span>Folder</span><span class="muted">${esc(shortDir(cfg.workingDir))}</span></button></li>
       <li><button type="button" data-sact="copy"><span>Copy session id</span><span class="muted">${esc(friendlyName(state.sessionId))}</span></button></li>
     </ul>
     <p class="muted small flush">Tokens this session: ↑${fmtTokens(t.input)} ↓${fmtTokens(t.output)}</p>
     <div class="sheet-actions"><button class="btn" value="cancel">Close</button><button id="rename-ok" class="btn btn-primary" type="button">Save name</button></div>`,
    (body) => {
      const inp = body.querySelector("#rename-input");
      const save = () => {
        const v = inp.value.trim();
        conn.send({ type: "rename_session", title: v || null });
        sheet.close();
        toast(v ? `Renamed to “${v}”` : "Name cleared");
      };
      body.querySelector("#rename-ok").onclick = save;
      inp.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), save()));
      body.querySelectorAll("[data-sact]").forEach(
        (b) =>
          (b.onclick = async () => {
            const a = b.dataset.sact;
            if (a === "model") openModelSheet();
            if (a === "folder") openFolderSheet(false);
            if (a === "copy") {
              await copyText(state.sessionId);
              sheet.close();
              toast("Session id copied");
            }
          })
      );
    }
  );
}

function openSettingsSheet() {
  const st = notifyStatus();
  const why = {
    "needs-https": "Browsers only allow notifications on HTTPS pages. See “Optional: HTTPS” in the README.",
    unsupported: "This browser has no notifications. On iPhone, add jPhone to the Home Screen first (Share → Add to Home Screen) and open it from there.",
    denied: "Notifications are blocked for this site. Allow them in the browser's site settings.",
  }[st];
  const onOff = (v) => (v ? "On" : "Off");
  openSheet(
    "Settings",
    `<div class="section-label tight">Notifications</div>
     <ul class="opt-list">
       <li><button type="button" data-set="notify"${why ? " disabled" : ""}><span>Notify when jcode finishes</span><span class="muted">${why ? "unavailable" : onOff(notifyOn())}</span></button></li>
       <li><button type="button" data-set="hide"><span>Hide message content</span><span class="muted">${onOff(notifyHide())}</span></button></li>
       ${notifyOn() ? `<li><button type="button" data-set="test"><span>Send a test notification</span><span></span></button></li>` : ""}
     </ul>
     <p class="muted small flush">${why ? esc(why) : "Works while jPhone is open or recently in the background. Phones suspend background pages after a while. For a closed app, use Push below."}</p>
     <div class="section-label tight">Push (optional)</div>
     <ul class="opt-list">
       <li><button type="button" data-set="push"${pushCapable() ? "" : " disabled"}><span>Notify even when jPhone is closed</span><span class="muted">${pushCapable() ? onOff(!!cfg.push) : "unavailable"}</span></button></li>
       ${cfg.push ? `<li><button type="button" data-set="push-test"><span>Send a test push</span><span></span></button></li>` : ""}
     </ul>
     <p class="muted small flush">${pushCapable() ? "Needs the push relay running on the Mac (<code>tools/push-relay.py</code>, see README). Messages are end-to-end encrypted, but go through your browser's push service (Apple, Google or Mozilla)." : "Needs HTTPS, and on iPhone jPhone added to the Home Screen (iOS 16.4 or later)."}</p>
     <div class="section-label tight">App lock</div>
     <ul class="opt-list">
       ${
         !lockAvailable()
           ? `<li><button type="button" disabled><span>PIN lock</span><span class="muted">needs HTTPS</span></button></li>`
           : cfg.lock
             ? `<li><button type="button" data-set="lock-now"><span>Lock now</span><span></span></button></li>
                <li><button type="button" data-set="pin"><span>Change PIN</span><span></span></button></li>
                <li><button type="button" data-set="lock-off"><span>Turn off app lock</span><span class="muted">On</span></button></li>`
             : `<li><button type="button" data-set="pin"><span>Set a PIN</span><span class="muted">Off</span></button></li>`
       }
     </ul>
     <p class="muted small flush">Asks for the PIN when jPhone starts and after ${RELOCK_AFTER_MS / 60000} minutes away. If the phone is lost, revoke it on the Mac: <code>jcode pair --revoke</code>.</p>
     <div class="sheet-actions"><button class="btn" value="cancel">Done</button></div>`,
    (body) => {
      body.querySelectorAll("[data-set]").forEach(
        (b) =>
          (b.onclick = async () => {
            const a = b.dataset.set;
            if (a === "notify") {
              if (notifyOn()) cfg = store.save({ notify: false });
              else {
                const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
                cfg = store.save({ notify: p === "granted" });
                if (p !== "granted") toast("Notifications not allowed");
              }
            }
            if (a === "hide") {
              cfg = store.save({ notifyHide: !notifyHide() });
              pushResync();
            }
            if (a === "push") {
              b.disabled = true;
              try {
                if (cfg.push) {
                  await pushDisable();
                  toast("Push is off");
                } else {
                  await pushEnable();
                  toast("Push is on");
                }
              } catch (e) {
                cfg = store.save({ push: false });
                toast(e.message || "Could not turn on push");
              }
            }
            if (a === "push-test") {
              try {
                const r = await pushApi("test", {});
                toast(r.sent ? "Sent. Lock the phone to see it arrive." : "Nothing sent: is this phone subscribed?");
              } catch (e) {
                toast(e.message);
              }
            }
            if (a === "pin") return openPinSheet();
            if (a === "lock-now") return relock();
            if (a === "lock-off") {
              if (!confirm("Turn off the app lock? The device token will be stored unencrypted on this phone again.")) return;
              cfg = store.save({ lock: null });
              toast("App lock is off");
            }
            if (a === "test") showNotification({ title: "jcode finished", body: notifyHide() ? "Your turn. Open jPhone to see the reply." : "This is what a finished turn looks like.", tag: "jphone-test" });
            openSettingsSheet(); // re-render in place
          })
      );
    }
  );
}

function openModelSheet() {
  const models = state.models || [];
  const render = (q) =>
    models
      .filter((m) => !q || m.toLowerCase().includes(q.toLowerCase()))
      .map((m) => `<li><button type="button" data-model="${esc(m)}" class="${m === state.model ? "current" : ""}"><span>${esc(m)}</span>${m === state.model ? "<span>✓</span>" : ""}</button></li>`)
      .join("");
  openSheet(
    "Model",
    `<label class="field search"><input id="model-q" placeholder="Search ${models.length} models" autocapitalize="off" autocorrect="off" spellcheck="false"/></label><ul id="model-list" class="opt-list">${render("")}</ul>`,
    (body) => {
      const list = body.querySelector("#model-list");
      body.querySelector("#model-q").addEventListener("input", (e) => (list.innerHTML = render(e.target.value)));
      list.addEventListener("click", (e) => {
        const b = e.target.closest("[data-model]");
        if (!b) return;
        conn.send({ type: "set_model", model: b.dataset.model });
        sheet.close();
        toast(`Switching to ${b.dataset.model}`);
      });
    }
  );
}

// --- toast / haptics ------------------------------------------------------------

let toastTimer = null;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 1800);
}

function haptic(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// --- lifecycle -------------------------------------------------------------------

// The CSP in index.html only lets the page talk to port 7643. Say so instead of
// failing silently when someone runs the gateway on another port.
document.addEventListener("securitypolicyviolation", (e) => {
  if (!/^connect-src/.test(e.effectiveDirective || e.violatedDirective || "")) return;
  const msg = `Blocked by jPhone's security policy: ${e.blockedURI}. Only gateway port 7643 is allowed; edit connect-src in web/index.html to use another port.`;
  if (app.dataset.view === "pair") pairErr.textContent = msg;
  else showBanner(msg, "error");
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pushSeen(false);
    return void (hiddenAt = Date.now());
  }
  clearAttentionAndSeen();
  if (cfg.lock && cfg.token && hiddenAt && Date.now() - hiddenAt > RELOCK_AFTER_MS) relock();
  hiddenAt = 0;
  if (conn) conn.kick();
});
window.addEventListener("online", () => conn && conn.kick());
window.addEventListener("pageshow", (e) => e.persisted && conn && conn.kick());

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
// Push on: tell the relay we are here (also re-registers after a relay reset).
if (cfg.push && cfg.token) pushResync().then(() => !document.hidden && pushSeen(true));

// --- boot ------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
if (params.has("demo")) {
  // Offline demo: no gateway, no token, nothing persisted.
  import("./lib/demo.js").then(({ demoHistory, demoLive }) => {
    cfg = store.ephemeral({ workingDir: "/Users/you/code/booking-app", host: "your-mac.tailnet.ts.net", deviceId: "demo", instanceId: "demo" });
    conn = { send: () => 1, connected: true, kick() {}, stop() {}, switchSession() {} };
    setView("chat");
    dispatch({ type: "local:phase", phase: "connected" });
    if (params.get("demo") !== "empty") dispatch(demoHistory());
    if (params.get("demo") === "live") demoLive(dispatch);
    if (params.get("demo") === "drawer") setTimeout(openDrawer, 50);
  });
} else {
  // A pairing link (#pair=HOST:PORT:CODE, e.g. from the QR helper). Read it once,
  // then drop it from the address bar and history so the code does not linger.
  const link = parsePairFragment(location.hash);
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  if (link) initPairing("", link);
  else if (cfg.lock && cfg.base) showLock();
  else if (cfg.token && cfg.base) startChat();
  else initPairing();
  if (!link && cfg.token && !cfg.workingDir) setTimeout(() => openFolderSheet(true), 300);
}

// Debug hook for automated screenshots/tests.
window.__jphone = { get state() { return state; }, dispatch, store, events: eventLog, get conn() { return conn; } };
