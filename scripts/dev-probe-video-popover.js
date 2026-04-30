#!/usr/bin/env node
// Probe Flow's mode popover IN VIDEO MODE — dump all visible button texts
// inside the popover. Used to find the actual selector for the x1 (output
// count) tab in video mode. Zero credit cost (no Create click).
//
// Usage:
//   node scripts/dev-probe-video-popover.js [URL]

const { chromium } = require('playwright');
const path = require('node:path');
const { PROFILE_DIR } = require('../lib/browser');
const selectors = require('../lib/selectors');

const URL = process.argv[2] || 'https://labs.google/fx/tools/flow';

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const [page] = ctx.pages();
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  console.log(`[probe] loaded ${URL}`);

  const modeBtn = await page.waitForSelector(selectors.common.modeButton, { timeout: 10000 });
  const label = (await modeBtn.textContent()) || '';
  console.log(`[probe] mode button label: ${JSON.stringify(label)}`);

  // Make sure we're in video mode first.
  if (!/^Video/.test(label)) {
    await modeBtn.click();
    await page.waitForTimeout(1500);
    const videoTab = await page.waitForSelector(selectors.video.videoModeTab, { timeout: 5000 }).catch(() => null);
    if (videoTab) { await videoTab.click(); await page.waitForTimeout(1500); }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(800);
  }

  // Re-open popover and enumerate buttons.
  await modeBtn.click();
  await page.waitForTimeout(1500);

  const shotPath = path.resolve(__dirname, '..', 'tmp', 'dev-preview', 'video-popover-' + Date.now() + '.png');
  await page.screenshot({ path: shotPath, fullPage: true });
  console.log(`[probe] screenshot: ${shotPath}`);

  // Enumerate flow_tab_slider_trigger buttons.
  console.log('\n=== flow_tab_slider_trigger (visible) ===');
  const triggers = await page.locator('button.flow_tab_slider_trigger').all();
  for (const b of triggers) {
    if (!(await b.isVisible().catch(() => false))) continue;
    const t = ((await b.textContent().catch(() => '')) || '').trim();
    const aria = (await b.getAttribute('aria-label').catch(() => '')) || '';
    const title = (await b.getAttribute('title').catch(() => '')) || '';
    console.log(`  text=${JSON.stringify(t)}  aria=${JSON.stringify(aria)}  title=${JSON.stringify(title)}`);
  }

  // Also enumerate any element with text matching x<digit>.
  console.log('\n=== anything containing /^x\\d+$/ or /^\\d+x?$/ text ===');
  const all = await page.locator('text=/^x?\\d+x?$/').all();
  for (const e of all) {
    if (!(await e.isVisible().catch(() => false))) continue;
    const t = ((await e.textContent().catch(() => '')) || '').trim();
    const tag = await e.evaluate((n) => n.tagName + (n.className ? '.' + n.className.split(' ').slice(0,2).join('.') : '')).catch(() => '?');
    console.log(`  ${tag}: ${JSON.stringify(t)}`);
  }

  // Verify the new countTab selector resolves.
  console.log('\n=== verifying selectors.video.countTab(1) ===');
  const sel1 = selectors.video.countTab(1);
  console.log(`  selector: ${sel1}`);
  const m1 = await page.locator(sel1).count();
  console.log(`  matches: ${m1}`);
  if (m1 > 0) {
    const t1 = await page.locator(sel1).first().textContent();
    console.log(`  first match text: ${JSON.stringify(t1)}`);
  }

  console.log('\n=== closing popover ===');
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  await ctx.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
