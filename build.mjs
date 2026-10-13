// Build Markora into ./dist  —  run: node build.mjs
import * as esbuild from "esbuild";
import { cpSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const out = "dist";
rmSync(out, { recursive: true, force: true });
cpSync("public", out, { recursive: true });

await esbuild.build({
  entryPoints: { app: "src/main.js" },
  bundle: true,
  format: "esm",
  splitting: true, // mermaid becomes lazy-loaded chunks
  minify: true,
  outdir: out,
  chunkNames: "chunks/[name]-[hash]",
  loader: { ".md": "text" },
  target: ["chrome110", "edge110", "firefox115", "safari16"],
});
await esbuild.build({
  entryPoints: { app: "src/styles.css" },
  bundle: true,
  minify: true,
  outdir: out,
  assetNames: "assets/[name]-[hash]",
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
});

// Precache list + version for the service worker
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = walk(out).map((f) => relative(out, f).replaceAll("\\", "/")).filter((f) => f !== "sw.js");
const hash = createHash("sha1");
for (const f of files) hash.update(readFileSync(join(out, f)));
const sw = readFileSync(join(out, "sw.js"), "utf8")
  .replace("__VERSION__", hash.digest("hex").slice(0, 10))
  .replace('"__FILES__"', JSON.stringify(["./", ...files.filter((f) => !/\.(ttf|woff)$/.test(f))]));
writeFileSync(join(out, "sw.js"), sw);
console.log(`Built ${files.length} files → ${out}/`);
