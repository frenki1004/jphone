// Pairing from scanned or pasted text. Run: ./test/run.sh
import { parsePairText } from "../web/lib/scan.js";

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

const want = { host: "mac.tail0ac473.ts.net", port: "7643", code: "340916" };

test("full link, as tools/pair-qr.py prints and the QR holds", () => {
  eq(parsePairText("https://mac.tail0ac473.ts.net/#pair=mac.tail0ac473.ts.net:7643:340916"), want);
  eq(parsePairText("  http://100.1.2.3:8765/#pair=mac.tail0ac473.ts.net:7643:340916\n"), want);
});

test("fragment only, and bare HOST:PORT:CODE", () => {
  eq(parsePairText("#pair=mac.tail0ac473.ts.net:7643:340916"), want);
  eq(parsePairText("pair=mac.tail0ac473.ts.net:7643:340916"), want);
  eq(parsePairText("mac.tail0ac473.ts.net:7643:340 916"), want);
  eq(parsePairText("[fd7a:115c::1]:7643:123456"), { host: "[fd7a:115c::1]", port: "7643", code: "123456" });
});

test("rejects anything else", () => {
  for (const bad of ["", null, "hello", "https://example.com/", "https://x/#other=1", "mac:7643:12345", "mac:99999:123456", "https://x/#pair=mac:7643"]) eq(parsePairText(bad), null, String(bad));
});

print(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} failed`);
