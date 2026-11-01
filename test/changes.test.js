// "Files changed" card data. Run: ./test/run.sh
import { fileChanges, replacementHunk, parsePatch } from "../web/lib/changes.js";
import { initialState, reduce } from "../web/lib/reducer.js";

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
const sum = (fs) => fs.map((f) => `${f.status} ${f.path}${f.to ? ` -> ${f.to}` : ""} +${f.added} -${f.removed}`);
const done = (name, input, output = "") => ({ name, input, output, status: "done" });

test("edit: only the lines that differ count, shared lines become context", () => {
  const h = replacementHunk("a\nb\nc\nd", "a\nB\nc\nd");
  eq(h, [{ t: " ", s: "a" }, { t: "-", s: "b" }, { t: "+", s: "B" }, { t: " ", s: "c" }, { t: " ", s: "d" }]);
  eq(sum(fileChanges([done("edit", { file_path: "src/x.js", old_string: "a\nb", new_string: "a\nB\nC" })])), ["modified src/x.js +2 -1"]);
});

test("edit with an edits array, and several tools on one file add up", () => {
  const tools = [
    done("edit", { file_path: "a.ts", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p\nq", new_string: "p" }] }),
    done("edit", { file_path: "a.ts", old_string: "1", new_string: "2" }),
  ];
  eq(sum(fileChanges(tools)), ["modified a.ts +2 -3"]);
  eq(fileChanges(tools)[0].diff.filter((l) => l.t === "@").length, 2, "hunk separators");
});

test("write: new vs overwritten, from jcode's output text", () => {
  eq(sum(fileChanges([done("write", { file_path: "n.md", content: "a\nb\n" }, "created new file (2 lines)")])), ["added n.md +2 -0"]);
  eq(sum(fileChanges([done("write", { file_path: "o.md", content: "a" }, "overwrote file (1 lines)")])), ["written o.md +1 -0"]);
});

test("apply_patch (Codex format): add, update, delete, move", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: docs/new.md",
    "+# New",
    "+text",
    "*** Update File: src/app.js",
    "*** Move to: src/main.js",
    "@@ function boot()",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    "*** Delete File: old.txt",
    "*** End Patch",
  ].join("\n");
  eq(sum(fileChanges([done("apply_patch", { patch_text: patch })])), ["added docs/new.md +2 -0", "moved src/app.js -> src/main.js +2 -1", "deleted old.txt +0 -0"]);
});

test("unified diff via patch or apply_patch, incl. a removed line starting with '--'", () => {
  const diff = ["--- a/lib/u.py", "+++ b/lib/u.py", "@@ -1,3 +1,3 @@", " import os", "--- old comment", "+# new comment", " x = 1", "--- /dev/null", "+++ b/NEW", "@@ -0,0 +1 @@", "+hi"].join("\n");
  eq(sum([...parsePatch(diff).values()]), ["modified lib/u.py +1 -1", "added NEW +1 -0"]);
  eq(sum(fileChanges([done("patch", { patch_text: diff })])).length, 2);
});

test("failed, running and non-file tools are ignored", () => {
  const tools = [
    { name: "edit", input: { file_path: "a", old_string: "x", new_string: "y" }, status: "failed" },
    { name: "edit", input: { file_path: "b", old_string: "x", new_string: "y" }, status: "running" },
    done("bash", { command: "rm -rf build" }),
    done("read", { file_path: "c" }),
  ];
  eq(fileChanges(tools), []);
});

test("from a streamed turn: tool_input deltas become the edit's input", () => {
  let s = initialState();
  for (const ev of [
    { type: "local:user", text: "fix", requestId: 1 },
    { type: "tool_start", id: "e1", name: "edit" },
    { type: "tool_input", id: "e1", delta: '{"file_path":"src/app.js",' },
    { type: "tool_input", id: "e1", delta: '"old_string":"a\\nb","new_string":"a\\nB\\nc"}' },
    { type: "tool_exec", id: "e1", name: "edit" },
    { type: "tool_done", id: "e1", name: "edit", output: "Edited src/app.js" },
    { type: "done", id: 1, req_type: "message" },
  ])
    s = reduce(s, ev);
  eq(sum(fileChanges(s.entries[1].tools)), ["modified src/app.js +2 -1"]);
});

print(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error("tests failed");
