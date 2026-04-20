const path = require('node:path');
const fs = require('node:fs');
const { execFile, execSync } = require('node:child_process');
const selectors = require('./selectors');
const {
  ensureContextForUrl,
  findOrCreatePage,
  humanPause,
  jitter,
} = require('./browser');

const DEFAULT_FLOW_URL = 'https://labs.google/fx/tools/flow/project/bcc73489-69d9-4621-974a-7168318a59d2';
const DEFAULT_TIMEOUT_MS = 180_000;

// Veo extend clips replay ~1s of the prior clip at their start (temporal
// continuity). We trim that before concat to avoid a visible repeat at
// each seam. Overridable via the runJob `overlap_seconds` arg.
const DEFAULT_OVERLAP_SECONDS = 1.0;

function ffmpegAvailable() {
  try {
    execSync('command -v ffmpeg', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Build ffmpeg args for a trim+concat+scale of N clips.
// Clip 0 plays in full; clips 1..N-1 trim `overlap` seconds off the start.
// Each input is scaled-with-pad to the target 1080p dims (1920×1080 for
// 16:9, 1080×1920 for 9:16) before concat — a plain lanczos resize, not a
// learned upscale, so quality is bounded by the 720p source. The scale-pad
// step also makes concat robust to Flow occasionally delivering a clip at
// an unexpected aspect mid-scene (we've seen clip 0 landscape + clip 1
// portrait in the same job).
function buildFfmpegArgs(partPaths, overlap, aspect, output) {
  const args = ['-v', 'error', '-y'];
  for (const p of partPaths) args.push('-i', p);

  const N = partPaths.length;
  const targetW = aspect === '16:9' ? 1920 : 1080;
  const targetH = aspect === '16:9' ? 1080 : 1920;

  // Per-input: trim the overlap (for i≥1) + scale-fit-with-pad to target dims.
  // scale=...:force_original_aspect_ratio=decrease fits within the box without
  // cropping; pad=... fills the remaining edges with black. This makes concat
  // robust even if Flow returns a clip at an unexpected aspect — we've seen
  // Flow deliver clip 0 landscape and clip 1 portrait in the same scene.
  const filters = [];
  const scalePad = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  for (let i = 0; i < N; i += 1) {
    if (i === 0) {
      filters.push(`[0:v]${scalePad},setpts=PTS-STARTPTS[v0]`);
      filters.push(`[0:a]asetpts=PTS-STARTPTS[a0]`);
    } else {
      filters.push(`[${i}:v]trim=start=${overlap},${scalePad},setpts=PTS-STARTPTS[v${i}]`);
      filters.push(`[${i}:a]atrim=start=${overlap},asetpts=PTS-STARTPTS[a${i}]`);
    }
  }
  let concatInputs = '';
  for (let i = 0; i < N; i += 1) concatInputs += `[v${i}][a${i}]`;
  filters.push(`${concatInputs}concat=n=${N}:v=1:a=1[vout][aout]`);

  args.push('-filter_complex', filters.join('; '));
  args.push('-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20');
  args.push('-c:a', 'aac');
  args.push(output);
  return args;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

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
// ensures Video tab is selected, picks the aspect ratio (9:16 portrait
// or 16:9 landscape) and the model. This is the popover Flow consults
// when the next Create on the grid spawns a NEW scene. Extend clips
// (iter 1+) inherit the scene's aspect — it can't be changed mid-scene.
//
// Short-circuits on the mock fixture.
async function ensureVideoModeForNewScene(page, modelName, aspectRatio, isMockFixture) {
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

  // Click the aspect-ratio option. Flow's popover shows only 9:16 and 16:9
  // in video mode. Clicking when already selected is a harmless no-op.
  if (aspectRatio) {
    const aspectBtn = await page.waitForSelector(
      selectors.video.aspectOption(aspectRatio),
      { timeout: 3000 }
    ).catch(() => null);
    if (aspectBtn) {
      console.log(`[flow-video] setting aspect ratio: ${aspectRatio}`);
      await aspectBtn.click();
      await humanPause(page, 1200, 2500);
    } else {
      console.log(`[flow-video] aspect option "${aspectRatio}" not found in popover — keeping current`);
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
  overlap_seconds,
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
  // Default to portrait (9:16) — best for mobile playback and social media,
  // which is the most common target for Veo videos. Override with --aspect
  // 16:9 or --orientation landscape.
  const chosenAspect = aspect || '9:16';
  if (chosenAspect !== '9:16' && chosenAspect !== '16:9') {
    const err = new Error(`aspect must be "9:16" or "16:9" (got ${JSON.stringify(chosenAspect)})`);
    err.error_code = 'selector_missing';
    throw err;
  }
  const overlapSeconds = typeof overlap_seconds === 'number' ? overlap_seconds : DEFAULT_OVERLAP_SECONDS;
  const url = flowUrl || DEFAULT_FLOW_URL;
  const isMockFixture = url.startsWith('file://');

  // Check for ffmpeg up front if this is a multi-clip chain against real Flow.
  // Fail fast with a clear error instead of generating all clips and then
  // discovering ffmpeg is missing.
  if (prompts.length > 1 && !isMockFixture && !ffmpegAvailable()) {
    const err = new Error('ffmpeg not found in PATH — required for multi-clip stitching. Install via `brew install ffmpeg`.');
    err.error_code = 'ffmpeg_missing';
    throw err;
  }

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
          await ensureVideoModeForNewScene(page, modelForThisClip, chosenAspect, isMockFixture);
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

    // Fetch each clip's mp4 bytes directly (Flow serves them at
    // /fx/api/trpc/media.getMediaUrlRedirect?name=<uuid>, authenticated
    // via the profile's cookies). For N=1 we write the single clip to
    // output_path. For N>1 we trim `overlapSeconds` off each extend
    // clip (Veo's extend feature replays ~1s of the prior clip at the
    // start for continuity — naive concat produces a visible repeat)
    // and concatenate via ffmpeg.
    //
    // Flow's Download modal (720p/1080p) was explored but always
    // produces a single-clip 8-second output regardless of scene
    // length. Client-side stitching is the only way to get the full
    // 8 + 7*(N-1) second arc.
    fs.mkdirSync(path.dirname(output_path), { recursive: true });
    const tmpDir = path.join(path.dirname(output_path), `_parts-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const partPaths = [];
    for (let i = 0; i < clipSrcs.length; i += 1) {
      const src = clipSrcs[i];
      const partPath = path.join(tmpDir, `clip-${String(i).padStart(2, '0')}.mp4`);
      let bytes;
      if (src.startsWith('data:')) {
        // Mock fixture path — data URL, decode base64.
        const base64 = src.split(',', 2)[1];
        bytes = Buffer.from(base64, 'base64');
      } else {
        const resp = await context.request.get(src);
        if (!resp.ok()) {
          const err = new Error(`clip ${i + 1} fetch failed: HTTP ${resp.status()}`);
          err.error_code = 'network';
          throw err;
        }
        bytes = await resp.body();
      }
      fs.writeFileSync(partPath, bytes);
      partPaths.push(partPath);
      console.log(`[flow-video] clip ${i + 1}/${clipSrcs.length} saved: ${bytes.length} bytes`);
    }

    let finalSize;
    if (isMockFixture) {
      // Mock fixture: data URLs aren't real mp4s, skip ffmpeg. Use the
      // last clip's bytes so mock tests that only check size > 0
      // continue to pass.
      fs.copyFileSync(partPaths[partPaths.length - 1], output_path);
      finalSize = fs.statSync(output_path).size;
    } else {
      // Real Flow: always run ffmpeg — even for N=1 — so single-clip
      // jobs also get the 1080p scale pass. Multi-clip jobs additionally
      // trim the per-seam overlap.
      const args = buildFfmpegArgs(partPaths, overlapSeconds, chosenAspect, output_path);
      console.log(
        `[flow-video] ffmpeg: ${partPaths.length} clip(s), overlap ${overlapSeconds}s, scale to 1080p (${chosenAspect})`
      );
      try {
        await runFfmpeg(args);
      } catch (e) {
        const err = new Error(`ffmpeg failed: ${e.message}\n${e.stderr || ''}`);
        err.error_code = 'network';
        throw err;
      }
      finalSize = fs.statSync(output_path).size;
    }

    // Clean up temp parts regardless of path taken.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    if (finalSize === 0) {
      const err = new Error('stitched output file is empty');
      err.error_code = 'network';
      throw err;
    }
    console.log(`[flow-video] saved ${finalSize} bytes → ${output_path}`);

    return {
      video_path: output_path,
      prompt_count: prompts.length,
      model: modelsUsed[0] || null,  // first clip's model (back-compat scalar)
      models: modelsUsed,             // full per-clip list (e.g. ['Quality','Fast','Quality'])
      aspect: chosenAspect,
      overlap_seconds: prompts.length > 1 ? overlapSeconds : null,
      clip_urls: clipSrcs,           // individual clip URLs, useful for debugging
    };
  } finally {
    if (context._ephemeral) await context.browser().close();
  }
}

module.exports = { runJob };
