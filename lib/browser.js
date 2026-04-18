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
