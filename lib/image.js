const path = require('node:path');
const fs = require('node:fs');
const selectors = require('./selectors');
const {
  PROFILE_DIR,
  jitter,
  humanPause,
  ensureContextForUrl,
  findOrCreatePage,
  closeBrowser,
} = require('./browser');

const DEFAULT_TIMEOUT_MS = 180_000;

const ROTATION_SKIP = new Set(['Nano Banana 2']);

function pickRandomModel() {
  const names = selectors.image.modelNames.filter((n) => !ROTATION_SKIP.has(n));
  return names[Math.floor(Math.random() * names.length)];
}

// Flow defaults to Video mode (Veo) and x2 output count. We need Image mode
// to get stills, and we only download one result per job, so x1 output is
// both faster and 2-4x cheaper in quota.
//
// The mode button in the prompt bar shows the current selection — its text
// includes "Video" when in video mode, or the model name (e.g. "Nano Banana
// 2") when in image mode, followed by the aspect ratio and output count
// (e.g. "...crop_16_9x2"). Clicking it opens a popover with:
//   top:    Image/Video/Frames/Ingredients tabs
//   second: model dropdown (Nano Banana Pro / Nano Banana 2 / Imagen 4)
//   middle: aspect ratio options
//   bottom: output count (x1/x2/x3/x4)
//
// This function opens the popover once, flips whichever settings are wrong,
// then presses Escape to close it. If nothing needs changing, it's a no-op.
async function ensureImageModeAndCount(page, desiredCount = 1, desiredModel = null, desiredAspect = null) {
  const modeBtn = await page.waitForSelector(selectors.common.modeButton, { timeout: 3000 })
    .catch(() => null);
  if (!modeBtn) return; // UI variant without a mode toggle, or not yet loaded

  const label = (await modeBtn.textContent()) || '';
  const inImageMode = !/Video/i.test(label);
  // The "xN" suffix in the label reflects the current count.
  const countMatch = label.match(/x(\d+)\b/);
  const currentCount = countMatch ? parseInt(countMatch[1], 10) : null;
  const countOK = currentCount === desiredCount;

  // The modeBtn label also embeds the currently-active model name when in
  // image mode — check which (if any) of the known models it contains.
  // Order "Nano Banana 2" before "Nano Banana Pro" so `includes` doesn't
  // falsely match "Pro" in a label that actually contains "2".
  const currentModel =
    [...selectors.image.modelNames].sort((a, b) => b.length - a.length).find((n) => label.includes(n)) || null;
  const modelOK = !desiredModel || currentModel === desiredModel;

  // Aspect is encoded in the modeBtn label as "crop_W_H" (e.g. crop_9_16).
  // Convert to "W:H" for human-readable comparison.
  const aspectMatch = label.match(/crop_(\d+)_(\d+)/);
  const currentAspect = aspectMatch ? `${aspectMatch[1]}:${aspectMatch[2]}` : null;
  const aspectOK = !desiredAspect || currentAspect === desiredAspect;

  console.log(
    `[flow-daemon] mode popover state: inImageMode=${inImageMode} ` +
    `currentModel=${currentModel || 'unknown'} currentCount=${currentCount} ` +
    `currentAspect=${currentAspect || 'unknown'} ` +
    `→ desired: Image/${desiredModel || '(any model)'}/x${desiredCount}` +
    `${desiredAspect ? '/' + desiredAspect : ''} ` +
    `(label=${JSON.stringify(label.slice(0, 120))})`
  );

  if (inImageMode && countOK && modelOK && aspectOK) {
    console.log('[flow-daemon] all popover settings already correct — no-op');
    return;
  }

  // Longer pauses around the settings flips (1.2–2.5s) — previous 400–800ms
  // was fast enough that Google flagged the session as "unusual activity"
  // when combined with quick typing. Real users glance at each option
  // before clicking.
  await modeBtn.click();
  await humanPause(page, 1200, 2500);

  if (!inImageMode) {
    const imageTab = await page.waitForSelector(selectors.image.imageModeTab, { timeout: 3000 })
      .catch(() => null);
    if (imageTab) {
      await imageTab.click();
      await humanPause(page, 1200, 2500);
    }
  }

  if (!modelOK) {
    const trigger = await page.waitForSelector(selectors.image.modelDropdown, { timeout: 3000 })
      .catch(() => null);
    if (!trigger) {
      console.log(
        `[flow-daemon] model dropdown trigger NOT FOUND with selector: ${selectors.image.modelDropdown}`
      );
    } else {
      console.log(`[flow-daemon] model dropdown trigger found — clicking`);
      await trigger.click();
      await humanPause(page, 800, 1600);
      const option = await page.waitForSelector(selectors.image.modelOption(desiredModel), { timeout: 3000 })
        .catch(() => null);
      if (!option) {
        console.log(
          `[flow-daemon] model option "${desiredModel}" NOT FOUND with selector: ${selectors.image.modelOption(desiredModel)}`
        );
      } else {
        console.log(`[flow-daemon] clicking model option "${desiredModel}"`);
        await option.click();
        await humanPause(page, 1200, 2500);
      }
    }
  }

  if (!countOK) {
    const countTab = await page.waitForSelector(selectors.image.countTab(desiredCount), { timeout: 3000 })
      .catch(() => null);
    if (countTab) {
      await countTab.click();
      await humanPause(page, 1200, 2500);
    }
  }

  if (!aspectOK && desiredAspect) {
    // Aspect-option buttons live in the same popover. Selector reuses
    // selectors.video.aspectOption (mode-agnostic; matches any tab-slider
    // trigger with the ratio text). Image mode offers 9:16, 16:9, 1:1, 4:3, 3:4.
    const aspectBtn = await page.waitForSelector(
      selectors.video.aspectOption(desiredAspect),
      { timeout: 3000 }
    ).catch(() => null);
    if (aspectBtn) {
      console.log(`[flow-daemon] setting aspect ratio: ${desiredAspect}`);
      await aspectBtn.click();
      await humanPause(page, 1200, 2500);
    } else {
      console.log(`[flow-daemon] aspect option "${desiredAspect}" not found in popover — keeping ${currentAspect}`);
    }
  }

  // Close the popover so it doesn't intercept clicks on the prompt input.
  await page.keyboard.press('Escape').catch(() => {});
  await humanPause(page, 800, 1600);
}

// Back-compat alias. Older callers (including the in-repo runJob below)
// transition to the new name; any external wrappers can keep using this.
const ensureImageMode = (page) => ensureImageModeAndCount(page, 1);

async function runJob({ prompt, project_id, segment_id, output_path, rootDir, flowUrl, timeoutMs, aspect }) {
  if (!rootDir) throw new Error('rootDir required');
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;

  const context = await ensureContextForUrl(flowUrl);
  const isMockFixture = flowUrl && flowUrl.startsWith('file://');

  try {
    const page = await findOrCreatePage(context, flowUrl);

    // Login check: prompt input must be present
    const input = await page.waitForSelector(selectors.common.promptInput, { timeout: 5000 })
      .catch(() => null);
    if (!input) {
      const err = new Error('prompt input not found — not logged in?');
      err.error_code = 'not_logged_in';
      throw err;
    }

    // Switch Flow into Image mode + x1 output count, and pick a random
    // image model per job so we rotate across Nano Banana Pro / Nano Banana
    // 2 / Imagen 4 (skip in test mode — the mock fixture doesn't have the
    // mode/count popover).
    let chosenModel = null;
    if (!isMockFixture) {
      chosenModel = pickRandomModel();
      console.log(`[flow-daemon] model for this job: ${chosenModel}`);
      await ensureImageModeAndCount(page, 1, chosenModel, aspect);
    }

    // Snapshot the set of image src URLs BEFORE submission. After submission
    // we'll poll for new srcs. Flow sets img.alt to the prompt (truncated)
    // which isn't a stable detection signal, but src is unique per image.
    const beforeSrcs = new Set(
      await page.$$eval(selectors.image.allImages, (els) => els.map((el) => el.src))
    );

    // Humanized pause before interacting (like a user reading the page).
    await humanPause(page, 600, 1500);

    // Clear the input and type the new prompt. The keyboard dance handles
    // cross-platform select-all: Meta+A works on macOS, Control+A on
    // Linux/Windows. Each .catch() ignores the failing accelerator so the
    // surviving platform's key combo wins.
    await input.click();
    await page.keyboard.press('Meta+A').catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});

    // Type the prompt. Against real Flow we use a per-CHARACTER random delay
    // (120-270ms jitter, ~30 WPM) so Google's keystroke detector sees
    // human-like variance — Playwright's built-in { delay: N } uses a fixed
    // N for the whole string which got us flagged as "unusual activity".
    // Against the mock fixture (file:// URL) we type instantly since a
    // static HTML page can't detect us and long prompts would blow past
    // test timeouts (150 chars × 200ms = 30s of pure typing).
    if (isMockFixture) {
      await page.keyboard.type(prompt);
    } else {
      for (const ch of prompt) {
        await page.keyboard.type(ch);
        await page.waitForTimeout(jitter(120, 270));
      }
    }

    // Pause between finishing typing and clicking Create (like a human
    // proofreading their prompt before submitting).
    await humanPause(page, 1000, 2500);

    // Submit
    const genBtn = await page.waitForSelector(selectors.common.generateButton, { timeout: 3000 });
    await genBtn.click();

    // Wait for a new image src to appear (any img whose src wasn't in the
    // before-snapshot).
    let newSrc = null;
    try {
      newSrc = await page.waitForFunction(
        ({ selector, beforeArray }) => {
          const before = new Set(beforeArray);
          for (const el of document.querySelectorAll(selector)) {
            if (el.src && !before.has(el.src)) return el.src;
          }
          return null;
        },
        { selector: selectors.image.allImages, beforeArray: [...beforeSrcs] },
        { timeout }
      );
      newSrc = await newSrc.jsonValue();
    } catch (e) {
      const err = new Error('timeout waiting for outputs');
      err.error_code = 'timeout';
      throw err;
    }

    if (!newSrc || typeof newSrc !== 'string') {
      const err = new Error('no new image src found');
      err.error_code = 'selector_missing';
      throw err;
    }

    // Download the image bytes
    let bytes;
    if (newSrc.startsWith('data:')) {
      const base64 = newSrc.split(',', 2)[1];
      bytes = Buffer.from(base64, 'base64');
    } else {
      const resp = await context.request.get(newSrc);
      if (!resp.ok()) {
        const err = new Error(`image download failed: ${resp.status()}`);
        err.error_code = 'network';
        throw err;
      }
      bytes = await resp.body();
    }

    // Resolve target path. Callers can either supply an explicit output_path
    // (absolute or relative to rootDir) or fall back to the legacy Content
    // Hub pattern priv/uploads/video_projects/<project>/segments/<segment>.
    let relPath, absPath;
    if (output_path) {
      if (path.isAbsolute(output_path)) {
        absPath = output_path;
        relPath = output_path;
      } else {
        relPath = output_path;
        absPath = path.join(rootDir, output_path);
      }
    } else {
      relPath = path.join(
        'priv', 'uploads', 'video_projects',
        String(project_id), 'segments', String(segment_id), 'flow.png'
      );
      absPath = path.join(rootDir, relPath);
    }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, bytes);

    return { image_path: relPath, model: chosenModel };
  } finally {
    if (context._ephemeral) await context.browser().close();
  }
}

module.exports = { runJob, closeBrowser, PROFILE_DIR };
