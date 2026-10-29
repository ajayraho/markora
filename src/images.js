// Images in Markdown:
//  • web images (https://…) and embedded ones (data:…) just render
//  • relative paths (./img/a.png) next to a disk file render once you grant access to its folder
//  • pasting / dropping an image into the editor embeds it, so it travels with the note (and syncs)
import { db } from "./db.js";

const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i; // http:, https:, data:, blob:, //cdn…
const blobCache = new Map(); // "folderName|path|lastModified" → blob URL

async function folders() { return (await db.getMeta("folders").catch(() => null)) || []; }

/** Find a granted folder that contains this file → { dir, path: ["sub", "file.md"] } */
async function locate(fileHandle, { ask = false } = {}) {
  for (const dir of await folders()) {
    const path = await dir.resolve(fileHandle).catch(() => null);
    if (!path) continue;
    let perm = await dir.queryPermission({ mode: "read" });
    if (perm !== "granted" && ask) perm = await dir.requestPermission({ mode: "read" });
    return { dir, path, granted: perm === "granted" };
  }
  return null;
}

async function loadRelative(dir, baseParts, src) {
  const clean = decodeURIComponent(src.split(/[?#]/)[0]).replace(/\\/g, "/");
  const parts = [...baseParts];
  for (const seg of clean.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  let h = dir;
  for (let i = 0; i < parts.length - 1 && h; i++) h = await h.getDirectoryHandle(parts[i]).catch(() => null);
  if (!h) return null;
  const fh = await h.getFileHandle(parts.at(-1)).catch(() => null);
  if (!fh) return null;
  const file = await fh.getFile();
  const key = `${dir.name}|${parts.join("/")}|${file.lastModified}`;
  if (!blobCache.has(key)) blobCache.set(key, URL.createObjectURL(file));
  return blobCache.get(key);
}

function placeholder(img, text, action) {
  const box = document.createElement(action ? "button" : "span");
  box.className = "img-missing";
  box.type = "button";
  box.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg><span></span>`;
  box.lastChild.textContent = text;
  if (action) box.addEventListener("click", action);
  img.replaceWith(box);
}

/**
 * After rendering: point relative <img> at files from the granted folder, or show a button
 * that asks for access. `rerender` is called once access is granted.
 */
export async function resolveImages(root, doc, rerender) {
  const imgs = [...root.querySelectorAll("img")].filter((img) => !REMOTE.test(img.getAttribute("src") || ""));
  if (!imgs.length) return;
  if (!doc.handle || typeof FileSystemDirectoryHandle === "undefined" || !("resolve" in FileSystemDirectoryHandle.prototype)) {
    for (const img of imgs) placeholder(img, `${img.getAttribute("src")} (local image, not available here)`);
    return;
  }
  const loc = await locate(doc.handle);
  if (!loc) {
    const grant = async () => {
      try {
        const dir = await window.showDirectoryPicker({ id: "markora-images", startIn: doc.handle, mode: "read" });
        if (!(await dir.resolve(doc.handle))) throw new Error(`Pick the folder that contains ${doc.name}`);
        const list = (await folders()).filter((f) => f.name !== dir.name);
        await db.setMeta("folders", [...list.slice(-19), dir]);
        rerender();
      } catch (e) { if (e.name !== "AbortError") alertToast(e.message); }
    };
    for (const img of imgs) placeholder(img, `Show ${img.getAttribute("src")}: allow access to this file's folder`, grant);
    return;
  }
  if (!loc.granted) {
    for (const img of imgs) placeholder(img, `Show ${img.getAttribute("src")}: allow folder access again`, async () => { await locate(doc.handle, { ask: true }); rerender(); });
    return;
  }
  const base = loc.path.slice(0, -1);
  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute("src");
    const url = await loadRelative(loc.dir, base, src).catch(() => null);
    if (url) img.src = url;
    else placeholder(img, `Image not found: ${src}`);
  }));
}

let alertToast = (m) => console.warn(m);
export const setImageToast = (fn) => (alertToast = fn);

/* ---------- pasting / dropping images into the editor ---------- */
const MAX_SIDE = 1600;

/** Shrink big photos and return a data: URL (GIF/SVG are kept as-is) */
export async function imageToDataURL(file) {
  const read = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  if (/gif|svg/.test(file.type) || file.size < 150_000) return read(file);
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((res) => c.toBlob(res, "image/webp", 0.85));
  return read(blob || file);
}

/**
 * Insert images at the cursor as reference-style links, with the (long) data URLs
 * collected at the bottom of the document so the text stays readable.
 */
export async function insertImages(ta, files) {
  const refs = [], defs = [];
  for (const f of files) {
    const id = "img-" + Math.random().toString(36).slice(2, 8);
    const alt = (f.name || "image").replace(/\.[a-z0-9]+$/i, "").replace(/[\[\]]/g, "") || "image";
    refs.push(`![${alt}][${id}]`);
    defs.push(`[${id}]: ${await imageToDataURL(f)}`);
  }
  const v = ta.value;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const insert = refs.join("\n");
  const tail = (v.endsWith("\n") ? "" : "\n") + "\n" + defs.join("\n") + "\n";
  ta.value = v.slice(0, s) + insert + v.slice(e) + tail;
  ta.setSelectionRange(s + insert.length, s + insert.length);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/* ---------- links that point at images (e.g. pasted from ChatGPT) ---------- */
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp)(?:[?#]|$)/i;
const IMG_HOSTS = /(^|\.)(images\.openai\.com|oaiusercontent\.com|i\.imgur\.com|pbs\.twimg\.com|googleusercontent\.com|githubusercontent\.com|media\.discordapp\.net|cdn\.discordapp\.com)$/i;

function looksLikeImage(href) {
  try {
    const u = new URL(href);
    return /^https?:$/.test(u.protocol) && (IMG_EXT.test(u.pathname) || IMG_HOSTS.test(u.hostname));
  } catch { return false; }
}

/** A link alone on its line that points at an image → show the image, link text as caption */
export function previewImageLinks(root) {
  for (const a of root.querySelectorAll("p > a[href]")) {
    const p = a.parentElement;
    if (p.childNodes.length !== 1 || a.querySelector("img") || !looksLikeImage(a.href)) continue;
    const caption = a.textContent;
    const img = new Image();
    img.alt = caption;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = a.href;
    const cap = document.createElement("span");
    cap.className = "img-cap";
    cap.textContent = caption;
    a.classList.add("img-link");
    a.replaceChildren(img, cap);
    img.addEventListener("error", () => { a.classList.remove("img-link"); a.replaceChildren(caption); }, { once: true });
  }
}
