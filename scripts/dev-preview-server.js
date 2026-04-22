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
const JOBS_ROOT = path.resolve(__dirname, '..', 'tmp', 'picker-jobs');
// Static HTML sources (committed) live under web/; served alongside the
// ephemeral tmp/dev-preview/ content so picker.html etc. load the latest
// source without manual copy steps.
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(JOBS_ROOT, { recursive: true });

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────
// Picker API — minimal file-based job store for make-viral-health-video-vi.
// The skill (Claude) is the orchestrator: it creates the job, polls the
// state file, and does the creative work (prompt writing, flow-cli +
// flow-video-cli fires). This server only persists state transitions
// between the browser-side picker UI and the skill.
//
// Job directory layout: tmp/picker-jobs/<id>/
//   state.json      — { id, state, subject, grid, characters, video_url, … }
//   char-1.png … char-4.png — character variants (written by skill)
//   final.mp4       — final video (written by skill or copied from flow-video-cli)
//
// State machine:
//   init → grid_done → (skill picks up) char_gen → char_pick
//        → char_picked → (skill picks up) video_gen → done
// ─────────────────────────────────────────────────────────────────────────

function jobDir(id) {
  if (!/^[a-zA-Z0-9_-]{6,40}$/.test(id)) throw new Error('invalid job id');
  return path.join(JOBS_ROOT, id);
}

function readJob(id) {
  const p = path.join(jobDir(id), 'state.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJob(id, data) {
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(data, null, 2));
}

// "Current" job pointer — lets the picker UI live at a stable URL
// (http://…:47399/picker.html with no query param) that always resolves
// to the latest active job. Updated on /api/picker-init.
const CURRENT_POINTER = path.join(JOBS_ROOT, '_current.txt');
function setCurrent(jobId) {
  fs.writeFileSync(CURRENT_POINTER, jobId);
}
function getCurrent() {
  try { return fs.readFileSync(CURRENT_POINTER, 'utf8').trim() || null; }
  catch { return null; }
}

// POST /api/picker-init  { subject } → { job_id, url }
// Skill calls this to create a new job. Also updates the "current" pointer
// so http://…/picker.html (no query) resolves to this job.
app.post('/api/picker-init', (req, res) => {
  const subject = (req.body && req.body.subject || '').toString().trim();
  if (!subject) return res.status(400).json({ error: 'subject required' });
  const id = 'job_' + Math.random().toString(36).slice(2, 12);
  const now = new Date().toISOString();
  writeJob(id, {
    id,
    state: 'init',
    subject,
    created_at: now,
    updated_at: now,
    grid: null,
    characters: null,
    char_index: null,
    video_url: null,
    video_progress: null,
    error: null,
  });
  setCurrent(id);
  // Stable URL works with or without query param.
  res.json({ job_id: id, url: '/picker.html' });
});

// GET /api/picker-current → { job_id } | 404 if nothing yet
// Picker UI calls this when loaded without ?job= to resolve the latest job.
app.get('/api/picker-current', (req, res) => {
  const id = getCurrent();
  if (!id) return res.status(404).json({ error: 'no active job' });
  res.json({ job_id: id });
});

// GET /api/picker-status?job=<id>  → full job state
// Polled by picker UI + by the skill (to detect user submissions).
app.get('/api/picker-status', (req, res) => {
  try {
    const job = readJob(req.query.job);
    if (!job) return res.status(404).json({ error: 'unknown job' });
    res.json(job);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/picker-submit-grid  { job, setting, treatment, protagonist, arc, sound }
// Picker submits the 5-axis grid. Server advances state to `grid_done` so
// the skill's polling loop picks it up and triggers character gen.
app.post('/api/picker-submit-grid', (req, res) => {
  try {
    const { job, setting, treatment, protagonist, arc, sound } = req.body || {};
    if (![setting, treatment, protagonist, arc, sound].every((v) => typeof v === 'string' && v)) {
      return res.status(400).json({ error: 'all 5 picks required' });
    }
    const data = readJob(job);
    if (!data) return res.status(404).json({ error: 'unknown job' });
    if (data.state !== 'init') {
      return res.status(409).json({ error: `cannot submit grid in state ${data.state}` });
    }
    data.grid = { setting, treatment, protagonist, arc, sound };
    data.state = 'grid_done';
    data.updated_at = new Date().toISOString();
    writeJob(job, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/picker-submit-char  { job, char_index }
// Picker submits the character pick. Server advances state to `char_picked`
// so the skill's polling loop kicks off video generation.
app.post('/api/picker-submit-char', (req, res) => {
  try {
    const { job, char_index } = req.body || {};
    if (!Number.isInteger(char_index) || char_index < 0 || char_index > 3) {
      return res.status(400).json({ error: 'char_index must be 0..3' });
    }
    const data = readJob(job);
    if (!data) return res.status(404).json({ error: 'unknown job' });
    if (data.state !== 'char_pick') {
      return res.status(409).json({ error: `cannot submit char in state ${data.state}` });
    }
    data.char_index = char_index;
    data.state = 'char_picked';
    data.updated_at = new Date().toISOString();
    writeJob(job, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/picker-update  { job, patch: { state?, characters?, video_url?, video_progress?, error? } }
// Used BY THE SKILL to update state after each async step (character gen,
// video render). No auth — local dev only.
app.post('/api/picker-update', (req, res) => {
  try {
    const { job, patch } = req.body || {};
    if (!job || !patch || typeof patch !== 'object') return res.status(400).json({ error: 'job + patch required' });
    const data = readJob(job);
    if (!data) return res.status(404).json({ error: 'unknown job' });
    const ALLOWED = ['state', 'characters', 'video_url', 'video_progress', 'error'];
    for (const k of ALLOWED) if (k in patch) data[k] = patch[k];
    data.updated_at = new Date().toISOString();
    writeJob(job, data);
    res.json({ ok: true, job: data });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Directory listing at / — inlines images + videos so you can scroll through
// without clicking each link. Ordered by mtime descending (genuinely
// newest first; alphabetical sort can bury fresh files under older names).
app.get('/', (req, res) => {
  const files = fs.readdirSync(ROOT)
    .map((name) => ({ name, mtime: fs.statSync(path.join(ROOT, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.name);
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

// Order matters: WEB_ROOT (committed HTML sources) takes precedence over
// ROOT (ephemeral preview) so picker.html always serves the latest source.
app.use(express.static(WEB_ROOT, { index: false }));
app.use(express.static(ROOT, { index: false }));

// Serve per-job artifacts (character PNGs, final mp4) that the picker UI
// references as `/picker-jobs/<id>/…`. No directory listing — only direct
// file access, which is what the picker's fetched URLs need.
app.use('/picker-jobs', express.static(JOBS_ROOT, { index: false }));

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
