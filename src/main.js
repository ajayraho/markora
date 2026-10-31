import { renderMarkdown, renderMermaid, esc, COPY_ICON, CHECK_ICON } from "./render.js";
import { db, MAX_ITEMS, MAX_TEXT, requestPersistence } from "./db.js";
import { setupEditor, ACTIONS } from "./editor.js";
import { createDiffView } from "./diffview.js";
import { resolveImages, insertImages, setImageToast, previewImageLinks } from "./images.js";
import { initSync, syncNow, syncSoon, syncState, onSyncChange, connect, disconnect, isConnected, fetchText, nameKey } from "./sync.js";
import SAMPLE from "./sample.md";

/* ============================================================
   Elements & small helpers
   ============================================================ */
const $ = (id) => document.getElementById(id);
const els = {
  layout: document.querySelector(".layout"),
  tabs: $("tabs"), empty: $("empty"), doc: $("doc"), md: $("md"), meta: $("meta"),
  outline: $("outline"), drop: $("dropzone"), toast: $("toast"), input: $("fileInput"),
  modeBtn: $("modeBtn"),
  pane: $("editorPane"), editor: $("editor"), edTitle: $("edTitle"), edStatus: $("edStatus"),
  saveBtn: $("saveBtn"), edTools: $("edTools"), resizer: $("resizer"), editBtn: $("editBtn"),
  library: $("library"), libList: $("libList"), libCount: $("libCount"), libSearch: $("libSearch"),
};
const store = {
  get: (k, d) => { try { return localStorage.getItem("markora." + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem("markora." + k, v); } catch {} },
};
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const displayName = (n) => n.replace(/\.(md|markdown|mdown|mkd|mkdn|mdx|txt)$/i, "") || "Untitled";
const debounce = (fn, ms) => { let t; const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; f.flush = (...a) => { clearTimeout(t); fn(...a); }; return f; };

let toastTimer;
function toast(msg, ms = 1900) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms);
}

/* ============================================================
   State
   doc = { id, kind: "note" | "file", name, text, handle?, lastModified, size,
           dirty, scroll, needsPermission, transient }
   - note: lives only in the browser (IndexedDB), autosaved
   - file: a file on disk; edits are kept as a draft until you Save (Ctrl+S)
   ============================================================ */
const docs = [];
let inlineEdit = null; // active edit-in-preview session
let activeId = null;
const active = () => docs.find((d) => d.id === activeId);

/* ============================================================
   Persistence (IndexedDB)
   ============================================================ */
const record = (d) => ({
  pinned: !!d.pinned,
  id: d.id, kind: d.kind, name: d.name,
  text: d.text.length <= MAX_TEXT ? d.text : null,
  handle: d.handle || null, dirty: !!d.dirty,
  lastModified: d.lastModified || 0, size: d.size || 0,
});

/** Make room for one more library item. Returns false if the library is full of notes. */
async function ensureRoom(exceptId) {
  const all = await db.all();
  if (all.some((r) => r.id === exceptId) || all.length < MAX_ITEMS) return true;
  const openIds = new Set(docs.map((d) => d.id));
  // Evict the oldest recent-file entries first (they're only references to disk files)
  const evictable = all.filter((r) => r.kind === "file" && !r.dirty && !openIds.has(r.id)).sort((a, b) => a.updated - b.updated);
  let over = all.length - MAX_ITEMS + 1;
  for (const r of evictable) { if (over-- <= 0) break; await db.del(r.id); }
  return over <= 0;
}

const pending = new Map();
function persist(d, { now = false } = {}) {
  if (d.transient) return;
  clearTimeout(pending.get(d.id));
  const run = async () => {
    pending.delete(d.id);
    try {
      if (!(await ensureRoom(d.id))) {
        d.transient = true;
        toast(`Library is full (${MAX_ITEMS} items). Delete some in the Library to save this note.`, 4000);
        updateEditorChrome();
        return;
      }
      if (d.discarded) return;
      const prev = await db.get(d.id).catch(() => null); // keep sync bookkeeping fields
      const rec = record(d);
      const changed = !prev || prev.text !== rec.text || prev.name !== rec.name;
      await db.put({ ...(prev || {}), ...rec, updated: changed ? Date.now() : prev.updated });
      if (changed) syncSoon(); // batched: pushed after ~30 s of quiet, on tab switch, hide or Ctrl+S
    } catch (e) { console.error("persist failed", e); }
    if (d.id === activeId) updateEditorChrome();
  };
  if (now) return run();
  pending.set(d.id, setTimeout(run, 350));
}
function flushAll() { for (const d of docs) if (pending.has(d.id)) persist(d, { now: true }); }
addEventListener("visibilitychange", () => document.hidden && flushAll());
addEventListener("pagehide", flushAll);

const saveSession = debounce(() => db.setMeta("session", { open: docs.map((d) => d.id), active: activeId }).catch(() => {}), 200);

async function restoreSession() {
  let session;
  try { session = await db.getMeta("session"); } catch { return; }
  if (!session?.open?.length) return;
  for (const id of session.open) {
    const r = await db.get(id).catch(() => null);
    if (!r) continue;
    if (r.kind === "note" && typeof r.text !== "string") continue; // only in Drive: open it from the Library
    const d = { ...r, text: r.text ?? "", scroll: 0 };
    if (d.kind === "file" && d.handle) {
      const perm = await d.handle.queryPermission?.({ mode: "read" }).catch(() => "denied");
      if (perm === "granted") await refreshFromDisk(d, { force: !d.dirty });
      else d.needsPermission = true;
    }
    docs.push(d);
  }
  docs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)); // stable: pinned first, order kept
  activeId = docs.some((d) => d.id === session.active) ? session.active : docs[0]?.id ?? null;
}

/* ============================================================
   Theme: style (claude/chatgpt) × mode (light/dark/system)
   ============================================================ */
const ICONS = {
  light: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  dark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
  system: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>`,
};
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const style = store.get("style", "claude");
  const pref = store.get("mode", "system");
  const mode = pref === "system" ? (darkMQ.matches ? "dark" : "light") : pref;
  const root = document.documentElement;
  const modeChanged = root.dataset.mode !== mode;
  root.dataset.style = style;
  root.dataset.mode = mode;
  document.querySelectorAll("[data-style-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.styleBtn === style)));
  els.modeBtn.innerHTML = ICONS[pref];
  els.modeBtn.title = `Theme: ${pref} (click to change)`;
  requestAnimationFrame(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.body).backgroundColor;
  });
  if (modeChanged && els.md.querySelector(".mermaid-block")) renderPreview(true);
}
document.querySelectorAll("[data-style-btn]").forEach((b) =>
  b.addEventListener("click", () => { store.set("style", b.dataset.styleBtn); applyTheme(); })
);
els.modeBtn.addEventListener("click", () => {
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(store.get("mode", "system")) + 1) % 3];
  store.set("mode", next);
  applyTheme();
  toast(`Theme: ${next}`);
});
darkMQ.addEventListener("change", applyTheme);

/* ============================================================
   Creating & opening documents
   ============================================================ */
const MD_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdx|txt)$/i;

function addDoc(d) {
  docs.push({ scroll: 0, dirty: false, lastModified: 0, size: 0, ...d });
  activate(d.id);
  persist(docs.at(-1), { now: true });
  saveSession();
}

/* One document per name (case-insensitive): "plan.md" here, on your phone and in Drive is one document. */
async function takenNames(exceptId) {
  const taken = new Set();
  for (const r of await db.all().catch(() => [])) if (r.id !== exceptId) taken.add(nameKey(r.name));
  for (const d of docs) if (d.id !== exceptId) taken.add(nameKey(d.name));
  for (const n of (await db.getMeta("sync").catch(() => null))?.remoteNames || []) taken.add(n);
  return taken;
}
async function findByName(name) {
  const k = nameKey(name);
  return docs.find((d) => nameKey(d.name) === k) || (await db.all().catch(() => [])).find((r) => nameKey(r.name) === k) || null;
}
/** "Pasted.md" → "Pasted 2.md" if the name is taken */
async function uniqueName(name) {
  const taken = await takenNames();
  const base = displayName(name), ext = name.match(MD_EXT)?.[0] || ".md";
  if (!taken.has(nameKey(base + ext))) return base + ext;
  let n = 2;
  while (taken.has(nameKey(`${base} ${n}${ext}`))) n++;
  return `${base} ${n}${ext}`;
}
async function nextUntitled() {
  const taken = await takenNames();
  let n = 1;
  while (taken.has(`untitled ${n}.md`)) n++;
  return `Untitled ${n}.md`;
}

async function newNote(text = "", name = null, { edit = true, reuse = false } = {}) {
  if (name && reuse) {
    // e.g. "View sample": open the existing document with this name
    const same = await findByName(name);
    if (same) { await openFromLibrary(same); return; }
  }
  name = name ? await uniqueName(name) : await nextUntitled();
  addDoc({ id: newId(), kind: "note", name, text });
  if (edit) setEditor(true, { focus: true });
}

async function openHandle(handle) {
  // Already open in a tab?
  for (const d of docs) if (d.handle && (await d.handle.isSameEntry(handle).catch(() => false))) {
    await refreshFromDisk(d, { force: !d.dirty, handle });
    return activate(d.id);
  }
  // Known from the library? Reuse its id (keeps any unsaved draft)
  let known = null;
  for (const r of await db.all().catch(() => [])) if (r.handle && (await r.handle.isSameEntry(handle).catch(() => false))) { known = r; break; }
  const file = await handle.getFile();
  if (!known) {
    // Same name already in the library (a note, or the synced copy from another device)? It's the same document.
    const same = await findByName(file.name);
    if (same) {
      const openTab = docs.find((d) => d.id === same.id);
      const rec = openTab || same;
      const diskText = await file.text();
      const localNewer = typeof rec.text === "string" && rec.text !== diskText && (rec.updated || 0) > file.lastModified;
      const d = openTab || { ...same, text: same.text ?? "", scroll: 0 };
      Object.assign(d, { kind: "file", handle, name: file.name, lastModified: file.lastModified, size: file.size, needsPermission: false, noSync: false });
      if (localNewer) { d.dirty = true; toast("Your newer edits are kept. Press Ctrl+S to write them to the file."); }
      else { d.text = diskText; d.dirty = false; }
      if (!openTab) docs.push(d);
      persist(d, { now: true });
      activate(d.id);
      saveSession();
      return;
    }
  }
  if (known?.dirty) {
    const d = { ...known, handle, needsPermission: false, scroll: 0 };
    docs.push(d);
    activate(d.id);
    toast("Restored your unsaved edits for this file");
  } else {
    addDoc({ id: known?.id || newId(), kind: "file", name: file.name, text: await file.text(), handle, lastModified: file.lastModified, size: file.size });
  }
  saveSession();
}

async function openPlainFile(file) {
  // No handle (phones, Firefox): it becomes a note, or updates the document with the same name
  const text = await file.text();
  const same = await findByName(file.name);
  if (!same) return newNote(text, file.name, { edit: false });
  await openFromLibrary(same);
  const d = active();
  if (d && d.text !== text) {
    d.text = text;
    if (d.kind === "file") d.dirty = true;
    persist(d);
    syncEditorFromDoc({ keepCursor: false });
    renderPreview();
    renderTabs();
  }
}

async function pickFiles() {
  if ("showOpenFilePicker" in window) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: "Markdown", accept: { "text/markdown": [".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx"], "text/plain": [".txt"] } }],
      });
      for (const h of handles) await openHandle(h);
    } catch (e) { if (e.name !== "AbortError") console.error(e); }
  } else {
    els.input.click();
  }
}
els.input.addEventListener("change", async () => {
  for (const f of els.input.files) await openPlainFile(f);
  els.input.value = "";
});
$("openBtn").addEventListener("click", pickFiles);
$("emptyOpen").addEventListener("click", pickFiles);
$("emptyNew").addEventListener("click", () => newNote());
$("diffBtn").addEventListener("click", () => newDiff());
$("sampleBtn").addEventListener("click", () => newNote(SAMPLE, "Welcome to Markora.md", { edit: false, reuse: true }));

// Drag & drop anywhere
let dragDepth = 0;
addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { dragDepth++; els.drop.classList.remove("hidden"); } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; els.drop.classList.add("hidden"); } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.drop.classList.add("hidden");
  const dropped = imageFiles(e.dataTransfer?.files);
  if (dropped.length) {
    if (active() && editorOpen) { await insertImages(els.editor, dropped).catch((err) => toast("Couldn't add image: " + err.message)); return; }
    if (dropped.length === (e.dataTransfer?.files?.length || 0)) { toast("Open the editor (Ctrl+E) and drop images there to add them"); return; }
  }
  const items = [...(e.dataTransfer?.items || [])].filter((i) => i.kind === "file");
  const handlesP = items.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : Promise.resolve(null)));
  const files = items.map((i) => i.getAsFile());
  const handles = await Promise.all(handlesP);
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    if (!f || !MD_EXT.test(f.name)) { toast(`Not a Markdown file: ${f?.name ?? "?"}`); continue; }
    if (handles[k]?.kind === "file") await openHandle(handles[k]);
    else await openPlainFile(f);
  }
});

// Paste Markdown text when nothing editable is focused → new note
addEventListener("paste", (e) => {
  if (e.target.closest?.("input, textarea, [contenteditable]")) return;
  const text = e.clipboardData?.getData("text/plain");
  if (text && text.trim()) newNote(text, "Pasted.md", { edit: false });
});

/* ============================================================
   Disk sync: live reload + permissions + saving
   ============================================================ */
async function refreshFromDisk(d, { force = false, handle = d.handle } = {}) {
  try {
    const f = await handle.getFile();
    if (!force && f.lastModified === d.lastModified && f.size === d.size) return false;
    d.text = await f.text();
    Object.assign(d, { lastModified: f.lastModified, size: f.size, dirty: false, needsPermission: false, name: f.name });
    persist(d);
    return true;
  } catch { return false; }
}

async function reconnect(d) {
  try {
    const p = await d.handle.requestPermission({ mode: "read" });
    if (p !== "granted") return toast("Permission not granted");
    d.needsPermission = false;
    if (!d.dirty) await refreshFromDisk(d, { force: true });
    if (d.id === activeId) { syncEditorFromDoc(); renderPreview(); }
    renderTabs();
  } catch (e) { toast("Couldn't reconnect: " + e.message); }
}

let polling = false;
setInterval(async () => {
  const d = active();
  if (polling || inlineEdit || document.hidden || !d?.handle || d.dirty || d.needsPermission) return;
  polling = true;
  if (await refreshFromDisk(d)) { syncEditorFromDoc({ keepCursor: true }); renderPreview(true); toast("Reloaded from disk", 1200); }
  polling = false;
}, 1000);

async function saveDoc(d = active(), { saveAs = false } = {}) {
  if (!d) return;
  if (d.kind === "diff") { await persist(d, { now: true }); return toast("Diffs are saved in this browser automatically"); }
  if (d.kind === "file" && d.handle && !saveAs) {
    try {
      if ((await d.handle.queryPermission({ mode: "readwrite" })) !== "granted" &&
          (await d.handle.requestPermission({ mode: "readwrite" })) !== "granted") return toast("Write permission denied");
      const w = await d.handle.createWritable();
      await w.write(d.text);
      await w.close();
      const f = await d.handle.getFile();
      Object.assign(d, { dirty: false, lastModified: f.lastModified, size: f.size, needsPermission: false });
      await persist(d, { now: true });
      renderTabs(); updateEditorChrome(); renderMeta();
      toast(`Saved ${d.name}${isConnected() ? " (and to Google Drive)" : ""}`);
      syncNow();
    } catch (e) { toast("Save failed: " + e.message, 3000); }
    return;
  }
  if (d.kind === "note" && !saveAs) {
    await persist(d, { now: true });
    if (isConnected()) { await syncNow(); toast(syncState().status === "error" ? "Saved here. Drive sync will retry." : "Saved to Google Drive"); }
    else toast("Saved in this browser. Ctrl+Shift+S saves it as a file.");
    updateEditorChrome();
    return;
  }
  // Notes (or Save As): pick a location on disk
  const suggestedName = MD_EXT.test(d.name) ? d.name : d.name + ".md";
  if ("showSaveFilePicker" in window) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }] });
      const w = await handle.createWritable();
      await w.write(d.text);
      await w.close();
      const f = await handle.getFile();
      Object.assign(d, { kind: "file", handle, name: f.name, dirty: false, lastModified: f.lastModified, size: f.size, transient: false });
      await persist(d, { now: true });
      syncSoon(1000);
      renderTabs(); updateEditorChrome(); renderMeta();
      toast(`Saved to ${f.name} — edits now save to this file`);
    } catch (e) { if (e.name !== "AbortError") toast("Save failed: " + e.message, 3000); }
  } else {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([d.text], { type: "text/markdown" })), download: suggestedName });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
els.saveBtn.addEventListener("click", () => saveDoc());

// "Open with → Markora" from the OS (File Handling API)
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    await ready;
    for (const h of params.files || []) if (h.kind === "file") await openHandle(h);
  });
}

/* ============================================================
   Tabs
   ============================================================ */
function activate(id) {
  const prev = active();
  if (prev && prev.id !== id) { prev.scroll = scrollY; syncSoon(1500); }
  if (id) db.get(id).then((r) => r && db.put({ ...r, lastOpened: Date.now() })).catch(() => {});
  activeId = id;
  renderTabs();
  syncEditorFromDoc();
  renderPreview();
  saveSession();
}

function closeDoc(id, { force = false } = {}) {
  const i = docs.findIndex((d) => d.id === id);
  if (i < 0) return;
  const d = docs[i];
  const emptyDiff = d.kind === "diff" && !parseDiff(d).left.trim() && !parseDiff(d).right.trim();
  if ((d.kind === "note" && !d.text.trim()) || emptyDiff) {
    // Closing an empty note discards it, so the library doesn't fill up with blank "Untitled N"s
    d.discarded = true;
    clearTimeout(pending.get(d.id)); pending.delete(d.id);
    db.del(d.id).then(() => syncSoon(), () => {});
  } else if (pending.has(d.id)) persist(d, { now: true });
  if (!force && d.transient && d.text.trim() && !confirm(`"${displayName(d.name)}" isn't saved (library full). Close anyway?`)) return;
  docs.splice(i, 1);
  if (activeId === id) activeId = docs[Math.min(i, docs.length - 1)]?.id ?? null;
  renderTabs();
  syncEditorFromDoc();
  renderPreview();
  saveSession();
}

const PIN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/></svg>`;

/* ---------- Reorder: drag & drop (pinned tabs always stay first) ---------- */
let dragId = null;
function wireTabDrag(t, d) {
  t.addEventListener("dragstart", (e) => {
    dragId = d.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-markora-tab", d.id);
    requestAnimationFrame(() => t.classList.add("dragging"));
  });
  t.addEventListener("dragend", () => { dragId = null; clearDropMarks(); renderTabs(); });
  t.addEventListener("dragover", (e) => {
    if (!dragId || dragId === d.id) return;
    const from = docs.find((x) => x.id === dragId);
    if (!!from.pinned !== !!d.pinned) return; // can't mix pinned / unpinned zones
    e.preventDefault();
    e.stopPropagation();
    const r = t.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    clearDropMarks();
    t.classList.add(after ? "drop-after" : "drop-before");
  });
  t.addEventListener("drop", (e) => {
    if (!dragId || dragId === d.id) return;
    e.preventDefault();
    e.stopPropagation();
    const after = t.classList.contains("drop-after");
    const from = docs.findIndex((x) => x.id === dragId);
    const [moved] = docs.splice(from, 1);
    let to = docs.findIndex((x) => x.id === d.id) + (after ? 1 : 0);
    docs.splice(to, 0, moved);
    clearDropMarks();
    renderTabs();
    saveSession();
  });
}
function clearDropMarks() { els.tabs.querySelectorAll(".drop-before, .drop-after, .dragging").forEach((x) => x.classList.remove("drop-before", "drop-after", "dragging")); }

/** Move a tab left/right with the keyboard, staying inside its pinned/unpinned zone */
function moveTab(id, dir) {
  const i = docs.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= docs.length || !!docs[j].pinned !== !!docs[i].pinned) return;
  [docs[i], docs[j]] = [docs[j], docs[i]];
  renderTabs();
  saveSession();
}

/* ---------- Pin / unpin ---------- */
function togglePin(id) {
  const d = docs.find((x) => x.id === id);
  if (!d) return;
  d.pinned = !d.pinned;
  docs.splice(docs.indexOf(d), 1);
  const firstUnpinned = docs.findIndex((x) => !x.pinned);
  // pinning → end of the pinned group; unpinning → start of the unpinned group
  docs.splice(firstUnpinned < 0 ? docs.length : firstUnpinned, 0, d);
  persist(d);
  renderTabs();
  saveSession();
}

/* ---------- Right-click menu on tabs ---------- */
const tabMenu = Object.assign(document.createElement("div"), { className: "tab-menu hidden", role: "menu" });
document.body.appendChild(tabMenu);
function openTabMenu(id, x, y) {
  const d = docs.find((t) => t.id === id);
  if (!d) return;
  const i = docs.indexOf(d);
  const items = [
    [d.pinned ? "Unpin tab" : "Pin tab", () => togglePin(id)],
    ["Rename", () => startTabRename(id), "F2"],
    ["Move left", () => moveTab(id, -1), "Ctrl+Shift+PgUp", i === 0 || !!docs[i - 1].pinned !== !!d.pinned],
    ["Move right", () => moveTab(id, 1), "Ctrl+Shift+PgDn", i === docs.length - 1 || !!docs[i + 1].pinned !== !!d.pinned],
    null,
    ["Close", () => closeDoc(id), "Alt+W"],
    ["Close other tabs", () => docs.filter((t) => t.id !== id && !t.pinned).forEach((t) => closeDoc(t.id)), "", docs.every((t) => t.id === id || t.pinned)],
  ];
  tabMenu.innerHTML = "";
  for (const it of items) {
    if (!it) { tabMenu.appendChild(Object.assign(document.createElement("div"), { className: "sep" })); continue; }
    const [label, fn, key = "", disabled = false] = it;
    const b = document.createElement("button");
    b.type = "button";
    b.disabled = disabled;
    b.innerHTML = `<span></span><kbd>${key}</kbd>`;
    b.firstChild.textContent = label;
    b.addEventListener("click", () => { closeTabMenu(); fn(); });
    tabMenu.appendChild(b);
  }
  tabMenu.classList.remove("hidden");
  const r = tabMenu.getBoundingClientRect();
  tabMenu.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
  tabMenu.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
}
function closeTabMenu() { tabMenu.classList.add("hidden"); }
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".tab-menu")) closeTabMenu(); });
addEventListener("blur", closeTabMenu);
addEventListener("resize", closeTabMenu);

let tabEditing = false;
function renderTabs() {
  if (tabEditing) return;
  els.tabs.innerHTML = "";
  for (const d of docs) {
    const t = document.createElement("div");
    t.className = "tab" + (d.id === activeId ? " active" : "") + (d.dirty ? " dirty" : "") + (d.pinned ? " pinned" : "");
    t.draggable = true;
    t.dataset.id = d.id;
    const live = d.kind === "file" && d.handle && !d.needsPermission;
    t.title = (d.kind === "note" ? `${d.name} — note saved in browser` : live ? `${d.name} — live reload on` : d.name) + "\nDouble-click to rename (F2)";
    const dot = live ? '<span class="live"></span>' : d.kind === "diff" ? '<span class="diff-ico">±</span>' : d.kind === "note" ? '<span class="note-dot"></span>' : "";
    t.innerHTML = d.pinned
      ? `<span class="pin" title="Pinned">${PIN_ICON}</span><span class="name"></span>${dot}`
      : `${dot}<span class="name"></span><button class="x" title="Close (Alt+W)" aria-label="Close">×</button>`;
    t.querySelector(".name").textContent = displayName(d.name);
    t.addEventListener("click", (e) => { if (!e.target.closest(".x")) activate(d.id); });
    t.addEventListener("auxclick", (e) => { if (e.button === 1) closeDoc(d.id); });
    t.addEventListener("dblclick", (e) => { if (!e.target.closest(".x")) startTabRename(d.id); });
    t.querySelector(".x")?.addEventListener("click", () => closeDoc(d.id));
    t.addEventListener("contextmenu", (e) => { e.preventDefault(); openTabMenu(d.id, e.clientX, e.clientY); });
    wireTabDrag(t, d);
    els.tabs.appendChild(t);
    if (d.id === activeId) t.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  if (docs.length) {
    const add = document.createElement("button");
    add.className = "tab-add";
    add.title = "New note (Alt+N)";
    add.setAttribute("aria-label", "New note");
    add.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
    add.addEventListener("click", () => newNote());
    els.tabs.appendChild(add);
  }
}

/** Inline rename inside the tab */
function startTabRename(id) {
  const d = docs.find((x) => x.id === id);
  const tab = [...els.tabs.children][docs.indexOf(d)];
  if (!d || !tab || tabEditing) return;
  if (d.id !== activeId) activate(d.id);
  tabEditing = true;
  const nameEl = [...els.tabs.children][docs.indexOf(d)].querySelector(".name");
  const input = Object.assign(document.createElement("input"), { className: "tab-rename", value: displayName(d.name), spellcheck: false });
  input.style.width = Math.max(80, nameEl.offsetWidth + 24) + "px";
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    tabEditing = false;
    if (commit) await renameDoc(d, input.value);
    renderTabs();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("input", () => (input.style.width = Math.max(80, input.value.length * 7.5 + 24) + "px"));
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
}

/** Rename a note, or rename a disk file in place (Chromium's FileSystemHandle.move) */
async function renameDoc(d, raw) {
  let name = (raw || "").trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\.+$/, "");
  if (!name) return false;
  if (!MD_EXT.test(name)) name += d.name.match(MD_EXT)?.[0] || ".md";
  if (name === d.name) return true;
  if (nameKey(name) !== nameKey(d.name) && (await takenNames(d.id)).has(nameKey(name))) {
    toast(`"${displayName(name)}" already exists. Pick another name.`, 3000);
    return false;
  }
  if (d.kind === "file" && d.handle) {
    if (typeof d.handle.move !== "function") {
      toast("This browser can't rename files on disk. Use Save as (Ctrl+Shift+S) instead.", 3500);
      return false;
    }
    try {
      if ((await d.handle.queryPermission({ mode: "readwrite" })) !== "granted" &&
          (await d.handle.requestPermission({ mode: "readwrite" })) !== "granted") { toast("Rename needs write permission"); return false; }
      await d.handle.move(name);
      const f = await d.handle.getFile();
      Object.assign(d, { name: f.name, lastModified: f.lastModified, size: f.size });
      toast(`Renamed to ${f.name}`);
    } catch (e) {
      toast(e.name === "InvalidModificationError" || /exist/i.test(e.message) ? `A file named ${name} already exists` : "Rename failed: " + e.message, 3500);
      return false;
    }
  } else {
    d.name = name;
  }
  persist(d);
  if (d.id === activeId) {
    document.title = `${d.dirty ? "• " : ""}${displayName(d.name)} — Markora`;
    if (document.activeElement !== els.edTitle) els.edTitle.value = displayName(d.name);
    renderMeta();
  }
  return true;
}

/* ============================================================
   Preview
   ============================================================ */
function renderMeta() {
  const d = active();
  if (!d) return;
  const words = (d.text.match(/\S+/g) || []).length;
  const parts = [d.kind === "note" ? "Note" : "File", `${words.toLocaleString()} words`, `${Math.max(1, Math.round(words / 230))} min read`];
  if (d.kind === "file" && d.lastModified) parts.push(`Saved ${new Date(d.lastModified).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`);
  els.meta.innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join('<span class="dot"></span>');
  let banner = document.getElementById("permBanner");
  if (d.needsPermission) {
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "permBanner";
      banner.className = "perm-banner";
      els.doc.prepend(banner);
    }
    banner.innerHTML = `<span>Showing the last saved copy of <b></b>. Reconnect to read the latest version from disk.</span><button class="btn sm">Reconnect</button>`;
    banner.querySelector("b").textContent = d.name;
    banner.querySelector("button").onclick = () => reconnect(d);
  } else banner?.remove();
}

/* ---------- Diff tabs: two live-diffed columns, kept in this browser only ---------- */
const diffRoot = $("diffView");
const parseDiff = (d) => { try { const j = JSON.parse(d.text || "{}"); return { left: j.left || "", right: j.right || "" }; } catch { return { left: "", right: "" }; } };
const diffView = createDiffView(diffRoot, {
  onChange(left, right) {
    const d = active();
    if (d?.kind !== "diff") return;
    d.text = JSON.stringify({ left, right });
    persist(d);
  },
});
async function newDiff() {
  const taken = await takenNames();
  let n = 1;
  while (taken.has(nameKey(`Diff ${n}`))) n++;
  addDoc({ id: newId(), kind: "diff", name: `Diff ${n}`, text: JSON.stringify({ left: "", right: "" }) });
  diffView.focus();
}
let shownDiffId = null;

async function renderPreview(keepScroll = false) {
  if (inlineEdit) return;
  const d = active();
  const isDiff = d?.kind === "diff";
  diffRoot.classList.toggle("hidden", !isDiff);
  document.body.classList.toggle("diff-mode", isDiff);
  if (isDiff) {
    for (const el of [els.empty, els.doc, els.pane, els.resizer, els.outline]) el.classList.add("hidden");
    els.layout.classList.remove("editing");
    document.title = `${displayName(d.name)} — Markora`;
    if (shownDiffId !== d.id) { const { left, right } = parseDiff(d); diffView.load(left, right); shownDiffId = d.id; }
    return;
  }
  shownDiffId = null;
  const hasDoc = !!d;
  els.empty.classList.toggle("hidden", hasDoc);
  els.doc.classList.toggle("hidden", !hasDoc);
  els.layout.classList.toggle("editing", hasDoc && editorOpen);
  els.pane.classList.toggle("hidden", !(hasDoc && editorOpen));
  els.resizer.classList.toggle("hidden", !(hasDoc && editorOpen));
  if (!hasDoc) { document.title = "Markora"; buildOutline(); return; }
  const y = keepScroll ? scrollY : d.scroll;
  document.title = `${d.dirty ? "• " : ""}${displayName(d.name)} — Markora`;
  renderMeta();
  els.md.innerHTML = renderMarkdown(d.text);
  els.md.querySelectorAll("a[href]").forEach((a) => {
    if (/^https?:|^mailto:/i.test(a.getAttribute("href"))) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  });
  els.md.querySelectorAll('input[type="checkbox"][disabled]').forEach((c) => { c.disabled = false; });
  const mermaidDone = renderMermaid(els.md); // cached diagrams fill synchronously → no jump while typing
  resolveImages(els.md, d, () => renderPreview(true));
  previewImageLinks(els.md);
  buildOutline();
  scrollTo(0, y);
  await mermaidDone;
  if (y && !keepScroll) scrollTo(0, y);
}

// Copy buttons
/* ============================================================
   Edit in the preview: double-click a block, tick checkboxes
   ============================================================ */
/** Replace a range of the active doc's text and refresh everything */
function applyEdit(a, len, replacement) {
  const d = active();
  if (!d) return;
  d.text = d.text.slice(0, a) + replacement + d.text.slice(a + len);
  if (d.kind === "file") d.dirty = true;
  persist(d);
  renderTabs();
  syncEditorFromDoc({ keepCursor: true });
  renderPreview(true);
}

// Checkboxes: toggle the n-th task marker inside the block's source
els.md.addEventListener("change", (e) => {
  const box = e.target.closest('input[type="checkbox"]');
  const blk = box?.closest(".blk");
  if (!blk || inlineEdit) return;
  const d = active();
  const a = +blk.dataset.a, len = +blk.dataset.len;
  const n = [...blk.querySelectorAll('input[type="checkbox"]')].indexOf(box);
  let i = -1;
  const src = d.text.slice(a, a + len).replace(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/gm, (m, pre, mark) =>
    ++i === n ? `${pre}[${mark === " " ? "x" : " "}]` : m);
  applyEdit(a, len, src);
});

// Double-click a block → edit its Markdown in place. Leaves on Esc (or Ctrl+Enter),
// clicking elsewhere, or after a few idle seconds. Changes are always kept.
const IDLE_MS = 4000;
els.md.addEventListener("dblclick", (e) => {
  if (inlineEdit || e.target.closest("a, button, input, textarea, .copy")) return;
  const blk = e.target.closest(".blk");
  if (!blk) return;
  window.getSelection()?.removeAllRanges();
  const d = active();
  const a = +blk.dataset.a, len = +blk.dataset.len;
  const ta = Object.assign(document.createElement("textarea"), { className: "inline-edit", value: d.text.slice(a, a + len), spellcheck: true });
  blk.replaceChildren(ta, Object.assign(document.createElement("div"), { className: "inline-hint", textContent: "Esc to finish" }));
  blk.classList.add("editing");
  const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  fit();
  ta.focus();
  let timer;
  const finish = (save = true) => {
    if (!inlineEdit) return;
    clearTimeout(timer);
    inlineEdit = null;
    if (save && ta.value !== d.text.slice(a, a + len)) applyEdit(a, len, ta.value);
    else renderPreview(true);
  };
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => finish(true), IDLE_MS); };
  inlineEdit = { finish };
  ta.addEventListener("input", () => { fit(); bump(); });
  ta.addEventListener("keydown", (ev) => {
    bump();
    if (ev.key === "Escape" || (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); ev.stopPropagation(); finish(true); }
  });
  ta.addEventListener("pointerdown", bump);
  ta.addEventListener("blur", () => setTimeout(() => finish(true), 0));
  bump();
});

els.md.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy");
  if (!btn) return;
  const code = btn.closest(".codeblock").querySelector("code").innerText;
  try {
    await navigator.clipboard.writeText(code);
    btn.innerHTML = `${CHECK_ICON}<span>Copied</span>`;
    setTimeout(() => (btn.innerHTML = `${COPY_ICON}<span>Copy</span>`), 1600);
  } catch { toast("Couldn't access clipboard"); }
});

/* ============================================================
   Editor pane
   ============================================================ */
let editorOpen = store.get("editor", "0") === "1";

const TOOL_ICONS = {
  heading: "H", bold: "<b>B</b>", italic: "<i>I</i>", strike: "<s>S</s>", code: "&lt;/&gt;",
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>`,
  ul: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>`,
  ol: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 4.5h1.2V9M3.6 9h2.4M3.6 14.2c.4-.6 2.6-.7 2.4.8-.1.9-2.4 1.9-2.4 3h2.6" stroke-width="1.5"/></svg>`,
  task: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="7" height="7" rx="1.5"/><path d="m4.8 7.5 1.5 1.5 2.5-3"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 7.5h7M14 17.5h7"/></svg>`,
  quote: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 18v-5c0-4 2-6.5 5.5-7l.5 1.5C8 8.3 7.2 9.6 7.2 11H10v7zm10 0v-5c0-4 2-6.5 5.5-7l.5 1.5c-2 .8-2.8 2.1-2.8 3.5H20v7z"/></svg>`,
  codeblock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 8-4 4 4 4M16 8l4 4-4 4"/></svg>`,
  table: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M10 4v16"/></svg>`,
};
const GROUPS = [["heading", "bold", "italic", "strike", "code"], ["link", "ul", "ol", "task"], ["quote", "codeblock", "table"]];
for (const [gi, g] of GROUPS.entries()) {
  if (gi) els.edTools.appendChild(Object.assign(document.createElement("span"), { className: "sep" }));
  for (const key of g) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tool";
    b.title = ACTIONS[key].title;
    b.innerHTML = TOOL_ICONS[key];
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep textarea selection
    b.addEventListener("click", () => ACTIONS[key].run(els.editor));
    els.edTools.appendChild(b);
  }
}
setupEditor(els.editor);
setImageToast((m) => toast(m, 3500));

// Paste or drop images into the editor → embedded in the note
const imageFiles = (list) => [...(list || [])].filter((f) => f.type.startsWith("image/"));
els.editor.addEventListener("paste", (e) => {
  const imgs = imageFiles(e.clipboardData?.files);
  if (!imgs.length) return;
  e.preventDefault();
  insertImages(els.editor, imgs).catch((err) => toast("Couldn't add image: " + err.message));
});

function setEditor(open, { focus = false } = {}) {
  editorOpen = open;
  store.set("editor", open ? "1" : "0");
  els.editBtn.setAttribute("aria-pressed", String(open));
  renderPreview(true);
  syncEditorFromDoc();
  if (open && focus) els.editor.focus();
}
els.editBtn.addEventListener("click", () => (active() ? setEditor(!editorOpen, { focus: !editorOpen }) : newNote()));
$("collapseBtn").addEventListener("click", () => setEditor(false));

function syncEditorFromDoc({ keepCursor = false } = {}) {
  const d = active();
  if (d?.kind === "diff") return;
  if (!d || !editorOpen) return updateEditorChrome();
  if (els.editor.value !== d.text) {
    const { selectionStart: s, selectionEnd: e, scrollTop } = els.editor;
    els.editor.value = d.text;
    if (keepCursor) { els.editor.setSelectionRange(s, e); els.editor.scrollTop = scrollTop; }
    else { els.editor.setSelectionRange(0, 0); els.editor.scrollTop = 0; }
  }
  if (document.activeElement !== els.edTitle) els.edTitle.value = displayName(d.name);
  els.edTitle.title = d.kind === "file" ? "Rename the file on disk (Enter to apply)" : "Click to rename";
  updateEditorChrome();
}

function updateEditorChrome() {
  const d = active();
  if (!d) return;
  let status, cls = "";
  if (d.transient) { status = "Not saved: library full"; cls = "warn"; }
  else if (d.kind === "note") status = pending.has(d.id) ? "Saving…" : "Saved in browser";
  else if (d.dirty) { status = "Unsaved changes"; cls = "warn"; }
  else status = "Saved to disk";
  els.edStatus.textContent = status;
  els.edStatus.className = "ed-status " + cls;
  els.saveBtn.textContent = d.kind === "file" ? "Save" : "Save as…";
  els.saveBtn.title = d.kind === "file" ? "Save to disk (Ctrl+S)" : "Save as a .md file on disk (Ctrl+S)";
  els.saveBtn.classList.toggle("primary", d.kind === "file" && d.dirty);
}

const livePreview = debounce(() => renderPreview(true), 140);
els.editor.addEventListener("input", () => {
  const d = active();
  if (!d) return;
  d.text = els.editor.value;
  const wasDirty = d.dirty;
  if (d.kind === "file") d.dirty = true;
  persist(d);
  updateEditorChrome();
  if (wasDirty !== d.dirty) renderTabs();
  livePreview();
  syncScroll();
});

els.edTitle.addEventListener("input", () => {
  const d = active();
  if (!d || d.kind !== "note") return;
  d.name = (els.edTitle.value.trim() || "Untitled") + ".md";
  persist(d);
  renderTabs();
  document.title = `${displayName(d.name)} — Markora`;
});
els.edTitle.addEventListener("change", async () => {
  const d = active();
  if (!d || d.kind !== "file") return;
  if (!(await renameDoc(d, els.edTitle.value))) els.edTitle.value = displayName(d.name);
  renderTabs();
});
els.edTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); els.editor.focus(); }
  else if (e.key === "Escape") { const d = active(); if (d) els.edTitle.value = displayName(d.name); els.editor.focus(); }
});

// Scroll sync: editor → preview (proportional)
function syncScroll() {
  const ta = els.editor;
  const max = ta.scrollHeight - ta.clientHeight;
  if (max <= 0) return;
  const ratio = ta.scrollTop / max;
  scrollTo(0, ratio * (document.documentElement.scrollHeight - innerHeight));
}
els.editor.addEventListener("scroll", () => requestAnimationFrame(syncScroll));

// Resizable split
const applyWidth = (w) => els.layout.style.setProperty("--editor-w", w + "px");
applyWidth(+store.get("editorW", Math.round(innerWidth * 0.45)));
els.resizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  els.resizer.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing");
  const move = (ev) => applyWidth(Math.min(Math.max(ev.clientX, 280), innerWidth - 320));
  const up = (ev) => {
    els.resizer.removeEventListener("pointermove", move);
    document.body.classList.remove("resizing");
    store.set("editorW", Math.round(Math.min(Math.max(ev.clientX, 280), innerWidth - 320)));
  };
  els.resizer.addEventListener("pointermove", move);
  els.resizer.addEventListener("pointerup", up, { once: true });
});
els.resizer.addEventListener("dblclick", () => { applyWidth(Math.round(innerWidth / 2)); store.set("editorW", Math.round(innerWidth / 2)); });

/* ============================================================
   Library (IndexedDB): notes + recent files
   ============================================================ */
const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
};
const NOTE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const FILE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`;

async function renderLibrary() {
  const all = (await db.all().catch(() => [])).sort((a, b) => b.updated - a.updated);
  const notes = all.filter((r) => r.kind === "note").length;
  els.libCount.textContent = `${all.length}/${MAX_ITEMS}`;
  els.libCount.title = `${notes} notes, ${all.length - notes} recent files`;
  const q = els.libSearch.value.trim().toLowerCase();
  const rows = q ? all.filter((r) => r.name.toLowerCase().includes(q) || (r.text || "").toLowerCase().includes(q)) : all;
  els.libList.innerHTML = rows.length ? "" : `<div class="lib-empty">${q ? "No matches" : "Nothing here yet. Create a note or open a file."}</div>`;
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "lib-row" + (r.id === activeId ? " current" : "");
    const preview = r.kind === "diff" ? "" : (r.text || "").replace(/[#>*_`\-\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    row.innerHTML = `<span class="ico">${r.kind === "note" ? NOTE_ICON : FILE_ICON}</span>
      <span class="txt"><span class="nm"></span><span class="sub"></span></span>
      <button class="del" title="${r.kind === "note" ? "Delete note" : "Remove from recent files"}">×</button>`;
    row.querySelector(".nm").textContent = displayName(r.name) + (r.dirty ? " •" : "");
    const where = r.kind === "diff" ? "Diff · this browser" : r.kind === "file" ? "On this device" : typeof r.text !== "string" ? "In Google Drive" : r.remoteId ? "Synced" : "This browser";
    row.querySelector(".sub").textContent = `${where} · ${ago(r.updated)}${preview ? " · " + preview : ""}`;
    row.addEventListener("click", (e) => { if (!e.target.closest(".del")) { openFromLibrary(r); toggleLibrary(false); } });
    const del = row.querySelector(".del");
    del.addEventListener("click", async () => {
      if (!del.classList.contains("confirm")) {
        del.classList.add("confirm");
        del.textContent = r.kind === "note" ? "Delete?" : "Remove?";
        setTimeout(() => { del.classList.remove("confirm"); del.textContent = "×"; }, 2500);
        return;
      }
      const open = docs.find((d) => d.id === r.id);
      if (open) { open.transient = true; clearTimeout(pending.get(open.id)); pending.delete(open.id); closeDoc(open.id, { force: true }); }
      await db.del(r.id);
      syncSoon(500);
      renderLibrary();
    });
    els.libList.appendChild(row);
  }
}

async function openFromLibrary(r) {
  if (docs.some((d) => d.id === r.id)) return activate(r.id);
  if (typeof r.text !== "string" && r.kind === "note") {
    if (!isConnected() || !navigator.onLine) return toast("This note is in Google Drive. Connect to the internet to open it.");
    try { r = { ...r, text: await fetchText(r) }; } catch (e) { return toast("Couldn't download it: " + e.message); }
  }
  const d = { ...r, text: r.text ?? "", scroll: 0 };
  if (d.kind === "file" && d.handle) {
    let perm = await d.handle.queryPermission({ mode: "read" }).catch(() => "denied");
    if (perm !== "granted") perm = await d.handle.requestPermission({ mode: "read" }).catch(() => "denied"); // we're in a click
    if (perm === "granted") { if (!d.dirty) await refreshFromDisk(d, { force: true }); }
    else d.needsPermission = true;
  }
  docs.push(d);
  activate(d.id);
}

function toggleLibrary(on = els.library.classList.contains("hidden")) {
  els.library.classList.toggle("hidden", !on);
  if (on) toggleSyncPop(false);
  $("libraryBtn").setAttribute("aria-pressed", String(on));
  if (on) { els.libSearch.value = ""; renderLibrary(); setTimeout(() => els.libSearch.focus(), 0); }
}
$("libraryBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleLibrary(); });
$("libNew").addEventListener("click", () => { toggleLibrary(false); newNote(); });
els.libSearch.addEventListener("input", renderLibrary);
document.addEventListener("pointerdown", (e) => {
  if (!els.library.classList.contains("hidden") && !e.target.closest("#library, #libraryBtn")) toggleLibrary(false);
});

/* ============================================================
   Outline
   ============================================================ */
let outlineOn = store.get("outline", innerWidth > 1100 ? "1" : "0") === "1";
let observer;
function buildOutline() {
  observer?.disconnect();
  const heads = [...els.md.querySelectorAll("h1, h2, h3")];
  const show = outlineOn && !els.doc.classList.contains("hidden") && heads.length > 1;
  els.outline.classList.toggle("hidden", !show);
  if (!show) return;
  const minLevel = Math.min(...heads.map((h) => +h.tagName[1]));
  els.outline.innerHTML = "<h4>On this page</h4>";
  const links = new Map();
  for (const h of heads) {
    const a = document.createElement("a");
    a.href = "#" + h.id;
    a.textContent = h.textContent;
    a.className = "l" + (+h.tagName[1] - minLevel + 1);
    a.addEventListener("click", (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior: "smooth", block: "start" });
      if (innerWidth <= 1100) toggleOutline(false);
    });
    els.outline.appendChild(a);
    links.set(h, a);
  }
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) {
      els.outline.querySelectorAll("a.active").forEach((x) => x.classList.remove("active"));
      links.get(en.target)?.classList.add("active");
    }
  }, { rootMargin: "-60px 0px -70% 0px" });
  heads.forEach((h) => observer.observe(h));
}
function toggleOutline(on = !outlineOn) {
  outlineOn = on;
  store.set("outline", on ? "1" : "0");
  buildOutline();
}
$("outlineBtn").addEventListener("click", () => toggleOutline());

/* ============================================================
   Google Drive sync UI
   ============================================================ */
const CLOUD = {
  off: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 0 1 2.3 8.4"/><path d="m3 3 18 18"/></svg>`,
  idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z"/></svg>`,
  syncing: `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z"/><path d="M12 10v3M12 16h.01"/></svg>`,
};
const syncBtn = $("syncBtn"), syncPop = $("syncPop");

function renderSyncUI(st = syncState()) {
  syncBtn.innerHTML = CLOUD[st.status];
  syncBtn.classList.toggle("warn", st.status === "error");
  syncBtn.title = st.status === "off" ? "Sync with Google Drive" : st.status === "syncing" ? "Syncing…" : st.status === "error" ? "Sync problem: " + st.error : `Synced with Google Drive${st.email ? " (" + st.email + ")" : ""}`;
  if (syncPop.classList.contains("hidden")) return;
  if (st.status === "off") {
    syncPop.innerHTML = `<div class="lib-head"><strong>Sync with Google Drive</strong></div>
      <div class="sync-body"><p>See and edit your notes on every device. They're saved as <code>.md</code> files in a <b>Markora</b> folder in your own Google Drive. Markora can only see the files it creates there.</p>
      <p class="muted">Files you open from disk sync too. Changes made elsewhere are written back to the file.</p>
      <button class="btn primary" id="syncConnect">Connect Google Drive</button>
      <p class="muted legal"><a href="privacy.html" target="_blank">Privacy</a> · <a href="terms.html" target="_blank">Terms</a></p></div>`;
    $("syncConnect").onclick = () => { flushAll(); connect(); };
  } else {
    const when = st.status === "syncing" ? "Syncing…" : st.status === "error" ? `Problem: ${esc(st.error || "unknown")}` : st.lastSync ? `Synced ${ago(st.lastSync)}` : "Waiting to sync";
    syncPop.innerHTML = `<div class="lib-head"><strong>Google Drive</strong><span class="lib-count"></span></div>
      <div class="sync-body"><p><span class="sync-dot ${st.status}"></span>${when}${navigator.onLine ? "" : " · offline"}</p>
      <p class="muted">Notes and files you open sync to the <b>Markora</b> folder in your Drive.</p>
      <div class="row"><button class="btn primary" id="syncNowBtn">Sync now</button><button class="btn" id="syncOff">Disconnect</button></div></div>`;
    syncPop.querySelector(".lib-count").textContent = st.email || "";
    $("syncNowBtn").onclick = () => syncNow();
    $("syncOff").onclick = async () => {
      const { missing } = await disconnect();
      toast(missing ? `Disconnected. ${missing} notes couldn't be downloaded and stay only in Drive.` : "Disconnected. All your notes are kept on this device.", 4000);
    };
  }
}
function toggleSyncPop(on = syncPop.classList.contains("hidden")) {
  syncPop.classList.toggle("hidden", !on);
  syncBtn.setAttribute("aria-pressed", String(on));
  if (on) { toggleLibrary(false); renderSyncUI(); }
}
syncBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleSyncPop(); });
document.addEventListener("pointerdown", (e) => {
  if (!syncPop.classList.contains("hidden") && !e.target.closest("#syncPop, #syncBtn")) toggleSyncPop(false);
});
onSyncChange(renderSyncUI);

const isBusy = (id) => pending.has(id) || (!!inlineEdit && activeId === id);

/** A disk file was edited on another device: write it to disk if we still may, else leave it unsaved (•) */
async function writeSyncedChange(d) {
  const perm = await d.handle?.queryPermission?.({ mode: "readwrite" }).catch(() => "denied");
  if (perm === "granted") await saveDoc(d);
  else toast(`${displayName(d.name)} was edited on another device. Press Ctrl+S to save it to disk.`, 4500);
}

/** Apply changes that the sync pulled down from Drive to open tabs */
async function onRemoteChanges(changes) {
  const closedFiles = changes.filter((c) => c.type === "updated" && c.kind === "file" && !docs.some((d) => d.id === c.id));
  if (closedFiles.length) toast(`${closedFiles.length === 1 ? "A file" : closedFiles.length + " files"} you opened here changed on another device. Open from the Library to save.`, 4500);
  const reset = changes.find((c) => c.type === "reset");
  if (reset) toast(`${reset.count} documents were missing from Google Drive. Uploading them again from this device.`, 4500);
  if (changes.some((c) => c.merged && docs.some((d) => d.id === c.id))) toast("Merged with edits from another device", 2500);
  for (const c of changes) {
    const d = docs.find((x) => x.id === c.id);
    if (!d) continue;
    if (c.type === "updated") {
      const rec = await db.get(c.id);
      if (!rec || isBusy(d.id)) continue; // mid-edit: merged on the next round
      d.text = rec.text ?? "";
      if (d.kind === "file") {
        d.dirty = true;
        await writeSyncedChange(d);
      } else d.name = rec.name;
      if (d.id === activeId) { syncEditorFromDoc({ keepCursor: true }); renderPreview(true); }
    } else if (c.type === "deleted" && !pending.has(d.id)) {
      d.discarded = true;
      closeDoc(d.id, { force: true });
    }
  }
  renderTabs();
  if (!els.library.classList.contains("hidden")) renderLibrary();
}

/* ============================================================
   Keyboard
   ============================================================ */
addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === "s") { e.preventDefault(); saveDoc(active(), { saveAs: e.shiftKey }); }
  else if (mod && k === "o") { e.preventDefault(); pickFiles(); }
  else if (mod && k === "e") { e.preventDefault(); if (active()?.kind === "diff") return; active() ? setEditor(!editorOpen, { focus: !editorOpen }) : newNote(); }
  else if (mod && e.shiftKey && k === "l") { e.preventDefault(); toggleLibrary(); }
  else if (mod && e.key === "\\") { e.preventDefault(); toggleOutline(); }
  else if (e.key === "F2" && activeId != null && !e.target.closest?.("input, textarea")) { e.preventDefault(); startTabRename(activeId); }
  else if (e.altKey && k === "n") { e.preventDefault(); newNote(); }
  else if (e.altKey && k === "d") { e.preventDefault(); newDiff(); }
  else if (e.altKey && k === "w" && activeId != null) { e.preventDefault(); closeDoc(activeId); }
  else if (e.key === "Escape" && !els.library.classList.contains("hidden")) toggleLibrary(false);
  else if (mod && e.shiftKey && (e.key === "PageUp" || e.key === "PageDown") && activeId != null) { e.preventDefault(); moveTab(activeId, e.key === "PageUp" ? -1 : 1); }
  else if (e.key === "Escape" && !tabMenu.classList.contains("hidden")) closeTabMenu();
  else if (e.ctrlKey && e.key === "Tab" && docs.length > 1) {
    e.preventDefault();
    const i = docs.findIndex((d) => d.id === activeId);
    activate(docs[(i + (e.shiftKey ? -1 : 1) + docs.length) % docs.length].id);
  }
});

/* ============================================================
   Install & offline
   ============================================================ */
addEventListener("appinstalled", () => toast("Installed — Markora is now in “Open with”"));
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(console.error);

/* ============================================================
   Boot
   ============================================================ */
applyTheme();
// keep layout offsets in sync with the top bar's height (it wraps to two rows on phones)
new ResizeObserver(([e]) => document.documentElement.style.setProperty("--bar-h", e.target.offsetHeight + "px")).observe(document.querySelector(".bar"));
els.editBtn.setAttribute("aria-pressed", String(editorOpen));
requestPersistence();
/** One-time cleanup: drop "conflicted copy" notes and merge documents that share a name */
async function cleanupLibrary() {
  if (await db.getMeta("cleanup-v2").catch(() => null)) return;
  const all = await db.all();
  const groups = new Map();
  for (const r of all) {
    if (r.kind === "note" && /\(conflicted copy [^)]*\)\.\w+$/i.test(r.name)) { await db.del(r.id, { fromSync: true }); continue; }
    const k = nameKey(r.name);
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // keep the disk file if there is one, otherwise the most recently edited
    list.sort((a, b) => (b.kind === "file") - (a.kind === "file") || (b.updated || 0) - (a.updated || 0));
    for (const r of list.slice(1)) await db.del(r.id, { fromSync: true });
  }
  await db.setMeta("cleanup-v2", true);
}

const ready = cleanupLibrary().catch(console.error).then(restoreSession).catch(console.error).then(async () => {
  renderTabs();
  syncEditorFromDoc();
  renderPreview();
  renderSyncUI();
  const flag = await initSync({ onRemoteChanges, isOpen: (id) => docs.some((d) => d.id === id), isBusy });
  if (flag === "connected") toast("Google Drive connected. Syncing your notes…", 3000);
  else if (flag === "cancelled") toast("Google sign-in cancelled");
  else if (flag === "error") toast("Couldn't connect Google Drive. Try again.", 3500);
});

// for debugging / tests
window.markora = { newNote, openHandle, saveDoc, docs, db, syncNow };
