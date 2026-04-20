const { chromium } = require('playwright');
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_FLOW_URL = 'https://labs.google/fx/tools/flow/project/bcc73489-69d9-4621-974a-7168318a59d2';
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
