// Google Drive sync: notes and opened files live as plain .md files in a "Markora" folder
// in the user's own Drive. The browser talks to Google directly; our server only renews
// the login (see /api/auth).
//
// Rules:
//  • A document's identity is its file name (case-insensitive): same name = same document.
//  • Edits are saved locally right away and pushed in batches (idle, tab switch, hide, Ctrl+S).
//  • Edits on two devices are merged line by line (3-way, against the last synced version);
//    where both changed the same lines, the newest edit wins. No "conflicted copy" files.
//  • With Drive connected, notes you haven't opened for 30 days keep only a placeholder
//    locally and are downloaded again when opened.
import { db } from "./db.js";
import { diff3Merge } from "node-diff3";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "Markora";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FIELDS = "id,name,version,modifiedTime,appProperties";
const EVICT_AFTER = 30 * 24 * 3600 * 1000;
const PUSH_DELAY = 30_000;      // push edits after 30 s of quiet
const POLL_EVERY = 5 * 60_000;  // look for changes from other devices every 5 min

class SignedOut extends Error {}
const state = { status: "off", email: null, lastSync: 0, error: null }; // off | idle | syncing | error
const listeners = new Set();
let hooks = { onRemoteChanges: () => {}, isOpen: () => false, isBusy: () => false };
let token = null, tokenExp = 0;

export const syncState = () => ({ ...state });
export const isConnected = () => state.status !== "off";
export const onSyncChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(syncState()));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const getMeta = async () => (await db.getMeta("sync").catch(() => null)) || {};
const setMeta = async (patch) => db.setMeta("sync", { ...(await getMeta()), ...patch });

export const fileName = (name) => (/\.(md|markdown|mdown|mkd|mkdn|mdx|txt)$/i.test(name) ? name : name + ".md");
export const nameKey = (name) => fileName(name).trim().toLowerCase();
const syncable = (r) => (r.kind === "note" && (typeof r.text === "string" || r.remoteId)) || (r.kind === "file" && typeof r.text === "string" && !r.noSync);
const unlink = (r) => { const c = { ...r }; delete c.remoteId; delete c.remoteVersion; delete c.syncedAt; delete c.base; return c; };

/* ---------- auth ---------- */
async function getToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const r = await fetch("/api/auth/token", { method: "POST", credentials: "same-origin" });
  if (r.status === 401) { await signedOut(); throw new SignedOut(); }
  if (!r.ok) throw new Error(`Couldn't renew Google login (${r.status})`);
  const j = await r.json();
  token = j.access_token;
  tokenExp = Date.now() + j.expires_in * 1000;
  if (j.email && j.email !== state.email) { state.email = j.email; setMeta({ email: j.email }); }
  return token;
}

async function signedOut() {
  token = null;
  Object.assign(state, { status: "off", email: null, error: null });
  await setMeta({ connected: false });
  emit();
}

async function g(url, opts = {}, retry = true) {
  const t = await getToken();
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });
  if (r.status === 401 && retry) { token = null; return g(url, opts, false); }
  if (!r.ok) { const e = new Error(`Drive error ${r.status}`); e.status = r.status; throw e; }
  return r;
}
const gj = async (url, opts) => (await g(url, opts)).json();
const jsonBody = (method, obj) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

function multipart(meta, text) {
  const b = "markora" + Math.random().toString(36).slice(2);
  return {
    headers: { "Content-Type": `multipart/related; boundary=${b}` },
    body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
          `--${b}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${text}\r\n--${b}--`,
  };
}

/* ---------- Drive helpers ---------- */
async function findOrCreateFolder() {
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`);
  let id = (await gj(`${API}/files?q=${q}&fields=files(id)&spaces=drive`)).files?.[0]?.id;
  if (!id) id = (await gj(`${API}/files?fields=id`, jsonBody("POST", { name: FOLDER, mimeType: FOLDER_MIME }))).id;
  await setMeta({ folderId: id });
  return id;
}

async function folderAlive(id) {
  try { return !(await gj(`${API}/files/${id}?fields=trashed`)).trashed; }
  catch (e) { if (e.status === 404) return false; throw e; }
}

async function listRemote(folder) {
  const out = [];
  let page = "";
  do {
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false`);
    const j = await gj(`${API}/files?q=${q}&fields=nextPageToken,files(${FIELDS})&pageSize=1000&spaces=drive${page ? "&pageToken=" + page : ""}`);
    out.push(...j.files);
    page = j.nextPageToken;
  } while (page);
  return out;
}

const download = async (id) => (await g(`${API}/files/${id}?alt=media`)).text();
const trash = (id) => g(`${API}/files/${id}?fields=id`, jsonBody("PATCH", { trashed: true })).catch((e) => { if (e.status !== 404) throw e; });

async function uploadText({ remoteId, folder, name, text, id, kind, edited = Date.now() }) {
  // "edited" = when the text was last edited (not uploaded), so merges can tell which edit is newer
  const meta = remoteId ? { name: fileName(name), appProperties: { edited: String(edited) } }
    : { name: fileName(name), parents: [folder], mimeType: "text/markdown", appProperties: { markoraId: id, origin: kind === "file" ? "disk" : "note", edited: String(edited) } };
  const { headers, body } = multipart(meta, text);
  const url = remoteId ? `${UPLOAD}/files/${remoteId}?uploadType=multipart&fields=${FIELDS}` : `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`;
  return gj(url, { method: remoteId ? "PATCH" : "POST", headers, body });
}

/* ---------- merging ---------- */
/** 3-way line merge of local vs remote against the last synced base; overlaps go to the newer side */
export function merge(local, base, remote, preferLocal) {
  if (local === remote) return local;
  if (base == null) return preferLocal ? local : remote;
  const out = [];
  for (const chunk of diff3Merge(local.split("\n"), base.split("\n"), remote.split("\n"))) {
    if (chunk.ok) out.push(...chunk.ok);
    else out.push(...(preferLocal ? chunk.conflict.a : chunk.conflict.b));
  }
  return out.join("\n");
}

/** Mark a record as in sync with Drive file `f`, holding `text` */
async function markSynced(id, f, text, { expectUpdated, fromRemote = false } = {}) {
  const cur = await db.get(id);
  if (!cur) return false;
  if (expectUpdated !== undefined && cur.updated !== expectUpdated) {
    // edited while we were talking to Drive: keep the edit, remember what Drive has now
    await db.put({ ...cur, remoteId: f.id, remoteVersion: f.version, base: text });
    return false;
  }
  const now = Date.now();
  const next = { ...cur, remoteId: f.id, remoteVersion: f.version, base: text };
  if (fromRemote && cur.text !== text) {
    next.text = text;
    next.updated = now;
    if (cur.kind === "file") next.dirty = true; // needs writing to the disk file
  }
  if (cur.kind !== "file" && fromRemote) next.name = f.name;
  next.syncedAt = next.updated ?? now;
  await db.put(next);
  return fromRemote && cur.text !== text;
}

/* ---------- the sync pass ---------- */
async function pass() {
  const changes = [];
  const meta = await getMeta();
  let folder = meta.folderId || (await findOrCreateFolder());

  // 1. deletions made on this device
  const tombstones = meta.tombstones || [];
  for (const rid of tombstones) await trash(rid);
  if (tombstones.length) await setMeta({ tombstones: ((await getMeta()).tombstones || []).filter((t) => !tombstones.includes(t)) });

  // 2. what's in Drive
  let locals = (await db.all()).filter(syncable);
  const linked = locals.filter((r) => r.remoteId);
  if (!linked.length && meta.folderId && !(await folderAlive(folder))) folder = await findOrCreateFolder();
  let remote = await listRemote(folder);
  const byId = new Map(remote.map((f) => [f.id, f]));
  const missing = linked.filter((r) => !byId.has(r.remoteId));

  // Lots of linked docs vanished at once (folder deleted / Drive cleaned up)? Don't mirror that as
  // deletions on this device: unlink them so they're uploaded again instead.
  if (missing.length) {
    const folderGone = !remote.length && !(await folderAlive(folder));
    const mass = missing.length >= 3 && missing.length > linked.length / 2;
    if (folderGone || mass) {
      if (folderGone) { folder = await findOrCreateFolder(); remote = await listRemote(folder); }
      for (const r of missing) await db.put(unlink(r));
      locals = (await db.all()).filter(syncable);
      changes.push({ type: "reset", count: missing.length });
    }
  }

  // Duplicate names in Drive (left by older versions or a race): keep the newest
  const byKey = new Map();
  for (const f of [...remote].sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime))) {
    const k = nameKey(f.name);
    if (byKey.has(k)) { await trash(f.id); continue; }
    byKey.set(k, f);
  }
  const remoteById = new Map([...byKey.values()].map((f) => [f.id, f]));
  await setMeta({ remoteNames: [...byKey.keys()] });

  // 3. reconcile every local document
  for (const r of locals) {
    const k = nameKey(r.name);
    const f = (r.remoteId && remoteById.get(r.remoteId)) || byKey.get(k);
    const localChanged = !r.syncedAt || r.updated > r.syncedAt;

    if (!f) {
      if (r.remoteId && !localChanged) {
        // deleted on another device
        if (r.kind === "file") await db.put({ ...unlink(r), noSync: true }); // never touch the disk file
        else if (!hooks.isBusy(r.id)) { await db.del(r.id, { fromSync: true }); changes.push({ type: "deleted", id: r.id }); }
        continue;
      }
      if (typeof r.text !== "string" || !r.text.trim()) continue; // nothing to upload (empty draft / placeholder)
      const nf = await uploadText({ folder, name: r.name, text: r.text, id: r.id, kind: r.kind, edited: r.updated });
      await markSynced(r.id, nf, r.text, { expectUpdated: r.updated });
      continue;
    }
    byKey.delete(nameKey(f.name));
    byKey.delete(k);

    const remoteChanged = f.version !== r.remoteVersion || f.id !== r.remoteId;
    if (!localChanged && !remoteChanged) continue;

    if (typeof r.text !== "string") {
      // placeholder (not downloaded): just remember the newest version
      await db.put({ ...(await db.get(r.id)), remoteId: f.id, remoteVersion: f.version, name: f.name });
      continue;
    }
    if (hooks.isBusy(r.id) && remoteChanged) continue; // you're typing in it: merge on the next round

    if (localChanged && !remoteChanged) {
      const nf = await uploadText({ remoteId: f.id, name: r.name, text: r.text, edited: r.updated });
      await markSynced(r.id, nf, r.text, { expectUpdated: r.updated });
      continue;
    }

    const remoteText = await download(f.id);
    if (!localChanged) {
      if (await markSynced(r.id, f, remoteText, { fromRemote: true })) changes.push({ type: "updated", id: r.id, kind: r.kind });
      continue;
    }

    // changed on both sides → merge
    const preferLocal = r.updated >= (Number(f.appProperties?.edited) || Date.parse(f.modifiedTime));
    const merged = merge(r.text, r.remoteId === f.id ? r.base : null, remoteText, preferLocal);
    let target = f;
    if (merged !== remoteText) target = await uploadText({ remoteId: f.id, name: preferLocal ? r.name : f.name, text: merged });
    const cur = await db.get(r.id);
    if (cur && cur.updated === r.updated) {
      await db.put({ ...cur, text: merged, updated: Date.now() });
      const changed = merged !== r.text;
      await markSynced(r.id, target, merged, { fromRemote: false });
      if (changed) {
        if (cur.kind === "file") await db.put({ ...(await db.get(r.id)), dirty: true });
        changes.push({ type: "updated", id: r.id, kind: r.kind, merged: true });
      }
    }
  }

  // 4. documents that exist only in Drive → new local notes
  for (const f of byKey.values()) {
    const text = await download(f.id);
    const now = Date.now();
    const id = newId();
    await db.put({ id, kind: "note", name: f.name, text, base: text, handle: null, dirty: false, pinned: false, lastModified: 0, size: 0, updated: now, syncedAt: now, lastOpened: 0, remoteId: f.id, remoteVersion: f.version, fromDisk: f.appProperties?.origin === "disk" });
    changes.push({ type: "added", id });
  }

  // 5. free up space: synced notes you haven't opened in 30 days keep only a placeholder
  const cutoff = Date.now() - EVICT_AFTER;
  for (const r of await db.all()) {
    if (r.kind !== "note" || typeof r.text !== "string" || !r.remoteId || hooks.isOpen(r.id)) continue;
    if (r.updated > (r.syncedAt || 0) || Math.max(r.lastOpened || 0, r.updated || 0) > cutoff) continue;
    await db.put({ ...r, text: null, base: null });
  }
  return changes;
}

let running = null, again = false;
export function syncNow() {
  if (state.status === "off" || !navigator.onLine) return Promise.resolve();
  clearTimeout(soonTimer);
  if (running) { again = true; return running; }
  running = (async () => {
    state.status = "syncing"; emit();
    try {
      const changes = await pass();
      Object.assign(state, { status: "idle", lastSync: Date.now(), error: null });
      if (changes.length) hooks.onRemoteChanges(changes);
    } catch (e) {
      if (!(e instanceof SignedOut)) Object.assign(state, { status: "error", error: e.message });
    } finally {
      emit();
      running = null;
      if (again) { again = false; setTimeout(syncNow, 300); }
    }
  })();
  return running;
}

let soonTimer;
/** Schedule a push. Repeated calls keep pushing it back (batches a burst of edits). */
export function syncSoon(ms = PUSH_DELAY) {
  if (state.status === "off") return;
  clearTimeout(soonTimer);
  soonTimer = setTimeout(syncNow, ms);
}

/** Download a placeholder note's text (Drive-connected only) */
export async function fetchText(r) {
  if (!r.remoteId) return null;
  const text = await download(r.remoteId);
  const cur = await db.get(r.id);
  if (cur && typeof cur.text !== "string") await db.put({ ...cur, text, base: text });
  return text;
}

export async function initSync(h) {
  hooks = { ...hooks, ...h };
  const url = new URL(location.href);
  const flag = url.searchParams.get("sync");
  if (flag) { url.searchParams.delete("sync"); history.replaceState(null, "", url.pathname + url.search + url.hash); }
  const meta = await getMeta();
  if (flag === "connected") await setMeta({ connected: true });
  if (flag === "connected" || meta.connected) {
    Object.assign(state, { status: "idle", email: meta.email || null });
    emit();
    syncNow();
  }
  setInterval(() => { if (!document.hidden) syncNow(); }, POLL_EVERY);
  document.addEventListener("visibilitychange", () => syncNow()); // push when hidden, pull when back
  addEventListener("online", () => syncNow());
  return flag; // "connected" | "cancelled" | "error" | null
}

export function connect() { location.href = "/api/auth/login"; }

export async function disconnect() {
  // Bring back any notes that only exist as placeholders, so this device keeps everything
  const all = await db.all();
  let missing = 0;
  for (const r of all) if (r.kind === "note" && typeof r.text !== "string") {
    try { await fetchText(r); } catch { missing++; }
  }
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  for (const r of await db.all()) if (r.remoteId || r.base !== undefined) await db.put(unlink(r));
  await db.setMeta("sync", { connected: false });
  token = null;
  Object.assign(state, { status: "off", email: null, error: null, lastSync: 0 });
  emit();
  return { missing };
}
