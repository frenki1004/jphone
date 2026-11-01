// Recent project folders. Run: ./test/run.sh
import { touchDir, forgetDir, seedDirs, cleanDir, MAX_RECENT_DIRS } from "../web/lib/recent.js";

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
const dirs = (l) => l.map((d) => d.dir);

test("most recent first, no duplicates, capped", () => {
  let l = touchDir([], "/a", 1);
  l = touchDir(l, "/b", 2);
  l = touchDir(l, "/a", 3);
  eq(dirs(l), ["/a", "/b"]);
  for (let i = 0; i < 20; i++) l = touchDir(l, `/p${i}`, 10 + i);
  eq(l.length, MAX_RECENT_DIRS);
  eq(l[0].dir, "/p19");
});

test("forget removes one folder", () => {
  eq(dirs(forgetDir(touchDir(touchDir([], "/a"), "/b"), "/a")), ["/b"]);
});

test("seeded from remembered sessions, newest first, plus the current folder", () => {
  const sessions = [{ id: "1", dir: "/old", at: 1 }, { id: "2", dir: "/new", at: 5 }, { id: "3", at: 9 }, { id: "4", dir: "/old", at: 2 }];
  eq(dirs(seedDirs(sessions, "/now")), ["/now", "/new", "/old"]);
  eq(dirs(seedDirs(undefined, null)), []);
});

test("cleanDir keeps absolute paths only and trims trailing slashes", () => {
  eq(cleanDir(" /Users/me/code/app/ "), "/Users/me/code/app");
  eq(cleanDir("/"), "/");
  eq(cleanDir("code/app"), null);
  eq(cleanDir(""), null);
});

print(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error("tests failed");
