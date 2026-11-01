// jPhone app shell: state store, rendering, interactions.
import { initialState, reduce, friendlyName, sessionCreatedAt, toolSummary, fmtTokens } from "./lib/reducer.js";
import { Connection, gatewayBase, checkHealth, pair } from "./lib/connection.js";
import { render as renderMd, esc } from "./lib/markdown.js";
import { parsePairFragment } from "./lib/pairlink.js";

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
        localStorage.setItem(STORE_KEY, JSON.stringify(memo));
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
  }
  if (ev.type === "local:phase") onPhase(ev);
  if (ev.type === "done" || ev.type === "error" || ev.type === "interrupted") onTurnMaybeEnded();
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
    cfg = store.save({ host, port: pairPort.value || "7643", base, token: res.token, serverName: res.server_name, serverVersion: res.server_version });
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
    el.innerHTML = esc(e.text) + (meta ? `<span class="meta">${meta}</span>` : "");
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
  const hasText = input.value.trim().length > 0;
  if (state.processing) return hasText ? "queue" : "stop";
  return "send";
}

function renderComposer() {
  const mode = composerMode();
  sendBtn.dataset.mode = mode;
  sendBtn.setAttribute("aria-label", mode === "stop" ? "Stop" : mode === "queue" ? "Queue message" : "Send");
  sendBtn.disabled = mode === "send" && (!input.value.trim() || !cfg.workingDir);
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
  const text = input.value.trim();
  if (!text || !conn || !cfg.workingDir) return;
  if (mode === "queue") {
    conn.send({ type: "soft_interrupt", content: text, urgent: false });
    dispatch({ type: "local:user", text, queued: true });
  } else {
    const id = conn.send({ type: "message", content: text });
    dispatch({ type: "local:user", text, requestId: id });
    if (!conn.connected) toast("Offline: will send when reconnected");
  }
  input.value = "";
  saveDraft();
  autosize();
  stickToBottom = true;
  scrollToBottom(true);
  haptic(8);
  renderComposer();
}

function stop() {
  if (!conn) return;
  conn.send({ type: "cancel" });
  haptic([12, 30, 12]);
  toast("Stopping…");
}

function onTurnMaybeEnded() {
  if (!state.processing && document.hidden && "Notification" in window && Notification.permission === "granted") {
    try {
      new Notification("jcode finished", { body: lastAssistantSnippet(), tag: "jphone-turn", icon: "icons/icon-192.png" });
    } catch {
      /* not allowed outside SW on some platforms */
    }
  }
}

function lastAssistantSnippet() {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i];
    if (e.role === "assistant" && e.text) return e.text.replace(/\s+/g, " ").slice(0, 140);
  }
  return "";
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

function openFolderSheet(required) {
  const recent = [...new Set([cfg.workingDir, ...(cfg.sessions || []).map((s) => s.dir)].filter(Boolean))].slice(0, 6);
  const guess = cfg.workingDir || "/Users/";
  openSheet(
    "Project folder",
    `<p class="muted small flush">jcode works inside this folder on your Mac. Use the full path.</p>
     <label class="field"><span>Absolute path</span><input id="dir-input" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url" value="${esc(guess)}" placeholder="/Users/you/code/project"/></label>
     ${recent.length ? `<div class="section-label tight">Recent</div><ul class="opt-list">${recent.map((d) => `<li><button type="button" data-dir="${esc(d)}" class="${d === cfg.workingDir ? "current" : ""}"><span>${esc(shortDir(d))}</span></button></li>`).join("")}</ul>` : ""}
     <p id="dir-err" class="error-text"></p>
     <div class="sheet-actions">${required ? "" : `<button class="btn" value="cancel">Cancel</button>`}<button id="dir-ok" class="btn btn-primary" type="button">Use folder</button></div>`,
    (body) => {
      const inp = body.querySelector("#dir-input");
      const commit = (dir) => {
        dir = dir.trim().replace(/\/+$/, "") || "/";
        if (!dir.startsWith("/")) {
          body.querySelector("#dir-err").textContent = "Use an absolute path, starting with /";
          return;
        }
        const changed = dir !== cfg.workingDir;
        cfg = store.save({ workingDir: dir });
        sheet.close();
        if (!conn) return;
        conn.workingDir = dir;
        if (conn.stopped) {
          conn.start();
        } else if (changed) {
          switchTo(null); // a new folder means a new session
        }
        renderAll();
        toast(`Working in ${shortDir(dir)}`);
      };
      body.querySelector("#dir-ok").onclick = () => commit(inp.value);
      inp.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), commit(inp.value)));
      body.querySelectorAll("[data-dir]").forEach((b) => (b.onclick = () => commit(b.dataset.dir)));
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
  if (!document.hidden && conn) conn.kick();
});
window.addEventListener("online", () => conn && conn.kick());
window.addEventListener("pageshow", (e) => e.persisted && conn && conn.kick());

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

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
  else if (cfg.token && cfg.base) startChat();
  else initPairing();
  if (!link && cfg.token && !cfg.workingDir) setTimeout(() => openFolderSheet(true), 300);
}

// Debug hook for automated screenshots/tests.
window.__jphone = { get state() { return state; }, dispatch, store, events: eventLog, get conn() { return conn; } };
