#!/usr/bin/env node
// Dev-time: click Flow's mode button to open the settings popover, then
// screenshot and probe every visible tab/option inside. Identifies which
// selector pattern matches the real Video tab, model names, aspect options.
//
// Zero quota cost — opening the popover doesn't trigger generation.

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

async function probeAndShot(page, name, sel) {
  const safeName = name.replace(/[^a-z0-9]/gi, '_');
  const outPath = path.join(OUT_DIR, `${stamp()}-popover-${safeName}.png`);
  try {
    const count = await page.locator(sel).count();
    if (count === 0) return { name, sel, count: 0, outPath: null };
    await page.locator(sel).first().screenshot({ path: outPath });
    return { name, sel, count, outPath };
  } catch (e) {
    return { name, sel, count: 'ERR', error: e.message, outPath: null };
  }
}

async function main() {
  console.log(`[popover-probe] opening ${DEFAULT_URL}`);

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

  // Click the mode button (which we've confirmed is button:has-text("crop_16_9"))
  console.log('[popover-probe] clicking mode button...');
  await page.click(selectors.common.modeButton);
  await page.waitForTimeout(1500); // let popover animate in

  // Baseline: full-page screenshot with popover open
  const basePath = path.join(OUT_DIR, `${stamp()}-popover-00-full-page.png`);
  await page.screenshot({ path: basePath, fullPage: false });
  console.log(`[popover-probe] full-page → ${path.basename(basePath)}`);

  // Probe every flow_tab_slider_trigger button — this is the class the
  // existing image selector uses. Count how many match and dump each one.
  const sliderCount = await page.locator('button.flow_tab_slider_trigger').count();
  console.log(`[popover-probe] flow_tab_slider_trigger matches: ${sliderCount}`);
  for (let i = 0; i < sliderCount; i += 1) {
    const handle = page.locator('button.flow_tab_slider_trigger').nth(i);
    const text = (await handle.textContent().catch(() => '')).trim().slice(0, 80);
    const outPath = path.join(OUT_DIR, `${stamp()}-popover-slider-${i}-${text.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}.png`);
    try {
      await handle.screenshot({ path: outPath });
      console.log(`[popover-probe]   slider[${i}] "${text}" → ${path.basename(outPath)}`);
    } catch (e) {
      console.log(`[popover-probe]   slider[${i}] "${text}" (screenshot failed: ${e.message})`);
    }
  }

  // Try current video-namespace selectors (live-verify)
  console.log('\n[popover-probe] probing current video selectors:');
  const videoTabRes = await probeAndShot(page, 'videoModeTab', selectors.video.videoModeTab);
  console.log(`[popover-probe]   videoModeTab (${selectors.video.videoModeTab}): ${videoTabRes.count}${videoTabRes.outPath ? ' → ' + path.basename(videoTabRes.outPath) : ''}`);

  // Also try a few additional candidate patterns for safety
  const candidates = [
    ['video-tab-exact-text', 'button.flow_tab_slider_trigger:text-is("Video")'],
    ['video-tab-has-text', 'button:has-text("Video")'],
    ['frames-tab-text', 'button.flow_tab_slider_trigger:has-text("Frames")'],
    ['ingredients-tab', 'button.flow_tab_slider_trigger:has-text("Ingredients")'],
  ];
  for (const [name, sel] of candidates) {
    const r = await probeAndShot(page, name, sel);
    console.log(`[popover-probe]   ${name} (${sel}): ${r.count}${r.outPath ? ' → ' + path.basename(r.outPath) : ''}`);
  }

  // Also dump all buttons inside the popover area by label.
  // Heuristic: any button with a short text that's currently visible.
  console.log('\n[popover-probe] all visible buttons on the page (short-text only):');
  const buttons = await page.locator('button').all();
  let visible = 0;
  for (const b of buttons) {
    const isVis = await b.isVisible().catch(() => false);
    if (!isVis) continue;
    const text = (await b.textContent().catch(() => '')).trim();
    if (text.length === 0 || text.length > 40) continue;
    visible += 1;
    if (visible <= 40) {
      console.log(`[popover-probe]   btn: ${JSON.stringify(text)}`);
    }
  }
  console.log(`[popover-probe] total visible short-text buttons: ${visible}`);

  console.log(`\n[popover-probe] screenshots in ${OUT_DIR}`);
  console.log('[popover-probe] leaving Chromium open. Ctrl+C the process to exit.');
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(`[popover-probe] failed: ${e.message}`);
  process.exit(1);
});
