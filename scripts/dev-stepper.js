#!/usr/bin/env node
// Interactive step-by-step Playwright harness for the flow-video-cli live
// test. Launches Chromium once, navigates to Flow, then WAITS for commands
// written to /tmp/flow-stepper.cmd. Each command executes a single action,
// takes a screenshot, and writes the result to /tmp/flow-stepper.out.
//
// Commands (one per line):
//   ensure-video [MODEL]      open popover → Video tab → pick MODEL → close
//                             (MODEL defaults to "Veo 3.1 - Quality")
//   type TEXT                 humanized type into prompt input
//   click-create              click the enabled Create button (QUOTA SPENT)
//   wait-clip                 wait up to 180s for a new <video> to appear
//   click-latest-clip         click newest <video>'s parent → detail view
//   click-extend              click Extend button (NO quota; opens extend UI)
//   nav-grid                  navigate back to project URL (grid view)
//   download [PATH]           fetch newest <video>.currentSrc, save to PATH
//                             (default: tmp/dev-preview/stepper-<ts>.mp4)
//   shot                      just take a screenshot (no action)
//   exit                      close browser and exit
//
// Screenshots land in tmp/dev-preview/ so they're served by the preview
// server and can be displayed inline in the chat.

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const selectors = require('../lib/selectors');
const { PROFILE_DIR } = require('../lib/browser');

const CMD_FILE = '/tmp/flow-stepper.cmd';
const OUT_FILE = '/tmp/flow-stepper.out';
const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'dev-preview');
const PROJECT_URL = 'https://labs.google/fx/tools/flow/project/bcc73489-69d9-4621-974a-7168318a59d2';

fs.mkdirSync(OUT_DIR, { recursive: true });

let page, context;
let stepNum = 0;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function stamp() {
  stepNum += 1;
  return String(stepNum).padStart(2, '0');
}

async function shot(label) {
  const name = `stepper-${stamp()}-${label.replace(/[^a-z0-9]/gi, '_')}.png`;
  const p = path.join(OUT_DIR, name);
  await page.screenshot({ path: p, fullPage: false });
  return name;
}

async function handle(line) {
  const idx = line.indexOf(' ');
  const name = idx < 0 ? line : line.slice(0, idx);
  const arg = idx < 0 ? '' : line.slice(idx + 1);
  let result = 'ok';

  try {
    if (name === 'ensure-video') {
      const model = arg || 'Veo 3.1 - Quality';
      await page.click(selectors.common.modeButton);
      await sleep(1800);
      const label = (await page.locator(selectors.common.modeButton).textContent()) || '';
      if (!/^Video/.test(label)) {
        await page.click(selectors.video.videoModeTab);
        await sleep(1800);
      }
      const trigger = await page.waitForSelector(selectors.video.videoModelDropdownTrigger, { timeout: 3000 }).catch(() => null);
      if (trigger) {
        const triggerText = (await trigger.textContent()) || '';
        if (!triggerText.includes(model)) {
          await trigger.click();
          await sleep(1200);
          const opt = await page.waitForSelector(selectors.video.videoModelOption(model), { timeout: 3000 });
          await opt.click();
          await sleep(1200);
        }
      }
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(1200);
      result = `Video mode + model set to ${model}`;
    } else if (name === 'inline-model') {
      // Switch model via the inline dropdown that's visible on the clip
      // detail / extend-prompt views. Works without opening the popover,
      // so it's usable AFTER click-extend has hidden the mode button.
      const model = arg || 'Veo 3.1 - Quality';
      const trigger = await page.waitForSelector(selectors.video.videoModelDropdownTrigger, { timeout: 5000 });
      const triggerText = (await trigger.textContent()) || '';
      if (triggerText.includes(model)) {
        result = `Model already ${model} (no-op)`;
      } else {
        await trigger.click();
        await sleep(1200);
        const opt = await page.waitForSelector(selectors.video.videoModelOption(model), { timeout: 3000 });
        await opt.click();
        await sleep(1500);
        result = `Switched model to ${model} via inline dropdown`;
      }
    } else if (name === 'type') {
      await page.click(selectors.common.promptInput);
      await page.keyboard.press('Meta+A').catch(() => {});
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await sleep(800);
      for (const ch of arg) {
        await page.keyboard.type(ch);
        await sleep(120 + Math.floor(Math.random() * 150));
      }
      result = `Typed ${arg.length} chars`;
    } else if (name === 'click-create') {
      await page.click(selectors.common.generateButton);
      result = 'Clicked Create — QUOTA SPENT';
    } else if (name === 'wait-clip') {
      const before = new Set((await page.$$eval(selectors.video.allVideos, (els) =>
        els.map((el) => el.src).filter((s) => !!s))).filter((s) => !!s));
      const start = Date.now();
      let found = false;
      while (Date.now() - start < 180_000) {
        const after = await page.$$eval(selectors.video.allVideos, (els) =>
          els.map((el) => el.src).filter((s) => !!s));
        if (after.some((s) => !before.has(s))) { found = true; break; }
        await sleep(3000);
      }
      result = found
        ? `New clip rendered after ${Math.round((Date.now() - start) / 1000)}s`
        : 'TIMEOUT — no new clip after 180s';
    } else if (name === 'click-latest-clip') {
      const parent = page.locator(selectors.video.allVideos).first().locator('xpath=..');
      await parent.click({ force: true, timeout: 5000 }).catch(async () => {
        await page.locator(selectors.video.allVideos).first().locator('xpath=../..').click({ force: true, timeout: 5000 });
      });
      await sleep(2500);
      result = 'Clicked newest clip → detail view';
    } else if (name === 'click-extend') {
      const btn = await page.waitForSelector(selectors.video.extendButton, { timeout: 8000 });
      await btn.click();
      await sleep(1500);
      result = 'Clicked Extend — extend-prompt UI open';
    } else if (name === 'nav-grid') {
      await page.goto(PROJECT_URL, { waitUntil: 'networkidle', timeout: 30_000 });
      await sleep(2500);
      result = 'Navigated to project grid';
    } else if (name === 'download') {
      const srcs = await page.$$eval(selectors.video.allVideos, (els) =>
        els.map((el) => el.currentSrc || el.src).filter((s) => !!s));
      const cands = srcs.filter((s) => !s.includes('gstatic.com') && !s.includes('/flow_camera/'));
      if (cands.length === 0) {
        result = 'FAIL: no downloadable src found';
      } else {
        const url = cands[0];
        const resp = await context.request.get(url);
        const bytes = await resp.body();
        const outPath = arg || path.join(OUT_DIR, `stepper-download-${Date.now()}.mp4`);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, bytes);
        const previewCopy = path.join(OUT_DIR, path.basename(outPath));
        if (previewCopy !== outPath) fs.copyFileSync(outPath, previewCopy);
        result = `Downloaded ${bytes.length} bytes → ${outPath} (also ${path.basename(previewCopy)} in preview)`;
      }
    } else if (name === 'download-src') {
      // Usage: download-src <URL> [PATH]
      // Fetch a specific URL via the Playwright context (auth-aware) and
      // save to disk. Useful when the default candidates[0] is wrong.
      const parts = arg.split(' ');
      const url = parts[0];
      const outPath = parts.slice(1).join(' ') || path.join(OUT_DIR, `stepper-src-${Date.now()}.mp4`);
      const resp = await context.request.get(url);
      if (!resp.ok()) {
        result = `FAIL: HTTP ${resp.status()}`;
      } else {
        const bytes = await resp.body();
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, bytes);
        const previewCopy = path.join(OUT_DIR, path.basename(outPath));
        if (previewCopy !== outPath) fs.copyFileSync(outPath, previewCopy);
        result = `Downloaded ${bytes.length} bytes → ${outPath}`;
      }
    } else if (name === 'dump-srcs') {
      const srcs = await page.$$eval(selectors.video.allVideos, (els) =>
        els.map((el, idx) => ({
          idx,
          visible: !!(el.offsetWidth || el.offsetHeight),
          src: el.currentSrc || el.src || '',
        }))
      );
      const filtered = srcs.filter((s) => s.src && !s.src.includes('gstatic.com') && !s.src.includes('/flow_camera/'));
      result = `srcs (${srcs.length} total, ${filtered.length} candidates):\n` +
        filtered.map((s) => `  [${s.idx}] vis=${s.visible} ${s.src.slice(0, 140)}`).join('\n');
    } else if (name === 'click-history') {
      // Click "Show history" button in clip detail view — reveals the
      // scene's clip timeline with all extends.
      const btn = await page.waitForSelector('button:has-text("Show history")', { timeout: 5000 });
      await btn.click();
      await sleep(2500);
      result = 'Clicked Show history';
    } else if (name === 'shot') {
      result = 'Screenshot only';
    } else if (name === 'exit') {
      result = 'Exiting';
    } else {
      result = `Unknown command: ${name}`;
    }
  } catch (e) {
    result = `ERROR: ${e.message}`;
  }

  const screenshotName = await shot(name);
  const out = { cmd: line, result, screenshot: screenshotName };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`[stepper] ${name} → ${result} (${screenshotName})`);
  return name === 'exit';
}

(async () => {
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  page = await context.newPage();
  await page.goto(PROJECT_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await sleep(3000);
  const initShot = await shot('init');
  fs.writeFileSync(OUT_FILE, JSON.stringify({ cmd: 'init', result: 'Flow project grid loaded', screenshot: initShot }, null, 2));
  console.log(`[stepper] ready — waiting for commands at ${CMD_FILE}`);

  while (true) {
    while (!fs.existsSync(CMD_FILE)) await sleep(300);
    const line = fs.readFileSync(CMD_FILE, 'utf8').trim();
    try { fs.unlinkSync(CMD_FILE); } catch {}
    if (!line) continue;
    console.log(`[stepper] <- ${line}`);
    const done = await handle(line);
    if (done) break;
  }

  await context.close();
  process.exit(0);
})().catch((e) => {
  console.error(`[stepper] fatal: ${e.message}`);
  process.exit(1);
});
