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
const ROOT = path.resolve(__dirname, '..', 'tmp', 'dev-preview');

fs.mkdirSync(ROOT, { recursive: true });

const app = express();

// Directory listing at /
app.get('/', (req, res) => {
  const files = fs.readdirSync(ROOT).sort().reverse();
  res.type('html').send(`
    <!doctype html>
    <html><head><title>flow-daemon dev preview</title>
    <style>
      body { font-family: sans-serif; max-width: 800px; margin: 2em auto; padding: 0 1em; }
      li { margin: 0.5em 0; }
      a { text-decoration: none; color: #0366d6; }
      .ts { color: #666; font-size: 0.9em; margin-left: 0.5em; }
    </style></head>
    <body>
    <h1>dev preview</h1>
    <p>Serving <code>${ROOT}</code> — newest first.</p>
    <ul>
    ${files.map((f) => {
      const st = fs.statSync(path.join(ROOT, f));
      const when = st.mtime.toISOString().slice(0, 19).replace('T', ' ');
      return `<li><a href="/${encodeURIComponent(f)}">${f}</a><span class="ts">${when}</span></li>`;
    }).join('')}
    </ul>
    </body></html>
  `);
});

app.use(express.static(ROOT, { index: false }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-preview] serving ${ROOT}`);
  console.log(`[dev-preview] local:     http://127.0.0.1:${PORT}/`);
  console.log(`[dev-preview] tailscale: https://mac-mini.tailf56d7b.ts.net:${PORT}/`);
  console.log(`[dev-preview] drop screenshots + mp4s into tmp/dev-preview/; list page shows newest first.`);
});
