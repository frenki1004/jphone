// Web Push helpers. Run: ./test/run.sh
import { urlB64ToBytes, subscriptionBody, sameKey, pushNotice } from "../web/lib/push.js";

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

// RFC 8291's example receiver key: 65 bytes, starts with 0x04.
const KEY = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

test("urlB64ToBytes decodes base64url without padding", () => {
  const b = urlB64ToBytes(KEY);
  eq(b.length, 65);
  eq(b[0], 4);
  eq(Array.from(urlB64ToBytes("-_8")), [251, 255]);
});

test("subscriptionBody keeps only endpoint and keys", () => {
  const sub = { toJSON: () => ({ endpoint: "https://web.push.apple.com/x", expirationTime: null, keys: { p256dh: KEY, auth: "BTBZMqHH6r4Tts7J_aSIgg", extra: 1 } }) };
  eq(subscriptionBody(sub, 1), { subscription: { endpoint: "https://web.push.apple.com/x", keys: { p256dh: KEY, auth: "BTBZMqHH6r4Tts7J_aSIgg" } }, hide: true });
  eq(subscriptionBody({ endpoint: "e", keys: { p256dh: "p", auth: "a" } }, false).hide, false);
});

test("sameKey compares the subscription's server key", () => {
  const sub = { options: { applicationServerKey: urlB64ToBytes(KEY).buffer } };
  ok(sameKey(sub, KEY));
  ok(!sameKey(sub, "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"));
  ok(sameKey({ options: {} }, KEY), "unknown key: keep the subscription");
});

test("pushNotice never throws and clamps fields", () => {
  eq(pushNotice('{"title":"jcode finished · fox","body":"pong","tag":"jphone-fox"}'), { title: "jcode finished · fox", body: "pong", tag: "jphone-fox" });
  eq(pushNotice("not json"), { title: "jcode", body: "not json", tag: "jphone" });
  eq(pushNotice(""), { title: "jcode", body: "", tag: "jphone" });
  eq(pushNotice(null), { title: "jcode", body: "", tag: "jphone" });
  eq(pushNotice('{"title":5,"body":{"x":1}}'), { title: "jcode", body: "", tag: "jphone" });
  eq(pushNotice(JSON.stringify({ body: "x".repeat(1000) })).body.length, 300);
});

test("sw.js carries the same pushNotice", () => {
  const sw = readFile("web/sw.js");
  const lib = readFile("web/lib/push.js");
  const body = (src) => {
    const i = src.indexOf("function pushNotice(data) {");
    ok(i >= 0, "pushNotice not found");
    return src.slice(i, src.indexOf("\n}\n", i));
  };
  eq(body(sw), body(lib));
  ok(sw.includes('addEventListener("push"'), "sw has a push handler");
  ok(sw.includes('"lib/push.js"'), "sw caches lib/push.js");
});

print(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} failed`);
