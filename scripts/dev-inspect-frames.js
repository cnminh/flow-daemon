#!/usr/bin/env node
// Dev-time: navigate to Flow, open mode popover, click the Frames tab,
// screenshot the resulting frames-to-video upload UI, and probe for the
// file input + preview selectors. Zero quota cost.

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

async function shot(page, label) {
  const p = path.join(OUT_DIR, `${stamp()}-frames-${label}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  full-page → ${path.basename(p)}`);
  return p;
}

async function enumerateButtons(page, label) {
  console.log(`[frames] visible buttons (${label}):`);
  const buttons = await page.locator('button').all();
  for (const b of buttons) {
    const isVis = await b.isVisible().catch(() => false);
    if (!isVis) continue;
    const text = (await b.textContent().catch(() => '')).trim();
    if (text.length === 0 || text.length > 60) continue;
    console.log(`  btn: ${JSON.stringify(text)}`);
  }
}

async function main() {
  console.log(`[frames] opening ${DEFAULT_URL}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  await page.goto(DEFAULT_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(3000);

  // Open popover + click Video first (so Frames tab becomes visible).
  await page.click(selectors.common.modeButton);
  await page.waitForTimeout(1500);
  await page.click(selectors.video.videoModeTab);
  await page.waitForTimeout(2000);

  // The popover may have closed after Video click. Re-open it.
  const modeStillVisible = await page.locator(selectors.common.modeButton).isVisible().catch(() => false);
  const framesVisible = await page.locator(selectors.video.framesTab).isVisible().catch(() => false);
  if (!framesVisible && modeStillVisible) {
    console.log('[frames] re-opening popover to expose Frames tab...');
    await page.click(selectors.common.modeButton);
    await page.waitForTimeout(1500);
  }
  await shot(page, '01-before-frames-click');

  // Click the Frames tab.
  const framesCount = await page.locator(selectors.video.framesTab).count();
  console.log(`[frames] framesTab (${selectors.video.framesTab}) matches: ${framesCount}`);
  if (framesCount === 0) {
    console.log('[frames] Frames tab not visible — aborting. Popover may need scrolling or different state.');
  } else {
    console.log('[frames] clicking Frames tab...');
    await page.locator(selectors.video.framesTab).first().click();
    await page.waitForTimeout(2500);
    await shot(page, '02-after-frames-click');

    // Close any lingering popover.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1000);
    await shot(page, '03-frames-mode-page');

    await enumerateButtons(page, 'frames mode');

    // Probe for file upload affordances and preview markers.
    console.log('[frames] probing for upload + preview affordances:');
    const candidates = [
      ['file-input', 'input[type="file"]'],
      ['upload-button', 'button:has-text("Upload")'],
      ['upload-image', 'button:has-text("uploadUpload image")'],
      ['add-media', 'button:has-text("Add Media")'],
      ['add-frame', 'button:has-text("frame")'],
      ['browse', 'button:has-text("Browse")'],
      ['drop-zone', '[data-testid*="drop"]'],
      ['data-frame-preview', '[data-frame-preview]'],
    ];
    for (const [name, sel] of candidates) {
      const c = await page.locator(sel).count();
      if (c > 0) {
        console.log(`[frames]   ${name} (${sel}): count=${c}`);
        try {
          const vis = await page.locator(sel).first().isVisible().catch(() => false);
          console.log(`[frames]     first visible: ${vis}`);
          if (vis) {
            await page.locator(sel).first().screenshot({
              path: path.join(OUT_DIR, `${stamp()}-frames-affordance-${name}.png`),
            }).catch(() => {});
          }
        } catch {}
      }
    }
  }

  console.log(`\n[frames] screenshots in ${OUT_DIR}`);
  console.log('[frames] leaving Chromium open. Ctrl+C to exit.');
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(`[frames] failed: ${e.message}`);
  process.exit(1);
});
