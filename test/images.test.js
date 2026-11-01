// Photo attachment sizing. Run: ./test/run.sh
import { fitWithin, needsReencode, base64FromBytes, MAX_EDGE } from "../web/lib/images.js";

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

test("12 MP phone photo is scaled to the long-edge limit, aspect kept", () => {
  eq(fitWithin(4032, 3024), { w: MAX_EDGE, h: 1176 });
  eq(fitWithin(3024, 4032), { w: 1176, h: MAX_EDGE });
});

test("small images are never upscaled", () => {
  eq(fitWithin(800, 600), { w: 800, h: 600 });
});

test("re-encode only when needed", () => {
  eq(needsReencode({ type: "image/png", size: 300000, width: 1170, height: 1500 }), false, "small screenshot passes through");
  eq(needsReencode({ type: "image/jpeg", size: 4500000, width: 4032, height: 3024 }), true, "camera photo");
  eq(needsReencode({ type: "image/png", size: 5000000, width: 1500, height: 1500 }), true, "too many bytes");
  eq(needsReencode({ type: "image/heic", size: 900000, width: 1000, height: 800 }), true, "unsupported type");
});

test("base64 of bytes, including large buffers", () => {
  if (typeof btoa !== "function") return print("       (no btoa in this engine, skipped)");
  eq(base64FromBytes(new Uint8Array([104, 105, 33])), "aGkh");
  const big = new Uint8Array(100000).fill(65);
  eq(base64FromBytes(big).length, Math.ceil(100000 / 3) * 4);
});

print(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error("tests failed");
