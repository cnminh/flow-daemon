const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const selectors = require('./selectors');

const DEFAULT_FLOW_URL = 'https://labs.google/fx/tools/flow/project/df1bcbae-00a1-4f8c-b95a-9964f15cfcb0';
const DEFAULT_TIMEOUT_MS = 180_000;
const PROFILE_DIR = path.join(
  require('node:os').homedir(),
  '.content-hub',
  'flow-profile'
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

// Remove stale Chromium singleton lock files. These get left behind when a
// Chromium exits uncleanly (e.g. the daemon was kill -9'd). On next launch
// Chromium refuses to start because the profile appears "in use". The lock
// is a symlink to `hostname-PID` — if that PID isn't running, it's safe to
// remove.
function cleanStaleProfileLock() {
  const lockPath = path.join(PROFILE_DIR, 'SingletonLock');
  try {
    const target = fs.readlinkSync(lockPath); // throws if missing
    // target looks like "hostname-12345"; extract the PID
    const m = target.match(/-(\d+)$/);
    if (m) {
      const pid = Number(m[1]);
      try {
        process.kill(pid, 0); // signal 0 = existence check, throws if dead
        // PID still alive — don't clean; the real Chromium is running
        return;
      } catch {
        // Process is gone; lock is stale
      }
    }
    // Remove lock + related singleton files
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.unlinkSync(path.join(PROFILE_DIR, name)); } catch {}
    }
    console.log('[flow-daemon] cleaned stale profile lock');
  } catch {
    // No lock to clean
  }
}

async function ensureContext() {
  if (browserContext) return browserContext;
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  cleanStaleProfileLock();
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

// Flow defaults to Video mode (Veo). We need Image mode to get stills.
// The mode button in the prompt bar shows the current selection — its
// text includes "Video" when in video mode, or the model name (e.g.
// "Nano Banana 2") when in image mode. Clicking it opens a popover with
// Image/Video/Frames/Ingredients tabs. We click "Image" and press Escape
// to close the popover.
//
// This is a no-op if we're already in image mode.
async function ensureImageMode(page) {
  const modeBtn = await page.waitForSelector(selectors.modeButton, { timeout: 3000 })
    .catch(() => null);
  if (!modeBtn) return; // UI variant without a mode toggle, or not yet loaded

  const label = (await modeBtn.textContent()) || '';
  if (!/Video/i.test(label)) {
    // Already in image mode (label shows model name like "Nano Banana 2")
    return;
  }

  await modeBtn.click();
  await humanPause(page, 400, 800);

  const imageTab = await page.waitForSelector(selectors.imageModeTab, { timeout: 3000 })
    .catch(() => null);
  if (imageTab) {
    await imageTab.click();
    await humanPause(page, 400, 800);
  }

  // Close the popover so it doesn't intercept clicks on the prompt input.
  await page.keyboard.press('Escape').catch(() => {});
  await humanPause(page, 300, 700);
}

async function runJob({ prompt, project_id, segment_id, rootDir, flowUrl, timeoutMs }) {
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

    // Switch Flow into Image mode (skip in test mode — the mock fixture
    // doesn't need this dance).
    if (!isMockFixture) {
      await ensureImageMode(page);
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

    // Type with humanized per-character delay (40-90ms jitter). Matches a
    // typing speed of roughly 60-100 WPM with natural variance.
    await page.keyboard.type(prompt, { delay: jitter(40, 90) });

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

    // Save to disk
    const relPath = path.join(
      'priv', 'uploads', 'video_projects',
      String(project_id), 'segments', String(segment_id), 'flow.png'
    );
    const absPath = path.join(rootDir, relPath);
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
