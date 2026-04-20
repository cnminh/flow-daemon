#!/usr/bin/env node
// Zero-quota test: exercise the NEW extend-click sequence against an
// existing clip. Clicks into the detail view, clicks Extend (which just
// opens the extend-prompt UI — no AI generation happens), verifies we
// reach the "ready to type extend prompt" state. Stops BEFORE Create.
//
// Proves the fix in lib/video.js commit 4636f59 works against real Flow
// without burning a single credit.

const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { PROFILE_DIR } = require('../lib/browser');
const selectors = require('../lib/selectors');

const FLOW_URL = 'https://labs.google/fx/tools/flow/project/bcc73489-69d9-4621-974a-7168318a59d2';

const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'dev-preview');
fs.mkdirSync(OUT_DIR, { recursive: true });

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

(async () => {
  console.log(`[ext-click] opening ${FLOW_URL}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  await page.goto(FLOW_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(3000);

  console.log('[ext-click] STEP 1: click newest <video>\'s parent to enter detail view');
  const latestClipParent = page.locator(selectors.video.allVideos).first().locator('xpath=..');
  try {
    await latestClipParent.click({ force: true, timeout: 5000 });
  } catch (e) {
    console.log(`  parent click failed (${e.message.slice(0, 80)}) — trying grandparent`);
    await page.locator(selectors.video.allVideos).first().locator('xpath=../..').click({ force: true, timeout: 5000 });
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT_DIR, `${stamp()}-extclick-01-detail-view.png`) });

  console.log('[ext-click] STEP 2: look for Extend button');
  const extCount = await page.locator(selectors.video.extendButton).count();
  const extVisible = extCount > 0 ? await page.locator(selectors.video.extendButton).first().isVisible().catch(() => false) : false;
  console.log(`  Extend button: count=${extCount} visible=${extVisible}`);
  if (!extVisible) {
    console.log('[ext-click] FAIL — no Extend button after detail-view click');
    await context.close();
    process.exit(1);
  }

  console.log('[ext-click] STEP 3: click Extend (opens extend-prompt UI, no AI)');
  await page.locator(selectors.video.extendButton).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT_DIR, `${stamp()}-extclick-02-after-extend-click.png`) });

  console.log('[ext-click] STEP 4: verify we\'re in "ready to type extend prompt" state');
  // Expect: prompt input visible + exactly one enabled Create button visible
  const promptVisible = await page.locator(selectors.common.promptInput).isVisible().catch(() => false);
  console.log(`  promptInput visible: ${promptVisible}`);

  // Diagnose the TWO Create buttons that live in extend mode. We want the
  // refined selector (:not([disabled])) to pick exactly one visible + enabled.
  const allCreateCount = await page.locator('button:has-text("arrow_forwardCreate")').count();
  const enabledCreateCount = await page.locator(selectors.common.generateButton).count();
  console.log(`  all Create buttons (enabled+disabled): ${allCreateCount}`);
  console.log(`  enabled Create buttons (refined selector): ${enabledCreateCount}`);
  if (enabledCreateCount === 1) {
    const h = page.locator(selectors.common.generateButton).first();
    const isVis = await h.isVisible().catch(() => false);
    const isEnabled = await h.isEnabled().catch(() => false);
    console.log(`  refined match: visible=${isVis} enabled=${isEnabled}`);
  }

  // Enumerate what's visible — to understand the post-Extend-click UI.
  console.log('\n[ext-click] visible short-text buttons in extend-prompt state:');
  const buttons = await page.locator('button').all();
  for (const b of buttons) {
    if (!(await b.isVisible().catch(() => false))) continue;
    const text = (await b.textContent().catch(() => '')).trim();
    if (!text || text.length > 60) continue;
    console.log(`  btn: ${JSON.stringify(text)}`);
  }

  if (promptVisible && enabledCreateCount === 1) {
    console.log('\n[ext-click] SUCCESS — extend-prompt UI is ready. Closing without clicking Create.');
  } else {
    console.log('\n[ext-click] PARTIAL — Extend clicked but UI state unclear. Inspect screenshots.');
  }

  await context.close();
  process.exit(0);
})().catch((e) => {
  console.error(`[ext-click] fatal: ${e.message}`);
  process.exit(1);
});
