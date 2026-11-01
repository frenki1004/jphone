// Recently used project folders, most recent first. jcode takes the folder as
// `working_dir` when a session starts; it has no API to browse folders, so
// jPhone remembers the ones you used.

export const MAX_RECENT_DIRS = 10;

export function touchDir(list, dir, now = Date.now()) {
  if (!dir) return list || [];
  return [{ dir, at: now }, ...(list || []).filter((d) => d.dir !== dir)].slice(0, MAX_RECENT_DIRS);
}

export function forgetDir(list, dir) {
  return (list || []).filter((d) => d.dir !== dir);
}

// First run after an update: start from the folders of remembered sessions.
export function seedDirs(sessions, current) {
  let list = [];
  const byAge = [...(sessions || [])].filter((s) => s.dir).sort((a, b) => (a.at || 0) - (b.at || 0));
  for (const s of byAge) list = touchDir(list, s.dir, s.at || 0);
  if (current && !list.some((d) => d.dir === current)) list = touchDir(list, current, Date.now());
  return list;
}

// Normalize what someone typed: absolute, no trailing slash. Null if unusable.
export function cleanDir(raw) {
  const dir = String(raw || "").trim().replace(/\/+$/, "") || (String(raw || "").trim() ? "/" : "");
  return dir.startsWith("/") ? dir : null;
}
