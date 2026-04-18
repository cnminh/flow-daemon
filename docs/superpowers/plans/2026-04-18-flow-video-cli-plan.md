# `flow-video-cli` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second CLI (`flow-video-cli`) that drives Google Flow in video mode (with multi-clip extend + optional frame-to-video) alongside the existing `flow-cli` image tool, reusing the same daemon, browser, and queue.

**Architecture:** Unified single-daemon design. The existing daemon (port 47321) learns to dispatch to an image worker or a video worker based on the enqueue body shape. Code is split: `lib/browser.js` (shared browser/profile lifecycle), `lib/image.js` (today's image worker), `lib/video.js` (new), `lib/selectors.js` (reorganized into `common` / `image` / `video` namespaces), `lib/cli-shared.js` (daemon lifecycle + flag parsing shared by both CLIs).

**Tech Stack:** Node 18+, Playwright 1.47, Express 4.19, `node --test`. No new dependencies. Hermetic tests use a new `test/mock-flow-video.html` fixture over `file://`.

**Spec:** See `docs/superpowers/specs/2026-04-18-flow-video-cli-design.md`.

---

## File Map

### New files
- `lib/browser.js` — extracted browser lifecycle from `lib/flow.js`
- `lib/cli-shared.js` — extracted CLI lifecycle + flag parsing from `bin/flow-cli.js`
- `lib/image.js` — renamed from `lib/flow.js` after the extract
- `lib/video.js` — new video worker
- `bin/flow-video-cli.js` — new CLI
- `scripts/dev-preview-server.js` — dev-time static file server for screenshots / mp4s
- `test/mock-flow-video.html` — hermetic Playwright fixture for video tests
- `test/video.test.js` — unit tests for video worker

### Modified files
- `lib/queue.js` — generalize `enqueue` to take an opaque payload
- `lib/selectors.js` — reorganize into `{ common, image, video }` namespaces
- `server.js` — dispatch by payload shape; add video validation; update `/status` + `/health` response shape
- `bin/flow-cli.js` — use extracted `lib/cli-shared.js` helpers
- `package.json` — add `flow-video-cli` to `bin` map
- `.gitignore` — add `tmp/`
- `README.md` — document new CLI
- `AGENTS.md` — update architecture one-pager
- `test/daemon.test.js` — update `require('../lib/flow.js')` → `require('../lib/image.js')`

---

## Task 1: Baseline check

**Goal:** Confirm current tests pass on the worktree before any changes.

**Files:**
- No changes

- [ ] **Step 1: Run existing tests from the worktree root**

```bash
cd /Users/cuongnguyen/projects/flow-daemon/.worktrees/feat-video-cli
npm test
```

Expected: 5 tests pass, 0 fail, 0 skipped. Any failure stops the plan — debug before proceeding.

---

## Task 2: Extract `lib/browser.js`

**Goal:** Move shared browser/profile lifecycle out of `lib/flow.js` into `lib/browser.js`. Behavior unchanged. Existing tests must stay green.

**Files:**
- Create: `lib/browser.js`
- Modify: `lib/flow.js`

- [ ] **Step 1: Create `lib/browser.js` with the shared helpers**

Copy from `lib/flow.js` (lines 1-202) into `lib/browser.js`, adjusting the `require('./selectors')` path (it's the same relative path, so no change). Also remove the now-unused `selectors` import if it isn't referenced in the extracted code (it isn't — selectors are used only in `ensureImageModeAndCount` and `runJob`, which stay in image.js).

Create `lib/browser.js`:

```javascript
const { chromium } = require('playwright');
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PROFILE_DIR = path.join(
  require('node:os').homedir(),
  '.flow-daemon',
  'profile'
);

// Module-level persistent browser context (reused across jobs).
let browserContext = null;

// Pick a random integer in [min, max] inclusive.
function jitter(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Pause for a humanized random duration between steps.
async function humanPause(page, min = 800, max = 2000) {
  await page.waitForTimeout(jitter(min, max));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function removeLockFiles() {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.unlinkSync(path.join(PROFILE_DIR, name));
    } catch {}
  }
}

async function cleanStaleProfileLock() {
  const lockPath = path.join(PROFILE_DIR, 'SingletonLock');

  let target;
  try {
    target = fs.readlinkSync(lockPath);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    if (e.code === 'EINVAL') {
      try { fs.unlinkSync(lockPath); } catch {}
      console.log('[flow-daemon] removed malformed SingletonLock (not a symlink)');
      return;
    }
    throw e;
  }

  const match = target.match(/-(\d+)$/);
  const pid = match ? parseInt(match[1], 10) : null;

  if (!pid) {
    removeLockFiles();
    console.log(`[flow-daemon] removed SingletonLock with unparseable target "${target}"`);
    return;
  }

  if (!pidAlive(pid)) {
    removeLockFiles();
    console.log(`[flow-daemon] cleared stale SingletonLock (PID ${pid} is dead)`);
    return;
  }

  let cmdline = '';
  try {
    cmdline = execSync(`ps -p ${pid} -o command=`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}

  const isOurOrphan = cmdline.includes(`--user-data-dir=${PROFILE_DIR}`);

  if (!isOurOrphan) {
    const err = new Error(
      `Profile ${PROFILE_DIR} is locked by PID ${pid} which is not our Chromium. ` +
      `Close it manually (kill -9 ${pid}) and retry. ` +
      `Offending command: ${cmdline.slice(0, 100) || 'unknown'}`
    );
    err.error_code = 'profile_locked';
    throw err;
  }

  console.log(`[flow-daemon] found orphan Chromium PID ${pid} using our profile — SIGKILL'ing`);
  try { process.kill(pid, 'SIGKILL'); } catch {}

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (pidAlive(pid)) {
    const err = new Error(`failed to kill orphan Chromium PID ${pid} within 4s`);
    err.error_code = 'profile_locked';
    throw err;
  }

  try {
    execSync(`pkill -9 -f "user-data-dir=${PROFILE_DIR}"`, { stdio: 'ignore' });
  } catch {}

  removeLockFiles();
  console.log(`[flow-daemon] orphan Chromium PID ${pid} killed; lock released`);
}

async function ensureContext() {
  if (browserContext) return browserContext;
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  await cleanStaleProfileLock();
  browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
  });

  await browserContext.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  browserContext.on('close', () => {
    browserContext = null;
  });
  return browserContext;
}

async function ensureContextForUrl(flowUrl) {
  if (flowUrl && flowUrl.startsWith('file://')) {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    ctx._ephemeral = true;
    return ctx;
  }
  return ensureContext();
}

async function findOrCreatePage(context, flowUrl) {
  const pages = context.pages();
  const existing = pages.find((p) => p.url().startsWith(flowUrl.split('?')[0]));
  if (existing) return existing;
  const page = await context.newPage();
  await page.goto(flowUrl, { waitUntil: 'networkidle' });
  return page;
}

async function closeBrowser() {
  if (browserContext) {
    try {
      await browserContext.close();
    } catch {}
    browserContext = null;
  }
}

module.exports = {
  PROFILE_DIR,
  jitter,
  humanPause,
  ensureContext,
  ensureContextForUrl,
  findOrCreatePage,
  closeBrowser,
};
```

- [ ] **Step 2: Edit `lib/flow.js` to delegate to `lib/browser.js`**

At the top of `lib/flow.js`, replace lines 1-13 (old imports + PROFILE_DIR const) with:

```javascript
const path = require('node:path');
const fs = require('node:fs');
const selectors = require('./selectors');
const {
  PROFILE_DIR,
  jitter,
  humanPause,
  ensureContextForUrl,
  findOrCreatePage,
  closeBrowser,
} = require('./browser');

const DEFAULT_FLOW_URL = 'https://labs.google/fx/tools/flow/project/bcc73489-69d9-4621-974a-7168318a59d2';
const DEFAULT_TIMEOUT_MS = 180_000;
```

Delete from `lib/flow.js` everything from line 15 (old `let browserContext = null;`) through line 202 (end of `findOrCreatePage`). The `pickRandomModel`, `ensureImageModeAndCount`, `runJob`, and `closeBrowser` alias that follow stay.

At the bottom of `lib/flow.js`, change the exports to:

```javascript
module.exports = { runJob, closeBrowser, PROFILE_DIR };
```

(`closeBrowser` is re-exported from `browser.js` since it was imported above — keep the re-export for back-compat with `server.js`.)

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: 5 tests pass, 0 fail. No behavior changed — only module boundaries moved.

- [ ] **Step 4: Commit**

```bash
git add lib/browser.js lib/flow.js
git commit -m "$(cat <<'EOF'
refactor: extract lib/browser.js from lib/flow.js

No behavior change. Moves browser/profile lifecycle (launchPersistentContext,
SingletonLock cleanup, humanized typing helpers, navigator.webdriver erase)
into a shared module so the forthcoming video worker can reuse it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Reorganize `lib/selectors.js` into namespaces

**Goal:** Split selectors into `{ common, image, video }` so video-mode selectors can be added cleanly. `video` namespace starts empty; populated in Task 7.

**Files:**
- Modify: `lib/selectors.js`
- Modify: `lib/flow.js` (now uses `selectors.common.*` / `selectors.image.*`)

- [ ] **Step 1: Rewrite `lib/selectors.js` with namespaces**

Replace the entire contents with:

```javascript
// Single source of CSS/Playwright selectors for the labs.google/flow UI.
// When Google ships a UI change, this file is the only place to update.
// For tests against test/mock-flow.html and test/mock-flow-video.html, the
// fixtures mirror these selectors.
//
// Last verified against real Flow DOM: 2026-04-13.

// Selectors used by both image and video flows.
const common = {
  // Prompt input: contentEditable div where user types the prompt.
  promptInput: '[role="textbox"]',

  // Generate button. Real Flow renders "arrow_forward" glyph + "Create".
  generateButton: 'text=arrow_forwardCreate',

  // Mode switcher in the prompt bar. Label contains "crop_16_9" glyph.
  modeButton: 'button:has-text("crop_16_9")',

  // Error-state canaries.
  captchaFrame: 'iframe[src*="recaptcha"]',
  quotaBanner: 'text=/no credits/i',
};

// Image-mode-only selectors.
const image = {
  // "Image" tab inside the mode popover.
  imageModeTab: 'button.flow_tab_slider_trigger:has-text("Image")',

  // Count-per-prompt tab inside the mode popover. countTab(1) → "x1".
  countTab: (n) => `button.flow_tab_slider_trigger:has-text("x${n}")`,

  // Image models Flow currently exposes.
  modelNames: ['Nano Banana Pro', 'Nano Banana 2', 'Imagen 4'],

  // Dropdown trigger inside the mode popover.
  modelDropdown: [
    'button:has-text("Nano Banana Pro"):not(:has-text("crop_16_9"))',
    'button:has-text("Nano Banana 2"):not(:has-text("crop_16_9"))',
    'button:has-text("Imagen 4"):not(:has-text("crop_16_9"))',
  ].join(', '),

  // Option inside the opened model dropdown.
  modelOption: (name) =>
    `[role="option"]:has-text("${name}"), [role="menuitem"]:has-text("${name}"), li:has-text("${name}")`,

  // All <img> elements on the page.
  allImages: 'img',
};

// Video-mode-only selectors. Most are placeholders verified live per
// docs/superpowers/specs/2026-04-18-flow-video-cli-design.md §9.
const video = {
  // Populated in Task 7.
};

module.exports = { common, image, video };
```

- [ ] **Step 2: Update `lib/flow.js` to use namespaced selectors**

Replace every bare `selectors.X` reference in `lib/flow.js` with the namespaced form. Quick find/replace:

- `selectors.promptInput` → `selectors.common.promptInput`
- `selectors.generateButton` → `selectors.common.generateButton`
- `selectors.modeButton` → `selectors.common.modeButton`
- `selectors.captchaFrame` → `selectors.common.captchaFrame`
- `selectors.quotaBanner` → `selectors.common.quotaBanner`
- `selectors.imageModeTab` → `selectors.image.imageModeTab`
- `selectors.countTab` → `selectors.image.countTab`
- `selectors.modelNames` → `selectors.image.modelNames`
- `selectors.modelDropdown` → `selectors.image.modelDropdown`
- `selectors.modelOption` → `selectors.image.modelOption`
- `selectors.allImages` → `selectors.image.allImages`

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: 5 tests pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add lib/selectors.js lib/flow.js
git commit -m "$(cat <<'EOF'
refactor: namespace selectors by mode (common/image/video)

No behavior change. Reorganizes lib/selectors.js into three namespaces so
video-mode selectors can be added in their own area. Existing image flow
uses selectors.common.* and selectors.image.*; video namespace populated
later.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Rename `lib/flow.js` → `lib/image.js`

**Goal:** Make the module name match its responsibility now that browser/selectors are split out.

**Files:**
- Rename: `lib/flow.js` → `lib/image.js`
- Modify: `server.js`
- Modify: `test/daemon.test.js`

- [ ] **Step 1: Rename the file**

```bash
git mv lib/flow.js lib/image.js
```

- [ ] **Step 2: Update `server.js` require**

In `server.js`, change line 4 from:

```javascript
const { runJob, closeBrowser } = require('./lib/flow');
```

to:

```javascript
const { runJob, closeBrowser } = require('./lib/image');
```

- [ ] **Step 3: Update `test/daemon.test.js` require**

In `test/daemon.test.js`, change line 147 from:

```javascript
const { runJob } = require('../lib/flow.js');
```

to:

```javascript
const { runJob } = require('../lib/image.js');
```

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: 5 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add lib/image.js server.js test/daemon.test.js
git commit -m "$(cat <<'EOF'
refactor: rename lib/flow.js to lib/image.js

Final step of the three-way split. lib/image.js is the image-mode Playwright
worker; lib/browser.js is shared lifecycle; lib/video.js (new) will be the
video-mode worker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Generalize `lib/queue.js::enqueue` to opaque payload

**Goal:** Remove image-specific field names from the queue module so video jobs can use the same queue.

**Files:**
- Modify: `lib/queue.js`
- Modify: `server.js`

- [ ] **Step 1: Rewrite `lib/queue.js`**

Replace the entire file with:

```javascript
// In-memory FIFO job queue. Jobs live here until daemon restart.
// The queue is payload-agnostic — each job carries an opaque `payload`
// object that the caller (image worker, video worker) destructures as it
// needs. This keeps the queue free of mode-specific field names.

let nextSeq = 0;
const jobs = new Map(); // jobId -> job object
const pending = []; // jobIds in FIFO order (queued only)

function newId() {
  nextSeq += 1;
  return `j_${Date.now().toString(36)}${nextSeq}`;
}

// payload is any JSON-serializable object. The worker that consumes this job
// is responsible for knowing which fields to read.
function enqueue(payload) {
  const jobId = newId();
  const job = {
    job_id: jobId,
    status: 'queued',
    payload,
    // Result fields populated by markDone/markError:
    result: null,
    error: null,
    error_code: null,
    started_at: null,
    finished_at: null,
  };
  jobs.set(jobId, job);
  pending.push(jobId);
  return jobId;
}

function get(jobId) {
  return jobs.get(jobId) || null;
}

function queuePositionOf(jobId) {
  const idx = pending.indexOf(jobId);
  return idx < 0 ? null : idx + 1;
}

function shiftNext() {
  return pending.shift() || null;
}

function markRunning(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'running';
  job.started_at = new Date().toISOString();
}

function markDone(jobId, result) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'done';
  job.result = result; // worker-shaped: { image_path } or { video_path, ... }
  job.finished_at = new Date().toISOString();
}

function markError(jobId, { error, error_code, ...extra }) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'error';
  job.error = error;
  job.error_code = error_code;
  // Extra fields (e.g. failed_at_index, completed_prompts) flow through to
  // the status response.
  Object.assign(job, extra);
  job.finished_at = new Date().toISOString();
}

function depth() {
  return pending.length;
}

function currentJob() {
  for (const job of jobs.values()) {
    if (job.status === 'running') return job;
  }
  return null;
}

function reset() {
  nextSeq = 0;
  jobs.clear();
  pending.length = 0;
}

module.exports = {
  enqueue,
  get,
  queuePositionOf,
  shiftNext,
  markRunning,
  markDone,
  markError,
  depth,
  currentJob,
  reset,
};
```

- [ ] **Step 2: Update `server.js` `/enqueue`, `drainQueue`, `/status`, `/health` to use payload + result**

In `server.js`:

**At lines 101-119 (`POST /enqueue`)**, change to:

```javascript
  app.post('/enqueue', (req, res) => {
    const body = req.body || {};
    const { prompt, project_id, segment_id, output_path } = body;
    if (!prompt) {
      return res.status(400).json({ error: 'prompt required' });
    }
    const hasOutputPath = typeof output_path === 'string' && output_path.length > 0;
    const hasIds = typeof project_id === 'number' && typeof segment_id === 'number';
    if (!hasOutputPath && !hasIds) {
      return res.status(400).json({
        error: 'either output_path OR (project_id + segment_id) required',
      });
    }
    const jobId = queue.enqueue({
      type: 'image',
      prompt,
      project_id,
      segment_id,
      output_path: output_path || null,
    });
    touchActivity();
    setImmediate(drainQueue);
    res.json({ job_id: jobId, queue_position: queue.queuePositionOf(jobId) });
  });
```

**At lines 23-71 (`drainQueue`)**, change the `runJob` call + result handling to read from payload and write to result:

```javascript
async function drainQueue() {
  if (workerBusy) return;
  const jobId = queue.shiftNext();
  if (!jobId) return;

  const rootDir = process.env.FLOW_ROOT_DIR || path.resolve(__dirname, '..', '..');
  const flowUrl = process.env.FLOW_URL_OVERRIDE || null;

  workerBusy = true;
  touchActivity();
  queue.markRunning(jobId);
  const job = queue.get(jobId);
  const p = job.payload;

  try {
    const { image_path } = await runJob({
      prompt: p.prompt,
      project_id: p.project_id,
      segment_id: p.segment_id,
      output_path: p.output_path,
      rootDir,
      flowUrl,
    });
    queue.markDone(jobId, { image_path });
    browserConnected = true;
    loggedIn = true;
  } catch (e) {
    queue.markError(jobId, {
      error: e.message || String(e),
      error_code: e.error_code || 'selector_missing',
    });
    if (e.error_code === 'browser_crashed') browserConnected = false;
    if (e.error_code === 'profile_locked') browserConnected = false;
    if (e.error_code === 'not_logged_in') loggedIn = false;
  } finally {
    workerBusy = false;
    touchActivity();
    if (queue.depth() > 0 && !flowUrl) {
      const cooldown = 5000 + Math.floor(Math.random() * 10_000);
      setTimeout(drainQueue, cooldown);
    } else {
      setImmediate(drainQueue);
    }
  }
}
```

**At lines 77-99 (`/health`)**, change `current_job` construction:

```javascript
  app.get('/health', (req, res) => {
    const current = queue.currentJob();
    res.json({
      ok: true,
      browser_connected: browserConnected,
      logged_in: loggedIn,
      worker_busy: workerBusy,
      queue_depth: queue.depth(),
      current_job: current
        ? {
            job_id: current.job_id,
            type: current.payload.type || 'image',
            prompt: current.payload.prompt && current.payload.prompt.length > 120
              ? current.payload.prompt.slice(0, 120) + '...'
              : current.payload.prompt,
            started_at: current.started_at,
            output_path: current.payload.output_path,
            project_id: current.payload.project_id,
            segment_id: current.payload.segment_id,
          }
        : null,
      version: VERSION,
    });
  });
```

**At lines 121-135 (`/status/:jobId`)**, change to:

```javascript
  app.get('/status/:jobId', (req, res) => {
    const job = queue.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'unknown job' });
    const p = job.payload;
    res.json({
      status: job.status,
      type: p.type || 'image',
      project_id: p.project_id,
      segment_id: p.segment_id,
      output_path: p.output_path,
      image_path: job.result ? job.result.image_path : null,
      error: job.error,
      error_code: job.error_code,
      started_at: job.started_at,
      finished_at: job.finished_at,
    });
  });
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: 5 tests pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add lib/queue.js server.js
git commit -m "$(cat <<'EOF'
refactor: generalize queue to opaque payload

Jobs now carry an opaque payload object instead of image-specific fields on
the job record. Server constructs the payload from the enqueue body (including
a new type='image' tag) and the worker/status/health code reads from
payload/result. Behavior unchanged for image callers; prepares the queue to
carry video jobs too.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extract `lib/cli-shared.js`

**Goal:** Pull daemon-lifecycle + flag parsing out of `bin/flow-cli.js` so both CLIs share the code.

**Files:**
- Create: `lib/cli-shared.js`
- Modify: `bin/flow-cli.js`

- [ ] **Step 1: Create `lib/cli-shared.js`**

```javascript
// Shared helpers for flow-cli and flow-video-cli: daemon lifecycle, flag
// parsing, stdin, HTTP polling. No mode-specific logic here.

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const DAEMON_STARTUP_TIMEOUT_MS = 15000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

async function isDaemonHealthy(url) {
  try {
    const r = await fetch(`${url}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

function findProcessOnPort(port) {
  try {
    const out = execSync(`lsof -ti :${port}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    return parseInt(out.split(/\s+/)[0], 10) || null;
  } catch {
    return null;
  }
}

function spawnDaemon({ serverPath, logDir, logFile }) {
  fs.mkdirSync(logDir, { recursive: true });
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();
  return child.pid;
}

// Bring the daemon up if it isn't already. If something's holding the port
// but not responding, probe briefly then kill it. Then spawn a fresh daemon
// detached, poll /health until it answers.
async function ensureDaemonUp({ port, url, serverPath, logDir, logFile }) {
  if (await isDaemonHealthy(url)) return;

  const zombie = findProcessOnPort(port);
  if (zombie) {
    console.error(`[cli] port ${port} held by PID ${zombie} — probing for 3s before deciding`);
    let settledHealthy = false;
    for (let i = 0; i < 6; i += 1) {
      await sleep(500);
      if (await isDaemonHealthy(url)) {
        settledHealthy = true;
        break;
      }
    }
    if (settledHealthy) {
      console.error(`[cli] port ${port} was booting, now healthy — proceeding`);
      return;
    }
    console.error(`[cli] PID ${zombie} still not responding after probe — killing`);
    try { process.kill(zombie, 'SIGKILL'); } catch {}
    await sleep(1000);
  }

  console.error('[cli] daemon not running — starting in background');
  const pid = spawnDaemon({ serverPath, logDir, logFile });
  console.error(`[cli] daemon PID ${pid} (log: ${logFile})`);

  const started = Date.now();
  while (Date.now() - started < DAEMON_STARTUP_TIMEOUT_MS) {
    await sleep(500);
    if (await isDaemonHealthy(url)) {
      const secs = Math.round((Date.now() - started) / 1000);
      console.error(`[cli] daemon ready after ${secs}s`);
      return;
    }
  }

  console.error(`[cli] daemon did not respond within ${DAEMON_STARTUP_TIMEOUT_MS / 1000}s`);
  console.error(`[cli] check ${logFile} for errors`);
  process.exit(2);
}

module.exports = {
  sleep,
  parseFlags,
  readStdin,
  isDaemonHealthy,
  findProcessOnPort,
  spawnDaemon,
  ensureDaemonUp,
};
```

- [ ] **Step 2: Update `bin/flow-cli.js` to use the shared helpers**

In `bin/flow-cli.js`:

Replace lines 19-28 (constants + spawn/execSync imports) with:

```javascript
const path = require('node:path');
const os = require('node:os');
const {
  sleep,
  parseFlags,
  readStdin,
  ensureDaemonUp,
} = require('../lib/cli-shared');

const PORT = process.env.FLOW_DAEMON_PORT || '47321';
const URL = process.env.FLOW_DAEMON_URL || `http://127.0.0.1:${PORT}`;
const LOG_DIR = path.join(os.homedir(), '.flow-daemon');
const LOG_FILE = path.join(LOG_DIR, 'daemon.log');
const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');
```

Delete lines 106-198 in `bin/flow-cli.js` (the entire block from `// --- daemon auto-start helpers ---` through the end of `ensureDaemonUp`).

Delete lines 304-335 in `bin/flow-cli.js` (the duplicated `parseFlags`, `readStdin`, `sleep` helpers).

Change line 213 in `bin/flow-cli.js` from:

```javascript
  await ensureDaemonUp();
```

to:

```javascript
  await ensureDaemonUp({ port: PORT, url: URL, serverPath: SERVER_PATH, logDir: LOG_DIR, logFile: LOG_FILE });
```

- [ ] **Step 3: Run tests + manual smoke check**

```bash
npm test
```

Expected: 5 tests pass.

Manual: start the daemon, call `flow-cli health`, confirm it responds.

```bash
# From a separate terminal, or in background:
node /Users/cuongnguyen/projects/flow-daemon/.worktrees/feat-video-cli/server.js &
sleep 2
node /Users/cuongnguyen/projects/flow-daemon/.worktrees/feat-video-cli/bin/flow-cli.js health
```

Expected: JSON with `ok: true`. Kill the daemon afterward.

```bash
kill $(lsof -ti :47321) 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
git add lib/cli-shared.js bin/flow-cli.js
git commit -m "$(cat <<'EOF'
refactor: extract lib/cli-shared.js from bin/flow-cli.js

Pulls daemon-lifecycle helpers (ensureDaemonUp, findProcessOnPort, spawnDaemon)
and flag/stdin utilities into a shared module so the forthcoming
bin/flow-video-cli.js can reuse them. Behavior of flow-cli is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add `test/mock-flow-video.html` + video selectors

**Goal:** Build a hermetic Playwright fixture that mimics Flow's video UI enough to exercise the upcoming video worker, and populate the `video` selectors namespace.

**Files:**
- Create: `test/mock-flow-video.html`
- Modify: `lib/selectors.js`

- [ ] **Step 1: Create `test/mock-flow-video.html`**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Mock Flow — Video</title>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    [role="textbox"] { width: 400px; min-height: 40px; border: 1px solid #ccc;
      padding: 8px; outline: none; }
    #clips video { width: 200px; height: 120px; margin: 4px; display: block; }
    .extend-btn { margin: 4px 0; }
  </style>
</head>
<body>
  <h1>Mock Flow — Video</h1>

  <!-- Matches selectors.common.promptInput = [role="textbox"] -->
  <div role="textbox" contenteditable="true" data-placeholder="Describe your video"></div>
  <br/>

  <!-- Matches selectors.common.generateButton = text=arrow_forwardCreate
       Real Flow renders the "arrow_forward" glyph prefix; this mock mirrors
       that combined text content. -->
  <button onclick="mockCreate()">arrow_forwardCreate</button>

  <!-- Matches selectors.video.framesEntry = text=Frames -->
  <button onclick="openFrames()">Frames</button>
  <input type="file" id="frame-input" accept="image/*" style="display:none" onchange="onFrameUpload(event)" />
  <div id="frame-preview-container"></div>

  <!-- Matches selectors.video.downloadSceneButton = text=Download scene -->
  <button id="download-btn" style="display:none" onclick="mockDownloadScene()">Download scene</button>

  <div id="clips"></div>

  <script>
    // Query params:
    //   ?failat=N  — the Nth Create click produces no <video>, simulating a
    //                clip that didn't render. Used to test extend_failed.
    //   ?rejectframe=1 — frame upload is rejected (no preview appears).
    const params = new URLSearchParams(location.search);
    const failat = parseInt(params.get('failat') || '-1', 10);
    const rejectFrame = params.get('rejectframe') === '1';

    let clipCount = 0;

    function mockCreate() {
      clipCount += 1;
      // Simulate a clip that never finishes rendering: skip adding the <video>.
      if (clipCount === failat) return;

      // Simulate real Flow's brief render delay (kept short for test speed).
      setTimeout(() => {
        const clips = document.getElementById('clips');
        const wrap = document.createElement('div');

        const video = document.createElement('video');
        // Unique "src" so the src-diff detection in lib/video.js picks it up.
        // Not a real video — tests only check element presence + src change.
        video.src = 'data:video/mp4;base64,AAAAHGZ0eXBtcDQyAAAAAW1wNDJtcDQxaXNvbQ==#clip-' + clipCount;
        video.setAttribute('data-clip-index', String(clipCount));

        const extend = document.createElement('button');
        extend.className = 'extend-btn';
        extend.textContent = 'Extend';
        extend.onclick = mockCreate;

        wrap.appendChild(video);
        wrap.appendChild(extend);
        clips.appendChild(wrap);

        document.getElementById('download-btn').style.display = 'inline-block';
      }, 100);
    }

    function openFrames() {
      document.getElementById('frame-input').click();
    }

    function onFrameUpload(ev) {
      const file = ev.target.files[0];
      if (!file) return;
      if (rejectFrame) return; // simulate Flow rejecting the upload
      const preview = document.getElementById('frame-preview-container');
      preview.innerHTML = '';
      const el = document.createElement('div');
      el.setAttribute('data-frame-preview', '1');
      el.textContent = 'Frame uploaded: ' + file.name;
      preview.appendChild(el);
    }

    function mockDownloadScene() {
      // Trigger a Playwright "download" event by programmatically clicking
      // an <a download>. The blob bytes are a tiny stub — tests only check
      // size > 0 and the download path matches output_path.
      const blob = new Blob([new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70])],
        { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'scene.mp4';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: Populate `video` namespace in `lib/selectors.js`**

Replace the `const video = { ... };` block in `lib/selectors.js` with:

```javascript
// Video-mode-only selectors. Most are best-effort starters that MUST be
// verified live per docs/superpowers/specs/2026-04-18-flow-video-cli-design.md §9
// before they'll work against real labs.google/flow. The mock fixture
// test/mock-flow-video.html mirrors these for hermetic tests.
const video = {
  // Tab inside the mode popover that switches Flow to video mode.
  // Live-verify — placeholder pattern mirrors the image tab shape.
  videoModeTab: 'button.flow_tab_slider_trigger:has-text("Video")',

  // Video models Flow currently exposes. Live-verify exact names.
  modelNames: ['veo-3', 'veo-3-fast', 'veo-2'],

  // Aspect-ratio options inside the mode popover. Live-verify.
  aspectOption: (ratio) =>
    `button.flow_tab_slider_trigger:has-text("${ratio}")`,

  // All <video> elements on the page. Used for src-diff completion detection,
  // mirror of image.allImages.
  allVideos: 'video',

  // Extend button that appears next to each generated clip.
  extendButton: 'button:has-text("Extend")',

  // Entry point for the Frames-to-video upload UI.
  framesEntry: 'button:has-text("Frames")',

  // Thumbnail preview that appears after a successful frame upload.
  framePreview: '[data-frame-preview]',

  // Button that triggers the stitched scene download.
  downloadSceneButton: 'button:has-text("Download scene")',
};
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: 5 tests pass (no new tests yet; just making sure existing ones still pass with selectors changes).

- [ ] **Step 4: Commit**

```bash
git add test/mock-flow-video.html lib/selectors.js
git commit -m "$(cat <<'EOF'
feat(video): add mock-flow-video fixture + video selectors

Hermetic Playwright fixture that mirrors the minimum video UI we need:
prompt input, Create button, <video> outputs with unique srcs, per-clip
Extend button, Frames upload flow, and a Download scene button that
triggers a Playwright 'download' event. Query params (?failat=N,
?rejectframe=1) let tests simulate failure modes.

Selectors.video is populated with best-effort starters; most must be
verified live per spec §9 before they match real Flow DOM.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Implement `lib/video.js` — single-prompt happy path (TDD)

**Goal:** Write a test that drives the creation of `lib/video.js::runJob` for the simplest case (1 prompt, no frame).

**Files:**
- Create: `test/video.test.js`
- Create: `lib/video.js`

- [ ] **Step 1: Write the failing test**

Create `test/video.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Hermetic fixture path. The video mock lives at test/mock-flow-video.html.
const MOCK_URL = 'file://' + path.resolve(__dirname, 'mock-flow-video.html');

const PROMPT_POOL = [
  'A weathered wooden bridge over a mountain stream in late autumn, morning mist, cinematic 16:9',
  'An elderly woman reading under a reading lamp in a cozy library, warm tungsten light',
  'A lone fisherman in a wooden boat at sunrise on a glass-calm lake, silhouette',
  'A misty pine forest at dawn, shafts of golden sunlight piercing the fog',
];

function randomPrompt() {
  return PROMPT_POOL[Math.floor(Math.random() * PROMPT_POOL.length)];
}

test('video.runJob produces an mp4 from a single prompt (mock fixture)', async () => {
  require('../lib/queue').reset();

  const { runJob } = require('../lib/video');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-test-'));
  const outputPath = path.join(outputDir, 'single.mp4');

  try {
    const result = await runJob({
      prompts: [randomPrompt()],
      output_path: outputPath,
      flowUrl: MOCK_URL,
      timeoutMs: 10_000,
    });

    assert.strictEqual(result.video_path, outputPath);
    assert.strictEqual(result.prompt_count, 1);
    assert.ok(fs.existsSync(outputPath), `expected ${outputPath} to exist`);
    assert.ok(fs.statSync(outputPath).size > 0, 'mp4 should not be empty');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test — expect MODULE_NOT_FOUND**

```bash
node --test test/video.test.js 2>&1 | head -20
```

Expected: fails with `Cannot find module '../lib/video'` or similar.

- [ ] **Step 3: Create `lib/video.js` with a minimal runJob**

```javascript
const path = require('node:path');
const fs = require('node:fs');
const selectors = require('./selectors');
const {
  ensureContextForUrl,
  findOrCreatePage,
  humanPause,
  jitter,
} = require('./browser');

const DEFAULT_FLOW_URL = 'https://labs.google/fx/tools/flow/project/bcc73489-69d9-4621-974a-7168318a59d2';
const DEFAULT_TIMEOUT_MS = 180_000;

function pickRandomModel() {
  const names = selectors.video.modelNames;
  return names[Math.floor(Math.random() * names.length)];
}

// Humanized typing: per-character jitter (120-270ms) against real Flow,
// instantaneous against the mock fixture so tests don't run for minutes.
async function typePrompt(page, prompt, isMockFixture) {
  if (isMockFixture) {
    await page.keyboard.type(prompt);
  } else {
    for (const ch of prompt) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(jitter(120, 270));
    }
  }
}

// Switch Flow's prompt bar to Video mode. Mirror of image.js's
// ensureImageModeAndCount. On the mock fixture there's no mode button so
// this returns early. On real Flow, reads the mode button's label,
// opens the popover if we're in image mode, clicks the Video tab.
// The videoModeTab selector is a best-effort starter — verify live per
// spec §9 before relying on it.
async function ensureVideoMode(page) {
  const modeBtn = await page.waitForSelector(selectors.common.modeButton, { timeout: 3000 })
    .catch(() => null);
  if (!modeBtn) return; // mock fixture, or UI not loaded

  const label = (await modeBtn.textContent()) || '';
  const inVideoMode = /Video/i.test(label);
  if (inVideoMode) return;

  await modeBtn.click();
  await humanPause(page, 1200, 2500);

  const videoTab = await page.waitForSelector(selectors.video.videoModeTab, { timeout: 3000 })
    .catch(() => null);
  if (videoTab) {
    await videoTab.click();
    await humanPause(page, 1200, 2500);
  }

  await page.keyboard.press('Escape').catch(() => {});
  await humanPause(page, 800, 1600);
}

async function runJob({
  prompts,
  frame_path,
  output_path,
  flowUrl,
  timeoutMs,
  model,
  aspect,
}) {
  if (!Array.isArray(prompts) || prompts.length === 0) {
    const err = new Error('prompts must be a non-empty array');
    err.error_code = 'selector_missing';
    throw err;
  }
  if (!output_path || !path.isAbsolute(output_path)) {
    const err = new Error('output_path required and must be absolute');
    err.error_code = 'selector_missing';
    throw err;
  }

  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const chosenModel = model || pickRandomModel();
  const chosenAspect = aspect || '16:9';
  const url = flowUrl || DEFAULT_FLOW_URL;
  const isMockFixture = url.startsWith('file://');

  const context = await ensureContextForUrl(flowUrl);

  try {
    const page = await findOrCreatePage(context, url);

    // Login canary
    const input = await page.waitForSelector(selectors.common.promptInput, { timeout: 5000 })
      .catch(() => null);
    if (!input) {
      const err = new Error('prompt input not found — not logged in?');
      err.error_code = 'not_logged_in';
      throw err;
    }

    // Flip Flow to Video mode if it isn't already. No-op on the mock
    // fixture (no mode button present).
    await ensureVideoMode(page);

    // Snapshot existing video srcs so we detect "new" ones.
    const beforeSrcs = new Set(
      await page.$$eval(selectors.video.allVideos, (els) => els.map((el) => el.src))
    );

    // Clear input and type first prompt.
    await input.click();
    await page.keyboard.press('Meta+A').catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await humanPause(page, 600, 1500);

    await typePrompt(page, prompts[0], isMockFixture);

    await humanPause(page, 1000, 2500);

    // Submit
    const genBtn = await page.waitForSelector(selectors.common.generateButton, { timeout: 3000 });
    await genBtn.click();

    // Wait for a new <video> element.
    await page.waitForFunction(
      ({ selector, beforeArray }) => {
        const before = new Set(beforeArray);
        for (const el of document.querySelectorAll(selector)) {
          if (el.src && !before.has(el.src)) return true;
        }
        return false;
      },
      { selector: selectors.video.allVideos, beforeArray: [...beforeSrcs] },
      { timeout }
    );

    // Trigger the stitched scene download and capture the bytes.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.click(selectors.video.downloadSceneButton),
    ]);

    fs.mkdirSync(path.dirname(output_path), { recursive: true });
    await download.saveAs(output_path);

    const size = fs.statSync(output_path).size;
    if (size === 0) {
      const err = new Error('downloaded video is empty');
      err.error_code = 'network';
      throw err;
    }

    return {
      video_path: output_path,
      prompt_count: prompts.length,
      model: chosenModel,
      aspect: chosenAspect,
    };
  } finally {
    if (context._ephemeral) await context.browser().close();
  }
}

module.exports = { runJob };
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
node --test test/video.test.js 2>&1 | tail -15
```

Expected: `pass 1`, `fail 0`.

- [ ] **Step 5: Run the full suite**

```bash
npm test && node --test test/video.test.js
```

Expected: All 5 existing tests pass plus the 1 new video test passes.

- [ ] **Step 6: Commit**

```bash
git add test/video.test.js lib/video.js
git commit -m "$(cat <<'EOF'
feat(video): lib/video.js runJob for single-prompt case

First TDD step for the video worker. runJob accepts prompts + output_path,
drives the prompt input, clicks Create, waits for a <video> element, and
saves the Download-scene event bytes to disk. Tested against the hermetic
mock-flow-video fixture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Extend loop — multi-prompt chain (TDD)

**Goal:** Add support for 2..N prompts chained via the Extend button.

**Files:**
- Modify: `test/video.test.js`
- Modify: `lib/video.js`

- [ ] **Step 1: Add a failing test for 3-prompt chain**

Append to `test/video.test.js`:

```javascript
test('video.runJob handles a 3-prompt extend chain (mock fixture)', async () => {
  require('../lib/queue').reset();

  const { runJob } = require('../lib/video');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-test-'));
  const outputPath = path.join(outputDir, 'three-clip.mp4');

  try {
    const result = await runJob({
      prompts: [randomPrompt(), randomPrompt(), randomPrompt()],
      output_path: outputPath,
      flowUrl: MOCK_URL,
      timeoutMs: 10_000,
    });

    assert.strictEqual(result.prompt_count, 3);
    assert.ok(fs.existsSync(outputPath));
    assert.ok(fs.statSync(outputPath).size > 0);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run — expect FAIL (only one clip gets generated)**

```bash
node --test test/video.test.js 2>&1 | tail -20
```

Expected: the new test times out waiting for a second video (none is generated because we never click Extend).

- [ ] **Step 3: Extend the runJob loop to handle 2..N prompts**

In `lib/video.js`, replace the block from `// Snapshot existing video srcs` down through `// Wait for a new <video> element.` and its `page.waitForFunction` call with:

```javascript
    // Iterate prompts: 0 is the initial Create; 1..N-1 are Extend clicks.
    for (let i = 0; i < prompts.length; i += 1) {
      const prompt = prompts[i];
      const isExtend = i > 0;

      // Snapshot existing video srcs so we detect only the NEW one for this iteration.
      const beforeSrcs = new Set(
        await page.$$eval(selectors.video.allVideos, (els) => els.map((el) => el.src))
      );

      if (isExtend) {
        // Click the Extend button on the latest clip.
        const extendBtn = await page.waitForSelector(selectors.video.extendButton, { timeout: 5000 });
        await extendBtn.click();
        await humanPause(page, 800, 1600);
      }

      // Clear input and type this prompt.
      const currentInput = await page.waitForSelector(selectors.common.promptInput, { timeout: 3000 });
      await currentInput.click();
      await page.keyboard.press('Meta+A').catch(() => {});
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await humanPause(page, 600, 1500);

      await typePrompt(page, prompt, isMockFixture);

      await humanPause(page, 1000, 2500);

      // Submit this clip.
      const genBtn = await page.waitForSelector(selectors.common.generateButton, { timeout: 3000 });
      await genBtn.click();

      // Wait for a new <video> element (new src relative to this iteration's snapshot).
      await page.waitForFunction(
        ({ selector, beforeArray }) => {
          const before = new Set(beforeArray);
          for (const el of document.querySelectorAll(selector)) {
            if (el.src && !before.has(el.src)) return true;
          }
          return false;
        },
        { selector: selectors.video.allVideos, beforeArray: [...beforeSrcs] },
        { timeout }
      );

      // Cooldown between clips (not after the last). Skipped on mock fixture
      // so tests stay fast.
      if (i < prompts.length - 1 && !isMockFixture) {
        const cooldown = 5000 + Math.floor(Math.random() * 10_000);
        await page.waitForTimeout(cooldown);
      }
    }
```

- [ ] **Step 4: Run the suite — expect both video tests to pass**

```bash
node --test test/video.test.js 2>&1 | tail -15
```

Expected: 2 pass, 0 fail.

- [ ] **Step 5: Run the full suite**

```bash
npm test && node --test test/video.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add test/video.test.js lib/video.js
git commit -m "$(cat <<'EOF'
feat(video): extend loop for multi-prompt chains

runJob now iterates prompts; the first is Create, prompts 2..N click the
Extend button on the most recent clip, then type + Create. Between clips
there's a 5-15s humanized cooldown against real Flow (skipped on mock).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Extend-failure mid-chain (TDD)

**Goal:** When a clip mid-chain fails to render, return `error_code: 'extend_failed'` with `failed_at_index` and `completed_prompts`.

**Files:**
- Modify: `test/video.test.js`
- Modify: `lib/video.js`

- [ ] **Step 1: Add a failing test**

Append to `test/video.test.js`:

```javascript
test('video.runJob reports extend_failed when clip 2 of 3 fails to render', async () => {
  require('../lib/queue').reset();

  const { runJob } = require('../lib/video');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-test-'));
  const outputPath = path.join(outputDir, 'failed.mp4');

  try {
    await assert.rejects(
      async () => {
        await runJob({
          prompts: [randomPrompt(), randomPrompt(), randomPrompt()],
          output_path: outputPath,
          // failat=2 → the 2nd Create click (first Extend) produces no <video>,
          // simulating a clip that never finishes rendering.
          flowUrl: MOCK_URL + '?failat=2',
          timeoutMs: 2_000,
        });
      },
      (err) => {
        assert.strictEqual(err.error_code, 'extend_failed');
        assert.strictEqual(err.failed_at_index, 1);
        assert.strictEqual(err.completed_prompts, 1);
        return true;
      }
    );
    assert.ok(!fs.existsSync(outputPath), 'no mp4 should have been written');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run — expect FAIL (current code throws generic timeout)**

```bash
node --test test/video.test.js 2>&1 | tail -25
```

Expected: the test fails because the thrown error has `error_code: 'timeout'` or similar, not `'extend_failed'`.

- [ ] **Step 3: Wrap the per-clip work in a try/catch that tags extend failures**

In `lib/video.js`, change the `for (let i = 0; ...` loop body to:

```javascript
    let completedPromptCount = 0;
    for (let i = 0; i < prompts.length; i += 1) {
      const prompt = prompts[i];
      const isExtend = i > 0;

      try {
        const beforeSrcs = new Set(
          await page.$$eval(selectors.video.allVideos, (els) => els.map((el) => el.src))
        );

        if (isExtend) {
          const extendBtn = await page.waitForSelector(selectors.video.extendButton, { timeout: 5000 });
          await extendBtn.click();
          await humanPause(page, 800, 1600);
        }

        const currentInput = await page.waitForSelector(selectors.common.promptInput, { timeout: 3000 });
        await currentInput.click();
        await page.keyboard.press('Meta+A').catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Delete').catch(() => {});
        await humanPause(page, 600, 1500);

        await typePrompt(page, prompt, isMockFixture);

        await humanPause(page, 1000, 2500);

        const genBtn = await page.waitForSelector(selectors.common.generateButton, { timeout: 3000 });
        await genBtn.click();

        await page.waitForFunction(
          ({ selector, beforeArray }) => {
            const before = new Set(beforeArray);
            for (const el of document.querySelectorAll(selector)) {
              if (el.src && !before.has(el.src)) return true;
            }
            return false;
          },
          { selector: selectors.video.allVideos, beforeArray: [...beforeSrcs] },
          { timeout }
        );

        completedPromptCount += 1;

        if (i < prompts.length - 1 && !isMockFixture) {
          const cooldown = 5000 + Math.floor(Math.random() * 10_000);
          await page.waitForTimeout(cooldown);
        }
      } catch (e) {
        if (isExtend) {
          const err = new Error(`extend failed on prompt ${i + 1}: ${e.message}`);
          err.error_code = 'extend_failed';
          err.failed_at_index = i;
          err.completed_prompts = completedPromptCount;
          throw err;
        }
        // Initial-clip failure: propagate with an appropriate code.
        if (!e.error_code) e.error_code = 'timeout';
        throw e;
      }
    }
```

- [ ] **Step 4: Run — expect all 3 video tests PASS**

```bash
node --test test/video.test.js 2>&1 | tail -15
```

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Run full suite**

```bash
npm test && node --test test/video.test.js
```

Expected: everything green.

- [ ] **Step 6: Commit**

```bash
git add test/video.test.js lib/video.js
git commit -m "$(cat <<'EOF'
feat(video): extend_failed mid-chain with failed_at_index

When a clip mid-chain times out, the thrown error carries
error_code=extend_failed, failed_at_index (0-indexed), and completed_prompts
so the caller knows exactly how far the scene got. The Flow scene is left
intact (no retry, no cleanup) so it can be inspected manually.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Frame upload + `frame_invalid` (TDD)

**Goal:** `--frame PATH` uploads a png/jpg as the starting frame, and validates it before spending Flow quota.

**Files:**
- Modify: `test/video.test.js`
- Modify: `lib/video.js`

- [ ] **Step 1: Add three failing tests**

Append to `test/video.test.js`:

```javascript
test('video.runJob with valid --frame uploads and produces mp4', async () => {
  require('../lib/queue').reset();

  const { runJob } = require('../lib/video');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-test-'));
  const outputPath = path.join(outputDir, 'with-frame.mp4');

  // Write a tiny valid 1x1 red PNG.
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64'
  );
  const framePath = path.join(outputDir, 'hero.png');
  fs.writeFileSync(framePath, pngBytes);

  try {
    const result = await runJob({
      prompts: [randomPrompt()],
      frame_path: framePath,
      output_path: outputPath,
      flowUrl: MOCK_URL,
      timeoutMs: 10_000,
    });

    assert.strictEqual(result.video_path, outputPath);
    assert.ok(fs.existsSync(outputPath));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('video.runJob rejects missing frame with frame_invalid', async () => {
  require('../lib/queue').reset();

  const { runJob } = require('../lib/video');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-test-'));

  try {
    await assert.rejects(
      async () => {
        await runJob({
          prompts: [randomPrompt()],
          frame_path: '/does/not/exist.png',
          output_path: path.join(outputDir, 'x.mp4'),
          flowUrl: MOCK_URL,
          timeoutMs: 5_000,
        });
      },
      (err) => {
        assert.strictEqual(err.error_code, 'frame_invalid');
        return true;
      }
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('video.runJob rejects non-image frame path with frame_invalid', async () => {
  require('../lib/queue').reset();

  const { runJob } = require('../lib/video');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-test-'));
  const notAnImage = path.join(outputDir, 'notes.txt');
  fs.writeFileSync(notAnImage, 'hello world');

  try {
    await assert.rejects(
      async () => {
        await runJob({
          prompts: [randomPrompt()],
          frame_path: notAnImage,
          output_path: path.join(outputDir, 'x.mp4'),
          flowUrl: MOCK_URL,
          timeoutMs: 5_000,
        });
      },
      (err) => {
        assert.strictEqual(err.error_code, 'frame_invalid');
        return true;
      }
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run — expect 3 new FAILs**

```bash
node --test test/video.test.js 2>&1 | tail -30
```

Expected: 3 new failures. Existing 3 still pass.

- [ ] **Step 3: Add validation + upload path**

In `lib/video.js`, right after the `prompts` + `output_path` validation at the top of `runJob`, insert the frame validation:

```javascript
  if (frame_path) {
    if (!fs.existsSync(frame_path)) {
      const err = new Error(`frame_path does not exist: ${frame_path}`);
      err.error_code = 'frame_invalid';
      throw err;
    }
    const ext = path.extname(frame_path).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
      const err = new Error(`frame_path must be .png or .jpg: ${frame_path}`);
      err.error_code = 'frame_invalid';
      throw err;
    }
  }
```

Then, inside the try block, after the login-canary check and before the `for (let i = 0; ...)` loop, add the upload step:

```javascript
    // Frames-to-video: upload the starting frame if provided.
    if (frame_path) {
      const framesBtn = await page.waitForSelector(selectors.video.framesEntry, { timeout: 5000 })
        .catch(() => null);
      if (!framesBtn) {
        const err = new Error('Frames entry point not found in Flow UI');
        err.error_code = 'selector_missing';
        throw err;
      }
      await framesBtn.click();
      await humanPause(page, 800, 1600);

      const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 3000 });
      await fileInput.setInputFiles(frame_path);

      await page.waitForSelector(selectors.video.framePreview, { timeout: 20_000 })
        .catch(() => {
          const err = new Error('frame upload preview did not appear within 20s — rejected?');
          err.error_code = 'frame_invalid';
          throw err;
        });
      await humanPause(page, 800, 1600);
    }
```

- [ ] **Step 4: Run — expect all 6 video tests PASS**

```bash
node --test test/video.test.js 2>&1 | tail -15
```

Expected: 6 pass, 0 fail.

- [ ] **Step 5: Run the full suite**

```bash
npm test && node --test test/video.test.js
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add test/video.test.js lib/video.js
git commit -m "$(cat <<'EOF'
feat(video): frames-to-video upload + frame_invalid validation

runJob accepts a frame_path parameter and uploads the image as the scene's
starting frame. File existence + extension are validated up front (before
any quota-spending click); upload rejection by Flow also raises
error_code=frame_invalid.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Wire `server.js` to accept video bodies and dispatch to the video worker

**Goal:** `POST /enqueue` with the video body shape lands in a video job; `drainQueue` dispatches to the right worker; `/status` + `/health` surface video fields.

**Files:**
- Modify: `server.js`
- Modify: `test/daemon.test.js`

- [ ] **Step 1: Add a failing daemon-level test for a video enqueue**

Append to `test/daemon.test.js`:

```javascript
test('POST /enqueue with video body shape dispatches to video worker', async () => {
  require('../lib/queue').reset();

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-daemon-test-'));
  const outputPath = path.join(rootDir, 'video-out.mp4');

  // Pin the worker to the mock-flow-video fixture.
  const MOCK_VIDEO_URL = 'file://' + path.resolve(__dirname, 'mock-flow-video.html');
  process.env.FLOW_ROOT_DIR = rootDir;
  process.env.FLOW_URL_OVERRIDE = MOCK_VIDEO_URL;

  const { createServer } = require('../server.js');
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const enqueueRes = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/enqueue',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.write(JSON.stringify({
        prompts: [randomPrompt()],
        output_path: outputPath,
      }));
      req.end();
    });

    assert.strictEqual(enqueueRes.status, 200);
    const jobId = enqueueRes.body.job_id;

    // Poll until done (max 15s)
    let finalStatus = null;
    for (let i = 0; i < 30; i += 1) {
      const { body } = await get(port, `/status/${jobId}`);
      if (body.status === 'done' || body.status === 'error') {
        finalStatus = body;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    assert.ok(finalStatus, 'video job should finish within 15s');
    assert.strictEqual(finalStatus.status, 'done');
    assert.strictEqual(finalStatus.type, 'video');
    assert.strictEqual(finalStatus.video_path, outputPath);
    assert.strictEqual(finalStatus.prompt_count, 1);
    assert.ok(fs.existsSync(outputPath));
    assert.ok(fs.statSync(outputPath).size > 0);
  } finally {
    delete process.env.FLOW_ROOT_DIR;
    delete process.env.FLOW_URL_OVERRIDE;
    await new Promise((r) => server.close(r));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run — expect FAIL (server doesn't know video body shape yet)**

```bash
npm test 2>&1 | tail -20
```

Expected: the new test fails with a 400 from `/enqueue` (`prompt required`) because the server only accepts the image body shape.

- [ ] **Step 3: Update `server.js` to discriminate body shapes and dispatch**

Near the top of `server.js`, change line 4 to import both workers:

```javascript
const imageRunner = require('./lib/image');
const videoRunner = require('./lib/video');
const { closeBrowser } = require('./lib/browser');
```

(Remove the combined `{ runJob, closeBrowser } = require('./lib/image')` destructuring.)

Replace the `drainQueue` function with:

```javascript
async function drainQueue() {
  if (workerBusy) return;
  const jobId = queue.shiftNext();
  if (!jobId) return;

  const rootDir = process.env.FLOW_ROOT_DIR || path.resolve(__dirname, '..', '..');
  const flowUrl = process.env.FLOW_URL_OVERRIDE || null;

  workerBusy = true;
  touchActivity();
  queue.markRunning(jobId);
  const job = queue.get(jobId);
  const p = job.payload;

  try {
    let result;
    if (p.type === 'video') {
      result = await videoRunner.runJob({
        prompts: p.prompts,
        frame_path: p.frame_path || null,
        output_path: p.output_path,
        flowUrl,
        model: p.model,
        aspect: p.aspect,
      });
    } else {
      result = await imageRunner.runJob({
        prompt: p.prompt,
        project_id: p.project_id,
        segment_id: p.segment_id,
        output_path: p.output_path,
        rootDir,
        flowUrl,
      });
    }
    queue.markDone(jobId, result);
    browserConnected = true;
    loggedIn = true;
  } catch (e) {
    queue.markError(jobId, {
      error: e.message || String(e),
      error_code: e.error_code || 'selector_missing',
      failed_at_index: e.failed_at_index,
      completed_prompts: e.completed_prompts,
    });
    if (e.error_code === 'browser_crashed') browserConnected = false;
    if (e.error_code === 'profile_locked') browserConnected = false;
    if (e.error_code === 'not_logged_in') loggedIn = false;
  } finally {
    workerBusy = false;
    touchActivity();
    if (queue.depth() > 0 && !flowUrl) {
      const cooldown = 5000 + Math.floor(Math.random() * 10_000);
      setTimeout(drainQueue, cooldown);
    } else {
      setImmediate(drainQueue);
    }
  }
}
```

Replace `POST /enqueue` with:

```javascript
  app.post('/enqueue', (req, res) => {
    const body = req.body || {};

    // Discriminate by body shape. `prompts` array → video; `prompt` string → image.
    if (Array.isArray(body.prompts)) {
      // Video path
      const { prompts, frame_path, output_path, model, aspect } = body;
      if (!prompts.every((p) => typeof p === 'string' && p.length > 0)) {
        return res.status(400).json({ error: 'prompts must be non-empty strings' });
      }
      if (typeof output_path !== 'string' || !path.isAbsolute(output_path)) {
        return res.status(400).json({ error: 'output_path required and must be absolute for video jobs' });
      }
      if (aspect && !['16:9', '9:16'].includes(aspect)) {
        return res.status(400).json({ error: 'aspect must be "16:9" or "9:16"' });
      }
      const jobId = queue.enqueue({
        type: 'video',
        prompts,
        frame_path: frame_path || null,
        output_path,
        model: model || null,
        aspect: aspect || '16:9',
      });
      touchActivity();
      setImmediate(drainQueue);
      return res.json({ job_id: jobId, queue_position: queue.queuePositionOf(jobId) });
    }

    // Image path (unchanged back-compat).
    const { prompt, project_id, segment_id, output_path } = body;
    if (!prompt) {
      return res.status(400).json({ error: 'prompt required' });
    }
    const hasOutputPath = typeof output_path === 'string' && output_path.length > 0;
    const hasIds = typeof project_id === 'number' && typeof segment_id === 'number';
    if (!hasOutputPath && !hasIds) {
      return res.status(400).json({
        error: 'either output_path OR (project_id + segment_id) required',
      });
    }
    const jobId = queue.enqueue({
      type: 'image',
      prompt,
      project_id,
      segment_id,
      output_path: output_path || null,
    });
    touchActivity();
    setImmediate(drainQueue);
    res.json({ job_id: jobId, queue_position: queue.queuePositionOf(jobId) });
  });
```

Replace `GET /status/:jobId` with:

```javascript
  app.get('/status/:jobId', (req, res) => {
    const job = queue.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'unknown job' });
    const p = job.payload;
    const r = job.result || {};

    const base = {
      status: job.status,
      type: p.type || 'image',
      output_path: p.output_path,
      error: job.error,
      error_code: job.error_code,
      started_at: job.started_at,
      finished_at: job.finished_at,
    };

    if (p.type === 'video') {
      res.json({
        ...base,
        video_path: r.video_path || null,
        prompt_count: r.prompt_count || (p.prompts ? p.prompts.length : null),
        model: r.model || null,
        aspect: r.aspect || null,
        failed_at_index: job.failed_at_index,
        completed_prompts: job.completed_prompts,
      });
    } else {
      res.json({
        ...base,
        project_id: p.project_id,
        segment_id: p.segment_id,
        image_path: r.image_path || null,
      });
    }
  });
```

Replace `/health` `current_job` construction with:

```javascript
  app.get('/health', (req, res) => {
    const current = queue.currentJob();
    let currentJobInfo = null;
    if (current) {
      const p = current.payload;
      currentJobInfo = {
        job_id: current.job_id,
        type: p.type || 'image',
        started_at: current.started_at,
        output_path: p.output_path,
      };
      if (p.type === 'video') {
        currentJobInfo.prompt_count = p.prompts ? p.prompts.length : null;
      } else {
        currentJobInfo.prompt = p.prompt && p.prompt.length > 120
          ? p.prompt.slice(0, 120) + '...'
          : p.prompt;
        currentJobInfo.project_id = p.project_id;
        currentJobInfo.segment_id = p.segment_id;
      }
    }
    res.json({
      ok: true,
      browser_connected: browserConnected,
      logged_in: loggedIn,
      worker_busy: workerBusy,
      queue_depth: queue.depth(),
      current_job: currentJobInfo,
      version: VERSION,
    });
  });
```

- [ ] **Step 4: Bump VERSION string**

In `server.js`, change line 6 from:

```javascript
const VERSION = '0.1.0';
```

to:

```javascript
const VERSION = '0.2.0';
```

- [ ] **Step 5: Run the full suite — expect all tests PASS**

```bash
npm test && node --test test/video.test.js
```

Expected: all tests pass (5 existing + 1 new daemon test + 6 video tests).

- [ ] **Step 6: Commit**

```bash
git add server.js test/daemon.test.js
git commit -m "$(cat <<'EOF'
feat(video): dispatch video jobs from the unified daemon

POST /enqueue now discriminates by body shape: prompts array → video job,
single prompt string → image job (existing Content Hub shape, unchanged).
drainQueue dispatches to imageRunner or videoRunner accordingly.
/status and /health grow video-aware response shapes (type, video_path,
prompt_count, model, aspect, failed_at_index, completed_prompts).

VERSION bumps to 0.2.0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Create `bin/flow-video-cli.js`

**Goal:** A thin CLI that takes variadic prompts + flags, posts the video body to the daemon, polls until done, and prints the mp4 path. Uses shared helpers from `lib/cli-shared.js`.

**Files:**
- Create: `bin/flow-video-cli.js`
- Modify: `package.json`

- [ ] **Step 1: Create `bin/flow-video-cli.js`**

```javascript
#!/usr/bin/env node
// flow-video-cli — generate videos via the Flow daemon in video mode.
//
// Subcommands:
//   generate [PROMPT...] [flags]    Variadic prompts: first creates the
//                                   initial clip, 2..N extend the same scene.
//                                   Output is one stitched mp4.
//
// Env:
//   FLOW_DAEMON_PORT   Daemon HTTP port (default 47321 — SAME as flow-cli,
//                      one daemon, one browser, one queue)
//   FLOW_DAEMON_URL    Override base URL (default http://127.0.0.1:$PORT)

const path = require('node:path');
const os = require('node:os');
const {
  sleep,
  parseFlags,
  readStdin,
  ensureDaemonUp,
} = require('../lib/cli-shared');

const PORT = process.env.FLOW_DAEMON_PORT || '47321';
const URL = process.env.FLOW_DAEMON_URL || `http://127.0.0.1:${PORT}`;
const LOG_DIR = path.join(os.homedir(), '.flow-daemon');
const LOG_FILE = path.join(LOG_DIR, 'daemon.log');
const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');

const cmd = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (cmd) {
    case 'generate':
      return cmdGenerate(args);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      printHelp();
      process.exit(1);
  }
}

async function cmdGenerate(rawArgs) {
  const flags = parseFlags(rawArgs);

  // Collect prompts: variadic positional args, or newline-split stdin.
  let prompts = flags._ || [];
  if (prompts.length === 0 && !process.stdin.isTTY) {
    const stdinText = await readStdin();
    prompts = stdinText.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (prompts.length === 0) {
    console.error('error: at least one prompt required (positional arg, or pipe via stdin)');
    process.exit(1);
  }

  // Resolve output path (default or --output).
  let outputPath = flags.output;
  if (!outputPath) {
    const ts = Math.floor(Date.now() / 1000);
    const dir = process.env.FLOW_VIDEO_OUTPUT_DIR || '/tmp/flow_video';
    outputPath = path.join(dir, `flow-${ts}.mp4`);
  }
  if (!path.isAbsolute(outputPath)) {
    outputPath = path.resolve(process.cwd(), outputPath);
  }

  // Validate aspect / model if supplied.
  if (flags.aspect && !['16:9', '9:16'].includes(flags.aspect)) {
    console.error('error: --aspect must be "16:9" or "9:16"');
    process.exit(1);
  }

  // Auto-start the daemon if needed.
  await ensureDaemonUp({ port: PORT, url: URL, serverPath: SERVER_PATH, logDir: LOG_DIR, logFile: LOG_FILE });

  if (flags['dry-run']) {
    // Dry-run: ask the daemon for a screenshot-and-stop via a synthetic env
    // var. The simplest path is to short-circuit client-side: print what
    // would be sent and exit 0. This does NOT open Flow — it just previews
    // the request payload. For a real DOM-level dry-run (screenshot at the
    // exact moment before clicking Create), call the daemon's video worker
    // directly; that's Task 16's job for live verification.
    console.error('[flow-video-cli] --dry-run: would enqueue the following payload:');
    console.log(JSON.stringify({
      prompts,
      frame_path: flags.frame || null,
      output_path: outputPath,
      model: flags.model || null,
      aspect: flags.aspect || '16:9',
    }, null, 2));
    process.exit(0);
  }

  const body = {
    prompts,
    output_path: outputPath,
  };
  if (flags.frame) body.frame_path = path.resolve(flags.frame);
  if (flags.model) body.model = flags.model;
  if (flags.aspect) body.aspect = flags.aspect;

  let enqueueRes;
  try {
    enqueueRes = await fetch(`${URL}/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`daemon not reachable on ${URL}: ${e.message}`);
    process.exit(2);
  }

  if (!enqueueRes.ok) {
    console.error(`enqueue failed: HTTP ${enqueueRes.status} — ${await enqueueRes.text()}`);
    process.exit(2);
  }

  const { job_id } = await enqueueRes.json();
  if (!flags.quiet && !flags.json) {
    console.error(`[flow-video-cli] enqueued ${job_id} (${prompts.length} prompt${prompts.length > 1 ? 's' : ''} → ${outputPath}), polling...`);
  }

  const startTime = Date.now();
  while (true) {
    await sleep(2000);
    let status;
    try {
      const r = await fetch(`${URL}/status/${job_id}`);
      if (!r.ok) {
        console.error(`status check failed: HTTP ${r.status}`);
        process.exit(2);
      }
      status = await r.json();
    } catch (e) {
      continue;
    }

    if (status.status === 'done') {
      const duration_ms = Date.now() - startTime;
      if (flags.json) {
        console.log(JSON.stringify({ ...status, duration_ms }, null, 2));
      } else {
        console.log(status.video_path);
      }
      return;
    }

    if (status.status === 'error') {
      if (flags.json) {
        console.error(JSON.stringify(status, null, 2));
      } else {
        let msg = `error (${status.error_code}): ${status.error}`;
        if (status.error_code === 'extend_failed') {
          msg += ` [failed_at_index=${status.failed_at_index}, completed_prompts=${status.completed_prompts}]`;
        }
        console.error(msg);
      }
      process.exit(3);
    }
  }
}

function printHelp() {
  process.stdout.write(`flow-video-cli — generate videos via the Flow daemon.

Usage:
  flow-video-cli generate PROMPT [PROMPT ...] [flags]

Prompts:
  First prompt creates the initial ~8s clip. Each additional prompt extends
  the same Flow scene with ~7-8 more seconds. Final output is one stitched mp4.

Flags:
  --output PATH       save the stitched mp4 to PATH (absolute or relative).
                      Default: /tmp/flow_video/flow-<unix-ts>.mp4
  --frame PATH        path to .png or .jpg to seed the first clip (frames-to-video)
  --model NAME        video model (veo-3, veo-3-fast, veo-2). Default: random
  --aspect 16:9|9:16  aspect ratio. Default: 16:9
  --dry-run           print the payload that would be sent and exit 0 (no quota burn)
  --json              print full status JSON instead of just the video path
  --quiet             suppress progress messages on stderr

Env:
  FLOW_DAEMON_PORT        daemon HTTP port (default 47321, shared with flow-cli)
  FLOW_DAEMON_URL         override base URL
  FLOW_VIDEO_OUTPUT_DIR   default output directory (default /tmp/flow_video/)

Examples:
  flow-video-cli generate "a weathered lighthouse at dusk"
  flow-video-cli generate "scene starts" "something happens" "scene ends"
  flow-video-cli generate "waves grow" --frame hero.png --output out.mp4
  echo "a cat walks" | flow-video-cli generate

Exit codes:
  0  success
  1  bad arguments
  2  daemon unreachable or HTTP error
  3  generation failed (see error_code in --json output)
`);
}

main().catch((e) => {
  console.error(`flow-video-cli: ${e.message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x bin/flow-video-cli.js
```

- [ ] **Step 3: Add it to `package.json` bin map**

In `package.json`, change the `bin` section from:

```json
  "bin": {
    "flow-cli": "./bin/flow-cli.js"
  },
```

to:

```json
  "bin": {
    "flow-cli": "./bin/flow-cli.js",
    "flow-video-cli": "./bin/flow-video-cli.js"
  },
```

- [ ] **Step 4: Manual smoke test**

Start the daemon pointed at the mock fixture, then run the CLI end-to-end:

```bash
# Terminal 1: start daemon pointed at the mock video fixture
FLOW_URL_OVERRIDE="file://$(pwd)/test/mock-flow-video.html" \
  node server.js &
DAEMON_PID=$!
sleep 2

# Run the CLI
node bin/flow-video-cli.js generate "a weathered wooden bridge in morning mist" \
  --output /tmp/flow-video-smoke.mp4

# Expected: prints /tmp/flow-video-smoke.mp4 on stdout

# Verify file exists
ls -l /tmp/flow-video-smoke.mp4

# Cleanup
kill $DAEMON_PID 2>/dev/null
rm -f /tmp/flow-video-smoke.mp4
```

Expected: CLI prints `/tmp/flow-video-smoke.mp4`, file exists, size > 0.

- [ ] **Step 5: Run the full test suite to ensure nothing regressed**

```bash
npm test && node --test test/video.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add bin/flow-video-cli.js package.json
git commit -m "$(cat <<'EOF'
feat(video): bin/flow-video-cli with all flags

Thin CLI: variadic prompts, --output, --frame, --model, --aspect, --json,
--quiet, --dry-run, stdin fallback (newline-split). Talks to the same
daemon as flow-cli (port 47321). Auto-starts the daemon if needed via
shared lib/cli-shared helpers. --dry-run currently short-circuits
client-side to preview the payload; real DOM-level dry-run happens during
live selector verification (§9 of spec, Task 16).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Add `scripts/dev-preview-server.js`

**Goal:** Small static server to host screenshots + mp4s over Tailscale while I'm live-verifying selectors against real Flow.

**Files:**
- Create: `scripts/dev-preview-server.js`
- Modify: `.gitignore`

- [ ] **Step 1: Ignore the preview directory**

Append to `.gitignore`:

```
tmp/
```

- [ ] **Step 2: Create `scripts/dev-preview-server.js`**

```javascript
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
```

- [ ] **Step 3: Make it executable**

```bash
chmod +x scripts/dev-preview-server.js
```

- [ ] **Step 4: Smoke test**

```bash
mkdir -p scripts
node scripts/dev-preview-server.js &
SERVER_PID=$!
sleep 1
curl -s http://127.0.0.1:47399/ | head -5
kill $SERVER_PID
```

Expected: HTML page with "dev preview" header.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-preview-server.js .gitignore
git commit -m "$(cat <<'EOF'
chore: add scripts/dev-preview-server.js for selector verification

Dev-time static file server (not shipped). Binds 127.0.0.1:47399 and
serves tmp/dev-preview/ with a directory listing page. Used during live
selector verification to send screenshots + sample mp4s to the user via
Tailscale (mac-mini.tailf56d7b.ts.net:47399). The tmp/ directory is
gitignored.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Update README and AGENTS.md

**Goal:** Document the new CLI, the unified-daemon architecture, and the video-specific error codes.

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update `README.md`**

In `README.md`, after the existing `## CLI` section but before `### Daemon lifecycle`, insert a new section:

```markdown
### `flow-video-cli` — video mode

A sibling CLI that drives Flow in **video mode** alongside `flow-cli`'s
image mode. Same daemon, same Chrome, same queue — video jobs take turns
with image jobs.

```bash
# One prompt → one ~8-second clip
flow-video-cli generate "a weathered lighthouse at dusk, 16:9"

# Variadic prompts → Flow's Extend feature chains them in one scene,
# output is one stitched mp4 (~8s per prompt)
flow-video-cli generate "scene opens" "something happens" "scene closes"

# Seed the first clip from a still image (frames-to-video)
flow-video-cli generate "waves grow bigger" --frame hero.png

# Pipe from flow-cli for the hero-image → video pipeline
flow-cli generate "a lighthouse at dusk" --output hero.png
flow-video-cli generate "waves grow bigger" --frame hero.png --output out.mp4
```

Default output path: `/tmp/flow_video/flow-<unix-ts>.mp4`. Override with
`--output PATH` (absolute or relative). No Content Hub pathing — use
`--output` when integrating with Content Hub.

Video-specific flags: `--frame PATH` (starting image), `--model` (veo-3 /
veo-3-fast / veo-2; default random), `--aspect 16:9|9:16` (default 16:9),
`--dry-run` (print payload and exit without burning quota).

Video-specific error codes:

| code | what to do |
|---|---|
| `extend_failed` | A specific extend step timed out. Response includes `failed_at_index` (0-indexed prompt that failed) and `completed_prompts`. The Flow scene is kept for manual inspection. |
| `frame_invalid` | `--frame PATH` doesn't exist, isn't png/jpg, or Flow rejected the upload. |
```

Also add an entry to the CLI subcommands table earlier in the README:

Change:
```markdown
| Command | Purpose |
|---|---|
| `flow-cli daemon` | Start the HTTP daemon in the foreground (Ctrl+C to stop) |
| `flow-cli health` | Full daemon health JSON |
| `flow-cli status` | Short human-readable snapshot: `idle` or `busy: generating (Ns elapsed)` |
| `flow-cli generate [PROMPT] [flags]` | Generate an image. **Auto-starts the daemon if it's not running** |
| `flow-cli help` / `--help` / `-h` | Print help |
```

to:

```markdown
| Command | Purpose |
|---|---|
| `flow-cli daemon` | Start the HTTP daemon in the foreground (Ctrl+C to stop) |
| `flow-cli health` | Full daemon health JSON |
| `flow-cli status` | Short human-readable snapshot: `idle` or `busy: generating (Ns elapsed)` |
| `flow-cli generate [PROMPT] [flags]` | Generate an image. **Auto-starts the daemon if it's not running** |
| `flow-video-cli generate [PROMPT...] [flags]` | Generate a video (variadic prompts = chained extends). Uses the same daemon. |
| `flow-cli help` / `--help` / `-h` | Print help |
```

- [ ] **Step 2: Update `AGENTS.md`**

In `AGENTS.md`, update the "What this project is" section — change:

```markdown
`flow-daemon` is a Node.js HTTP daemon + CLI that drives
[Google Flow](https://labs.google/fx/tools/flow/) via Playwright to generate
AI images from text prompts.
```

to:

```markdown
`flow-daemon` is a Node.js HTTP daemon + TWO CLIs (`flow-cli` for images,
`flow-video-cli` for videos) that drive [Google Flow](https://labs.google/fx/tools/flow/)
via Playwright. The daemon is unified — one process, one Chromium, one FIFO
queue; jobs are discriminated by body shape (image vs video). Invariant #1
(single job at a time) still holds across both kinds.
```

Update the "Architecture one-pager" to reflect the split modules. Change the
module-responsibilities bullets to include:

- `bin/flow-cli.js` — image CLI (unchanged surface)
- `bin/flow-video-cli.js` — video CLI (variadic prompts + --frame + --model)
- `lib/browser.js` — shared Playwright/profile lifecycle, anti-detection init
- `lib/image.js` — image-mode runJob (renamed from lib/flow.js)
- `lib/video.js` — video-mode runJob (frame upload, extend loop, scene download)
- `lib/cli-shared.js` — daemon lifecycle + flag parsing shared by both CLIs
- `lib/selectors.js` — now three namespaces: `common`, `image`, `video`

Add a new entry under "When you're asked to change something":

```markdown
- **Adding a video selector:** put it in `lib/selectors.js` under the `video`
  namespace. Update the `test/mock-flow-video.html` fixture to match.
  Run `node --test test/video.test.js`.
- **Video generation fails `selector_missing`:** follow the same Flow-UI-drift
  playbook as images — kill daemon, open Chromium manually on the Flow
  project, inspect, update `lib/selectors.js`.
```

Add the video error codes to the error-code taxonomy:

```markdown
- `extend_failed` — a mid-chain clip didn't render. Response has
  `failed_at_index` and `completed_prompts`. No retry; the caller decides.
- `frame_invalid` — `--frame PATH` failed validation (missing file,
  non-image, or Flow rejected the upload).
```

- [ ] **Step 3: Run tests one more time as a sanity check**

```bash
npm test && node --test test/video.test.js
```

Expected: everything passes.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs: document flow-video-cli and the unified-daemon shape

README: new section for flow-video-cli with usage examples, flags, and
video-specific error codes (extend_failed, frame_invalid). Updated CLI
subcommand table.

AGENTS.md: update "What this project is" + architecture one-pager to
reflect the two-CLI, three-module (browser/image/video) split. Added
video-selector playbook entries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Live-Flow selector verification

**Goal:** Verify and update the `video.*` selectors against the real `labs.google/fx/tools/flow/...` DOM. This is the only task that spends real Flow quota.

**Files:**
- Modify: `lib/selectors.js` (iteratively, each change a separate commit)

**Protocol (per spec §9):**

- [ ] **Step 1: Start the dev preview server in the background**

```bash
node scripts/dev-preview-server.js &
PREVIEW_PID=$!
```

Keep the PID around so you can stop it at the end.

- [ ] **Step 2: Start the daemon (real Flow, not mock)**

```bash
node server.js &
DAEMON_PID=$!
sleep 3
```

This opens a Chromium window. Make sure you can see Flow's video project
page is loaded and you're logged in.

- [ ] **Step 3: For EACH of the following selectors, run the screenshot-confirm protocol:**

  - `selectors.video.videoModeTab`
  - `selectors.video.modelNames` (read from the model dropdown)
  - `selectors.video.aspectOption('16:9')` and `aspectOption('9:16')`
  - `selectors.video.extendButton`
  - `selectors.video.framesEntry`
  - `selectors.video.framePreview`
  - `selectors.video.downloadSceneButton`
  - Completion detection: confirm `<video>` elements get a real `src` when a
    clip finishes (vs. a placeholder/spinner while rendering).

  For each selector:
  1. Open the Chromium devtools in the running daemon's browser window.
  2. Locate the target element. Prefer stable attributes: `aria-label`,
     `data-testid`, `role`. Avoid class names — they rotate.
  3. Take a screenshot: in the devtools console, or by running a tiny
     Playwright script that calls `page.screenshot({ path: 'tmp/dev-preview/<name>.png' })`.
  4. Send the URL `https://mac-mini.tailf56d7b.ts.net:47399/<name>.png` to
     the user plus a one-line description of which element is highlighted.
  5. Wait for explicit confirmation ("yes, that's the Extend button").
  6. Update `lib/selectors.js` with the confirmed selector string.
  7. Commit immediately (one selector per commit):
     ```bash
     git add lib/selectors.js
     git commit -m "fix(selectors): video.<name> → <new selector>"
     ```

- [ ] **Step 4: After all selectors confirmed, run one real end-to-end generate**

Choose a varied, meaningful prompt (never "test", "hello", "a brain" — see
AGENTS.md anti-detection rules):

```bash
node bin/flow-video-cli.js generate "a weathered lighthouse at dusk, waves breaking on rocks, cinematic 16:9" --output /tmp/flow_video/live-smoke.mp4
```

Expected: the CLI prints the mp4 path after ~60-120s. File opens in
QuickTime and plays a real ~8-second video.

- [ ] **Step 5: Run one real 2-prompt chain to verify extend works**

```bash
node bin/flow-video-cli.js generate "a weathered lighthouse at dusk" "storm clouds roll in, waves grow bigger" --output /tmp/flow_video/live-extend.mp4
```

Expected: ~4-5 minutes total. Output is one ~16-second mp4 with a visible
continuous arc between clips.

- [ ] **Step 6: Stop the preview server and daemon**

```bash
kill $PREVIEW_PID $DAEMON_PID 2>/dev/null
```

- [ ] **Step 7: Final summary commit**

If any selectors were updated across multiple commits in Step 3, you may
want a final rollup or just leave them as a sequence. Either is fine; the
history is useful.

```bash
git log --oneline -20
```

Verify each selector update is visible in the log as its own commit.

---

## Final verification

- [ ] **Run the full test suite**

```bash
npm test && node --test test/video.test.js
```

Expected: all tests pass (at least 6 image + 7 video = 13 tests).

- [ ] **Verify the worktree state is clean**

```bash
git status
```

Expected: `nothing to commit, working tree clean`.

- [ ] **Check the commit log**

```bash
git log --oneline main..HEAD
```

Expected: ~15-20 commits, each with a clear scope (`refactor:`, `feat(video):`,
`docs:`, `chore:`). One commit per logical change.

- [ ] **Check global install works**

```bash
cd /Users/cuongnguyen/projects/flow-daemon/.worktrees/feat-video-cli
npm install -g .
which flow-video-cli
flow-video-cli --help
```

Expected: the CLI is on PATH, `--help` prints the full usage.

---

## Done. Merge criteria

- All unit tests pass on the mock fixture
- At least one real single-clip generation succeeded against real Flow
- At least one real 2+ prompt extend chain succeeded
- No regressions in the existing image flow (confirmed by passing image tests)
- README and AGENTS.md describe the new CLI
- No selector in `lib/selectors.js::video` is a guess — every one was verified
  against real Flow DOM via the screenshot-confirm protocol

When all criteria hold, this branch is ready to merge into `main`.
