# Markora

A Markdown reader that renders `.md` files like a modern AI chat. Pick **Claude style** (serif, warm paper, clay accent) or **ChatGPT style** (sans-serif, clean white or graphite), in light, dark, or system mode.

## Features

- **Open with → Markora**: right-click any `.md` file in Explorer once the app is installed
- **Live reload**: files opened via *Open with*, the picker, or drag-and-drop re-render when they change on disk (green dot on the tab)
- **Rendering**: GFM tables, task lists, syntax-highlighted code with Copy, KaTeX math (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) and Mermaid diagrams
- **Editor with live preview**: press `Ctrl+E` (or the pencil) for a side-by-side editor. The preview updates as you type, the editor scroll-syncs, the divider drags (double-click to reset), and the pane collapses. It has a small toolbar, list auto-continue, and `Tab` indent
- **Saving**: notes autosave in the browser. For files opened from disk, `Ctrl+S` writes back to the file and `Ctrl+Shift+S` saves as. A note's **Save as…** turns it into a real `.md` file
- **Library** (`Ctrl+Shift+L`): up to 50 notes and recent files, stored in IndexedDB. Open tabs come back when you restart, unsaved edits to disk files are kept as drafts, and you get search and delete
- **Tabs**: multiple files open at once, with a sticky outline of headings. Drag tabs to reorder (or `Ctrl+Shift+PgUp/PgDn`). Right-click a tab to pin, rename or close it. Double-click or `F2` renames, and renaming a disk file renames it on disk
- **Offline**: everything, including fonts, is bundled, so it works with no internet once installed
- **Other ways to open**: drag-and-drop or paste Markdown text
- **Shortcuts**: `Ctrl+O` open, `Alt+N` new note, `Ctrl+E` editor, `Ctrl+S` save, `Ctrl+Shift+L` library, `Ctrl+\` outline, `Alt+W` close tab, `Ctrl+Tab` switch tab, `Ctrl+P` print
- **Editor shortcuts**: `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+K` link, `Ctrl+H` heading, ``Ctrl+` `` code

## Use it

Open the deployed site in **Edge or Chrome** and click the install icon in the address bar. After that it runs as its own app, works offline, and updates itself whenever a new version is deployed.

### Make it your default .md viewer (Windows)

1. Install Markora as described above.
2. Right-click any `.md` file and choose **Open with → Choose another app → Markora**.
3. Tick **Always use this app**. The first time, the browser asks permission for Markora to open files. Allow it.

## Deploy (Vercel)

The repo is ready for Vercel. `vercel.json` sets the build (`npm run build` into `dist/`) and the cache headers the service worker needs.

1. Push this repo to GitHub.
2. On [vercel.com/new](https://vercel.com/new), import the repo and keep the defaults. Settings come from `vercel.json`.
3. Every push to `main` redeploys automatically.

## Run locally

```bash
npm install
npm start          # builds and serves on http://localhost:4173
```

Without Node, run `npm run build` once somewhere, then `python serve.py` serves `dist/`.

## Develop

```
src/main.js      app logic (tabs, editor pane, library, saving, live reload, launchQueue)
src/render.js    Markdown → HTML (marked, highlight.js, KaTeX, Mermaid, DOMPurify)
src/editor.js    the textarea editor (toolbar actions, list continuation, indent)
src/db.js        IndexedDB storage (library cap: MAX_ITEMS = 50)
src/styles.css   both themes; tokens at the top
src/sample.md    the built-in sample document
public/          index.html, manifest (file_handlers), service worker, icons
build.mjs        esbuild bundle into dist/
```

Run `npm run build` after editing, then reload the page. The service worker picks up the new version.

## Notes

- *Open with* requires a Chromium browser (Edge or Chrome). Firefox and Safari can still use the app in a tab.
- Images referenced with relative paths (`![](./img.png)`) won't load, because a web app only gets access to the file you opened, not its folder.
