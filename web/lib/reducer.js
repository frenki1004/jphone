// Pure session state machine: (state, serverEvent) -> state.
// No DOM, no network. Tested headlessly against real gateway fixtures.

let nextLocalId = 1;
const lid = () => `e${nextLocalId++}`;

export function initialState() {
  return {
    phase: "idle", // idle | connecting | connected | reconnecting | failed
    phaseDetail: "",
    sessionId: null,
    sessionTitle: null,
    sessionTitles: {},
    allSessions: [],
    serverName: null,
    serverIcon: null,
    serverVersion: null,
    provider: null,
    model: null,
    models: [],
    effort: null,
    processing: false,
    activeRequestId: null, // id of the in-flight `message` request
    status: "", // short live status: "thinking", "running bash", ...
    tokens: { input: 0, output: 0 },
    entries: [], // transcript
    rev: 0, // bumps on every change, cheap dirty check
  };
}

// --- helpers -------------------------------------------------------------

function touch(entry) {
  entry.v = (entry.v || 0) + 1;
  return entry;
}

function lastStreaming(s) {
  // Queued follow-ups (and system notes) can sit after the streaming reply.
  for (let i = s.entries.length - 1; i >= 0; i--) {
    const e = s.entries[i];
    if (e.role === "assistant") return e.streaming ? e : null;
    if (e.role === "user" && !e.queued) return null;
  }
  return null;
}

function newAssistant(streaming) {
  // `parts` keeps text and tool calls in the order they happened:
  // text -> tool -> tool -> text. `text` and `tools` are flat views of it.
  return { id: lid(), role: "assistant", text: "", parts: [], reasoning: "", reasoningDone: !streaming, tools: [], streaming, v: 0 };
}

function appendText(e, str) {
  if (!str) return;
  const last = e.parts[e.parts.length - 1];
  if (last && last.kind === "text") last.text += str;
  else e.parts.push({ kind: "text", text: str });
  e.text += str;
}

function setText(e, str) {
  e.parts = e.parts.filter((p) => p.kind !== "text");
  e.text = "";
  appendText(e, str);
}

function addTool(e, tool) {
  e.tools.push(tool);
  e.parts.push({ kind: "tool", tool });
  return tool;
}

function streamingAssistant(s) {
  let e = lastStreaming(s);
  if (!e) {
    e = newAssistant(true);
    s.entries.push(e);
  }
  return e;
}

function finishStreaming(s) {
  const e = lastStreaming(s);
  if (!e) return;
  e.streaming = false;
  for (const t of e.tools) if (t.status === "running" || t.status === "pending") t.status = "cancelled";
  if (!e.text && !e.tools.length && !e.reasoning) s.entries.splice(s.entries.indexOf(e), 1);
  else touch(e);
}

function findTool(s, id) {
  for (let i = s.entries.length - 1; i >= 0; i--) {
    const e = s.entries[i];
    if (e.tools) {
      const t = e.tools.find((t) => t.id === id);
      if (t) return { entry: e, tool: t };
    }
  }
  return null;
}

function parseInput(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function system(s, text, kind = "info") {
  s.entries.push({ id: lid(), role: "system", kind, text, v: 0 });
}

export function friendlyName(sessionId) {
  if (!sessionId) return "";
  const m = /^session_([a-z0-9-]+?)_(\d{10,})_/i.exec(sessionId);
  return m ? m[1] : sessionId.replace(/^session_/, "").slice(0, 16);
}

export function sessionCreatedAt(sessionId) {
  const m = /_(\d{12,14})_/.exec(sessionId || "");
  return m ? Number(m[1]) : null;
}

// --- history -------------------------------------------------------------

function historyToEntries(messages) {
  const out = [];
  let assistant = null; // tool results attach to the assistant turn they belong to
  const ensureAssistant = () => {
    if (!assistant) {
      assistant = newAssistant(false);
      out.push(assistant);
    }
    return assistant;
  };
  for (const m of messages || []) {
    if (m.role === "user") {
      assistant = null;
      if (m.content) out.push({ id: lid(), role: "user", text: m.content, v: 0 });
    } else if (m.role === "tool") {
      const d = m.tool_data || {};
      addTool(ensureAssistant(), {
        id: d.id || lid(),
        name: d.name || "tool",
        input: parseInput(d.input),
        rawInput: "",
        output: m.content || d.output || "",
        error: d.error || null,
        status: d.error ? "failed" : "done",
        intent: d.intent || (d.input && d.input.intent) || null,
      });
    } else if (m.role === "assistant") {
      const a = ensureAssistant();
      if (m.content) appendText(a, a.text ? "\n\n" + m.content : m.content);
      if (m.tool_calls && !m.tool_data) {
        // Legacy: names only.
        for (const name of m.tool_calls) addTool(a, { id: lid(), name, input: null, rawInput: "", output: "", status: "done" });
      }
      if (m.response_stats) a.stats = m.response_stats;
    } else if (m.role === "system" && m.content) {
      out.push({ id: lid(), role: "system", kind: "info", text: m.content, v: 0 });
    }
  }
  return out.filter((e) => e.role !== "assistant" || e.text || e.tools.length);
}

// --- reducer -------------------------------------------------------------

export function reduce(s, ev) {
  s.rev++;
  switch (ev.type) {
    // Local intents (prefixed with "local:") ---------------------------------
    case "local:phase":
      s.phase = ev.phase;
      s.phaseDetail = ev.detail || "";
      if (ev.phase === "connected") {
        // Request ids from a previous socket will never be answered on this one.
        // A turn still running server-side is re-detected via the `state` event,
        // and then ends on the next `done` (peer-turn rule below).
        s.activeRequestId = null;
      }
      if (ev.phase !== "connected") s.status = ev.phase === "failed" ? "" : s.status;
      return s;
    case "local:user": {
      const entry = { id: lid(), role: "user", text: ev.text, queued: !!ev.queued, v: 0 };
      if (ev.images && ev.images.length) entry.images = ev.images; // local preview URLs of attached photos
      s.entries.push(entry);
      if (!ev.queued) {
        s.activeRequestId = ev.requestId ?? null;
        s.processing = true;
        s.status = "thinking";
      }
      return s;
    }
    case "local:error":
      system(s, ev.text, "error");
      return s;
    case "local:reset":
      s.entries = [];
      s.processing = false;
      s.activeRequestId = null;
      s.status = "";
      s.sessionId = ev.sessionId || null;
      s.sessionTitle = null;
      return s;

    // Session / meta -----------------------------------------------------------
    case "session":
      s.sessionId = ev.session_id;
      return s;
    case "history": {
      s.sessionId = ev.session_id || s.sessionId;
      s.provider = ev.provider_name || s.provider;
      s.model = ev.provider_model || s.model;
      if (ev.available_models && ev.available_models.length) s.models = ev.available_models;
      if (ev.all_sessions && ev.all_sessions.length) s.allSessions = ev.all_sessions;
      s.serverName = ev.server_name || s.serverName;
      s.serverIcon = ev.server_icon || s.serverIcon;
      s.serverVersion = ev.server_version || s.serverVersion;
      s.effort = ev.reasoning_effort || s.effort;
      if (ev.display_title) {
        s.sessionTitle = ev.display_title;
        s.sessionTitles[s.sessionId] = ev.display_title;
      }
      if (Array.isArray(ev.total_tokens)) s.tokens = { input: ev.total_tokens[0], output: ev.total_tokens[1] };
      // A refresh requested only for the session list must not touch the
      // transcript: it would wipe a reply that is still streaming.
      if (ev.req_type === "get_history" && ev.meta_only) return s;
      const incoming = historyToEntries(ev.messages);
      if (ev.messages_base_count != null && ev.messages_base_count > 0) s.entries.push(...incoming);
      else s.entries = incoming;
      if (ev.was_interrupted) system(s, "The previous turn was interrupted.", "warn");
      return s;
    }
    case "state":
      if (ev.is_processing && !s.processing) {
        s.processing = true;
        s.status = "working";
      } else if (!ev.is_processing && s.processing && s.activeRequestId == null) {
        finishStreaming(s);
        s.processing = false;
        s.status = "";
      }
      return s;
    case "session_renamed": {
      // `title` is the custom name (null when cleared); display_title falls back to the animal name.
      const custom = ev.title || null;
      if (custom) s.sessionTitles[ev.session_id] = custom;
      else delete s.sessionTitles[ev.session_id];
      if (ev.session_id === s.sessionId) s.sessionTitle = custom;
      return s;
    }
    case "model_changed":
      if (ev.error) system(s, `Model change failed: ${ev.error}`, "error");
      else {
        s.model = ev.model;
        s.provider = ev.provider_name || s.provider;
      }
      return s;
    case "available_models_updated":
      if (ev.available_models && ev.available_models.length) s.models = ev.available_models;
      if (ev.provider_model) s.model = ev.provider_model;
      return s;
    case "tokens":
      s.tokens = {
        input: s.tokens.input + (ev.input || 0),
        output: s.tokens.output + (ev.output || 0),
      };
      return s;

    // Streaming ---------------------------------------------------------------
    case "connection_phase":
      if (s.processing) s.status = ev.phase === "sending request" ? "thinking" : ev.phase;
      return s;
    case "status_detail":
      if (s.processing) s.status = ev.detail;
      return s;
    case "reasoning_delta": {
      const e = streamingAssistant(s);
      e.reasoning += ev.text || "";
      s.status = "reasoning";
      touch(e);
      return s;
    }
    case "reasoning_done": {
      const e = lastStreaming(s);
      if (e) touch(Object.assign(e, { reasoningDone: true }));
      return s;
    }
    case "text_delta": {
      const e = streamingAssistant(s);
      appendText(e, ev.text || "");
      e.reasoningDone = true;
      s.status = "writing";
      touch(e);
      return s;
    }
    case "text_replace": {
      const e = streamingAssistant(s);
      setText(e, ev.text || "");
      touch(e);
      return s;
    }
    case "text_suffix_replace": {
      const e = lastStreaming(s);
      const last = e && e.parts[e.parts.length - 1];
      if (last && last.kind === "text" && last.text.endsWith(ev.old_text)) {
        last.text = last.text.slice(0, last.text.length - ev.old_text.length) + ev.new_text;
        e.text = e.text.slice(0, e.text.length - ev.old_text.length) + ev.new_text;
        touch(e);
      }
      return s;
    }
    case "tool_start": {
      const e = streamingAssistant(s);
      addTool(e, { id: ev.id, name: ev.name, input: null, rawInput: "", output: "", status: "pending", intent: null, startedAt: Date.now() });
      s.status = `preparing ${ev.name}`;
      touch(e);
      return s;
    }
    case "tool_input": {
      const f = findTool(s, ev.id);
      if (f) {
        f.tool.rawInput += ev.delta || "";
        const parsed = parseInput(f.tool.rawInput);
        if (parsed) {
          f.tool.input = parsed;
          f.tool.intent = parsed.intent || f.tool.intent;
        }
        touch(f.entry);
      }
      return s;
    }
    case "tool_exec": {
      const f = findTool(s, ev.id);
      if (f) {
        f.tool.status = "running";
        if (!f.tool.input) f.tool.input = parseInput(f.tool.rawInput);
        touch(f.entry);
      }
      s.status = `running ${ev.name}`;
      return s;
    }
    case "tool_done": {
      let f = findTool(s, ev.id);
      if (!f && s.processing) {
        // Started before a reconnect replaced the transcript: rebuild the card.
        const e = streamingAssistant(s);
        addTool(e, { id: ev.id, name: ev.name || "tool", input: null, rawInput: "", output: "", status: "running", intent: null });
        f = findTool(s, ev.id);
      }
      if (f) {
        f.tool.output = ev.output || "";
        f.tool.error = ev.error || null;
        f.tool.status = ev.error ? "failed" : "done";
        f.tool.endedAt = Date.now();
        touch(f.entry);
      }
      s.status = "thinking";
      return s;
    }
    case "message_end":
      return s;
    case "soft_interrupt_injected": {
      const q = s.entries.find((e) => e.role === "user" && e.queued && e.text === ev.content) || s.entries.find((e) => e.role === "user" && e.queued);
      // The reply before the follow-up is complete; new text starts a fresh reply below it.
      const prior = lastStreaming(s);
      if (prior) {
        prior.streaming = false;
        touch(prior);
      }
      if (q) {
        q.queued = false;
        touch(q);
        // Move the delivered message to the end so the conversation reads in order.
        s.entries.splice(s.entries.indexOf(q), 1);
        s.entries.push(q);
      } else if (ev.content) {
        s.entries.push({ id: lid(), role: ev.display_role === "system" ? "system" : "user", kind: "info", text: ev.content, v: 0 });
      }
      return s;
    }
    case "peer_user_message":
      finishStreaming(s);
      s.entries.push({ id: lid(), role: "user", text: ev.content, peer: true, v: 0 });
      s.processing = true;
      s.status = "thinking";
      return s;
    case "compaction":
      system(s, "Context compacted" + (ev.tokens_saved ? ` (saved ${fmtTokens(ev.tokens_saved)} tokens)` : ""), "info");
      return s;
    case "provider_guardrail":
      system(s, ev.message, "warn");
      return s;
    case "turn_stopped":
      // `interrupted` follows a user cancel and already says so. Show other reasons.
      if (ev.message && ev.reason !== "interrupted") system(s, ev.message, ev.reason === "failure" || ev.reason === "crash" ? "error" : "warn");
      return s;
    case "notification":
      system(s, `${ev.from_name || friendlyName(ev.from_session)}: ${ev.message}`, "info");
      return s;
    case "interrupted":
      finishStreaming(s);
      s.processing = false;
      s.activeRequestId = null;
      s.status = "";
      // Queued follow-ups never reached the agent.
      for (const e of s.entries) if (e.queued) touch(Object.assign(e, { queued: false, dropped: true }));
      system(s, "Stopped.", "warn");
      return s;
    case "soft_interrupts_cancelled":
      for (const e of s.entries) if (e.queued) touch(Object.assign(e, { queued: false, dropped: true }));
      return s;
    // `stdin_request` is deliberately ignored: jcode closes the command's stdin
    // if no reply arrives within 1.5s, far too short to answer from a phone.
    case "error": {
      // Errors for side requests (rename, set_model...) must not end the turn.
      const side = ev.req_type && ev.req_type !== "message";
      const endsTurn = !side && (s.activeRequestId == null || ev.id == null || ev.id === s.activeRequestId);
      if (endsTurn) {
        finishStreaming(s);
        s.processing = false;
        s.activeRequestId = null;
        s.status = "";
      }
      system(s, ev.message + (ev.retry_after_secs ? ` (retry in ${ev.retry_after_secs}s)` : ""), "error");
      return s;
    }
    case "done": {
      // `done` acks every request (subscribe, get_history, ...). Only the
      // completion of a `message` ends the turn: ours by id, or one we cannot
      // identify (started by another client, or before we reconnected).
      if (ev.req_type && ev.req_type !== "message") {
        s.rev--;
        return s;
      }
      const ours = s.activeRequestId != null && ev.id === s.activeRequestId;
      const peerTurn = s.activeRequestId == null && (s.processing || lastStreaming(s));
      if (ours || peerTurn) {
        finishStreaming(s);
        s.processing = false;
        s.activeRequestId = null;
        s.status = "";
        for (const e of s.entries) if (e.queued) touch(Object.assign(e, { queued: false }));
      }
      return s;
    }
    case "session_close_requested":
      finishStreaming(s);
      s.processing = false;
      system(s, ev.reason || "Server closed this session.", "warn");
      return s;
    default:
      s.rev--; // unknown events are ignored (forward compatible)
      return s;
  }
}

export function fmtTokens(n) {
  if (n == null) return "0";
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + "k";
  return (n / 1e6).toFixed(1) + "M";
}

// Short human summary for a tool call, used in collapsed cards.
export function toolSummary(t) {
  const i = t.input || {};
  const pick = (...keys) => {
    for (const k of keys) if (typeof i[k] === "string" && i[k]) return i[k];
    return "";
  };
  switch (t.name) {
    case "bash":
      return pick("command");
    case "read":
    case "write":
    case "edit":
    case "multiedit":
      return pick("file_path", "path");
    case "apply_patch":
      return (pick("patch_text").match(/\*\*\* (?:Update|Add|Delete) File: (.+)/) || [])[1] || "patch";
    case "agentgrep":
    case "grep":
      return pick("query", "pattern");
    case "webfetch":
      return pick("url");
    case "web_search":
    case "websearch":
      return pick("query");
    case "todo":
      return "update plan";
    default:
      return pick("intent", "query", "path", "file_path", "url", "command", "action");
  }
}
