// Live side-by-side diff: two editable columns, highlighted as you type (IDE style).
// Each column is a <textarea> over a highlight layer with identical metrics, so editing stays
// native (undo, selection, IME) while the colours update underneath.
import { diffComm } from "node-diff3";
import DiffMatchPatch from "diff-match-patch";

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const LINE_H = 20; // px, must match .dv-ta / .dv-hl line-height

/** Line diff → per-side line classes, intra-line char marks, gap markers and a left→right line map */
function compute(left, right) {
  const L = left.split("\n"), R = right.split("\n");
  const sideL = L.map(() => ({ cls: "", html: null, gapBefore: 0 }));
  const sideR = R.map(() => ({ cls: "", html: null, gapBefore: 0 }));
  const mapLR = new Array(L.length + 1).fill(0);
  let li = 0, ri = 0, added = 0, removed = 0;
  const gapAt = (side, i, n, arr) => { if (i < arr.length) side[i].gapBefore += n; else if (arr.length) side[arr.length - 1].gapAfter = (side[arr.length - 1].gapAfter || 0) + n; };

  for (const chunk of diffComm(L, R)) {
    if (chunk.common) {
      for (let k = 0; k < chunk.common.length; k++) mapLR[li + k] = ri + k;
      li += chunk.common.length; ri += chunk.common.length;
      continue;
    }
    const a = chunk.buffer1, b = chunk.buffer2;
    const pairs = Math.min(a.length, b.length);
    for (let k = 0; k < pairs; k++) {
      const [ha, hb] = charDiff(a[k], b[k]);
      sideL[li + k] = { cls: "mod-l", html: ha, gapBefore: sideL[li + k].gapBefore };
      sideR[ri + k] = { cls: "mod-r", html: hb, gapBefore: sideR[ri + k].gapBefore };
      mapLR[li + k] = ri + k;
    }
    for (let k = pairs; k < a.length; k++) { sideL[li + k].cls = "del"; mapLR[li + k] = ri + b.length; }
    for (let k = pairs; k < b.length; k++) sideR[ri + k].cls = "add";
    if (b.length > a.length) gapAt(sideL, li + a.length, b.length - a.length, L);
    if (a.length > b.length) gapAt(sideR, ri + b.length, a.length - b.length, R);
    removed += a.length; added += b.length;
    li += a.length; ri += b.length;
  }
  mapLR[L.length] = R.length;
  return { L, R, sideL, sideR, mapLR, added, removed, same: left === right };
}

/** Character-level diff of two changed lines (Myers diff + semantic cleanup, like IDEs) */
const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 0.05; // per line; bail out to a coarser diff on pathological input
function charDiff(a, b) {
  const diffs = dmp.diff_main(a, b);
  dmp.diff_cleanupSemantic(diffs); // "value→total" instead of "v→tot…ue" noise; exact chars otherwise
  let ha = "", hb = "";
  for (const [op, text] of diffs) {
    const t = esc(text);
    if (op === 0) { ha += t; hb += t; }
    else if (op === -1) ha += `<mark class="d">${t}</mark>`;
    else hb += `<mark class="a">${t}</mark>`;
  }
  return [ha, hb];
}

function paint(hl, gutter, lines, side) {
  let h = "", g = "";
  lines.forEach((text, i) => {
    const s = side[i];
    const gap = s.gapBefore ? ` gap" data-gap="${s.gapBefore}` : "";
    const gapEnd = s.gapAfter ? ` gap-end" data-gap-end="${s.gapAfter}` : "";
    h += `<div class="ln ${s.cls}${gap}${gapEnd}">${s.html ?? esc(text)}​</div>`;
    g += `<div class="${s.cls}">${i + 1}</div>`;
  });
  hl.innerHTML = h;
  gutter.innerHTML = g;
}

export function createDiffView(root, { onChange }) {
  root.innerHTML = `
    <div class="dv-head">
      <div class="dv-col-head"><span class="dv-tag del">Original</span><span class="dv-hint">paste or type</span></div>
      <div class="dv-col-head"><span class="dv-tag add">Modified</span><span class="dv-stats" id="dvStats"></span>
        <button class="btn sm" id="dvSwap" title="Swap sides">⇄ Swap</button>
        <button class="btn sm" id="dvWrap" title="Wrap long lines in both columns">↩ Wrap</button>
        <button class="btn sm" id="dvClear" title="Clear both sides">Clear</button></div>
    </div>
    <div class="dv-body">
      ${["l", "r"].map((s) => `
      <div class="dv-col" data-side="${s}">
        <div class="dv-gutter"><div class="dv-gin"></div></div>
        <div class="dv-edit">
          <div class="dv-hl"></div>
          <textarea class="dv-ta" spellcheck="false" wrap="off" placeholder="${s === "l" ? "Original text…" : "Modified text…"}"></textarea>
        </div>
      </div>`).join("")}
    </div>`;
  const [cl, cr] = root.querySelectorAll(".dv-col");
  const parts = (c) => ({ ta: c.querySelector(".dv-ta"), hl: c.querySelector(".dv-hl"), gin: c.querySelector(".dv-gin") });
  const P = { l: parts(cl), r: parts(cr) };
  const stats = root.querySelector("#dvStats");
  let result = null, timer = 0, syncing = false;

  function refresh() {
    result = compute(P.l.ta.value, P.r.ta.value);
    paint(P.l.hl, P.l.gin, result.L, result.sideL);
    paint(P.r.hl, P.r.gin, result.R, result.sideR);
    layout();
    stats.innerHTML = result.same ? `<span class="same">Identical</span>` : `<span class="a">+${result.added}</span> <span class="d">−${result.removed}</span>`;
    follow(P.l); follow(P.r);
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, P.l.ta.value.length + P.r.ta.value.length > 50_000 ? 150 : 40); };

  // Line geometry. Without wrapping every line is LINE_H tall; with wrapping we measure the
  // highlight layer (which wraps exactly like the textarea) and size the line numbers to match.
  let wrap = false;
  try { wrap = localStorage.getItem("markora.diffWrap") === "1"; } catch {}
  const offsets = { l: [], r: [] };
  function layout() {
    for (const s of ["l", "r"]) {
      const p = P[s];
      p.hl.style.width = wrap ? p.ta.clientWidth + "px" : "";
      const lines = p.hl.children, nums = p.gin.children;
      const off = [];
      for (let i = 0; i < lines.length; i++) {
        off.push(wrap ? lines[i].offsetTop : 12 + i * LINE_H);
        if (nums[i]) nums[i].style.height = wrap ? lines[i].offsetHeight + "px" : "";
      }
      offsets[s] = off;
    }
  }
  const lineAt = (off, y) => { let lo = 0, hi = off.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (off[m] <= y) lo = m; else hi = m - 1; } return lo; };
  function setWrap(on) {
    wrap = on;
    try { localStorage.setItem("markora.diffWrap", on ? "1" : "0"); } catch {}
    root.classList.toggle("wrap", on);
    root.querySelector("#dvWrap").setAttribute("aria-pressed", String(on));
    layout(); follow(P.l); follow(P.r);
  }

  // keep highlight layer + line numbers glued to the textarea's scroll position
  const follow = (p) => {
    p.hl.style.transform = `translate(${-p.ta.scrollLeft}px, ${-p.ta.scrollTop}px)`;
    p.gin.style.transform = `translateY(${-p.ta.scrollTop}px)`;
  };
  // scrolling one side brings the matching line into view on the other
  function mirror(from, to, map, maxLine) {
    if (syncing || !result) return;
    syncing = true;
    const fo = offsets[from === P.l ? "l" : "r"], to_ = offsets[to === P.l ? "l" : "r"];
    const y = from.ta.scrollTop + 12;
    const i = lineAt(fo, y);
    const h = (fo[i + 1] ?? fo[i] + LINE_H) - fo[i];
    const frac = h ? Math.min(1, (y - fo[i]) / h) : 0;
    const j = Math.min(map(Math.min(i, maxLine)), to_.length - 1);
    const th = (to_[j + 1] ?? to_[j] + LINE_H) - to_[j];
    to.ta.scrollTop = Math.max(0, (to_[j] ?? 12) + frac * th - 12);
    follow(to);
    requestAnimationFrame(() => (syncing = false));
  }
  const l2r = (i) => result.mapLR[i] ?? 0;
  const r2l = (j) => { const m = result.mapLR; let best = 0; for (let i = 0; i < m.length; i++) { if (m[i] <= j) best = i; else break; } return best; };

  for (const s of ["l", "r"]) {
    const p = P[s];
    p.ta.addEventListener("input", () => { schedule(); onChange(P.l.ta.value, P.r.ta.value); });
    p.ta.addEventListener("scroll", () => {
      follow(p);
      if (s === "l") mirror(P.l, P.r, l2r, result ? result.L.length : 0);
      else mirror(P.r, P.l, r2l, result ? result.R.length : 0);
    });
    p.ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        document.execCommand("insertText", false, "\t");
      }
    });
  }

  root.querySelector("#dvWrap").addEventListener("click", () => setWrap(!wrap));
  new ResizeObserver(() => { if (wrap) { layout(); follow(P.l); follow(P.r); } }).observe(P.l.ta);
  setWrap(wrap);

  root.querySelector("#dvSwap").addEventListener("click", () => {
    [P.l.ta.value, P.r.ta.value] = [P.r.ta.value, P.l.ta.value];
    refresh(); onChange(P.l.ta.value, P.r.ta.value);
  });
  root.querySelector("#dvClear").addEventListener("click", () => {
    if (!P.l.ta.value && !P.r.ta.value) return;
    P.l.ta.value = P.r.ta.value = "";
    refresh(); onChange("", ""); P.l.ta.focus();
  });

  return {
    load(left, right) {
      if (P.l.ta.value !== left) P.l.ta.value = left;
      if (P.r.ta.value !== right) P.r.ta.value = right;
      P.l.ta.scrollTop = P.r.ta.scrollTop = 0;
      refresh();
    },
    focus() { (P.l.ta.value ? P.r.ta : P.l.ta).focus(); },
  };
}
