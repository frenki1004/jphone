// "Files changed" for a turn, built from the tool calls jcode streams.
// No extra gateway request: edit/write/apply_patch inputs already carry the
// path and the text that changed. Pure, no DOM.
//
// Counts come from what the agent sent, not from git: an `edit` counts the
// lines of old_string/new_string after trimming lines both share, and a
// `write` that overwrote a file counts every line as added (the old content
// is not in the event stream).

const lines = (s) => (s ? String(s).replace(/\n$/, "").split("\n") : []);

function fileEntry(map, path) {
  if (!map.has(path)) map.set(path, { path, added: 0, removed: 0, status: "modified", diff: [] });
  return map.get(path);
}

function pushHunk(f, hunk) {
  if (f.diff.length) f.diff.push({ t: "@", s: "" });
  for (const l of hunk) {
    f.diff.push(l);
    if (l.t === "+") f.added++;
    if (l.t === "-") f.removed++;
  }
}

// old/new text -> lines with common head and tail kept as (at most 2) context lines.
export function replacementHunk(oldText, newText, context = 2) {
  const a = lines(oldText);
  const b = lines(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out = [];
  for (const s of a.slice(Math.max(0, head - context), head)) out.push({ t: " ", s });
  for (const s of a.slice(head, a.length - tail)) out.push({ t: "-", s });
  for (const s of b.slice(head, b.length - tail)) out.push({ t: "+", s });
  for (const s of a.slice(a.length - tail, a.length - tail + context)) out.push({ t: " ", s });
  return out;
}

// Codex-style "*** Begin Patch" text.
function parseCodexPatch(text, map) {
  let f = null;
  let hunk = [];
  const flush = () => {
    if (f && hunk.length) pushHunk(f, hunk);
    hunk = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m;
    if ((m = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line))) {
      flush();
      f = fileEntry(map, m[2].trim());
      if (m[1] === "Add") f.status = "added";
      if (m[1] === "Delete") f.status = "deleted";
    } else if (f && (m = /^\*\*\* Move to: (.+)$/.exec(line))) {
      f.status = "moved";
      f.to = m[1].trim();
    } else if (/^\*\*\* (End Patch|Begin Patch|End of File)/.test(line)) {
      flush();
    } else if (f && line.startsWith("@@")) {
      flush();
    } else if (f && f.status !== "deleted" && /^[ +-]/.test(line)) {
      hunk.push({ t: line[0], s: line.slice(1) });
    }
  }
  flush();
}

// Plain unified diff (---/+++ headers).
function parseUnifiedDiff(text, map) {
  let f = null;
  let hunk = [];
  let oldPath = null;
  const flush = () => {
    if (f && hunk.length) pushHunk(f, hunk);
    hunk = [];
  };
  const clean = (p) => p.replace(/\t.*$/, "").replace(/^[ab]\//, "").trim();
  const all = text.split("\n").map((l) => l.replace(/\r$/, ""));
  for (let n = 0; n < all.length; n++) {
    const line = all[n];
    // A header is a "--- " line followed by "+++ " (a removed line could start with "-- ").
    if (line.startsWith("--- ") && (all[n + 1] || "").startsWith("+++ ")) {
      flush();
      oldPath = clean(line.slice(4));
      f = null;
    } else if (line.startsWith("+++ ") && oldPath != null && !f) {
      const newPath = clean(line.slice(4));
      const path = newPath === "/dev/null" ? oldPath : newPath;
      f = fileEntry(map, path);
      if (oldPath === "/dev/null") f.status = "added";
      if (newPath === "/dev/null") f.status = "deleted";
    } else if (line.startsWith("@@")) {
      flush();
    } else if (f && /^[ +-]/.test(line)) {
      hunk.push({ t: line[0], s: line.slice(1) });
    }
  }
  flush();
}

export function parsePatch(text, map = new Map()) {
  if (/^\*\*\* Begin Patch/m.test(text || "")) parseCodexPatch(text, map);
  else parseUnifiedDiff(text || "", map);
  return map;
}

// tools: the reducer's tool objects ({ name, input, output, status }).
// Returns files in first-touched order: { path, added, removed, status, to?, diff }.
export function fileChanges(tools) {
  const map = new Map();
  for (const t of tools || []) {
    if (t.status !== "done" || !t.input) continue;
    const i = t.input;
    if (t.name === "edit" && i.file_path) {
      const f = fileEntry(map, i.file_path);
      const edits = Array.isArray(i.edits) && i.edits.length ? i.edits : [{ old_string: i.old_string, new_string: i.new_string }];
      for (const e of edits) pushHunk(f, replacementHunk(e.old_string, e.new_string));
    } else if (t.name === "write" && i.file_path && typeof i.content === "string") {
      const f = fileEntry(map, i.file_path);
      if (/created new file/i.test(t.output || "")) f.status = "added";
      else if (f.status === "modified") f.status = "written";
      f.diff = [];
      f.added = 0;
      f.removed = 0;
      pushHunk(f, lines(i.content).map((s) => ({ t: "+", s })));
    } else if ((t.name === "apply_patch" || t.name === "patch") && typeof i.patch_text === "string") {
      parsePatch(i.patch_text, map);
    }
  }
  return [...map.values()];
}
