import { Marked, Renderer } from "marked";
import markedKatex from "marked-katex-extension";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";

/* ============================================================
   Markdown engine
   ============================================================ */
let slugs = new Map();
const slugify = (s) => {
  let base = s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[#\w]+;/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-") || "section";
  const n = slugs.get(base) || 0;
  slugs.set(base, n + 1);
  return n ? `${base}-${n}` : base;
};
export const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
export const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7"/></svg>`;

const md = new Marked({ gfm: true, breaks: false });
md.use(markedKatex({ throwOnError: false, nonStandard: true, output: "htmlAndMathml" }));
md.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang || "").trim().split(/\s+/)[0].toLowerCase();
      if (language === "mermaid") {
        return `<div class="mermaid-block" data-src="${esc(encodeURIComponent(text))}"></div>`;
      }
      let html;
      if (language && hljs.getLanguage(language)) html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      else if (!language && text.length < 20000) html = hljs.highlightAuto(text).value;
      else html = esc(text);
      const label = language || "text";
      return `<div class="codeblock"><div class="code-head"><span>${esc(label)}</span><button class="copy" type="button">${COPY_ICON}<span>Copy</span></button></div><pre><code class="hljs language-${esc(label)}">${html}</code></pre></div>`;
    },
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${slugify(inner)}">${inner}</h${depth}>`;
    },
    table(token) {
      // wrap default table so wide tables scroll horizontally
      return `<div class="table-wrap">${defaultTable.call(this, token)}</div>`;
    },
    listitem(item) {
      const html = defaultListitem.call(this, item);
      return item.task ? html.replace(/^<li>/, '<li class="task">') : html;
    },
  },
});
// Typographic quotes ("…" → “…”, it's → it’s), like AI chat apps show. Code is never touched.
function smartQuotes(t) {
  return t
    .replace(/(^|[\s(\[{\u2014\u2013-])"(?=\S)/g, "$1\u201C").replace(/"/g, "\u201D")
    .replace(/([\s(\[{\u201C\u2014\u2013-])'(?=\S)/g, "$1\u2018").replace(/'/g, "\u2019");
}
md.use({
  walkTokens(token) {
    if (token.type === "text" && !token.tokens && typeof token.text === "string" && !token.escaped) token.text = smartQuotes(token.text);
  },
});
// grab the default renderers so the overrides above can wrap them
const _r = new Renderer();
const defaultTable = _r.table;
const defaultListitem = _r.listitem;

/** Split off YAML frontmatter */
function splitFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/.exec(src);
  return m ? { fm: m[1], body: src.slice(m[0].length) } : { fm: null, body: src };
}

/** ChatGPT/Claude often emit \( \) and \[ \] — convert them to $ / $$ outside code */
function normalizeMath(src) {
  return src
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2) return part; // code — leave alone
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m.trim()}$`);
    })
    .join("");
}

export function renderMarkdown(src) {
  slugs = new Map();
  const { fm, body } = splitFrontmatter(src.replace(/^﻿/, ""));
  let html = md.parse(normalizeMath(body));
  if (fm) html = `<details class="frontmatter"><summary>Frontmatter</summary><pre>${esc(fm)}</pre></details>` + html;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"], ADD_TAGS: ["semantics", "annotation"] });
}

/* ============================================================
   Mermaid (lazy-loaded — only when a document uses it)
   ============================================================ */
let mermaidMod = null;
const mermaidCache = new Map();
export async function renderMermaid(root) {
  const blocks = root.querySelectorAll(".mermaid-block");
  if (!blocks.length) return;
  if (!mermaidMod) mermaidMod = (await import("mermaid")).default;
  const dark = document.documentElement.dataset.mode === "dark";
  const style = getComputedStyle(document.documentElement);
  mermaidMod.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "neutral",
    fontFamily: style.getPropertyValue("--ui-font"),
  });
  let i = 0;
  for (const el of blocks) {
    const src = decodeURIComponent(el.dataset.src);
    const key = (dark ? "d:" : "l:") + src;
    if (mermaidCache.has(key)) { el.innerHTML = mermaidCache.get(key); continue; }
    const id = `mmd-${Date.now()}-${i++}`;
    try {
      const { svg } = await mermaidMod.render(id, src);
      el.innerHTML = svg;
      mermaidCache.set(key, svg);
      if (mermaidCache.size > 50) mermaidCache.delete(mermaidCache.keys().next().value);
    } catch (e) {
      document.getElementById("d" + id)?.remove();
      el.classList.add("error");
      el.textContent = "Mermaid error: " + (e?.message || e) + "\n\n" + src;
    }
  }
}
