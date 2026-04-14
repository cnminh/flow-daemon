const { chromium } = require('playwright');
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const selectors = require('./selectors');

const DEFAULT_FLOW_URL = 'https://labs.google/fx/tools/flow/project/bcc73489-69d9-4621-974a-7168318a59d2';
const DEFAULT_TIMEOUT_MS = 180_000;
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

// Test whether a PID is alive. Returns true for real live processes AND
// for processes we can't signal (EPERM) — we never want to touch those.
// Returns false only when the process is definitively gone (ESRCH).
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

// Handle whatever's in the profile's Singleton* files before launching a
// new Chromium. Chromium refuses to start if it sees these files left
// behind from a previous session. Four cases:
//
//   1. No lock              → nothing to do
//   2. Lock is a symlink to a dead PID        → stale, remove all 3 files
//   3. Lock is a symlink to a live PID that's
//      OUR orphan chromium (identified by
//      --user-data-dir=OUR_PROFILE in argv)   → SIGKILL the orphan, remove
//   4. Lock is a symlink to a live PID that
//      is NOT our chromium                    → throw profile_locked error,
//                                                 the user must close the
//                                                 other thing themselves
//
// This runs before every chromium.launchPersistentContext() call inside
// ensureContext(), but ensureContext() only launches once per daemon life,
// so in practice this runs at most once per `flow-cli daemon` invocation.
async function cleanStaleProfileLock() {
  const lockPath = path.join(PROFILE_DIR, 'SingletonLock');

  // Read the symlink. Handle the three possible failure modes of readlinkSync
  // explicitly rather than swallowing all errors (which was the previous bug:
  // orphan-with-live-PID looked the same as "no lock" in logs).
  let target;
  try {
    target = fs.readlinkSync(lockPath);
  } catch (e) {
    if (e.code === 'ENOENT') return; // case 1: no lock, clean profile
    if (e.code === 'EINVAL') {
      // Lock file exists but isn't a symlink — corrupt from a bad exit.
      // Remove it so Chromium can start; nothing to check against.
      try { fs.unlinkSync(lockPath); } catch {}
      console.log('[flow-daemon] removed malformed SingletonLock (not a symlink)');
      return;
    }
    throw e; // unexpected — surface
  }

  // target looks like "hostname-12345"
  const match = target.match(/-(\d+)$/);
  const pid = match ? parseInt(match[1], 10) : null;

  if (!pid) {
    removeLockFiles();
    console.log(`[flow-daemon] removed SingletonLock with unparseable target "${target}"`);
    return;
  }

  if (!pidAlive(pid)) {
    // case 2: stale lock from a previous run that died
    removeLockFiles();
    console.log(`[flow-daemon] cleared stale SingletonLock (PID ${pid} is dead)`);
    return;
  }

  // PID is alive. Is it an orphan Chromium from a previous daemon of ours?
  // Identify by whether the process's argv contains our profile dir.
  let cmdline = '';
  try {
    cmdline = execSync(`ps -p ${pid} -o command=`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // ps failed — can't inspect. Safer to bail out than risk killing the
    // wrong process.
  }

  const isOurOrphan = cmdline.includes(`--user-data-dir=${PROFILE_DIR}`);

  if (!isOurOrphan) {
    // case 4: something else is using the profile — not our business
    const err = new Error(
      `Profile ${PROFILE_DIR} is locked by PID ${pid} which is not our Chromium. ` +
      `Close it manually (kill -9 ${pid}) and retry. ` +
      `Offending command: ${cmdline.slice(0, 100) || 'unknown'}`
    );
    err.error_code = 'profile_locked';
    throw err;
  }

  // case 3: our orphan — SIGKILL it so we can reclaim the profile
  console.log(`[flow-daemon] found orphan Chromium PID ${pid} using our profile — SIGKILL'ing`);
  try { process.kill(pid, 'SIGKILL'); } catch {}

  // Wait up to 4s for the process (and its helpers) to actually exit before
  // touching the lock files — otherwise we'd race with Chromium's shutdown
  // cleanup and either leave bad files or delete ones Chrome was rewriting.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (pidAlive(pid)) {
    const err = new Error(`failed to kill orphan Chromium PID ${pid} within 4s`);
    err.error_code = 'profile_locked';
    throw err;
  }

  // Sweep any remaining chromium helper processes that might still hold
  // file descriptors inside the profile. Renderers/GPU processes usually
  // exit on their own when the main pid dies, but we belt-and-suspenders
  // this to keep disk state clean.
  try {
    execSync(`pkill -9 -f "user-data-dir=${PROFILE_DIR}"`, { stdio: 'ignore' });
  } catch {
    // pkill exits non-zero when there's nothing to kill — expected
  }

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

  // Anti-detection: remove navigator.webdriver flag that Playwright sets to
  // true by default. This is the single most common automation signal.
  await browserContext.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  browserContext.on('close', () => {
    browserContext = null;
  });
  return browserContext;
}

// Test-only: inject a custom Playwright context (e.g. a fresh context for each test).
async function ensureContextForUrl(flowUrl) {
  // For tests with file:// URLs, use an ephemeral context so we don't
  // pollute the real profile dir.
  if (flowUrl && flowUrl.startsWith('file://')) {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    ctx._ephemeral = true;
    return ctx;
  }
  return ensureContext();
}

async function findOrCreatePage(context, flowUrl) {
  const url = flowUrl || DEFAULT_FLOW_URL;
  const pages = context.pages();
  const existing = pages.find((p) => p.url().startsWith(url.split('?')[0]));
  if (existing) return existing;
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  return page;
}

// Flow defaults to Video mode (Veo) and x2 output count. We need Image mode
// to get stills, and we only download one result per job, so x1 output is
// both faster and 2-4x cheaper in quota.
//
// The mode button in the prompt bar shows the current selection — its text
// includes "Video" when in video mode, or the model name (e.g. "Nano Banana
// 2") when in image mode, followed by the aspect ratio and output count
// (e.g. "...crop_16_9x2"). Clicking it opens a popover with:
//   top:    Image/Video/Frames/Ingredients tabs
//   middle: aspect ratio options
//   bottom: output count (x1/x2/x3/x4)
//
// This function opens the popover once, flips whichever settings are wrong,
// then presses Escape to close it. If nothing needs changing, it's a no-op.
async function ensureImageModeAndCount(page, desiredCount = 1) {
  const modeBtn = await page.waitForSelector(selectors.modeButton, { timeout: 3000 })
    .catch(() => null);
  if (!modeBtn) return; // UI variant without a mode toggle, or not yet loaded

  const label = (await modeBtn.textContent()) || '';
  const inImageMode = !/Video/i.test(label);
  // The "xN" suffix in the label reflects the current count.
  const countMatch = label.match(/x(\d+)\b/);
  const currentCount = countMatch ? parseInt(countMatch[1], 10) : null;
  const countOK = currentCount === desiredCount;

  if (inImageMode && countOK) return;

  // Longer pauses around the settings flips (1.2–2.5s) — previous 400–800ms
  // was fast enough that Google flagged the session as "unusual activity"
  // when combined with quick typing. Real users glance at each option
  // before clicking.
  await modeBtn.click();
  await humanPause(page, 1200, 2500);

  if (!inImageMode) {
    const imageTab = await page.waitForSelector(selectors.imageModeTab, { timeout: 3000 })
      .catch(() => null);
    if (imageTab) {
      await imageTab.click();
      await humanPause(page, 1200, 2500);
    }
  }

  if (!countOK) {
    const countTab = await page.waitForSelector(selectors.countTab(desiredCount), { timeout: 3000 })
      .catch(() => null);
    if (countTab) {
      await countTab.click();
      await humanPause(page, 1200, 2500);
    }
  }

  // Close the popover so it doesn't intercept clicks on the prompt input.
  await page.keyboard.press('Escape').catch(() => {});
  await humanPause(page, 800, 1600);
}

// Back-compat alias. Older callers (including the in-repo runJob below)
// transition to the new name; any external wrappers can keep using this.
const ensureImageMode = (page) => ensureImageModeAndCount(page, 1);

async function runJob({ prompt, project_id, segment_id, output_path, rootDir, flowUrl, timeoutMs }) {
  if (!rootDir) throw new Error('rootDir required');
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;

  const context = await ensureContextForUrl(flowUrl);
  const isMockFixture = flowUrl && flowUrl.startsWith('file://');

  try {
    const page = await findOrCreatePage(context, flowUrl);

    // Login check: prompt input must be present
    const input = await page.waitForSelector(selectors.promptInput, { timeout: 5000 })
      .catch(() => null);
    if (!input) {
      const err = new Error('prompt input not found — not logged in?');
      err.error_code = 'not_logged_in';
      throw err;
    }

    // Switch Flow into Image mode + x1 output count (skip in test mode —
    // the mock fixture doesn't have the mode/count popover).
    if (!isMockFixture) {
      await ensureImageModeAndCount(page, 1);
    }

    // Snapshot the set of image src URLs BEFORE submission. After submission
    // we'll poll for new srcs. Flow sets img.alt to the prompt (truncated)
    // which isn't a stable detection signal, but src is unique per image.
    const beforeSrcs = new Set(
      await page.$$eval(selectors.allImages, (els) => els.map((el) => el.src))
    );

    // Humanized pause before interacting (like a user reading the page).
    await humanPause(page, 600, 1500);

    // Clear the input and type the new prompt. The keyboard dance handles
    // cross-platform select-all: Meta+A works on macOS, Control+A on
    // Linux/Windows. Each .catch() ignores the failing accelerator so the
    // surviving platform's key combo wins.
    await input.click();
    await page.keyboard.press('Meta+A').catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});

    // Type the prompt. Against real Flow we use a per-CHARACTER random delay
    // (120-270ms jitter, ~30 WPM) so Google's keystroke detector sees
    // human-like variance — Playwright's built-in { delay: N } uses a fixed
    // N for the whole string which got us flagged as "unusual activity".
    // Against the mock fixture (file:// URL) we type instantly since a
    // static HTML page can't detect us and long prompts would blow past
    // test timeouts (150 chars × 200ms = 30s of pure typing).
    if (isMockFixture) {
      await page.keyboard.type(prompt);
    } else {
      for (const ch of prompt) {
        await page.keyboard.type(ch);
        await page.waitForTimeout(jitter(120, 270));
      }
    }

    // Pause between finishing typing and clicking Create (like a human
    // proofreading their prompt before submitting).
    await humanPause(page, 1000, 2500);

    // Submit
    const genBtn = await page.waitForSelector(selectors.generateButton, { timeout: 3000 });
    await genBtn.click();

    // Wait for a new image src to appear (any img whose src wasn't in the
    // before-snapshot).
    let newSrc = null;
    try {
      newSrc = await page.waitForFunction(
        ({ selector, beforeArray }) => {
          const before = new Set(beforeArray);
          for (const el of document.querySelectorAll(selector)) {
            if (el.src && !before.has(el.src)) return el.src;
          }
          return null;
        },
        { selector: selectors.allImages, beforeArray: [...beforeSrcs] },
        { timeout }
      );
      newSrc = await newSrc.jsonValue();
    } catch (e) {
      const err = new Error('timeout waiting for outputs');
      err.error_code = 'timeout';
      throw err;
    }

    if (!newSrc || typeof newSrc !== 'string') {
      const err = new Error('no new image src found');
      err.error_code = 'selector_missing';
      throw err;
    }

    // Download the image bytes
    let bytes;
    if (newSrc.startsWith('data:')) {
      const base64 = newSrc.split(',', 2)[1];
      bytes = Buffer.from(base64, 'base64');
    } else {
      const resp = await context.request.get(newSrc);
      if (!resp.ok()) {
        const err = new Error(`image download failed: ${resp.status()}`);
        err.error_code = 'network';
        throw err;
      }
      bytes = await resp.body();
    }

    // Resolve target path. Callers can either supply an explicit output_path
    // (absolute or relative to rootDir) or fall back to the legacy Content
    // Hub pattern priv/uploads/video_projects/<project>/segments/<segment>.
    let relPath, absPath;
    if (output_path) {
      if (path.isAbsolute(output_path)) {
        absPath = output_path;
        relPath = output_path;
      } else {
        relPath = output_path;
        absPath = path.join(rootDir, output_path);
      }
    } else {
      relPath = path.join(
        'priv', 'uploads', 'video_projects',
        String(project_id), 'segments', String(segment_id), 'flow.png'
      );
      absPath = path.join(rootDir, relPath);
    }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, bytes);

    return { image_path: relPath };
  } finally {
    if (context._ephemeral) await context.browser().close();
  }
}

async function closeBrowser() {
  if (browserContext) {
    try {
      await browserContext.close();
    } catch {}
    browserContext = null;
  }
}

module.exports = { runJob, ensureContext, closeBrowser, PROFILE_DIR };
