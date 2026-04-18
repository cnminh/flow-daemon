#!/usr/bin/env node
// Dev-time: launch Chromium headed against ~/.flow-daemon/profile/, navigate
// to the Flow video project URL, and for each lib/selectors.js::video.*
// selector try to locate a match. For each match: screenshot it. Dump
// everything into tmp/dev-preview/ so the user can inspect from the
// browser via the dev-preview-server.
//
// This spends ZERO Flow quota — it only reads the DOM, never clicks Create
// or Extend.
//
// Usage:
//   node scripts/dev-inspect-video.js [URL]
//
// Prereqs:
//   - The flow-daemon cannot be running (profile lock).
//   - You must already be logged into Google in the profile (from prior
//     flow-cli use). If you're not, the script takes a full-page screenshot
//     so you can see what state the page loaded into.

const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const selectors = require('../lib/selectors');
const { PROFILE_DIR } = require('../lib/browser');

const DEFAULT_URL = process.argv[2] ||
  'https://labs.google/fx/tools/flow/project/bcc73489-69d9-4621-974a-7168318a59d2';

const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'dev-preview');
fs.mkdirSync(OUT_DIR, { recursive: true });

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

async function probeSelector(page, name, selector) {
  const kind = typeof selector;
  const s = kind === 'function' ? null : selector;
  const safeName = name.replace(/[^a-z0-9]/gi, '_');
  const outPath = path.join(OUT_DIR, `${stamp()}-sel-${safeName}.png`);

  if (kind === 'function') {
    return { name, selector: '(function — needs arg)', count: null, outPath: null };
  }

  if (Array.isArray(selector)) {
    return { name, selector: '(array)', count: null, outPath: null };
  }

  try {
    const count = await page.locator(s).count();
    if (count === 0) {
      return { name, selector: s, count: 0, outPath: null };
    }
    const handle = await page.locator(s).first();
    await handle.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await handle.screenshot({ path: outPath }).catch(async () => {
      // Some elements can't be isolated-screenshotted (e.g. hidden inputs).
      // Fall back to a full-page shot with the bounding box annotated.
      await page.screenshot({ path: outPath, fullPage: false });
    });
    return { name, selector: s, count, outPath };
  } catch (e) {
    return { name, selector: s, count: 'ERROR', error: e.message, outPath: null };
  }
}

async function main() {
  console.log(`[inspect] profile: ${PROFILE_DIR}`);
  console.log(`[inspect] url:     ${DEFAULT_URL}`);
  console.log(`[inspect] output:  ${OUT_DIR}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  console.log('[inspect] navigating...');
  await page.goto(DEFAULT_URL, { waitUntil: 'networkidle', timeout: 60_000 });

  // Give Flow's React app a moment to paint the dynamic UI.
  await page.waitForTimeout(3000);

  // Always capture a full-page baseline so the user can see the actual UI state.
  const basePath = path.join(OUT_DIR, `${stamp()}-00-full-page.png`);
  await page.screenshot({ path: basePath, fullPage: true });
  console.log(`[inspect] full-page → ${path.basename(basePath)}`);

  // Also dump the mode-button's current label (lets us know if we're in Video
  // or Image mode) + whether the prompt input is present (login canary).
  const loggedIn = await page.locator(selectors.common.promptInput).count() > 0;
  const modeLabel = await page.locator(selectors.common.modeButton).textContent({ timeout: 2000 }).catch(() => null);
  console.log(`[inspect] logged_in=${loggedIn} modeLabel=${JSON.stringify(modeLabel && modeLabel.slice(0, 120))}`);

  console.log('\n[inspect] probing video selectors...');
  const results = [];
  for (const [name, sel] of Object.entries(selectors.video)) {
    const r = await probeSelector(page, name, sel);
    const tag = r.count === 0 ? 'MISS' : r.count === 'ERROR' ? 'ERR ' : `HIT (${r.count})`;
    const file = r.outPath ? ' → ' + path.basename(r.outPath) : '';
    console.log(`[inspect]   ${tag.padEnd(10)} video.${name.padEnd(20)} ${r.selector}${file}`);
    results.push(r);
  }

  // Also probe the common selectors, as a reality check.
  console.log('\n[inspect] probing common selectors...');
  for (const [name, sel] of Object.entries(selectors.common)) {
    const r = await probeSelector(page, `common-${name}`, sel);
    const tag = r.count === 0 ? 'MISS' : r.count === 'ERROR' ? 'ERR ' : `HIT (${r.count})`;
    const file = r.outPath ? ' → ' + path.basename(r.outPath) : '';
    console.log(`[inspect]   ${tag.padEnd(10)} common.${name.padEnd(20)} ${r.selector}${file}`);
  }

  console.log(`\n[inspect] ${OUT_DIR} — browse via http://127.0.0.1:47399/`);
  console.log('[inspect] leaving Chromium open for you to inspect. Ctrl+C to exit.');

  // Keep the process alive so the user can manually explore / click.
  await new Promise(() => {}); // never resolves
}

main().catch((e) => {
  console.error(`[inspect] failed: ${e.message}`);
  process.exit(1);
});
