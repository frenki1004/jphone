// When to notify, and what to say. Pure: no DOM, no Notification API.
//
// jcode's gateway has no "needs input" event: a turn ends and jcode waits for
// you (stdin prompts time out after 1.5 s, see README). So "finished" is the
// moment to tell you, plus errors that end a turn. A Stop you pressed is not.

// `wasProcessing`: state.processing before the event; `s`: state after it.
export function turnNotice(wasProcessing, s, ev, { hideContent = true, label = "" } = {}) {
  if (!wasProcessing || s.processing) return null;
  if (ev.type === "interrupted") return null;
  const tag = `jphone-${s.sessionId || "new"}`;
  if (ev.type === "error") {
    return hideContent
      ? { title: "jcode stopped with an error", body: "Open jPhone to see what happened.", tag }
      : { title: `jcode error${label ? ` · ${label}` : ""}`, body: oneLine(ev.message || "The turn failed.", 180), tag };
  }
  if (hideContent) return { title: "jcode finished", body: "Your turn. Open jPhone to see the reply.", tag };
  return { title: `jcode finished${label ? ` · ${label}` : ""}`, body: oneLine(lastReply(s), 180) || "Done.", tag };
}

function lastReply(s) {
  for (let i = s.entries.length - 1; i >= 0; i--) {
    const e = s.entries[i];
    if (e.role === "assistant" && e.text) return e.text;
  }
  return "";
}

function oneLine(text, max) {
  const t = String(text)
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
