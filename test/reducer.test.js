// Headless tests for the reducer. Run: ./test/run.sh (uses macOS JavaScriptCore, no Node needed)
import { initialState, reduce, friendlyName, toolSummary, fmtTokens } from "../web/lib/reducer.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    print(`  ok   ${name}`);
  } catch (e) {
    failed++;
    print(`  FAIL ${name}\n       ${e && e.message}`);
  }
}
function eq(a, b, msg = "") {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg} expected ${B} got ${A}`);
}
function ok(v, msg = "assertion failed") {
  if (!v) throw new Error(msg);
}
const ndjson = (path) =>
  readFile(path)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const run = (events, s = initialState()) => events.reduce(reduce, s);

const FIX = "spike/fixtures/";

test("real tool turn: user, tool card, streamed answer, idle at end", () => {
  const events = ndjson(FIX + "tool_turn.ndjson");
  const s = initialState();
  // subscribe + its done arrive before the user sends anything
  const firstMsgIdx = events.findIndex((e) => e.type === "ack" && e.id === 2);
  run(events.slice(0, firstMsgIdx), s);
  eq(s.processing, false, "not processing after subscribe done");
  ok(s.sessionId && s.sessionId.startsWith("session_orangutan"), "session id captured");

  reduce(s, { type: "local:user", text: "list files", requestId: 2 });
  ok(s.processing, "processing after send");
  run(events.slice(firstMsgIdx), s);

  eq(s.processing, false, "turn ended on done id=2");
  eq(s.entries.map((e) => e.role), ["user", "assistant"]);
  const a = s.entries[1];
  eq(a.streaming, false);
  eq(a.tools.length, 1);
  eq(a.tools[0].name, "bash");
  eq(a.tools[0].status, "done");
  eq(a.tools[0].input.command, "ls -A");
  ok(a.tools[0].output.includes("package.json"), "tool output kept");
  ok(a.text.startsWith("The current directory has"), "streamed text: " + a.text.slice(0, 40));
  ok(s.tokens.output > 0, "tokens counted");
});

test("history with tools renders as user + assistant(with tool card)", () => {
  const h = JSON.parse(readFile(FIX + "history_with_tools.json"));
  const s = run([h]);
  eq(s.entries.map((e) => e.role), ["user", "assistant"]);
  eq(s.entries[1].tools[0].name, "bash");
  eq(s.entries[1].tools[0].input.command, "ls -A");
  ok(s.entries[1].text.includes("6 entries"));
  eq(s.processing, false);
});

test("history captures server + model metadata", () => {
  const h = JSON.parse(readFile(FIX + "history.json"));
  const s = run([h]);
  eq(s.serverName, "devbox");
  ok(s.models.length > 10, "models list");
  ok(s.model, "model");
  ok(s.allSessions.length >= 1, "all sessions");
});

test("a `done` for get_history mid-turn does not end the turn", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "hi", requestId: 7 });
  reduce(s, { type: "text_delta", text: "Hel" });
  reduce(s, { type: "done", id: 8 });
  eq(s.processing, true, "still processing");
  ok(s.entries[1].streaming, "still streaming");
  reduce(s, { type: "text_delta", text: "lo" });
  reduce(s, { type: "done", id: 7 });
  eq(s.processing, false);
  eq(s.entries[1].text, "Hello");
});

test("side-request error does not end the turn, turn error does", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "hi", requestId: 3 });
  reduce(s, { type: "error", id: 9, message: "rename failed" });
  eq(s.processing, true);
  reduce(s, { type: "error", id: 3, message: "provider down" });
  eq(s.processing, false);
  eq(s.entries.filter((e) => e.kind === "error").length, 2);
});

test("interrupt cancels running tools and ends turn", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "go", requestId: 1 });
  reduce(s, { type: "tool_start", id: "t1", name: "bash" });
  reduce(s, { type: "tool_exec", id: "t1", name: "bash" });
  reduce(s, { type: "interrupted" });
  eq(s.processing, false);
  eq(s.entries[1].tools[0].status, "cancelled");
  eq(s.entries[s.entries.length - 1].kind, "warn");
});

test("tool_input deltas assemble JSON incrementally", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "x", requestId: 1 });
  reduce(s, { type: "tool_start", id: "t", name: "read" });
  for (const d of ['{"file_', 'path":"src/ma', 'in.rs","intent":"Read main"}']) reduce(s, { type: "tool_input", id: "t", delta: d });
  const t = s.entries[1].tools[0];
  eq(t.input.file_path, "src/main.rs");
  eq(t.intent, "Read main");
  eq(toolSummary(t), "src/main.rs");
});

test("tool failure marks card failed", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "x", requestId: 1 });
  reduce(s, { type: "tool_start", id: "t", name: "bash" });
  reduce(s, { type: "tool_done", id: "t", name: "bash", output: "", error: "exit 1" });
  eq(s.entries[1].tools[0].status, "failed");
});

test("reasoning streams separately from text", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "x", requestId: 1 });
  reduce(s, { type: "reasoning_delta", text: "Let me think" });
  eq(s.status, "reasoning");
  reduce(s, { type: "reasoning_done" });
  reduce(s, { type: "text_delta", text: "Answer" });
  const a = s.entries[1];
  eq([a.reasoning, a.reasoningDone, a.text], ["Let me think", true, "Answer"]);
});

test("queued soft interrupt resolves on injection", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "task", requestId: 1 });
  reduce(s, { type: "local:user", text: "also do X", queued: true });
  eq(s.entries[1].queued, true);
  reduce(s, { type: "soft_interrupt_injected", content: "also do X", point: "after_tool" });
  eq(s.entries[1].queued, false);
});

test("text_replace and text_suffix_replace", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "x", requestId: 1 });
  reduce(s, { type: "text_delta", text: "Hello wrld" });
  reduce(s, { type: "text_suffix_replace", old_text: "wrld", new_text: "world" });
  eq(s.entries[1].text, "Hello world");
  reduce(s, { type: "text_replace", text: "Replaced" });
  eq(s.entries[1].text, "Replaced");
});

test("empty assistant stub is dropped on done", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "x", requestId: 1 });
  reduce(s, { type: "text_delta", text: "" });
  reduce(s, { type: "done", id: 1 });
  eq(s.entries.map((e) => e.role), ["user"]);
});

test("peer user message from another client starts a turn", () => {
  const s = initialState();
  reduce(s, { type: "peer_user_message", content: "from laptop" });
  eq(s.processing, true);
  reduce(s, { type: "text_delta", text: "ok" });
  reduce(s, { type: "done", id: 99 });
  eq(s.processing, false);
  eq(s.entries[0].peer, true);
});

test("unknown events are ignored", () => {
  const s = initialState();
  const rev = s.rev;
  reduce(s, { type: "kv_cache_request", foo: 1 });
  reduce(s, { type: "swarm_status", members: [] });
  eq(s.rev, rev);
  eq(s.entries.length, 0);
});

test("session_renamed sets and clears the custom title (live shapes)", () => {
  const s = initialState();
  const id = "session_rhino_1793478612553_abc";
  reduce(s, { type: "session", session_id: id });
  reduce(s, { type: "session_renamed", session_id: id, title: "Fix login", display_title: "Fix login" });
  eq(s.sessionTitle, "Fix login");
  eq(s.sessionTitles[id], "Fix login");
  reduce(s, { type: "session_renamed", session_id: id, display_title: "rhino" }); // title omitted = cleared
  eq(s.sessionTitle, null);
  eq(id in s.sessionTitles, false);
});

test("text and tools stay interleaved in order (live)", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "x", requestId: 1 });
  reduce(s, { type: "text_delta", text: "Let me look. " });
  reduce(s, { type: "tool_start", id: "a", name: "bash" });
  reduce(s, { type: "tool_done", id: "a", name: "bash", output: "ok" });
  reduce(s, { type: "text_delta", text: "Found " });
  reduce(s, { type: "text_delta", text: "it." });
  reduce(s, { type: "done", id: 1 });
  const p = s.entries[1].parts;
  eq(p.map((x) => x.kind), ["text", "tool", "text"]);
  eq(p[2].text, "Found it.");
  eq(s.entries[1].text, "Let me look. Found it.");
});

test("history: preamble text, tool, answer stay one turn in order", () => {
  const s = run([
    {
      type: "history",
      session_id: "s",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "Checking." },
        { role: "tool", content: "out", tool_data: { id: "t", name: "bash", input: { command: "ls" } } },
        { role: "assistant", content: "Done.", response_stats: { output_tokens: 5 } },
        { role: "user", content: "q2" },
      ],
    },
  ]);
  eq(s.entries.map((e) => e.role), ["user", "assistant", "user"]);
  eq(s.entries[1].parts.map((x) => x.kind), ["text", "tool", "text"]);
  eq(s.entries[1].stats.output_tokens, 5);
});

test("reconnect mid-turn: state resumes processing, next done ends it", () => {
  const s = initialState();
  reduce(s, { type: "local:phase", phase: "connected" });
  reduce(s, { type: "local:user", text: "long task", requestId: 3 });
  reduce(s, { type: "text_delta", text: "Working" });
  // phone sleeps, socket drops, comes back
  reduce(s, { type: "local:phase", phase: "reconnecting" });
  reduce(s, { type: "local:phase", phase: "connected" });
  eq(s.activeRequestId, null, "stale id cleared");
  reduce(s, { type: "done", id: 10 }); // subscribe ack on the new socket
  reduce(s, { type: "history", session_id: "x", messages: [{ role: "user", content: "long task" }, { role: "assistant", content: "Working" }] });
  eq(s.processing, false, "history alone does not claim a running turn");
  reduce(s, { type: "state", id: 12, session_id: "x", message_count: 2, is_processing: true });
  eq(s.processing, true, "state restores the running turn");
  reduce(s, { type: "text_delta", text: " more" });
  reduce(s, { type: "done", id: 3 }); // completion arrives
  eq(s.processing, false);
});

test("state is_processing=false does not cut our own fresh turn", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "go", requestId: 5 });
  reduce(s, { type: "state", is_processing: false });
  eq(s.processing, true);
});

test("resumed turn survives side-request acks (drawer refresh)", () => {
  const s = initialState();
  reduce(s, { type: "local:phase", phase: "connected" });
  reduce(s, { type: "done", id: 1, req_type: "subscribe" });
  reduce(s, { type: "state", is_processing: true });
  eq(s.processing, true);
  reduce(s, { type: "done", id: 7, req_type: "get_history" });
  eq(s.processing, true, "get_history ack must not end the turn");
  reduce(s, { type: "error", id: 8, req_type: "rename_session", message: "nope" });
  eq(s.processing, true, "side error must not end the turn");
  reduce(s, { type: "done", id: 999 }); // completion of the turn (unknown id)
  eq(s.processing, false);
});

test("real stop sequence: one 'Stopped.' line, queued follow-up marked not sent", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "sleep 20", requestId: 4 });
  reduce(s, { type: "tool_start", id: "t", name: "bash" });
  reduce(s, { type: "tool_exec", id: "t", name: "bash" });
  reduce(s, { type: "stdin_request", request_id: "r1", prompt: "", is_password: false, tool_call_id: "t" }); // ignored
  reduce(s, { type: "local:user", text: "also the date", queued: true });
  // exact order observed from the live server after `cancel`
  reduce(s, { type: "ack", id: 5 });
  reduce(s, { type: "turn_stopped", reason: "interrupted", message: "The turn was interrupted by a cancellation request." });
  reduce(s, { type: "interrupted" });
  reduce(s, { type: "done", id: 4 });
  eq(s.processing, false);
  const sys = s.entries.filter((e) => e.role === "system").map((e) => e.text);
  eq(sys, ["Stopped."]);
  const q = s.entries.find((e) => e.text === "also the date");
  eq([q.queued, q.dropped], [false, true]);
  eq(s.entries[1].tools[0].status, "cancelled");
});

test("non-interrupt turn_stopped reasons are shown", () => {
  const s = initialState();
  reduce(s, { type: "turn_stopped", reason: "limit_reached", message: "Usage limit reached" });
  eq(s.entries[0].text, "Usage limit reached");
});

test("queued follow-up: streaming continues in the reply above it until delivered", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "task", requestId: 1 });
  reduce(s, { type: "text_delta", text: "Part one." });
  reduce(s, { type: "local:user", text: "and X", queued: true });
  reduce(s, { type: "text_delta", text: " More." });
  eq(s.entries.map((e) => e.role), ["user", "assistant", "user"]);
  eq(s.entries[1].text, "Part one. More.");
  reduce(s, { type: "soft_interrupt_injected", content: "and X", point: "after_tool" });
  reduce(s, { type: "text_delta", text: "Doing X." });
  eq(s.entries.map((e) => e.role), ["user", "assistant", "user", "assistant"]);
  eq(s.entries[3].text, "Doing X.");
  reduce(s, { type: "done", id: 1 });
  eq(s.processing, false);
  eq(s.entries[1].streaming, false);
  eq(s.entries[3].streaming, false);
});

test("tool finishing after a reconnect still gets a card (live sequence)", () => {
  const s = initialState();
  reduce(s, { type: "local:phase", phase: "connected" });
  reduce(s, { type: "local:user", text: "sleep 8", requestId: 4 });
  reduce(s, { type: "tool_start", id: "toolu_X", name: "bash" });
  reduce(s, { type: "local:phase", phase: "reconnecting" });
  reduce(s, { type: "local:phase", phase: "connected" });
  reduce(s, { type: "history", id: 5, session_id: "s", messages: [{ role: "user", content: "sleep 8" }] });
  reduce(s, { type: "state", id: 7, is_processing: true });
  reduce(s, { type: "tool_done", id: "toolu_X", name: "bash", output: "survived" });
  reduce(s, { type: "text_delta", text: "back" });
  reduce(s, { type: "done", id: 4 });
  const a = s.entries.find((e) => e.role === "assistant");
  eq(a.parts.map((p) => p.kind), ["tool", "text"]);
  eq([a.tools[0].name, a.tools[0].status, a.tools[0].output], ["bash", "done", "survived"]);
  eq(s.processing, false);
});

test("drawer refresh updates open sessions without touching a streaming reply", () => {
  const s = initialState();
  reduce(s, { type: "local:user", text: "go", requestId: 1 });
  reduce(s, { type: "text_delta", text: "Halfway" });
  reduce(s, { type: "history", id: 9, req_type: "get_history", meta_only: true, session_id: "a", all_sessions: ["a", "b"], messages: [{ role: "user", content: "go" }] });
  eq(s.allSessions, ["a", "b"]);
  eq(s.entries.map((e) => e.role), ["user", "assistant"]);
  eq([s.entries[1].text, s.entries[1].streaming, s.processing], ["Halfway", true, true]);
});

test("helpers", () => {
  eq(friendlyName("session_orangutan_1793478576470_72404828c8ee1114"), "orangutan");
  eq(fmtTokens(950), "950");
  eq(fmtTokens(23093), "23k");
  eq(fmtTokens(1500), "1.5k");
  eq(toolSummary({ name: "apply_patch", input: { patch_text: "*** Begin Patch\n*** Update File: a/b.rs\n" } }), "a/b.rs");
});

print(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error("tests failed");
