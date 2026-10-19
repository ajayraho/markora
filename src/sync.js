// Google Drive sync — notes live as plain .md files in a "Markora" folder in the user's Drive.
// The browser talks to Google directly; our server only renews the login (see /api/auth).
import { db } from "./db.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "Markora";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FIELDS = "id,name,version,modifiedTime,appProperties";

class SignedOut extends Error {}
const state = { status: "off", email: null, lastSync: 0, error: null }; // off | idle | syncing | error
const listeners = new Set();
let onRemote = () => {};
let token = null, tokenExp = 0;

export const syncState = () => ({ ...state });
export const onSyncChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(syncState()));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const getMeta = async () => (await db.getMeta("sync").catch(() => null)) || {};
const setMeta = async (patch) => db.setMeta("sync", { ...(await getMeta()), ...patch });

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
async function ensureFolder() {
  const meta = await getMeta();
  if (meta.folderId) {
    try { const f = await gj(`${API}/files/${meta.folderId}?fields=id,trashed`); if (!f.trashed) return { id: f.id, fresh: false }; }
    catch (e) { if (e.status !== 404) throw e; }
  }
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`);
  let id = (await gj(`${API}/files?q=${q}&fields=files(id)&spaces=drive`)).files?.[0]?.id;
  if (!id) id = (await gj(`${API}/files?fields=id`, jsonBody("POST", { name: FOLDER, mimeType: FOLDER_MIME }))).id;
  await setMeta({ folderId: id });
  return { id, fresh: true }; // new / different folder → don't trust old remote ids
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
const fileName = (name) => (/\.(md|markdown|mdx|txt)$/i.test(name) ? name : name + ".md");

/** Upload a local note (create or update) and mark it synced */
async function upload(r, folder, remoteId) {
  const meta = remoteId ? { name: fileName(r.name) }
    : { name: fileName(r.name), parents: [folder], mimeType: "text/markdown", appProperties: { markoraId: r.id, origin: r.kind === "file" ? "disk" : "note" } };
  const { headers, body } = multipart(meta, r.text || "");
  const url = remoteId ? `${UPLOAD}/files/${remoteId}?uploadType=multipart&fields=${FIELDS}` : `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`;
  const f = await gj(url, { method: remoteId ? "PATCH" : "POST", headers, body });
  const cur = await db.get(r.id);
  if (cur) await db.put({ ...cur, remoteId: f.id, remoteVersion: f.version, syncedAt: r.updated });
}

/** Write a downloaded version into the local note, unless the user edited it meanwhile */
async function saveLocal(r, f, text) {
  const cur = await db.get(r.id);
  if (!cur || cur.updated !== r.updated) return false; // edited during sync → next round resolves it
  const now = Date.now();
  if (cur.kind === "file") {
    // a file on this computer's disk: keep its real name; the change waits to be written to disk
    await db.put({ ...cur, text, dirty: true, updated: now, syncedAt: now, remoteId: f.id, remoteVersion: f.version });
  } else {
    await db.put({ ...cur, text, name: f.name, updated: now, syncedAt: now, remoteId: f.id, remoteVersion: f.version });
  }
  return true;
}

const conflictName = (name) => `${name.replace(/\.(md|markdown|mdx|txt)$/i, "")} (conflicted copy ${new Date().toLocaleDateString()}).md`;

/* ---------- the sync pass ---------- */
async function pass() {
  const changes = [];
  const folder = await ensureFolder();
  // notes, plus files opened from disk (we sync the copy we last read/saved)
  let locals = (await db.all()).filter((r) => r.kind === "note" || (r.kind === "file" && typeof r.text === "string" && !r.noSync));
  if (folder.fresh) {
    // first sync with this folder: forget old links so nothing gets deleted by mistake
    for (const r of locals) if (r.remoteId) { delete r.remoteId; delete r.remoteVersion; delete r.syncedAt; await db.put(r); }
    await setMeta({ tombstones: [] });
  }

  // 1. deletions made on this device
  const { tombstones = [] } = await getMeta();
  for (const rid of tombstones) {
    try { await g(`${API}/files/${rid}?fields=id`, jsonBody("PATCH", { trashed: true })); }
    catch (e) { if (e.status !== 404) throw e; }
  }
  if (tombstones.length) {
    const left = (await getMeta()).tombstones?.filter((t) => !tombstones.includes(t)) || [];
    await setMeta({ tombstones: left });
  }

  // 2. reconcile
  const remote = await listRemote(folder.id);
  const byKey = new Map(remote.map((f) => [f.appProperties?.markoraId || "drive:" + f.id, f]));
  const byRemoteId = new Map(remote.map((f) => [f.id, f]));

  for (const r of locals) {
    const f = (r.remoteId && byRemoteId.get(r.remoteId)) || byKey.get(r.id);
    const localChanged = !r.syncedAt || r.updated > r.syncedAt;
    if (!f) {
      if (r.remoteId && !localChanged && r.kind === "file") {
        // its Drive copy was deleted elsewhere: stop syncing this disk file, never touch the file itself
        const cur = await db.get(r.id);
        await db.put({ ...cur, remoteId: undefined, remoteVersion: undefined, syncedAt: undefined, noSync: true });
      } else if (r.remoteId && !localChanged) { await db.del(r.id, { fromSync: true }); changes.push({ type: "deleted", id: r.id }); }
      else if ((r.text || "").trim()) await upload(r, folder.id, null); // skip empty drafts
      continue;
    }
    byKey.delete(f.appProperties?.markoraId || "drive:" + f.id);
    const remoteChanged = f.version !== r.remoteVersion;
    if (!localChanged && !remoteChanged) continue;
    if (localChanged && !remoteChanged) { await upload(r, folder.id, f.id); continue; }

    const text = await download(f.id);
    if (!localChanged) { if (await saveLocal(r, f, text)) changes.push({ type: "updated", id: r.id, kind: r.kind }); continue; }

    // changed on both sides
    if (text === r.text) {
      const cur = await db.get(r.id);
      await db.put({ ...cur, name: f.name, remoteId: f.id, remoteVersion: f.version, syncedAt: r.updated });
      continue;
    }
    const remoteNewer = Date.parse(f.modifiedTime) > r.updated;
    const older = remoteNewer ? { name: r.name, text: r.text } : { name: f.name, text };
    if (remoteNewer) { if (await saveLocal(r, f, text)) changes.push({ type: "updated", id: r.id, kind: r.kind }); }
    else await upload(r, folder.id, f.id);
    const copy = { id: newId(), kind: "note", name: conflictName(older.name), text: older.text, handle: null, dirty: false, pinned: false, lastModified: 0, size: 0, updated: Date.now() };
    await db.put(copy);
    changes.push({ type: "added", id: copy.id, conflict: true });
  }

  // 3. notes that exist only in Drive
  for (const f of byKey.values()) {
    const text = await download(f.id);
    const now = Date.now();
    const id = f.appProperties?.markoraId || newId();
    await db.put({ id, kind: "note", name: f.name, text, handle: null, dirty: false, pinned: false, lastModified: 0, size: 0, updated: now, syncedAt: now, remoteId: f.id, remoteVersion: f.version, fromDisk: f.appProperties?.origin === "disk" });
    changes.push({ type: "added", id });
  }
  return changes;
}

let running = null, again = false;
export function syncNow() {
  if (state.status === "off" || !navigator.onLine) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    state.status = "syncing"; emit();
    try {
      const changes = await pass();
      Object.assign(state, { status: "idle", lastSync: Date.now(), error: null });
      if (changes.length) onRemote(changes);
      if (changes.some((c) => c.conflict)) again = true; // upload the conflicted copies
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
export function syncSoon(ms = 2500) { clearTimeout(soonTimer); soonTimer = setTimeout(syncNow, ms); }

export async function initSync({ onRemoteChanges }) {
  onRemote = onRemoteChanges;
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
  setInterval(() => { if (!document.hidden) syncNow(); }, 60_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(); });
  addEventListener("online", () => syncNow());
  return flag; // "connected" | "cancelled" | "error" | null
}

export function connect() { location.href = "/api/auth/login"; }

export async function disconnect() {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  // Unlink local notes so a later sign-in (maybe another account) starts clean. Notes stay on this device.
  for (const r of await db.all()) if (r.remoteId) { delete r.remoteId; delete r.remoteVersion; delete r.syncedAt; await db.put(r); }
  await db.setMeta("sync", { connected: false });
  token = null;
  Object.assign(state, { status: "off", email: null, error: null, lastSync: 0 });
  emit();
}
