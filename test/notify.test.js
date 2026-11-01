// Turn-end notifications. Run: ./test/run.sh
import { initialState, reduce } from "../web/lib/reducer.js";
import { turnNotice } from "../web/lib/notify.js";

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

// Feed events like app.js does: remember `processing` before each one.
function play(events, opts) {
  let s = initialState();
  s.sessionId = "session_fox_1793479403131_abc";
  const notices = [];
  for (const ev of events) {
    const was = s.processing;
    s = reduce(s, ev);
    const n = turnNotice(was, s, ev, opts);
    if (n) notices.push(n);
  }
  return notices;
}

const turn = [
  { type: "local:user", text: "fix it", requestId: 7 },
  { type: "text_delta", text: "Fixed the **bug** in `app.js`.\n\n```js\nsecret()\n```\nAll tests pass." },
  { type: "done", id: 7, req_type: "message" },
];

test("finished turn notifies once, content hidden by default", () => {
  const n = play(turn);
  eq(n.length, 1);
  eq(n[0].title, "jcode finished");
  ok(!/bug|secret|tests/.test(n[0].body), "no message content: " + n[0].body);
  eq(n[0].tag, "jphone-session_fox_1793479403131_abc");
});

test("with content shown: first words of the reply, markdown and code stripped", () => {
  const [n] = play(turn, { hideContent: false, label: "fox" });
  eq(n.title, "jcode finished · fox");
  ok(n.body.startsWith("Fixed the bug in app.js."), n.body);
  ok(!n.body.includes("secret"), "code blocks are not quoted: " + n.body);
});

test("a Stop you pressed does not notify", () => {
  eq(play([turn[0], turn[1], { type: "interrupted" }]).length, 0);
});

test("an error that ends the turn notifies, hidden or not", () => {
  const evs = [turn[0], { type: "error", id: 7, req_type: "message", message: "rate limited by provider" }];
  eq(play(evs)[0].title, "jcode stopped with an error");
  ok(!play(evs)[0].body.includes("rate"), "hidden");
  ok(play(evs, { hideContent: false })[0].body.includes("rate limited"), "shown");
});

test("side-request acks and errors mid-turn do not notify", () => {
  const evs = [turn[0], { type: "done", id: 9, req_type: "get_history" }, { type: "error", id: 10, req_type: "rename_session", message: "x" }];
  eq(play(evs).length, 0);
});

test("a peer turn (started elsewhere) that ends here notifies", () => {
  const evs = [{ type: "state", is_processing: true }, { type: "text_delta", text: "hi" }, { type: "done", id: 3 }];
  eq(play(evs).length, 1);
});

print(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error("tests failed");
