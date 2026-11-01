// App lock crypto. Needs WebCrypto: runs under Node, skipped under JavaScriptCore's shell.
import { lockToken, unlockToken, lockoutSeconds, validPin, lockAvailable } from "../web/lib/lock.js";

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(
        () => {
          passed++;
          print(`  ok   ${name}`);
        },
        (e) => {
          failed++;
          print(`  FAIL ${name}\n       ${e && e.message}`);
        }
      )
  );
}
function eq(a, b, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}
function ok(v, msg = "assertion failed") {
  if (!v) throw new Error(msg);
}

const TOKEN = "ab".repeat(32);

test("PIN rules and lockout schedule", () => {
  ok(validPin("1234") && validPin("123456789012"), "4-12 digits");
  ok(!validPin("123") && !validPin("12345a") && !validPin("1234567890123") && !validPin(null), "rejects others");
  eq([0, 4, 5, 6, 7, 20].map(lockoutSeconds), [0, 0, 30, 60, 120, 900]);
});

if (lockAvailable()) {
  test("right PIN unlocks, stored form does not contain the token", async () => {
    const lock = await lockToken("2468", TOKEN, 1000);
    ok(!JSON.stringify(lock).includes(TOKEN), "token not in clear");
    eq(await unlockToken(lock, "2468"), TOKEN);
  });
  test("wrong PIN and tampered data are rejected", async () => {
    const lock = await lockToken("2468", TOKEN, 1000);
    let threw = 0;
    await unlockToken(lock, "1357").catch(() => threw++);
    const bad = { ...lock, ct: lock.ct.slice(0, -4) + (lock.ct.endsWith("AAA=") ? "BBB=" : "AAA=") };
    await unlockToken(bad, "2468").catch(() => threw++);
    eq(threw, 2);
  });
  test("each lock uses a fresh salt and IV", async () => {
    const a = await lockToken("2468", TOKEN, 1000);
    const b = await lockToken("2468", TOKEN, 1000);
    ok(a.salt !== b.salt && a.iv !== b.iv && a.ct !== b.ct, "random per lock");
  });
} else {
  print("  skip crypto tests (no WebCrypto in this engine)");
}

await Promise.all(pending);
print(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error("tests failed");
