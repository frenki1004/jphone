// Pairing-link parsing. Run: ./test/run.sh
import { parsePairFragment, pairLink } from "../web/lib/pairlink.js";

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

test("MagicDNS host, port and code", () => {
  eq(parsePairFragment("#pair=studio.tail1234.ts.net:7643:123456"), { host: "studio.tail1234.ts.net", port: "7643", code: "123456" });
});

test("Tailscale IPv4, IPv6 in brackets, URL-encoded, spaced code", () => {
  eq(parsePairFragment("#pair=100.101.102.103:7643:000111").host, "100.101.102.103");
  eq(parsePairFragment("#pair=[fd7a:115c:a1e0::1]:7643:123456").host, "[fd7a:115c:a1e0::1]");
  eq(parsePairFragment("#pair=studio%3A7643%3A123%20456"), { host: "studio", port: "7643", code: "123456" });
});

test("rejects anything that is not exactly host:port:6 digits", () => {
  for (const bad of ["", "#", "#pair=", "#pair=studio:7643", "#pair=studio:7643:12345", "#pair=studio:7643:1234567", "#pair=studio:0:123456", "#pair=studio:70000:123456", "#pair=evil.com/x:7643:123456", "#pair=a b:7643:123456", "#pair=javascript:alert(1)", "#pair=%E0%A4%A:1:123456", "#other=1"])
    eq(parsePairFragment(bad), null, bad);
});

test("pairLink builds what parsePairFragment reads", () => {
  const url = pairLink("https://studio.tail1234.ts.net/?x=1#old", "studio.tail1234.ts.net", 7643, "654321");
  eq(url, "https://studio.tail1234.ts.net/#pair=studio.tail1234.ts.net:7643:654321");
  eq(parsePairFragment(url.slice(url.indexOf("#"))), { host: "studio.tail1234.ts.net", port: "7643", code: "654321" });
});

print(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error("tests failed");
