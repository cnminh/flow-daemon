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

// Flip Flow into Video mode AND select the requested video model.
// Runs once per clip (before typing the prompt). Short-circuits on the
// mock fixture (no mode button / dropdown present).
//
// Steps (real Flow):
//   1. If the mode button's label doesn't start with "Video", open the
//      popover + click the Video tab.
//   2. Open the model dropdown (visible inside the popover after the
//      Video tab is active) and click the option matching modelName, if
//      it isn't already selected.
//   3. Escape to close the popover.
//
// The mode button label in video mode starts with "Video" (e.g. "Videocrop_16_9x1").
// In image mode it starts with the image-model name ("Imagen 4..." etc.).
async function ensureVideoModeAndModel(page, modelName, isMockFixture) {
  if (isMockFixture) return;

  const modeBtn = await page.waitForSelector(selectors.common.modeButton, { timeout: 3000 })
    .catch(() => null);
  if (!modeBtn) return; // UI not loaded

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

  // Set the model. Only click if the current selection doesn't already
  // match — saves UI churn.
  const trigger = await page.waitForSelector(
    selectors.video.videoModelDropdownTrigger,
    { timeout: 3000 }
  ).catch(() => null);
  if (trigger) {
    const triggerLabel = (await trigger.textContent()) || '';
    if (!triggerLabel.includes(modelName)) {
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
        console.log(
          `[flow-video] model "${modelName}" not found in dropdown — keeping current selection`
        );
      }
    }
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
        // Ensure Video mode + desired model are selected BEFORE this clip.
        // On mock: no-op.
        await ensureVideoModeAndModel(page, modelForThisClip, isMockFixture);

        if (isExtend) {
          // Flow's Extend button only lives on a clip's detail view — the
          // grid state we land in after Create has no Extend affordance.
          // Click the newest <video>'s parent to enter detail view, then
          // look for the Extend button. The <video> element itself is
          // often styled display:none until hovered; clicking its wrapper
          // is more robust, so we click `xpath=..`.
          const latestClipParent = page.locator(selectors.video.allVideos).first().locator('xpath=..');
          await latestClipParent.click({ force: true, timeout: 5000 }).catch(async () => {
            // Fallback: try the grandparent if the direct parent isn't clickable.
            await page.locator(selectors.video.allVideos).first().locator('xpath=../..').click({ force: true, timeout: 5000 });
          });
          await humanPause(page, 1500, 3000);

          // Now Extend should be visible.
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

        // Cooldown between clips (not after the last). Skipped on mock fixture
        // so tests stay fast.
        if (i < prompts.length - 1 && !isMockFixture) {
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

    // Download the final clip. We captured each clip's src URL as it
    // rendered (clipSrcs[]); grab the last one. This avoids the modal
    // dance AND the pitfall where the grid doesn't surface extend clips
    // at videos[0] (the grid lists scenes, not clips — extends live
    // inside their parent scene's thumbnail).
    //
    // Flow serves the mp4 bytes over HTTPS at
    // /fx/api/trpc/media.getMediaUrlRedirect?name=<uuid> — authenticated
    // via the logged-in profile's cookies, which context.request.get uses.
    const downloadSrc = clipSrcs[clipSrcs.length - 1];
    if (!downloadSrc) {
      const err = new Error('no clip src captured during generation');
      err.error_code = 'selector_missing';
      throw err;
    }
    console.log(`[flow-video] downloading ${downloadSrc.slice(0, 140)}`);

    let bytes;
    if (downloadSrc.startsWith('data:')) {
      // Mock fixture path — data URL, decode base64.
      const base64 = downloadSrc.split(',', 2)[1];
      bytes = Buffer.from(base64, 'base64');
    } else {
      const resp = await context.request.get(downloadSrc);
      if (!resp.ok()) {
        const err = new Error(`video download failed: ${resp.status()}`);
        err.error_code = 'network';
        throw err;
      }
      bytes = await resp.body();
    }

    fs.mkdirSync(path.dirname(output_path), { recursive: true });
    fs.writeFileSync(output_path, bytes);

    const size = fs.statSync(output_path).size;
    if (size === 0) {
      const err = new Error('downloaded video is empty');
      err.error_code = 'network';
      throw err;
    }

    return {
      video_path: output_path,
      prompt_count: prompts.length,
      model: modelsUsed[0] || null,  // first clip's model (back-compat scalar)
      models: modelsUsed,             // full per-clip list (e.g. ['Quality','Fast','Quality'])
      aspect: chosenAspect,
    };
  } finally {
    if (context._ephemeral) await context.browser().close();
  }
}

module.exports = { runJob };
