// Small, safe markdown -> HTML renderer tuned for agent output.
// Everything is HTML-escaped first, then a limited set of constructs is emitted.
// Pure string functions: testable headlessly.

export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// --- tiny syntax highlighter ---------------------------------------------

const KW = new Set(
  (
    "fn let mut const pub use mod impl struct enum trait match if else for while loop return break continue async await " +
    "move ref self Self super crate where type as in static unsafe dyn true false None Some Ok Err " +
    "function var new class extends import export from default this null undefined typeof instanceof try catch finally throw yield of " +
    "def lambda pass with is not and or elif None True False print " +
    "func package go defer chan select interface map range struct " +
    "int float double char bool void string str u8 u16 u32 u64 i32 i64 usize isize f32 f64 String Vec Option Result " +
    "public private protected final abstract override sealed val object when fun " +
    "echo fi then do done esac case local export source sudo cd"
  ).split(" ")
);

const LANG_ALIASES = { sh: "bash", shell: "bash", zsh: "bash", console: "bash", js: "javascript", ts: "typescript", py: "python", rs: "rust", yml: "yaml" };

export function highlight(code, lang = "") {
  lang = (LANG_ALIASES[lang] || lang || "").toLowerCase();
  if (lang === "diff" || (!lang && /^(?:[+-]{3} |@@ )/m.test(code))) {
    return code
      .split("\n")
      .map((l) => {
        const e = esc(l);
        if (/^\+(?!\+\+)/.test(l)) return `<span class="hl-add">${e}</span>`;
        if (/^-(?!--)/.test(l)) return `<span class="hl-del">${e}</span>`;
        if (/^@@/.test(l)) return `<span class="hl-meta">${e}</span>`;
        return e;
      })
      .join("\n");
  }
  if (lang === "json") {
    return esc(code).replace(/(&quot;(?:\\.|(?!&quot;).)*&quot;)(\s*:)?|\b(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b(true|false|null)\b/gi, (m, str, colon, num, lit) => {
      if (str) return colon ? `<span class="hl-key">${str}</span>${colon}` : `<span class="hl-str">${str}</span>`;
      if (num) return `<span class="hl-num">${num}</span>`;
      return `<span class="hl-kw">${lit}</span>`;
    });
  }
  const hashComments = /^(bash|python|yaml|toml|ruby|perl|r|make|dockerfile)$/.test(lang);
  const re = hashComments
    ? /(#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [tok, com, str, num, word] = m;
    if (com) out += `<span class="hl-com">${esc(com)}</span>`;
    else if (str) out += `<span class="hl-str">${esc(str)}</span>`;
    else if (num) out += `<span class="hl-num">${esc(num)}</span>`;
    else if (word && KW.has(word)) out += `<span class="hl-kw">${esc(word)}</span>`;
    else if (word && /^[A-Z][A-Za-z0-9]*$/.test(word)) out += `<span class="hl-type">${esc(word)}</span>`;
    else if (word && code[re.lastIndex] === "(") out += `<span class="hl-fn">${esc(word)}</span>`;
    else out += esc(tok);
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}

// --- inline ---------------------------------------------------------------

function safeUrl(u) {
  const s = u.trim();
  return /^(https?:|mailto:)/i.test(s) ? s : null;
}

export function inline(text) {
  // Pull out code spans first so their content is never formatted.
  const codes = [];
  let s = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, c) => {
    codes.push(c.replace(/^ (.*) $/, "$1"));
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) => {
    const raw = url.replace(/&amp;/g, "&");
    const safe = safeUrl(raw);
    return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  // bare urls
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

// --- blocks ---------------------------------------------------------------

function splitRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

export function render(md, { streaming = false } = {}) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[2];
      const lang = fence[3] || "";
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      const closed = i < lines.length;
      i++;
      const code = body.join("\n");
      out.push(
        `<div class="code${closed || !streaming ? "" : " open"}"><div class="code-head"><span>${esc(lang || "text")}</span>` +
          `<button class="copy" data-copy type="button" aria-label="Copy code">copy</button></div>` +
          `<pre><code>${highlight(code, lang)}</code></pre></div>`
      );
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushPara();
      const lvl = Math.min(h[1].length + 1, 6); // h1 renders as h2: keep chat compact
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // hr
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push("<hr>");
      i++;
      continue;
    }

    // table
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : ""));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const al = (k) => (aligns[k] ? ` class="al-${aligns[k]}"` : ""); // a class, not style="": the CSP blocks inline styles
      out.push(
        `<div class="table"><table><thead><tr>${head.map((c, k) => `<th${al(k)}>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${head.map((_, k) => `<td${al(k)}>${inline(r[k] || "")}</td>`).join("")}</tr>`).join("") +
          `</tbody></table></div>`
      );
      continue;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      flushPara();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${render(q.join("\n"))}</blockquote>`);
      continue;
    }

    // lists (one level of nesting via indentation)
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[2]);
      const start = ordered ? parseInt(li[2], 10) : 1;
      const items = [];
      const baseIndent = li[1].length;
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m && m[1].length <= baseIndent + 1) {
          items.push({ text: m[3], sub: [] });
          i++;
        } else if (items.length && (lines[i].startsWith(" ".repeat(baseIndent + 2)) || /^\s{2,}\S/.test(lines[i])) && lines[i].trim()) {
          items[items.length - 1].sub.push(lines[i].slice(Math.min(baseIndent + 2, lines[i].search(/\S/))));
          i++;
        } else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>` +
          items
            .map((it) => {
              let t = it.text;
              let cls = "";
              const task = /^\[([ xX])\]\s+(.*)$/.exec(t);
              if (task) {
                cls = ` class="task${task[1] === " " ? "" : " checked"}"`;
                t = task[2];
              }
              return `<li${cls}>${inline(t)}${it.sub.length ? render(it.sub.join("\n")) : ""}</li>`;
            })
            .join("") +
          `</${tag}>`
      );
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join("");
}
