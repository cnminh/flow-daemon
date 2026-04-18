const path = require('node:path');
const fs = require('node:fs');
const selectors = require('./selectors');
const {
  ensureContextForUrl,
  findOrCreatePage,
  humanPause,
  jitter,
} = require('./browser');

const DEFAULT_FLOW_URL = 'https://labs.google/fx/tools/flow/project/bcc73489-69d9-4621-974a-7168318a59d2';
const DEFAULT_TIMEOUT_MS = 180_000;

function pickRandomModel() {
  const names = selectors.video.modelNames;
  return names[Math.floor(Math.random() * names.length)];
}

// Humanized typing: per-character jitter (120-270ms) against real Flow,
// instantaneous against the mock fixture so tests don't run for minutes.
async function typePrompt(page, prompt, isMockFixture) {
  if (isMockFixture) {
    await page.keyboard.type(prompt);
  } else {
    for (const ch of prompt) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(jitter(120, 270));
    }
  }
}

// Switch Flow's prompt bar to Video mode. Mirror of image.js's
// ensureImageModeAndCount. On the mock fixture there's no mode button so
// this returns early. On real Flow, reads the mode button's label,
// opens the popover if we're in image mode, clicks the Video tab.
// The videoModeTab selector is a best-effort starter — verify live per
// spec §9 before relying on it.
async function ensureVideoMode(page) {
  const modeBtn = await page.waitForSelector(selectors.common.modeButton, { timeout: 3000 })
    .catch(() => null);
  if (!modeBtn) return; // mock fixture, or UI not loaded

  const label = (await modeBtn.textContent()) || '';
  const inVideoMode = /Video/i.test(label);
  if (inVideoMode) return;

  await modeBtn.click();
  await humanPause(page, 1200, 2500);

  const videoTab = await page.waitForSelector(selectors.video.videoModeTab, { timeout: 3000 })
    .catch(() => null);
  if (videoTab) {
    await videoTab.click();
    await humanPause(page, 1200, 2500);
  }

  await page.keyboard.press('Escape').catch(() => {});
  await humanPause(page, 800, 1600);
}

async function runJob({
  prompts,
  frame_path,
  output_path,
  flowUrl,
  timeoutMs,
  model,
  aspect,
}) {
  if (!Array.isArray(prompts) || prompts.length === 0) {
    const err = new Error('prompts must be a non-empty array');
    err.error_code = 'selector_missing';
    throw err;
  }
  if (!output_path || !path.isAbsolute(output_path)) {
    const err = new Error('output_path required and must be absolute');
    err.error_code = 'selector_missing';
    throw err;
  }

  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const chosenModel = model || pickRandomModel();
  const chosenAspect = aspect || '16:9';
  const url = flowUrl || DEFAULT_FLOW_URL;
  const isMockFixture = url.startsWith('file://');

  const context = await ensureContextForUrl(flowUrl);

  try {
    const page = await findOrCreatePage(context, url);

    // Login canary
    const input = await page.waitForSelector(selectors.common.promptInput, { timeout: 5000 })
      .catch(() => null);
    if (!input) {
      const err = new Error('prompt input not found — not logged in?');
      err.error_code = 'not_logged_in';
      throw err;
    }

    // Flip Flow to Video mode if it isn't already. No-op on the mock
    // fixture (no mode button present).
    await ensureVideoMode(page);

    // Iterate prompts: 0 is the initial Create; 1..N-1 are Extend clicks.
    for (let i = 0; i < prompts.length; i += 1) {
      const prompt = prompts[i];
      const isExtend = i > 0;

      // Snapshot existing video srcs so we detect only the NEW one for this iteration.
      const beforeSrcs = new Set(
        await page.$$eval(selectors.video.allVideos, (els) => els.map((el) => el.src))
      );

      if (isExtend) {
        // Click the Extend button on the latest clip.
        const extendBtn = await page.waitForSelector(selectors.video.extendButton, { timeout: 5000 });
        await extendBtn.click();
        await humanPause(page, 800, 1600);
      }

      // Clear input and type this prompt.
      const currentInput = await page.waitForSelector(selectors.common.promptInput, { timeout: 3000 });
      await currentInput.click();
      await page.keyboard.press('Meta+A').catch(() => {});
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await humanPause(page, 600, 1500);

      await typePrompt(page, prompt, isMockFixture);

      await humanPause(page, 1000, 2500);

      // Submit this clip.
      const genBtn = await page.waitForSelector(selectors.common.generateButton, { timeout: 3000 });
      await genBtn.click();

      // Wait for a new <video> element (new src relative to this iteration's snapshot).
      await page.waitForFunction(
        ({ selector, beforeArray }) => {
          const before = new Set(beforeArray);
          for (const el of document.querySelectorAll(selector)) {
            if (el.src && !before.has(el.src)) return true;
          }
          return false;
        },
        { selector: selectors.video.allVideos, beforeArray: [...beforeSrcs] },
        { timeout }
      );

      // Cooldown between clips (not after the last). Skipped on mock fixture
      // so tests stay fast.
      if (i < prompts.length - 1 && !isMockFixture) {
        const cooldown = 5000 + Math.floor(Math.random() * 10_000);
        await page.waitForTimeout(cooldown);
      }
    }

    // Trigger the stitched scene download and capture the bytes.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.click(selectors.video.downloadSceneButton),
    ]);

    fs.mkdirSync(path.dirname(output_path), { recursive: true });
    await download.saveAs(output_path);

    const size = fs.statSync(output_path).size;
    if (size === 0) {
      const err = new Error('downloaded video is empty');
      err.error_code = 'network';
      throw err;
    }

    return {
      video_path: output_path,
      prompt_count: prompts.length,
      model: chosenModel,
      aspect: chosenAspect,
    };
  } finally {
    if (context._ephemeral) await context.browser().close();
  }
}

module.exports = { runJob };
