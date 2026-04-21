#!/usr/bin/env node
// End-to-end probe of Flow's frames-to-video upload path. Mirrors what
// lib/video.js::uploadFirstFrame does against real Flow, plus extra
// time-series screenshots and DOM enumeration so you can eyeball what
// Flow renders at each step. Use when the upload breaks after a Flow
// UI change and you need to identify which selector drifted.
//
// Sequence: enter Frames sub-mode → click Start slot → scroll library
// to bottom → click "Upload image" → click "I agree" (first-time only)
// → Playwright intercepts native file chooser → setFiles → wait 15s
// with 5 spaced screenshots while Flow processes the upload → Escape.
//
// Zero quota cost — no Create click.

const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const selectors = require('../lib/selectors');
const { PROFILE_DIR } = require('../lib/browser');

const URL = process.argv[2] ||
  'https://labs.google/fx/tools/flow/project/bcc73489-69d9-4621-974a-7168318a59d2';
const FRAME_FILE = process.argv[3] || '/tmp/flow_content/bo-charD-1776749060.png';

const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'dev-preview');

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

async function shot(page, label) {
  const p = path.join(OUT_DIR, `${stamp()}-frame-upload-${label}.png`);
  await page.screenshot({ path: p, fullPage: true });
  console.log(`  [shot] ${path.basename(p)}`);
}

async function enumerateImgsWithAlt(page, label) {
  console.log(`[probe] img elements visible (${label}):`);
  const imgs = await page.locator('img').all();
  let n = 0;
  for (const img of imgs) {
    const vis = await img.isVisible().catch(() => false);
    if (!vis) continue;
    const alt = (await img.getAttribute('alt').catch(() => '')) || '';
    const src = (await img.getAttribute('src').catch(() => '')) || '';
    if (!alt && !src.startsWith('blob:') && !src.startsWith('data:')) continue;
    console.log(`  img[${n}] alt=${JSON.stringify(alt.slice(0, 50))} src=${src.slice(0, 80)}`);
    n += 1;
    if (n > 10) { console.log('  … truncated'); break; }
  }
}

async function main() {
  if (!fs.existsSync(FRAME_FILE)) {
    console.error(`[probe] FRAME_FILE missing: ${FRAME_FILE}`);
    process.exit(1);
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(3000);

  // Enter Frames sub-mode.
  await page.click(selectors.common.modeButton);
  await page.waitForTimeout(1500);
  await page.click(selectors.video.videoModeTab);
  await page.waitForTimeout(2000);
  const framesVisible = await page.locator(selectors.video.framesTab).isVisible().catch(() => false);
  if (!framesVisible) {
    await page.click(selectors.common.modeButton);
    await page.waitForTimeout(1500);
  }
  await page.locator(selectors.video.framesTab).first().click();
  await page.waitForTimeout(2000);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1500);

  // Click Start + scroll.
  await page.locator('text=/^Start$/').first().click();
  await page.waitForTimeout(2500);
  for (let pass = 0; pass < 3; pass += 1) {
    await page.evaluate(() => {
      document.querySelectorAll('*').forEach((el) => {
        if (el.scrollHeight > el.clientHeight + 20) el.scrollTop = el.scrollHeight;
      });
    });
    await page.waitForTimeout(1200);
  }

  // Click Upload image with filechooser listener armed.
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 25_000 }).catch(() => null);
  await page.locator('text=/^Upload image$/i').first().click();
  await page.waitForTimeout(2000);

  // Click I agree if it appears.
  const agreeBtn = await page.locator('button:has-text("I agree")').first();
  const agreeVis = await agreeBtn.isVisible().catch(() => false);
  if (agreeVis) {
    console.log('[probe] clicking "I agree"');
    await agreeBtn.click();
    await page.waitForTimeout(1500);
  }

  // Wait for chooser + set file.
  const chooser = await chooserPromise;
  if (!chooser) {
    console.log('[probe] filechooser did not fire — aborting');
    await new Promise(() => {});
    return;
  }
  console.log('[probe] setting file...');
  await chooser.setFiles(FRAME_FILE);
  console.log('[probe] waiting + shooting every 3s for 15s...');

  // Time-series shots while Flow processes the upload.
  for (let i = 1; i <= 5; i += 1) {
    await page.waitForTimeout(3000);
    await shot(page, `tseries-${String(i * 3).padStart(2, '0')}s-post-setfiles`);
  }

  await enumerateImgsWithAlt(page, 'post-upload-all-imgs-with-alt');

  // Try closing any remaining modal with Escape + screenshot the Frames
  // panel state afterwards.
  console.log('[probe] pressing Escape to close any remaining modal...');
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(2500);
  await shot(page, 'final-after-escape');

  await enumerateImgsWithAlt(page, 'after-escape-visible-imgs');

  console.log(`\n[probe] shots in ${OUT_DIR}`);
  console.log('[probe] leaving Chromium open.');
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(`[probe] failed: ${e.message}`);
  process.exit(1);
});
