import { render, inline, highlight, esc } from "../web/lib/markdown.js";

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
function has(html, frag) {
  if (!html.includes(frag)) throw new Error(`expected to contain ${JSON.stringify(frag)}\n       got ${JSON.stringify(html)}`);
}
function lacks(html, frag) {
  if (html.includes(frag)) throw new Error(`must not contain ${JSON.stringify(frag)}\n       got ${JSON.stringify(html)}`);
}

test("escapes raw html (no XSS)", () => {
  const h = render('<img src=x onerror=alert(1)> and <script>alert(1)</script>');
  lacks(h, "<img");
  lacks(h, "<script");
  has(h, "&lt;script&gt;");
});

test("javascript: links are not linked", () => {
  const h = inline("[click](javascript:alert(1))");
  lacks(h, "href");
  has(h, "click");
});

test("http links get safe attrs", () => {
  const h = inline("see [docs](https://example.com/a?b=1&c=2)");
  has(h, 'href="https://example.com/a?b=1&amp;c=2"');
  has(h, 'rel="noopener noreferrer"');
});

test("bare urls autolink without trailing punctuation", () => {
  has(inline("go to https://example.com."), 'href="https://example.com"');
});

test("inline code is not formatted inside", () => {
  const h = inline("use `**not bold** <b>` here and **bold**");
  has(h, "<code>**not bold** &lt;b&gt;</code>");
  has(h, "<strong>bold</strong>");
});

test("snake_case words are not italicized", () => {
  lacks(inline("call my_func_name now"), "<em>");
  has(inline("this is _important_ ok"), "<em>important</em>");
});

test("fenced code with language, highlighted and copyable", () => {
  const h = render("text\n```rust\nfn main() { let x = 1; }\n```\nafter");
  has(h, '<span class="hl-kw">fn</span>');
  has(h, '<span class="hl-num">1</span>');
  has(h, "data-copy");
  has(h, "<p>after</p>");
});

test("unclosed fence while streaming is marked open", () => {
  const h = render("```js\nconst a =", { streaming: true });
  has(h, 'class="code open"');
  has(h, '<span class="hl-kw">const</span>');
});

test("diff highlighting", () => {
  const h = highlight("@@ -1 +1 @@\n-old\n+new", "diff");
  has(h, '<span class="hl-del">-old</span>');
  has(h, '<span class="hl-add">+new</span>');
});

test("strings containing html are escaped in highlighter", () => {
  const h = highlight('let s = "<b>hi</b>";', "rust");
  has(h, "&lt;b&gt;");
  lacks(h, "<b>");
});

test("lists, ordered start, nested, tasks", () => {
  const h = render("- a\n- b\n  - b1\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo");
  has(h, "<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul>");
  has(h, '<ol start="3">');
  has(h, '<li class="task checked">done</li>');
  has(h, '<li class="task">todo</li>');
});

test("tables with alignment", () => {
  const h = render("| a | b |\n|:--|--:|\n| 1 | **2** |");
  has(h, '<th class="al-right">b</th>');
  if (h.includes("style=")) throw new Error("inline style attribute (blocked by the CSP)");
  has(h, "<td>1</td>");
  has(h, "<strong>2</strong>");
});

test("headings render one level down, blockquote, hr", () => {
  const h = render("# Title\n> quoted **x**\n\n---");
  has(h, "<h2>Title</h2>");
  has(h, "<blockquote><p>quoted <strong>x</strong></p></blockquote>");
  has(h, "<hr>");
});

test("paragraph line breaks preserved", () => {
  has(render("one\ntwo"), "<p>one<br>two</p>");
});

test("esc", () => {
  if (esc(`<"'&>`) !== "&lt;&quot;&#39;&amp;&gt;") throw new Error(esc(`<"'&>`));
});

print(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error("tests failed");
