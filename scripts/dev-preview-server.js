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
const CHARS_ROOT = path.resolve(__dirname, '..', 'tmp', 'chars');
// Static HTML sources (committed) live under web/; served alongside the
// ephemeral tmp/dev-preview/ content so picker.html etc. load the latest
// source without manual copy steps.
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(JOBS_ROOT, { recursive: true });
fs.mkdirSync(CHARS_ROOT, { recursive: true });

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

// POST /api/picker-submit-char-prompts  { job, prompts: [p1, p2, p3, p4] }
// User approves (possibly-edited) character prompts from the
// char-prompts-review stage. State advances to `char_prompts_approved`
// so the skill's polling loop picks it up + fires flow-cli ×4.
app.post('/api/picker-submit-char-prompts', (req, res) => {
  try {
    const { job, prompts } = req.body || {};
    if (!Array.isArray(prompts) || prompts.length !== 4) {
      return res.status(400).json({ error: 'prompts must be array of 4 strings' });
    }
    if (!prompts.every((p) => typeof p === 'string' && p.trim().length > 0)) {
      return res.status(400).json({ error: 'each char prompt must be non-empty string' });
    }
    const data = readJob(job);
    if (!data) return res.status(404).json({ error: 'unknown job' });
    if (data.state !== 'char_prompts_review') {
      return res.status(409).json({ error: `cannot submit char prompts in state ${data.state}` });
    }
    data.character_prompts = prompts;
    data.state = 'char_prompts_approved';
    data.updated_at = new Date().toISOString();
    writeJob(job, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/picker-request-char-regen  { job, comment? }
// User wants AI to regenerate char prompts (optionally with steering
// comment). State moves to `char_prompts_regen_requested` so the skill
// regens + loops back to `char_prompts_review`.
app.post('/api/picker-request-char-regen', (req, res) => {
  try {
    const { job, comment } = req.body || {};
    const data = readJob(job);
    if (!data) return res.status(404).json({ error: 'unknown job' });
    if (data.state !== 'char_prompts_review') {
      return res.status(409).json({ error: `cannot request char regen in state ${data.state}` });
    }
    data.state = 'char_prompts_regen_requested';
    if (typeof comment === 'string' && comment.trim()) {
      data.revise_comment = comment.trim();
    }
    data.updated_at = new Date().toISOString();
    writeJob(job, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/picker-submit-prompts  { job, prompts: [act1, act2, act3] }
// User approves (possibly-edited) prompts. Server stores final prompts +
// advances state to `video_gen` so the skill picks up + fires flow-video-cli.
app.post('/api/picker-submit-prompts', (req, res) => {
  try {
    const { job, prompts } = req.body || {};
    if (!Array.isArray(prompts) || prompts.length !== 3) {
      return res.status(400).json({ error: 'prompts must be array of 3 strings' });
    }
    if (!prompts.every((p) => typeof p === 'string' && p.trim().length > 0)) {
      return res.status(400).json({ error: 'each prompt must be non-empty string' });
    }
    const data = readJob(job);
    if (!data) return res.status(404).json({ error: 'unknown job' });
    if (data.state !== 'prompts_review') {
      return res.status(409).json({ error: `cannot submit prompts in state ${data.state}` });
    }
    data.video_prompts = prompts;
    data.state = 'video_gen';
    data.updated_at = new Date().toISOString();
    writeJob(job, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Shared helper: archive the current final.mp4 + bump video_version
// so the next render writes a fresh file the picker will cache-bust.
function archiveFinalAndBumpVersion(data, dir) {
  const current = path.join(dir, 'final.mp4');
  if (fs.existsSync(current)) {
    const version = data.video_version || 1;
    const archived = path.join(dir, `final-v${version}.mp4`);
    try { fs.renameSync(current, archived); } catch {}
    data.video_version = version + 1;
  } else {
    data.video_version = (data.video_version || 1) + 1;
  }
}

// POST /api/picker-request-revise  { job, comment, mode? }
// Two modes from the done stage:
//   mode="regen" (default) — skill rewrites prompts incorporating the
//     user's comment, loops back through prompts_review. Comment required.
//   mode="rerender" — keep existing prompts, just fire video again
//     (different Veo seed → different output). Comment ignored.
app.post('/api/picker-request-revise', (req, res) => {
  try {
    const { job, comment, mode } = req.body || {};
    const action = mode === 'rerender' ? 'rerender' : 'regen';
    if (action === 'regen' && (typeof comment !== 'string' || comment.trim().length === 0)) {
      return res.status(400).json({ error: 'comment required for regen mode' });
    }
    const data = readJob(job);
    if (!data) return res.status(404).json({ error: 'unknown job' });
    if (data.state !== 'done') {
      return res.status(409).json({ error: `cannot revise in state ${data.state}` });
    }
    const dir = jobDir(job);
    archiveFinalAndBumpVersion(data, dir);
    if (action === 'regen') {
      data.state = 'revise_requested';
      data.revise_comment = comment.trim();
    } else {
      // rerender — skip script review, skill fires directly on existing video_prompts.
      data.state = 'video_gen';
      if (typeof comment === 'string' && comment.trim()) data.revise_comment = comment.trim();
    }
    data.updated_at = new Date().toISOString();
    writeJob(job, data);
    res.json({ ok: true, action });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/picker-request-regen  { job, comment? }
// User wants AI to generate a DIFFERENT version in review stage. Comment
// is optional — if present, steers the next rewrite; if absent, skill
// just picks a fresh angle. State moves to a short-lived
// `prompts_regen_requested` so the skill's polling loop picks it up +
// re-generates. Skill writes back to `prompts_review` with new prompts.
app.post('/api/picker-request-regen', (req, res) => {
  try {
    const { job, comment } = req.body || {};
    const data = readJob(job);
    if (!data) return res.status(404).json({ error: 'unknown job' });
    if (data.state !== 'prompts_review') {
      return res.status(409).json({ error: `cannot request regen in state ${data.state}` });
    }
    data.state = 'prompts_regen_requested';
    if (typeof comment === 'string' && comment.trim()) {
      data.revise_comment = comment.trim();
    }
    data.updated_at = new Date().toISOString();
    writeJob(job, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/picker-update  { job, patch: { state?, characters?, video_url?, video_progress?, error?, video_prompts?, video_prompts_critique?, regen_count? } }
// Used BY THE SKILL to update state after each async step (character gen,
// prompt gen, video render). No auth — local dev only.
app.post('/api/picker-update', (req, res) => {
  try {
    const { job, patch } = req.body || {};
    if (!job || !patch || typeof patch !== 'object') return res.status(400).json({ error: 'job + patch required' });
    const data = readJob(job);
    if (!data) return res.status(404).json({ error: 'unknown job' });
    const ALLOWED = ['state', 'characters', 'video_url', 'video_progress', 'error',
                     'video_prompts', 'video_prompts_critique', 'regen_count',
                     'revise_comment', 'video_version',
                     'character_prompts', 'character_prompts_critique'];
    for (const k of ALLOWED) if (k in patch) data[k] = patch[k];
    data.updated_at = new Date().toISOString();
    writeJob(job, data);
    res.json({ ok: true, job: data });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/videos — list all jobs that have a rendered video artifact.
// Includes in-progress-revise jobs by falling back to the latest archived
// final-v*.mp4 when the current final.mp4 was replaced during revise.
// Sorted by updated_at desc. Used by gallery.html.
app.get('/api/videos', (_req, res) => {
  try {
    if (!fs.existsSync(JOBS_ROOT)) return res.json([]);
    const items = [];
    for (const id of fs.readdirSync(JOBS_ROOT)) {
      if (!id.startsWith('job_')) continue;
      const jobDir = path.join(JOBS_ROOT, id);
      const statePath = path.join(jobDir, 'state.json');
      if (!fs.existsSync(statePath)) continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { continue; }

      // Resolve best video artifact with preference order:
      //   1. final-branded.mp4 (logo-branded for publishing)
      //   2. final.mp4 (current raw render)
      //   3. latest final-vN.mp4 (archived version from revise workflow)
      let videoUrl = null;
      let resolvedVersion = null;
      const brandedMp4 = path.join(jobDir, 'final-branded.mp4');
      const currentMp4 = path.join(jobDir, 'final.mp4');
      if (fs.existsSync(brandedMp4) && fs.statSync(brandedMp4).size > 0) {
        videoUrl = `/picker-jobs/${id}/final-branded.mp4`;
        resolvedVersion = data.video_version || 1;
      } else if (fs.existsSync(currentMp4) && fs.statSync(currentMp4).size > 0) {
        videoUrl = `/picker-jobs/${id}/final.mp4`;
        resolvedVersion = data.video_version || 1;
      } else {
        const versioned = fs.readdirSync(jobDir)
          .map((n) => ({ n, m: n.match(/^final-v(\d+)\.mp4$/) }))
          .filter((x) => x.m && fs.statSync(path.join(jobDir, x.n)).size > 0)
          .map((x) => ({ n: x.n, v: Number(x.m[1]) }))
          .sort((a, b) => b.v - a.v);
        if (versioned.length) {
          videoUrl = `/picker-jobs/${id}/${versioned[0].n}`;
          resolvedVersion = versioned[0].v;
        }
      }
      if (!videoUrl) continue;

      const charIdx = typeof data.char_index === 'number' ? data.char_index : 0;
      const thumbUrl = data.characters?.[charIdx]?.url
        || `/picker-jobs/${id}/char-${charIdx + 1}.png`;
      items.push({
        job_id: id,
        subject: data.subject || '(untitled)',
        video_url: videoUrl,
        thumb_url: thumbUrl,
        updated_at: data.updated_at,
        created_at: data.created_at,
        grid: data.grid || null,
        video_version: resolvedVersion,
        state: data.state,
        posted_to: data.posted_to || null
      });
    }
    items.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// ─── Chars Gallery ──────────────────────────────────────────────────────
// Static files: tmp/chars/<subject-slug>/v<N>/<index>.png
// Char code: <subject-slug>-v<N>-<index>  (e.g. "rau-den-do-v1-3")
app.use('/chars', express.static(CHARS_ROOT, { index: false }));

// API: enumerate all chars from disk. Files with `.hidden.` substring
// (e.g. `1.hidden.png`) are filtered out — hidden by user via /api/chars/hide.
//
// Returns:
//   chars: flat list of {code, subject, version, index, url, mtime}
//   shoots: object keyed by `<subject>/<version>` for scenes-* versions,
//           value = {sourceCharCode, sourceCharUrl} (from _meta.json or
//           inferred from latest non-scenes char of same subject).
app.get('/api/chars', (_req, res) => {
  const out = [];
  const shoots = {};
  // First pass: collect per-subject (newest non-scenes char by mtime) for inference fallback.
  const latestCharBySubject = {};
  try {
    const subjects = fs.readdirSync(CHARS_ROOT).filter((d) =>
      fs.statSync(path.join(CHARS_ROOT, d)).isDirectory());
    for (const subject of subjects.sort()) {
      // Versions: any subdirectory. Convention is `v<N>` for char gens
      // and `scenes-<jobshort>` for per-scene start frames from
      // render-by-scene.py. Both show up in the gallery.
      const versions = fs.readdirSync(path.join(CHARS_ROOT, subject))
        .filter((d) => /^[a-z0-9_-]+$/i.test(d) && fs.statSync(path.join(CHARS_ROOT, subject, d)).isDirectory())
        .sort();
      for (const version of versions) {
        const files = fs.readdirSync(path.join(CHARS_ROOT, subject, version))
          .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f) && !f.includes('.hidden.'))
          .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
        for (const file of files) {
          const idx = parseInt(file, 10);
          const item = {
            code: `${subject}-${version}-${idx}`,
            subject, version, index: idx,
            url: `/chars/${subject}/${version}/${file}`,
            mtime: fs.statSync(path.join(CHARS_ROOT, subject, version, file)).mtimeMs,
          };
          out.push(item);
          if (!version.startsWith('scenes-')) {
            const cur = latestCharBySubject[subject];
            if (!cur || cur.mtime < item.mtime) latestCharBySubject[subject] = item;
          }
        }
        // Read _meta.json if scenes-* dir, build shoot entry.
        if (version.startsWith('scenes-')) {
          const metaPath = path.join(CHARS_ROOT, subject, version, '_meta.json');
          let sourceCharCode = null;
          if (fs.existsSync(metaPath)) {
            try {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
              sourceCharCode = meta.source_char_code || null;
            } catch { /* ignore parse errors */ }
          }
          shoots[`${subject}/${version}`] = { sourceCharCode };
        }
      }
    }
    // Inference fallback: shoot without explicit sourceCharCode → use latest
    // non-scenes char of same subject.
    for (const [key, shoot] of Object.entries(shoots)) {
      if (shoot.sourceCharCode) continue;
      const subject = key.split('/')[0];
      const fallback = latestCharBySubject[subject];
      if (fallback) shoot.sourceCharCode = fallback.code;
    }
    // Resolve sourceCharCode → sourceCharUrl by lookup against `out`.
    const codeToUrl = Object.fromEntries(out.map((c) => [c.code, c.url]));
    for (const shoot of Object.values(shoots)) {
      if (shoot.sourceCharCode) shoot.sourceCharUrl = codeToUrl[shoot.sourceCharCode] || null;
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ chars: out, shoots, count: out.length });
});

// Hide a char by renaming `<idx>.png` → `<idx>.hidden.png`. Reversible
// by a manual rename (or future /api/chars/unhide).
app.post('/api/chars/hide', (req, res) => {
  const { code } = req.body || {};
  // code format: <subject>-<version>-<idx>
  // version may be `v<N>` (char gens) or `scenes-<jobshort>` (per-scene
  // frames). Match greedy version + numeric trailing idx.
  const m = /^([a-z0-9-]+?)-([a-z0-9_-]+)-(\d+)$/i.exec(code || '');
  if (!m) return res.status(400).json({ error: 'invalid code (expected <subject>-<version>-<idx>)' });
  const [, subject, version, idx] = m;
  const dir = path.join(CHARS_ROOT, subject, version);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'unknown subject/version' });
  const candidates = fs.readdirSync(dir).filter((f) => f.startsWith(`${idx}.`) && !f.includes('.hidden.'));
  if (candidates.length === 0) return res.status(404).json({ error: 'no file matching index' });
  const file = candidates[0];
  const ext = path.extname(file);
  const dst = `${idx}.hidden${ext}`;
  fs.renameSync(path.join(dir, file), path.join(dir, dst));
  res.json({ ok: true, hidden: dst });
});

// HTML gallery — auto-renders thumbnails grouped by subject + version.
app.get('/chars-gallery.html', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Chars Gallery</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 1rem; background: #1a1a1a; color: #eee; }
  h1 { font-size: 1.2rem; margin: 0 0 1rem; }
  h2 { font-size: 0.95rem; margin: 1.2rem 0 0.4rem; color: #ccc; border-bottom: 1px solid #333; padding-bottom: 0.3rem; display: flex; gap: 0.5rem; align-items: baseline; }
  h2 .badge { font-size: 0.7rem; color: #6cf; font-weight: normal; }
  h2 .badge.shoot { color: #fc6; }
  .group { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.6rem; margin-bottom: 1rem; }
  .strip { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0.4rem; margin-bottom: 1rem; }
  .strip .item.char-cell { outline: 2px solid #fc6; outline-offset: -2px; }
  .strip .item.char-cell::before { content: 'char'; position: absolute; top: 0.2rem; left: 0.2rem; background: rgba(252,200,100,0.85); color: #000; font-size: 0.6rem; padding: 1px 4px; border-radius: 2px; font-weight: bold; z-index: 1; }
  .strip .item .label { position: absolute; top: 0.2rem; right: 0.2rem; background: rgba(0,0,0,0.6); color: #fff; font-size: 0.6rem; padding: 1px 4px; border-radius: 2px; }
  .item { position: relative; background: #222; border-radius: 6px; overflow: hidden; cursor: pointer; transition: transform 0.1s; }
  .item:hover { transform: scale(1.02); }
  .item img { width: 100%; aspect-ratio: 9/16; object-fit: cover; display: block; }
  .item .code { font-size: 0.7rem; padding: 0.3rem 0.4rem; color: #aaa; word-break: break-all; }
  .item .actions { display: flex; gap: 0.3rem; padding: 0 0.3rem 0.3rem; }
  .item .actions button { flex: 1; font-size: 0.65rem; padding: 0.25rem; border: none; border-radius: 3px; cursor: pointer; background: #333; color: #ccc; }
  .item .actions button:hover { background: #444; color: #fff; }
  .item .actions button.hide:hover { background: #6b2020; }
  .item.placeholder { background: #2a2a2a; display: flex; align-items: center; justify-content: center; color: #666; font-size: 0.7rem; aspect-ratio: 9/16; }
  .empty { color: #666; padding: 2rem; text-align: center; }
  dialog { background: #111; color: #eee; border: none; border-radius: 8px; padding: 1rem; max-width: 95vw; max-height: 95vh; }
  dialog img { max-width: 80vw; max-height: 80vh; display: block; }
  dialog .code { margin-top: 0.5rem; font-family: monospace; }
  dialog::backdrop { background: rgba(0,0,0,0.85); }
  button { background: #333; color: #eee; border: none; padding: 0.4rem 0.8rem; border-radius: 4px; cursor: pointer; margin-top: 0.5rem; }
  button:hover { background: #444; }
</style>
</head><body>
<h1>Chars Gallery</h1>
<div id="root"><div class="empty">Loading…</div></div>
<dialog id="modal">
  <img id="modal-img" />
  <div class="code" id="modal-code"></div>
  <button onclick="document.getElementById('modal').close()">Close</button>
  <button onclick="navigator.clipboard.writeText(document.getElementById('modal-code').textContent); this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy code', 1500)">Copy code</button>
</dialog>
<script>
fetch('/api/chars').then(r => r.json()).then(({ chars, shoots }) => {
  const root = document.getElementById('root');
  if (!chars || chars.length === 0) {
    root.innerHTML = '<div class="empty">No chars yet. Run flow-cli generate --count 4 --output tmp/chars/&lt;slug&gt;/v1/1.png</div>';
    return;
  }
  shoots = shoots || {};
  const grouped = {};
  const groupMtime = {};
  for (const c of chars) {
    const key = c.subject + '/' + c.version;
    (grouped[key] ||= []).push(c);
    groupMtime[key] = Math.max(groupMtime[key] || 0, c.mtime || 0);
  }
  // Sort groups newest-first so just-generated chars + frames appear at top.
  const sortedEntries = Object.entries(grouped).sort((a, b) => groupMtime[b[0]] - groupMtime[a[0]]);

  function itemHtml(c, opts) {
    opts = opts || {};
    const cls = ['item'];
    if (opts.charCell) cls.push('char-cell');
    const label = opts.label ? \`<div class="label">\${opts.label}</div>\` : '';
    return \`
      <div class="\${cls.join(' ')}" data-code="\${c.code}" data-url="\${c.url}">
        \${label}
        <img src="\${c.url}" loading="lazy" />
        <div class="code">\${c.code}</div>
        <div class="actions">
          <button class="copy" onclick="event.stopPropagation();copyCode(this,'\${c.code}')">Copy</button>
          <button class="hide" onclick="event.stopPropagation();hideChar(this,'\${c.code}')">Hide</button>
        </div>
      </div>\`;
  }

  const html = sortedEntries.map(([key, items]) => {
    const isShoot = items[0].version.startsWith('scenes-');
    if (!isShoot) {
      return \`
        <h2>\${key} <span class="badge">char picks</span></h2>
        <div class="group">
          \${items.map(c => itemHtml(c)).join('')}
        </div>\`;
    }
    // Shoot row: [linked char] [scene 1..N] (max 5 cells)
    const shoot = shoots[key] || {};
    const sceneItems = items.slice().sort((a, b) => a.index - b.index);
    const charCellHtml = shoot.sourceCharCode && shoot.sourceCharUrl
      ? itemHtml({ code: shoot.sourceCharCode, url: shoot.sourceCharUrl }, { charCell: true, label: 'char' })
      : '<div class="item placeholder">(char unknown)</div>';
    const sceneCells = sceneItems.map((c, i) => itemHtml(c, { label: 'S' + (i + 1) })).join('');
    return \`
      <h2>\${key} <span class="badge shoot">video shoot</span></h2>
      <div class="strip">\${charCellHtml}\${sceneCells}</div>\`;
  }).join('');
  root.innerHTML = html;
  for (const el of root.querySelectorAll('.item:not(.placeholder)')) {
    el.addEventListener('click', () => {
      document.getElementById('modal-img').src = el.dataset.url;
      document.getElementById('modal-code').textContent = el.dataset.code;
      document.getElementById('modal').showModal();
    });
  }
}).catch(e => {
  document.getElementById('root').innerHTML = '<div class="empty">Error: ' + e.message + '</div>';
});

function copyCode(btn, code) {
  const flash = () => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 1200);
  };
  // Try modern clipboard API (HTTPS/localhost only)
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(code).then(flash).catch(fallback);
  } else {
    fallback();
  }
  function fallback() {
    // execCommand('copy') works on HTTP via Tailscale
    const ta = document.createElement('textarea');
    ta.value = code;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); flash(); }
    catch(e) { alert('Copy failed: select code manually:\\n' + code); }
    document.body.removeChild(ta);
  }
}

function hideChar(btn, code) {
  if (!confirm('Hide ' + code + '?')) return;
  fetch('/api/chars/hide', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ code }),
  }).then(r => r.json()).then(data => {
    if (data.ok) {
      const card = btn.closest('.item');
      card.style.opacity = 0;
      setTimeout(() => card.remove(), 300);
    } else {
      alert('Hide failed: ' + (data.error || 'unknown'));
    }
  });
}
</script>
</body></html>`);
});

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
