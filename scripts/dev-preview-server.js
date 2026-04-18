#!/usr/bin/env node
// Dev-time static file server for screenshots + generated mp4s during
// selector verification. Binds 127.0.0.1:PORT and serves tmp/dev-preview/.
// Accessible from phone/laptop via Tailscale:
//   https://mac-mini.tailf56d7b.ts.net:47399/<filename>
//
// Not installed globally. Not part of the shipping CLI. Started manually:
//   node scripts/dev-preview-server.js            # default port 47399
//   node scripts/dev-preview-server.js 47400      # custom port
//
// Companion: tmp/dev-preview/ is gitignored (via tmp/ entry).

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');

const PORT = parseInt(process.argv[2] || process.env.FLOW_PREVIEW_PORT || '47399', 10);
// Default binds localhost-only. Set FLOW_PREVIEW_HOST=0.0.0.0 to expose over
// Tailscale / LAN so you can view screenshots + mp4s from phone/laptop.
const HOST = process.env.FLOW_PREVIEW_HOST || '127.0.0.1';
const ROOT = path.resolve(__dirname, '..', 'tmp', 'dev-preview');

fs.mkdirSync(ROOT, { recursive: true });

const app = express();

// Directory listing at / — inlines images + videos so you can scroll through
// without clicking each link. Ordered newest first.
app.get('/', (req, res) => {
  const files = fs.readdirSync(ROOT).sort().reverse();
  const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  const VID_EXTS = new Set(['.mp4', '.webm', '.mov']);
  res.type('html').send(`<!doctype html>
<html><head><title>flow-daemon dev preview</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 1em;
    background: #111; color: #eee; }
  h1 { margin: 0 0 0.3em; font-size: 1.2em; }
  p { margin: 0 0 1em; color: #999; font-size: 0.85em; }
  .item { background: #1c1c1c; border: 1px solid #333; border-radius: 8px;
    margin: 0 0 1em; padding: 0.7em; }
  .head { font-family: monospace; font-size: 0.8em; color: #9cf;
    word-break: break-all; margin-bottom: 0.5em; }
  .ts { color: #888; }
  .item img, .item video { max-width: 100%; height: auto; display: block;
    border-radius: 4px; background: #000; }
  .item video { max-height: 480px; }
  a { color: #9cf; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style></head>
<body>
<h1>dev preview</h1>
<p><code>${ROOT}</code> — ${files.length} files, newest first.</p>
${files.map((f) => {
  const st = fs.statSync(path.join(ROOT, f));
  const when = st.mtime.toISOString().slice(0, 19).replace('T', ' ');
  const ext = path.extname(f).toLowerCase();
  const href = `/${encodeURIComponent(f)}`;
  let media = '';
  if (IMG_EXTS.has(ext)) {
    media = `<img src="${href}" loading="lazy" alt="${f}" />`;
  } else if (VID_EXTS.has(ext)) {
    media = `<video src="${href}" controls preload="metadata"></video>`;
  }
  return `<div class="item">
    <div class="head"><a href="${href}">${f}</a> <span class="ts">${when}</span></div>
    ${media}
  </div>`;
}).join('')}
</body></html>`);
});

app.use(express.static(ROOT, { index: false }));

app.listen(PORT, HOST, () => {
  console.log(`[dev-preview] serving ${ROOT}`);
  console.log(`[dev-preview] bind:      ${HOST}:${PORT}`);
  console.log(`[dev-preview] local:     http://127.0.0.1:${PORT}/`);
  if (HOST === '0.0.0.0') {
    console.log(`[dev-preview] tailscale: http://mac-mini:${PORT}/   (or http://100.116.196.2:${PORT}/)`);
  } else {
    console.log(`[dev-preview] tailscale: (disabled — run with FLOW_PREVIEW_HOST=0.0.0.0 to expose)`);
  }
  console.log(`[dev-preview] drop screenshots + mp4s into tmp/dev-preview/; list page shows newest first.`);
});
