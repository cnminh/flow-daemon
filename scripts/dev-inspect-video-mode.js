#!/usr/bin/env node
// Dev-time: flip Flow into Video mode, then probe the video-specific UI:
// model dropdown names, aspect options, any new panels/entries that appear.
// Zero quota cost — just switches modes, doesn't click Create.

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

async function savePageShot(page, label) {
  const p = path.join(OUT_DIR, `${stamp()}-vmode-${label}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  full-page → ${path.basename(p)}`);
  return p;
}

async function main() {
  console.log(`[video-mode] opening ${DEFAULT_URL}`);

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

  // Step 1: open the popover and click the Video tab.
  console.log('[video-mode] opening mode popover...');
  await page.click(selectors.common.modeButton);
  await page.waitForTimeout(1500);
  await savePageShot(page, '01-popover-before-switch');

  console.log('[video-mode] clicking Video tab...');
  await page.click(selectors.video.videoModeTab);
  await page.waitForTimeout(2000);
  await savePageShot(page, '02-after-video-click-popover-still-open');

  // Check the modeButton label — should now indicate video mode.
  const labelAfter = await page.locator(selectors.common.modeButton).textContent().catch(() => null);
  console.log(`[video-mode] mode button label is now: ${JSON.stringify(labelAfter)}`);

  // Step 2: probe the model dropdown now that we're in video mode.
  // The dropdown trigger in image mode showed "Imagen 4arrow_drop_down".
  // In video mode it should be some Veo variant.
  const dropdownCandidates = [
    ['veo-3-fast', 'button:has-text("Veo 3 Fast")'],
    ['veo-3', 'button:has-text("Veo 3"):not(:has-text("Fast"))'],
    ['veo-2', 'button:has-text("Veo 2")'],
    ['any-dropdown', 'button:has-text("arrow_drop_down")'],
  ];
  console.log('[video-mode] probing model dropdown candidates:');
  for (const [name, sel] of dropdownCandidates) {
    const count = await page.locator(sel).count();
    console.log(`  ${name} (${sel}): ${count}`);
    if (count > 0) {
      const texts = await page.locator(sel).allTextContents();
      console.log(`    texts: ${JSON.stringify(texts.slice(0, 5))}`);
      try {
        await page.locator(sel).first().screenshot({
          path: path.join(OUT_DIR, `${stamp()}-vmode-dropdown-${name}.png`),
        });
      } catch {}
    }
  }

  // Step 3: re-enumerate all flow_tab_slider_trigger buttons (mode popover
  // re-renders in video mode; options may differ).
  await savePageShot(page, '03-video-popover-state');
  const sliderCount = await page.locator('button.flow_tab_slider_trigger').count();
  console.log(`[video-mode] flow_tab_slider_trigger matches now: ${sliderCount}`);
  for (let i = 0; i < sliderCount; i += 1) {
    const h = page.locator('button.flow_tab_slider_trigger').nth(i);
    const text = (await h.textContent().catch(() => '')).trim().slice(0, 80);
    console.log(`  slider[${i}] "${text}"`);
  }

  // Step 4: close popover (Escape) and look at page-level changes.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  await savePageShot(page, '04-popover-closed-in-video-mode');

  // Step 5: enumerate visible buttons now that we're in video mode (to find
  // Add Media / Frames-to-video entry points).
  console.log('[video-mode] visible short-text buttons on the page:');
  const buttons = await page.locator('button').all();
  for (const b of buttons) {
    const isVis = await b.isVisible().catch(() => false);
    if (!isVis) continue;
    const text = (await b.textContent().catch(() => '')).trim();
    if (text.length === 0 || text.length > 40) continue;
    console.log(`  btn: ${JSON.stringify(text)}`);
  }

  // Step 6: click "Add Media" to see if that exposes the frames-to-video UI.
  const addMediaSel = 'button:has-text("addAdd Media")';
  if (await page.locator(addMediaSel).count() > 0) {
    console.log('[video-mode] clicking Add Media...');
    await page.click(addMediaSel);
    await page.waitForTimeout(2000);
    await savePageShot(page, '05-after-add-media-click');

    // Enumerate anything that showed up.
    const postButtons = await page.locator('button').all();
    console.log('[video-mode] visible buttons after Add Media click:');
    for (const b of postButtons) {
      const isVis = await b.isVisible().catch(() => false);
      if (!isVis) continue;
      const text = (await b.textContent().catch(() => '')).trim();
      if (text.length === 0 || text.length > 60) continue;
      console.log(`  btn: ${JSON.stringify(text)}`);
    }
    // Close whatever opened.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
  } else {
    console.log('[video-mode] no "Add Media" button visible on this page.');
  }

  // Step 7: hover over the first existing <video> clip to see if extend/download
  // affordances appear.
  const videoCount = await page.locator('video').count();
  console.log(`[video-mode] existing <video> elements: ${videoCount}`);
  if (videoCount > 0) {
    try {
      await page.locator('video').first().scrollIntoViewIfNeeded();
      await page.locator('video').first().hover();
      await page.waitForTimeout(1500);
      await savePageShot(page, '06-hover-first-video');
    } catch (e) {
      console.log(`[video-mode] hover failed: ${e.message}`);
    }
  }

  console.log(`\n[video-mode] screenshots in ${OUT_DIR}`);
  console.log('[video-mode] leaving Chromium open. Ctrl+C to exit.');
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(`[video-mode] failed: ${e.message}`);
  process.exit(1);
});
