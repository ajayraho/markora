// A deliberately simple Markdown editor on top of <textarea>.
// Uses execCommand("insertText") so the browser's native undo/redo keeps working.

function replaceRange(ta, start, end, text, selStart, selEnd) {
  ta.focus();
  ta.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, text)) {
    ta.setRangeText(text, start, end, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (selStart != null) ta.setSelectionRange(selStart, selEnd ?? selStart);
}

function lineBounds(ta, from = ta.selectionStart, to = ta.selectionEnd) {
  const v = ta.value;
  const start = v.lastIndexOf("\n", from - 1) + 1;
  let end = v.indexOf("\n", to - (to > from && v[to - 1] === "\n" ? 1 : 0));
  if (end < 0) end = v.length;
  return { start, end };
}

/** Wrap selection with markers (toggle off if already wrapped) */
function wrap(ta, before, after = before, placeholder = "text") {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e);
  if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
    replaceRange(ta, s - before.length, e + after.length, sel, s - before.length, e - before.length);
    return;
  }
  const inner = sel || placeholder;
  replaceRange(ta, s, e, before + inner + after, s + before.length, s + before.length + inner.length);
}

/** Toggle a prefix on every selected line */
function prefixLines(ta, prefixFn, matchRe) {
  const { start, end } = lineBounds(ta);
  const lines = ta.value.slice(start, end).split("\n");
  const allHave = lines.every((l) => matchRe.test(l) || !l.trim());
  const out = lines.map((l, i) => (!l.trim() && lines.length > 1 ? l : allHave ? l.replace(matchRe, "") : prefixFn(i) + l.replace(matchRe, "")));
  const text = out.join("\n");
  replaceRange(ta, start, end, text, start, start + text.length);
}

function heading(ta) {
  const { start, end } = lineBounds(ta);
  const line = ta.value.slice(start, end);
  const m = /^(#{1,6})\s/.exec(line);
  const level = m ? m[1].length : 0;
  const next = level >= 3 ? 0 : level + 1; // cycles: none → # → ## → ### → none
  const body = line.replace(/^#{1,6}\s+/, "");
  const text = (next ? "#".repeat(next) + " " : "") + body;
  replaceRange(ta, start, end, text, start + text.length);
}

function link(ta) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e);
  if (/^https?:\/\/\S+$/.test(sel)) {
    replaceRange(ta, s, e, `[link](${sel})`, s + 1, s + 5);
  } else {
    const t = sel || "link text";
    replaceRange(ta, s, e, `[${t}](https://)`, s + t.length + 3, s + t.length + 11);
  }
}

function codeBlock(ta) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e);
  const pre = s > 0 && v[s - 1] !== "\n" ? "\n" : "";
  const text = `${pre}\`\`\`\n${sel || ""}\n\`\`\`\n`;
  const cursor = s + pre.length + 3; // right after ``` so you can type the language
  replaceRange(ta, s, e, text, cursor);
}

function table(ta) {
  const s = ta.selectionStart;
  const pre = s > 0 && ta.value[s - 1] !== "\n" ? "\n\n" : "";
  const text = `${pre}| Column 1 | Column 2 |\n| -------- | -------- |\n| Cell     | Cell     |\n`;
  replaceRange(ta, s, ta.selectionEnd, text, s + pre.length + 2, s + pre.length + 10);
}

export const ACTIONS = {
  heading: { title: "Heading (Ctrl+H)", run: heading },
  bold: { title: "Bold (Ctrl+B)", run: (ta) => wrap(ta, "**", "**", "bold") },
  italic: { title: "Italic (Ctrl+I)", run: (ta) => wrap(ta, "*", "*", "italic") },
  strike: { title: "Strikethrough", run: (ta) => wrap(ta, "~~", "~~", "text") },
  code: { title: "Inline code (Ctrl+`)", run: (ta) => wrap(ta, "`", "`", "code") },
  link: { title: "Link (Ctrl+K)", run: link },
  ul: { title: "Bulleted list", run: (ta) => prefixLines(ta, () => "- ", /^\s*[-*+]\s(\[[ xX]\]\s)?/) },
  ol: { title: "Numbered list", run: (ta) => prefixLines(ta, (i) => `${i + 1}. `, /^\s*\d+[.)]\s/) },
  task: { title: "Task list", run: (ta) => prefixLines(ta, () => "- [ ] ", /^\s*[-*+]\s\[[ xX]\]\s/) },
  quote: { title: "Quote", run: (ta) => prefixLines(ta, () => "> ", /^>\s?/) },
  codeblock: { title: "Code block", run: codeBlock },
  table: { title: "Table", run: table },
};

const LIST_RE = /^(\s*)([-*+]|(\d+)([.)]))(\s+\[[ xX]\])?(\s+)/;

export function setupEditor(ta) {
  ta.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey) {
      const map = { b: "bold", i: "italic", k: "link", h: "heading", "`": "code" };
      if (map[k]) { e.preventDefault(); ACTIONS[map[k]].run(ta); return; }
    }

    // Tab / Shift+Tab: indent / outdent
    if (e.key === "Tab" && !mod && !e.altKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en } = ta;
      if (s === en && !e.shiftKey && !LIST_RE.test(ta.value.slice(lineBounds(ta).start, en))) {
        replaceRange(ta, s, en, "  ", s + 2);
        return;
      }
      const { start, end } = lineBounds(ta);
      const lines = ta.value.slice(start, end).split("\n");
      const out = lines.map((l) => (e.shiftKey ? l.replace(/^( {1,2}|\t)/, "") : "  " + l)).join("\n");
      const delta = out.split("\n")[0].length - lines[0].length;
      if (s === en) replaceRange(ta, start, end, out, Math.max(start, s + delta));
      else replaceRange(ta, start, end, out, start, start + out.length);
      return;
    }

    // Enter: continue lists (or end the list on an empty item)
    if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey && ta.selectionStart === ta.selectionEnd) {
      const s = ta.selectionStart;
      const { start } = lineBounds(ta);
      const line = ta.value.slice(start, s);
      const m = LIST_RE.exec(line);
      if (!m) return;
      e.preventDefault();
      if (line.trim() === m[0].trim()) {
        replaceRange(ta, start, s, "\n", start + 1); // empty item → exit list, leave a blank line
        return;
      }
      const [, indent, bullet, num, punct, task] = m;
      const marker = num ? `${+num + 1}${punct}` : bullet;
      const text = `\n${indent}${marker}${task ? " [ ]" : ""} `;
      replaceRange(ta, s, s, text, s + text.length);
    }
  });
}
