#!/usr/bin/env node
// Dev-time: navigate to Flow, click into the newest <video> clip (the one
// we just generated), then investigate how to download it:
//   - Read the <video>.src and try fetching it via context.request.get
//   - Find + probe the real Download affordance
//   - Observe any modal that appears when Download is clicked
// Zero quota cost — just inspection.

const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { PROFILE_DIR } = require('../lib/browser');
const selectors = require('../lib/selectors');

const DEFAULT_URL = process.argv[2] ||
  'https://labs.google/fx/tools/flow/project/bcc73489-69d9-4621-974a-7168318a59d2';

const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'dev-preview');
fs.mkdirSync(OUT_DIR, { recursive: true });

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

async function shot(page, label) {
  const p = path.join(OUT_DIR, `${stamp()}-dl-${label}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  → ${path.basename(p)}`);
  return p;
}

async function main() {
  console.log(`[dl] opening ${DEFAULT_URL}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  await page.goto(DEFAULT_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(3000);

  // Click the first <video> clip (should be newest — the one we just generated).
  console.log('[dl] clicking first <video> clip...');
  try {
    await page.locator('video').first().click({ timeout: 5000, force: true });
  } catch (e) {
    console.log('[dl]   direct click failed, trying parent:', e.message);
    await page.locator('video').first().locator('xpath=..').click({ timeout: 5000 });
  }
  await page.waitForTimeout(3000);
  await shot(page, '01-clip-detail');

  // Read the <video>.src of whatever is now visible.
  const videoCount = await page.locator('video').count();
  console.log(`[dl] <video> elements in detail view: ${videoCount}`);
  for (let i = 0; i < Math.min(videoCount, 5); i += 1) {
    const src = await page.locator('video').nth(i).getAttribute('src');
    const curSrc = await page.locator('video').nth(i).evaluate((v) => v.currentSrc);
    console.log(`  video[${i}].src = ${JSON.stringify(src && src.slice(0, 140))}`);
    console.log(`  video[${i}].currentSrc = ${JSON.stringify(curSrc && curSrc.slice(0, 140))}`);
  }

  // Enumerate visible buttons on this page (for the real Download affordance).
  console.log('[dl] visible short-text buttons:');
  const buttons = await page.locator('button').all();
  const seen = [];
  for (const b of buttons) {
    if (!(await b.isVisible().catch(() => false))) continue;
    const text = (await b.textContent().catch(() => '')).trim();
    if (!text || text.length > 60) continue;
    seen.push({ b, text });
    console.log(`  btn: ${JSON.stringify(text)}`);
  }

  // Try the download selector we have and see what happens.
  const downloadSel = selectors.video.downloadSceneButton;
  console.log(`\n[dl] probing download selector: ${downloadSel}`);
  const dlCount = await page.locator(downloadSel).count();
  console.log(`[dl]   count: ${dlCount}`);
  if (dlCount > 0) {
    try {
      await page.locator(downloadSel).first().screenshot({
        path: path.join(OUT_DIR, `${stamp()}-dl-02-download-button.png`),
      });
      console.log(`[dl]   screenshotted the matching button`);
    } catch {}

    // Click it and see what happens. Use a downloadPromise race to catch
    // a download event OR a modal that appears.
    console.log('[dl] clicking Download button + watching for download event...');
    const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await page.locator(downloadSel).first().click();
    await page.waitForTimeout(2500);
    await shot(page, '03-after-download-click');

    const download = await downloadPromise;
    if (download) {
      const targetPath = path.join(OUT_DIR, `${stamp()}-probe-download.mp4`);
      try {
        await download.saveAs(targetPath);
        const size = fs.statSync(targetPath).size;
        console.log(`[dl]   DOWNLOAD EVENT FIRED — saved ${size} bytes to ${path.basename(targetPath)}`);
      } catch (e) {
        console.log(`[dl]   download.saveAs failed: ${e.message}`);
      }
    } else {
      console.log('[dl]   no download event fired within 8s');
      // Maybe a modal appeared — enumerate what's visible now.
      console.log('[dl]   visible buttons AFTER download click:');
      const buttonsPost = await page.locator('button').all();
      for (const b of buttonsPost) {
        if (!(await b.isVisible().catch(() => false))) continue;
        const text = (await b.textContent().catch(() => '')).trim();
        if (!text || text.length > 60) continue;
        console.log(`    btn: ${JSON.stringify(text)}`);
      }
    }
  }

  // Alternative: try fetching the <video>.src directly via context.request.
  console.log('\n[dl] trying direct src fetch via context.request.get...');
  const firstSrc = await page.locator('video').first().evaluate((v) => v.currentSrc || v.src);
  console.log(`[dl]   firstSrc = ${JSON.stringify(firstSrc && firstSrc.slice(0, 160))}`);
  if (firstSrc && firstSrc.startsWith('http')) {
    try {
      const resp = await context.request.get(firstSrc);
      console.log(`[dl]   HTTP fetch: ${resp.status()} ${resp.statusText ? resp.statusText() : ''}`);
      if (resp.ok()) {
        const body = await resp.body();
        const targetPath = path.join(OUT_DIR, `${stamp()}-probe-src-fetch.mp4`);
        fs.writeFileSync(targetPath, body);
        console.log(`[dl]   SRC FETCH worked — saved ${body.length} bytes to ${path.basename(targetPath)}`);
      }
    } catch (e) {
      console.log(`[dl]   src fetch threw: ${e.message}`);
    }
  } else if (firstSrc && firstSrc.startsWith('blob:')) {
    console.log('[dl]   src is a blob URL — cannot fetch directly; need a different strategy');
  }

  console.log(`\n[dl] done. Screenshots in ${OUT_DIR}`);
  console.log('[dl] leaving Chromium open. Ctrl+C to exit.');
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(`[dl] failed: ${e.message}`);
  process.exit(1);
});
