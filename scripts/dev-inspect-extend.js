#!/usr/bin/env node
// Debug the Extend button after a clip has been generated. Navigates into
// the pho cart clip (our recently-failed extend attempt's clip 1), looks
// for the Extend button, enumerates visible buttons, screenshots the
// action bar. Zero quota cost.
//
// Theory: after runJob creates clip 1 and waitForFunction returns on the
// new <video>, the page state may NOT include the Extend button because
// Flow hasn't transitioned to the clip detail view yet — or the button
// appears on a specific interaction (hover / click on the clip).

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

async function enumerateButtons(page, label) {
  console.log(`\n[ext] visible buttons (${label}):`);
  const buttons = await page.locator('button').all();
  for (const b of buttons) {
    if (!(await b.isVisible().catch(() => false))) continue;
    const text = (await b.textContent().catch(() => '')).trim();
    if (!text || text.length > 60) continue;
    console.log(`  btn: ${JSON.stringify(text)}`);
  }
}

async function main() {
  console.log(`[ext] opening ${FLOW_URL}`);
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
  await page.screenshot({ path: path.join(OUT_DIR, `${stamp()}-ext-01-grid.png`) });

  await enumerateButtons(page, 'project grid');

  // Look at Extend right now (from grid). Probably not visible.
  const extGridCount = await page.locator(selectors.video.extendButton).count();
  const extGridVis = extGridCount > 0 ? await page.locator(selectors.video.extendButton).first().isVisible().catch(() => false) : false;
  console.log(`[ext] Extend button on grid: count=${extGridCount}, visible=${extGridVis}`);

  // Click the first <video> clip (newest — pho cart prep).
  console.log('[ext] clicking first <video> clip...');
  await page.locator('video').first().click({ force: true, timeout: 5000 }).catch(async (e) => {
    console.log(`  direct click: ${e.message.slice(0,80)} — trying parent`);
    await page.locator('video').first().locator('xpath=..').click({ force: true, timeout: 5000 });
  });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(OUT_DIR, `${stamp()}-ext-02-after-click.png`) });

  await enumerateButtons(page, 'after click on clip');

  // Now probe Extend.
  const extCount = await page.locator(selectors.video.extendButton).count();
  console.log(`\n[ext] Extend button count: ${extCount}`);
  if (extCount > 0) {
    for (let i = 0; i < extCount; i += 1) {
      const handle = page.locator(selectors.video.extendButton).nth(i);
      const text = await handle.textContent().catch(() => '');
      const visible = await handle.isVisible().catch(() => false);
      const box = await handle.boundingBox().catch(() => null);
      console.log(`[ext]   [${i}] text=${JSON.stringify(text.slice(0, 60))} visible=${visible} bbox=${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}` : 'null'}`);
      if (visible) {
        try {
          await handle.screenshot({ path: path.join(OUT_DIR, `${stamp()}-ext-03-button-${i}.png`) });
        } catch {}
      }
    }
  } else {
    console.log('[ext] No Extend button — checking alt selectors...');
    const alts = [
      ['add_to-Extend', 'button:has-text("keyboard_double_arrow_rightExtend")'],
      ['just-Extend-word', 'button:text-is("Extend")'],
      ['aria-extend', '[aria-label*="Extend" i]'],
      ['data-extend', '[data-testid*="extend" i]'],
    ];
    for (const [name, sel] of alts) {
      const c = await page.locator(sel).count();
      console.log(`[ext]   ${name} (${sel}): ${c}`);
    }
  }

  // Also try hovering over the clip.
  try {
    await page.locator('video').first().hover();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT_DIR, `${stamp()}-ext-04-after-hover.png`) });
    const extHover = await page.locator(selectors.video.extendButton).count();
    console.log(`[ext] Extend after hover: count=${extHover}`);
  } catch (e) {
    console.log(`[ext] hover failed: ${e.message}`);
  }

  console.log(`\n[ext] done. Screenshots in ${OUT_DIR}`);
  await context.close();
}

main().catch((e) => {
  console.error(`[ext] fatal: ${e.message}`);
  process.exit(1);
});
