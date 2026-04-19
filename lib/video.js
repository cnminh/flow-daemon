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

// Per-clip model policy:
//   i === 0            → 'Veo 3.1 - Quality' (best starting frame).
//   i >= 1 (extends)   → random between Quality and Fast (motion variety,
//                        Lite is too blocky for long chains).
// User `--model` override pins the entire chain to that one model.
function pickModelForIndex(i, override) {
  if (override) return override;
  if (i === 0) return 'Veo 3.1 - Quality';
  const pool = ['Veo 3.1 - Quality', 'Veo 3.1 - Fast'];
  return pool[Math.floor(Math.random() * pool.length)];
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

// Set the model via an already-visible dropdown trigger. Shared helper
// for the two context-specific model-setters below.
async function clickModelOption(page, modelName) {
  const trigger = await page.waitForSelector(
    selectors.video.videoModelDropdownTrigger,
    { timeout: 3000 }
  ).catch(() => null);
  if (!trigger) {
    console.log('[flow-video] model dropdown trigger not found — keeping current selection');
    return;
  }
  const triggerLabel = (await trigger.textContent()) || '';
  if (triggerLabel.includes(modelName)) return; // already set — save a click.

  console.log(
    `[flow-video] switching model: ${JSON.stringify(triggerLabel.slice(0, 60))} → ${modelName}`
  );
  await trigger.click();
  await humanPause(page, 800, 1600);
  const option = await page.waitForSelector(
    selectors.video.videoModelOption(modelName),
    { timeout: 3000 }
  ).catch(() => null);
  if (option) {
    await option.click();
    await humanPause(page, 1200, 2500);
  } else {
    console.log(`[flow-video] model "${modelName}" not in dropdown — keeping current`);
  }
}

// NEW-SCENE context (iter 0, on grid): opens the mode-button popover,
// ensures Video tab is selected, and picks the new-scene model via the
// popover's model dropdown. This is the dropdown Flow consults when the
// next Create on the grid spawns a NEW scene.
//
// Short-circuits on the mock fixture.
async function ensureVideoModeForNewScene(page, modelName, isMockFixture) {
  if (isMockFixture) return;

  const modeBtn = await page.waitForSelector(selectors.common.modeButton, { timeout: 3000 })
    .catch(() => null);
  if (!modeBtn) return; // UI not loaded or not on a page with the mode toggle

  const label = (await modeBtn.textContent()) || '';
  const inVideoMode = /^Video/.test(label);

  await modeBtn.click();
  await humanPause(page, 1200, 2500);

  if (!inVideoMode) {
    const videoTab = await page.waitForSelector(selectors.video.videoModeTab, { timeout: 3000 })
      .catch(() => null);
    if (videoTab) {
      await videoTab.click();
      await humanPause(page, 1200, 2500);
    }
  }

  await clickModelOption(page, modelName);

  await page.keyboard.press('Escape').catch(() => {});
  await humanPause(page, 800, 1600);
}

// EXTEND context (iter 1+, in clip detail view): picks the model via
// the INLINE dropdown visible on the clip detail / extend-prompt view.
// This is the dropdown Flow consults when the next Create extends the
// currently-viewed clip (separate from the new-scene model on the grid).
//
// Short-circuits on the mock fixture.
async function setExtendModel(page, modelName, isMockFixture) {
  if (isMockFixture) return;
  await clickModelOption(page, modelName);
}

async function runJob({
  prompts,
  frame_path,
  output_path,
  flowUrl,
  timeoutMs,
  model,
  aspect,
  quality,
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

  if (frame_path) {
    if (!fs.existsSync(frame_path)) {
      const err = new Error(`frame_path does not exist: ${frame_path}`);
      err.error_code = 'frame_invalid';
      throw err;
    }
    const ext = path.extname(frame_path).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
      const err = new Error(`frame_path must be .png or .jpg: ${frame_path}`);
      err.error_code = 'frame_invalid';
      throw err;
    }
  }

  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const chosenAspect = aspect || '16:9';
  const chosenQuality = quality || '1080p';
  if (chosenQuality !== '720p' && chosenQuality !== '1080p') {
    const err = new Error(`quality must be "720p" or "1080p" (got ${JSON.stringify(chosenQuality)})`);
    err.error_code = 'selector_missing';
    throw err;
  }
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

    // Frames-to-video: upload the starting frame if provided.
    if (frame_path) {
      const framesBtn = await page.waitForSelector(selectors.video.framesTab, { timeout: 5000 })
        .catch(() => null);
      if (!framesBtn) {
        const err = new Error('Frames entry point not found in Flow UI');
        err.error_code = 'selector_missing';
        throw err;
      }
      await framesBtn.click();
      await humanPause(page, 800, 1600);

      const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 3000, state: 'attached' });
      await fileInput.setInputFiles(frame_path);

      try {
        await page.waitForSelector(selectors.video.framePreview, { timeout: 20_000 });
      } catch {
        const err = new Error('frame upload preview did not appear within 20s — rejected?');
        err.error_code = 'frame_invalid';
        throw err;
      }
      await humanPause(page, 800, 1600);
    }

    // Iterate prompts: 0 is the initial Create; 1..N-1 are Extend clicks.
    // Each iteration may flip the model per the pickModelForIndex policy.
    // We track each iteration's new <video>.src so we can download the
    // exact clip at the end — critical for extend chains, where the
    // new clip doesn't surface at videos[0] on the grid (it lives as a
    // child of the parent scene's thumbnail).
    const modelsUsed = [];
    const clipSrcs = [];
    let completedPromptCount = 0;
    for (let i = 0; i < prompts.length; i += 1) {
      const prompt = prompts[i];
      const isExtend = i > 0;
      const modelForThisClip = pickModelForIndex(i, model);

      try {
        // Set the model for THIS clip, using the right dropdown for the
        // current context:
        //   - iter 0 (on project grid): new-scene popover dropdown. This
        //     is what Flow consults for a Create-from-scratch.
        //   - iter 1+ (already in clip detail view at this point — we
        //     entered it at the END of the previous iteration): inline
        //     dropdown on the detail / extend-prompt view. This is what
        //     Flow consults for an extend.
        // These are DIFFERENT dropdowns: setting one doesn't affect the
        // other. That's why we split the helpers.
        if (!isExtend) {
          await ensureVideoModeForNewScene(page, modelForThisClip, isMockFixture);
        } else {
          await setExtendModel(page, modelForThisClip, isMockFixture);
          // In extend context we must also explicitly click Extend to open
          // the extend-prompt UI. For iter 0 we type directly into the
          // grid prompt bar — no Extend click needed.
          const extendBtn = await page.waitForSelector(selectors.video.extendButton, { timeout: 8000 });
          await extendBtn.click();
          await humanPause(page, 800, 1600);
        }

        // Snapshot existing video srcs NOW — AFTER any detail-view
        // transition for extend. Detail view exposes ~15 gstatic-hosted
        // camera-motion preset demo clips that weren't present on the
        // grid; snapshotting here captures them so waitForFunction
        // doesn't mistake one for our newly-generated clip.
        const beforeSrcs = new Set(
          await page.$$eval(selectors.video.allVideos, (els) =>
            els.map((el) => el.src).filter((s) => !!s)
          )
        );

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

        // Wait for a new <video> element (new src relative to this iteration's
        // snapshot) and return its URL so we can download that exact clip
        // later without guessing on the grid. Defensively ignore Flow's
        // built-in gstatic.com/flow_camera/* motion-preset demo clips
        // even if somehow they slipped past the beforeSrcs snapshot.
        const newSrcHandle = await page.waitForFunction(
          ({ selector, beforeArray }) => {
            const before = new Set(beforeArray);
            for (const el of document.querySelectorAll(selector)) {
              const src = el.currentSrc || el.src;
              if (!src || before.has(src)) continue;
              if (src.includes('gstatic.com') || src.includes('/flow_camera/')) continue;
              return src;
            }
            return null;
          },
          { selector: selectors.video.allVideos, beforeArray: [...beforeSrcs] },
          { timeout }
        );
        const newSrc = await newSrcHandle.jsonValue();
        clipSrcs.push(newSrc);
        console.log(`[flow-video] clip ${i + 1} rendered: ${String(newSrc).slice(0, 120)}`);

        completedPromptCount += 1;
        modelsUsed.push(modelForThisClip);

        // End-of-iteration setup for the NEXT iteration, if there is one.
        // We click into the newest clip's detail view here so the next
        // iteration starts positioned for extend: it can use the inline
        // model dropdown (setExtendModel) + click Extend without any grid
        // transitions. For iter 0 → iter 1 this navigates from grid into
        // clip 1. For iter N → iter N+1 this re-clicks into the now-current
        // clip (which Flow may have auto-advanced to anyway).
        //
        // The <video> element is often styled display:none until hovered;
        // clicking its wrapper (xpath=..) is more robust than clicking the
        // media element directly. Fallback to grandparent if parent isn't
        // clickable.
        if (i < prompts.length - 1 && !isMockFixture) {
          const latestClipParent = page.locator(selectors.video.allVideos).first().locator('xpath=..');
          await latestClipParent.click({ force: true, timeout: 5000 }).catch(async () => {
            await page.locator(selectors.video.allVideos).first().locator('xpath=../..').click({ force: true, timeout: 5000 });
          });
          await humanPause(page, 1500, 3000);

          // Cooldown (anti-detection). Skipped on mock fixture so tests
          // stay fast.
          const cooldown = 5000 + Math.floor(Math.random() * 10_000);
          await page.waitForTimeout(cooldown);
        }
      } catch (e) {
        if (isExtend) {
          const err = new Error(`extend failed on prompt ${i + 1}: ${e.message}`);
          err.error_code = 'extend_failed';
          err.failed_at_index = i;
          err.completed_prompts = completedPromptCount;
          throw err;
        }
        // Initial-clip failure (i === 0): propagate with appropriate code.
        if (!e.error_code) e.error_code = 'timeout';
        throw e;
      }
    }

    // Download the STITCHED scene via Flow's Download modal. This is
    // different from fetching <video>.currentSrc (which returns just the
    // active clip, not the full 1+2+...+N arc).
    //
    // Flow's Download flow:
    //   1. We're already in the latest clip's detail view (end-of-iter
    //      navigation ensured this). The top-right "Download" button is
    //      visible.
    //   2. Click Download → modal opens with 4 resolution options:
    //         - 270p Animated GIF   (GIF, not mp4 — skip)
    //         - 720p Original Size  (stitched mp4, rendered resolution)
    //         - 1080p Upscaled      (stitched mp4, AI-upscaled)
    //         - 4K Upscaled · 50 credits   (DANGER — 50 EXTRA credits!)
    //   3. Click the chosen quality option → Playwright download event
    //      fires → saveAs(output_path).
    //
    // chosenQuality is '720p' or '1080p' (validated at top of runJob).
    // The downloadQualityOption selector REFUSES anything other than
    // those two — even a typo like '4K' throws before touching the DOM.
    const downloadBtn = await page.waitForSelector(selectors.video.downloadSceneButton, { timeout: 5000 });
    await downloadBtn.click();
    await humanPause(page, 1200, 2500);

    console.log(`[flow-video] download modal open, clicking ${chosenQuality} option`);
    const qualitySel = selectors.video.downloadQualityOption(chosenQuality);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.locator(qualitySel).first().click(),
    ]);

    fs.mkdirSync(path.dirname(output_path), { recursive: true });
    await download.saveAs(output_path);

    const size = fs.statSync(output_path).size;
    if (size === 0) {
      const err = new Error('downloaded video is empty');
      err.error_code = 'network';
      throw err;
    }
    console.log(`[flow-video] saved ${size} bytes → ${output_path}`);

    return {
      video_path: output_path,
      prompt_count: prompts.length,
      model: modelsUsed[0] || null,  // first clip's model (back-compat scalar)
      models: modelsUsed,             // full per-clip list (e.g. ['Quality','Fast','Quality'])
      aspect: chosenAspect,
      quality: chosenQuality,
    };
  } finally {
    if (context._ephemeral) await context.browser().close();
  }
}

module.exports = { runJob };
