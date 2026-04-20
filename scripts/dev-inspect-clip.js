#!/usr/bin/env node
// Dev-time: enumerate video model options, then navigate into an existing
// rendered clip to find the Extend + Download Scene affordances.
// Zero quota cost — no Create/Extend clicks.

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
  const p = path.join(OUT_DIR, `${stamp()}-clip-${label}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  full-page → ${path.basename(p)}`);
  return p;
}

async function enumerateButtons(page, label) {
  console.log(`[clip] visible buttons (${label}):`);
  const buttons = await page.locator('button').all();
  const seen = [];
  for (const b of buttons) {
    const isVis = await b.isVisible().catch(() => false);
    if (!isVis) continue;
    const text = (await b.textContent().catch(() => '')).trim();
    if (text.length === 0 || text.length > 60) continue;
    seen.push(text);
  }
  for (const t of seen) console.log(`  btn: ${JSON.stringify(t)}`);
  return seen;
}

async function main() {
  console.log(`[clip] opening ${DEFAULT_URL}`);

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

  // Flip to Video mode.
  await page.click(selectors.common.modeButton);
  await page.waitForTimeout(1500);
  await page.click(selectors.video.videoModeTab);
  await page.waitForTimeout(2000);

  // The popover is likely still open. Click the model dropdown to enumerate.
  console.log('[clip] clicking the model dropdown (Veo 3.1 - Quality)...');
  const dropdownSel = 'button:has-text("arrow_drop_down")';
  const dropdownCount = await page.locator(dropdownSel).count();
  if (dropdownCount > 0) {
    await page.locator(dropdownSel).first().click();
    await page.waitForTimeout(1500);
    await savePageShot(page, '01-model-dropdown-open');

    // Enumerate option-like entries.
    const optionSelectors = [
      '[role="option"]',
      '[role="menuitem"]',
      'li',
    ];
    for (const osel of optionSelectors) {
      const count = await page.locator(osel).count();
      if (count === 0) continue;
      const texts = await page.locator(osel).allTextContents();
      const visibleTexts = [];
      for (let i = 0; i < count; i += 1) {
        const isVis = await page.locator(osel).nth(i).isVisible().catch(() => false);
        if (isVis) visibleTexts.push(texts[i].trim());
      }
      if (visibleTexts.length > 0) {
        console.log(`[clip]   ${osel}: ${JSON.stringify(visibleTexts)}`);
      }
    }

    // Close the dropdown + popover.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  } else {
    console.log('[clip] no model dropdown visible — was the popover still open?');
  }

  // Back to the project grid so we can see all clips (previously we may have
  // been redirected into a specific one). Navigate back.
  await savePageShot(page, '02-after-dropdown-probe');

  // Go back to the grid URL explicitly in case navigation happened.
  await page.goto(DEFAULT_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(3000);

  // Find the first <video> element — these are clips in the grid. Click it.
  const videoCount = await page.locator('video').count();
  console.log(`[clip] <video> elements on grid: ${videoCount}`);
  if (videoCount === 0) {
    console.log('[clip] no video clips on this page; cannot inspect detail view.');
  } else {
    // Click a video clip's parent (usually the wrapping <a> or <button>).
    // Try the video itself first, then fall back to clicking its container.
    console.log('[clip] clicking first video clip...');
    try {
      await page.locator('video').first().scrollIntoViewIfNeeded();
      await page.locator('video').first().click({ timeout: 3000 });
    } catch (e) {
      console.log(`[clip]   direct video click failed: ${e.message} — trying parent`);
      try {
        const parent = page.locator('video').first().locator('xpath=..');
        await parent.click({ timeout: 3000 });
      } catch (e2) {
        console.log(`[clip]   parent click failed too: ${e2.message}`);
      }
    }
    await page.waitForTimeout(3000);
    await savePageShot(page, '03-clip-detail-view');

    // Enumerate the buttons now visible on the clip detail page.
    const seen = await enumerateButtons(page, 'clip detail');

    // Probe for Extend + Download-scene candidates.
    console.log('[clip] probing for Extend + Download affordances:');
    const candidates = [
      ['extend-has-text', 'button:has-text("Extend")'],
      ['extend-case-insensitive', 'button:text-matches("extend", "i")'],
      ['add_to-extend', 'button:has-text("add_toExtend")'],
      ['download-has-text', 'button:has-text("Download")'],
      ['download-scene', 'button:has-text("Download scene")'],
      ['download-video', 'button:has-text("Download video")'],
      ['download-icon', 'button:has-text("download")'],
      ['scenebuilder', 'button:has-text("Scenebuilder")'],
      ['play_movies', 'button:has-text("play_moviesScenebuilder")'],
    ];
    for (const [name, sel] of candidates) {
      const c = await page.locator(sel).count();
      if (c > 0) {
        const texts = await page.locator(sel).allTextContents();
        const visible = [];
        for (let i = 0; i < c; i += 1) {
          const isVis = await page.locator(sel).nth(i).isVisible().catch(() => false);
          if (isVis) visible.push(texts[i].trim());
        }
        console.log(`[clip]   ${name} (${sel}): count=${c}, visible=${visible.length}`);
        if (visible.length > 0) {
          try {
            await page.locator(sel).first().screenshot({
              path: path.join(OUT_DIR, `${stamp()}-clip-affordance-${name}.png`),
            });
          } catch {}
        }
      }
    }

    // Also try hovering over the clip (maybe affordances appear on hover).
    try {
      await page.locator('video').first().hover();
      await page.waitForTimeout(1000);
      await savePageShot(page, '04-video-hover');
      await enumerateButtons(page, 'after hover');
    } catch (e) {
      console.log(`[clip] hover failed: ${e.message}`);
    }

    // Try clicking the "Scenebuilder" button which might expose extend.
    const scenebuilderSel = 'button:has-text("play_moviesScenebuilder")';
    if (await page.locator(scenebuilderSel).count() > 0) {
      console.log('[clip] clicking Scenebuilder...');
      await page.locator(scenebuilderSel).click();
      await page.waitForTimeout(3000);
      await savePageShot(page, '05-scenebuilder');
      await enumerateButtons(page, 'scenebuilder view');
    }
  }

  console.log(`\n[clip] screenshots in ${OUT_DIR}`);
  console.log('[clip] leaving Chromium open. Ctrl+C to exit.');
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(`[clip] failed: ${e.message}`);
  process.exit(1);
});
