#!/usr/bin/env node
// Debug: after an extend chain completes, what does the page look like?
// Why does candidateSrcs.length === 0?
//
// Steps:
//  1. Navigate to the project.
//  2. Enumerate all <video> elements visible: count, src, currentSrc, parent tag.
//  3. Filter by the same rule the runJob uses (no gstatic/flow_camera).
//  4. Click the newest clip's parent to enter detail view.
//  5. Re-enumerate.

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

async function dumpVideos(page, label) {
  console.log(`\n[probe] <video> dump (${label}):`);
  const count = await page.locator(selectors.video.allVideos).count();
  console.log(`  total: ${count}`);
  for (let i = 0; i < Math.min(count, 20); i += 1) {
    const v = page.locator(selectors.video.allVideos).nth(i);
    const src = await v.getAttribute('src').catch(() => null);
    const cur = await v.evaluate((el) => el.currentSrc || '').catch(() => '');
    const vis = await v.isVisible().catch(() => false);
    const parent = await v.evaluate((el) => el.parentElement && el.parentElement.tagName).catch(() => null);
    console.log(`  [${i}] vis=${vis} parent=${parent}`);
    console.log(`      src=${JSON.stringify(src && src.slice(0, 140))}`);
    console.log(`      cur=${JSON.stringify(cur && cur.slice(0, 140))}`);
  }

  // Filter (same as runJob download step)
  const srcs = await page.$$eval(selectors.video.allVideos, (els) =>
    els.map((el) => el.currentSrc || el.src).filter((s) => !!s)
  );
  const candidates = srcs.filter((s) => !s.includes('gstatic.com') && !s.includes('/flow_camera/'));
  console.log(`  candidates after filter: ${candidates.length}`);
  candidates.slice(0, 5).forEach((c, i) => console.log(`    [${i}] ${c.slice(0, 120)}`));
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await ctx.newPage();
  await page.goto(FLOW_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT_DIR, `${stamp()}-postext-01-grid.png`) });

  await dumpVideos(page, 'project grid');

  // Click first clip
  console.log('\n[probe] clicking first <video>\'s parent...');
  const latestParent = page.locator(selectors.video.allVideos).first().locator('xpath=..');
  await latestParent.click({ force: true, timeout: 5000 }).catch(async () => {
    await page.locator(selectors.video.allVideos).first().locator('xpath=../..').click({ force: true, timeout: 5000 });
  });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT_DIR, `${stamp()}-postext-02-detail.png`) });

  await dumpVideos(page, 'detail view');

  console.log(`\n[probe] screenshots in ${OUT_DIR}`);
  await ctx.close();
})().catch((e) => {
  console.error(`[probe] ${e.message}`);
  process.exit(1);
});
