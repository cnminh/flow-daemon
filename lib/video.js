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

const DEFAULT_FLOW_URL = 'https://labs.google/fx/tools/flow/project/66894401-22dd-400e-b48c-2ac3ff84c969';
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

// Resolution → (long-edge, short-edge) dimensions. Flow's native source is
// 720p; 1080p and 4k are lanczos upscales, quality bounded by source.
const RESOLUTION_DIMS = {
  '720p':  { long: 1280, short: 720 },
  '1080p': { long: 1920, short: 1080 },
  '4k':    { long: 3840, short: 2160 },
};
const DEFAULT_RESOLUTION = '4k';

// ─── Ingredients-mode helpers ──────────────────────────────────────────
// Independent-scene rendering: each prompt makes its own clip with shared
// ingredient images as visual reference, then we ffmpeg-concat with
// crossfade (no extend chain → no character drift across scenes, but no
// motion continuity either; smooth-enough cuts via 200ms xfade default).
const DEFAULT_CROSSFADE_SECONDS = 0.2;

// Probe clip duration via ffprobe. Used to compute xfade offsets without
// assuming all clips are exactly 8s (Veo sometimes returns 7.5-8.2s).
function ffprobeDuration(filePath) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf8' }
    );
    const d = parseFloat(out.trim());
    if (!Number.isFinite(d) || d <= 0) throw new Error(`bad duration: ${out.trim()}`);
    return d;
  } catch (e) {
    throw new Error(`ffprobe failed for ${filePath}: ${e.message}`);
  }
}

// Build ffmpeg args: N independent clips → scale-pad to target → xfade
// chain (video) + acrossfade chain (audio). Output length =
// sum(durations) - (N-1) * crossfadeDur.
function buildFfmpegArgsXfade(partPaths, crossfadeDur, aspect, output, resolution) {
  const N = partPaths.length;
  if (N < 2) {
    // Single-clip → just scale, no xfade needed.
    return buildFfmpegArgs(partPaths, 0, aspect, output, resolution);
  }
  const durations = partPaths.map((p) => ffprobeDuration(p));
  const dims = RESOLUTION_DIMS[resolution || DEFAULT_RESOLUTION];
  const targetW = aspect === '16:9' ? dims.long : dims.short;
  const targetH = aspect === '16:9' ? dims.short : dims.long;

  const args = ['-v', 'error', '-y'];
  for (const p of partPaths) args.push('-i', p);

  const filters = [];
  const scalePad = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  // Pre-process each input: scale-pad + reset PTS.
  for (let i = 0; i < N; i += 1) {
    filters.push(`[${i}:v]${scalePad},setpts=PTS-STARTPTS[s${i}]`);
    filters.push(`[${i}:a]asetpts=PTS-STARTPTS[t${i}]`);
  }
  // Cumulative xfade chain. Offset for clip i+1 = sum(d[0..i]) - i*crossfadeDur.
  // First xfade: [s0][s1] offset = d[0] - crossfadeDur
  // Subsequent: [vK][s(K+1)] offset = (running output length) - crossfadeDur
  let runOut = durations[0];
  filters.push(
    `[s0][s1]xfade=transition=fade:duration=${crossfadeDur}:offset=${(runOut - crossfadeDur).toFixed(3)}[v01]`
  );
  filters.push(
    `[t0][t1]acrossfade=d=${crossfadeDur}[a01]`
  );
  let lastV = 'v01';
  let lastA = 'a01';
  runOut = runOut + durations[1] - crossfadeDur;
  for (let i = 2; i < N; i += 1) {
    const nextV = `v0${i}`;
    const nextA = `a0${i}`;
    filters.push(
      `[${lastV}][s${i}]xfade=transition=fade:duration=${crossfadeDur}:offset=${(runOut - crossfadeDur).toFixed(3)}[${nextV}]`
    );
    filters.push(
      `[${lastA}][t${i}]acrossfade=d=${crossfadeDur}[${nextA}]`
    );
    lastV = nextV;
    lastA = nextA;
    runOut = runOut + durations[i] - crossfadeDur;
  }

  args.push('-filter_complex', filters.join('; '));
  args.push('-map', `[${lastV}]`, '-map', `[${lastA}]`);
  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20');
  args.push('-c:a', 'aac');
  args.push('-movflags', '+faststart');
  args.push(output);
  return args;
}

// Build ffmpeg args for a trim+concat+scale of N clips.
// Clip 0 plays in full; clips 1..N-1 trim `overlap` seconds off the start.
// Each input is scaled-with-pad to the target dims (long edge × short edge,
// flipped for 9:16 portrait) before concat — a plain lanczos resize, not a
// learned upscale, so quality is bounded by the 720p source even at 4k. The
// scale-pad step also makes concat robust to Flow occasionally delivering
// a clip at an unexpected aspect mid-scene (we've seen clip 0 landscape +
// clip 1 portrait in the same job).
function buildFfmpegArgs(partPaths, overlap, aspect, output, resolution) {
  const args = ['-v', 'error', '-y'];
  for (const p of partPaths) args.push('-i', p);

  const N = partPaths.length;
  const dims = RESOLUTION_DIMS[resolution || DEFAULT_RESOLUTION];
  const targetW = aspect === '16:9' ? dims.long : dims.short;
  const targetH = aspect === '16:9' ? dims.short : dims.long;

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
  // Put moov atom at the start so browsers can stream-play without
  // downloading the whole file first. Without this, mobile/Tailscale
  // clients stall partway because the moov (index) sits at EOF.
  args.push('-movflags', '+faststart');
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
//   Default (randomExtends=false) → every clip uses 'Veo 3.1 - Quality'.
//     Prioritizes consistent quality across a scene; Fast extends can look
//     noticeably softer than a Quality clip 0.
//   randomExtends=true → clip 0 Quality, i>=1 random Quality/Fast. Keeps
//     motion variety between extends; Lite is excluded (too blocky for
//     long chains).
//   `override` (user --model flag) pins the entire chain to that one model.
function pickModelForIndex(i, override, randomExtends) {
  if (override) return override;
  if (i === 0) return 'Veo 3.1 - Quality';
  if (randomExtends) {
    const pool = ['Veo 3.1 - Quality', 'Veo 3.1 - Fast'];
    return pool[Math.floor(Math.random() * pool.length)];
  }
  return 'Veo 3.1 - Quality';
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
  // Flow's video mode defaults to x4 outputs per gen — burns 4x credits per
  // scene. We only download/keep one clip, so x1 is the right setting.
  const countMatch = label.match(/x(\d+)\b/);
  const currentCount = countMatch ? parseInt(countMatch[1], 10) : null;
  const countOK = currentCount === 1;

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

  if (!countOK) {
    const countTab = await page.waitForSelector(selectors.video.countTab(1), { timeout: 3000 })
      .catch(() => null);
    if (countTab) {
      console.log(`[flow-video] setting output count: 1x (was x${currentCount ?? '?'})`);
      await countTab.click();
      await humanPause(page, 1200, 2500);
    } else {
      console.log(`[flow-video] count=1 tab not found in popover — keeping current x${currentCount ?? '?'}`);
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

// Upload a starting frame for frames-to-video mode (iter 0 only).
//
// Two code paths diverge sharply:
//
// MOCK path — the fixture exposes framesTab + <input type=file> + a
// synthesized [data-frame-preview] element directly. Click tab, setInputFiles
// on the hidden input, wait for the preview. Simple, keeps the unit test
// hermetic without reproducing Flow's full multi-step UI.
//
// REAL Flow path — Flow's frame upload goes:
//   popover → Frames tab → Escape → canvas shows Start/End slot labels →
//   click "Start" → image library picker opens → scroll to bottom →
//   click "Upload image" → Terms popup (first time only) → click "I agree"
//   → native file chooser fires → Playwright intercepts → setFiles → wait
//   ~12s for Flow server to process the upload → Escape picker
//
// That flow is live-verified (scripts/dev-probe-frame-upload-v5.js). Key
// non-obvious bits: "Start" isn't a <button> (text selector required),
// "Upload image" is only visible after scroll, and the agreeButton is
// idempotent-skipped on subsequent uploads.
async function uploadFirstFrame(page, framePath, isMockFixture) {
  if (isMockFixture) {
    const framesTab = await page.waitForSelector(selectors.video.framesTab, { timeout: 2000 });
    console.log('[flow-video] (mock) switching to Frames-to-Video sub-mode');
    await framesTab.click();
    await humanPause(page, 1000, 2000);
    const fileInput = await page.waitForSelector('input[type="file"]', {
      timeout: 3000,
      state: 'attached',
    });
    await fileInput.setInputFiles(framePath);
    console.log(`[flow-video] (mock) uploaded frame: ${path.basename(framePath)}`);
    await page.waitForSelector(selectors.video.framePreview, { timeout: 5000 });
    return;
  }

  // Real Flow — re-open popover to reach Frames tab.
  const modeBtn = await page.waitForSelector(selectors.common.modeButton, { timeout: 2000 });
  console.log('[flow-video] re-opening mode popover for Frames tab');
  await modeBtn.click();
  await humanPause(page, 1000, 2000);

  const framesTab = await page.waitForSelector(selectors.video.framesTab, { timeout: 3000 });
  console.log('[flow-video] switching to Frames-to-Video sub-mode');
  await framesTab.click();
  await humanPause(page, 1000, 2000);
  await page.keyboard.press('Escape').catch(() => {});
  await humanPause(page, 800, 1600);

  // Start slot is a text label on the canvas, not a <button>.
  console.log('[flow-video] opening Start slot image picker');
  await page.locator(selectors.video.startSlotLabel).first().click();
  await humanPause(page, 2000, 3000);

  // "Upload image" lives at the bottom of the library. Scroll every
  // scrollable region so it's in view.
  for (let pass = 0; pass < 3; pass += 1) {
    await page.evaluate(() => {
      document.querySelectorAll('*').forEach((el) => {
        if (el.scrollHeight > el.clientHeight + 20) {
          el.scrollTop = el.scrollHeight;
        }
      });
    });
    await page.waitForTimeout(1200);
  }

  // Arm the filechooser listener BEFORE clicking Upload — it may fire
  // right away (subsequent uploads, no Terms popup) or after we click
  // "I agree" (first-time upload).
  console.log('[flow-video] clicking Upload image');
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 25_000 }).catch(() => null);
  await page.locator(selectors.video.uploadImageOption).first().click();
  await humanPause(page, 1500, 2500);

  const agreeBtn = await page.locator(selectors.video.agreeButton).first();
  const agreeVisible = await agreeBtn.isVisible().catch(() => false);
  if (agreeVisible) {
    console.log('[flow-video] accepting Flow Terms of Use (first-upload prompt)');
    await agreeBtn.click();
    await humanPause(page, 1000, 2000);
  }

  const chooser = await chooserPromise;
  if (!chooser) {
    const err = new Error('file chooser did not fire after Upload image click');
    err.error_code = 'selector_missing';
    throw err;
  }
  await chooser.setFiles(framePath);
  console.log(`[flow-video] frame uploaded: ${path.basename(framePath)}`);

  // Real Flow has no single reliable success selector. Time-series probe
  // (dev-probe-frame-upload-v5) showed upload lands within 10-15s. Fixed
  // wait is pragmatic; will refine if we find a stable signal later.
  await page.waitForTimeout(12_000);
  await page.keyboard.press('Escape').catch(() => {});
  await humanPause(page, 1000, 2000);
}

// Switch to Ingredients sub-mode + upload up to 3 reference images via the
// hidden multi-file input. Mutually exclusive with Frames mode (Veo UI
// constraint — pick one per scene).
//
// Mock fixture path mirrors uploadFirstFrame's mock: click tab, set files
// on the first <input type=file>, no agree-button or chooser dance.
//
// Real Flow path: re-open popover → Ingredients tab → close popover →
// setInputFiles directly on the hidden multi-file input. Native chooser
// is bypassed because the input is multi-file and lives in the DOM
// without Frames' "library picker → Upload image → Terms popup" wrapper.
async function setupIngredientsMode(page, ingredientsPaths, isMockFixture) {
  if (!Array.isArray(ingredientsPaths) || ingredientsPaths.length === 0) {
    const err = new Error('ingredientsPaths must be a non-empty array');
    err.error_code = 'selector_missing';
    throw err;
  }
  if (ingredientsPaths.length > 3) {
    const err = new Error(`ingredients_paths max 3 (got ${ingredientsPaths.length})`);
    err.error_code = 'selector_missing';
    throw err;
  }
  for (const p of ingredientsPaths) {
    if (!fs.existsSync(p)) {
      const err = new Error(`ingredient path does not exist: ${p}`);
      err.error_code = 'frame_invalid';
      throw err;
    }
  }

  if (isMockFixture) {
    const tab = await page.waitForSelector(selectors.video.ingredientsTab, { timeout: 2000 });
    console.log('[flow-video] (mock) switching to Ingredients sub-mode');
    await tab.click();
    await humanPause(page, 500, 1200);
    // Target the MULTI-file input specifically — not the single Frame input
    // which lives in the same DOM. Real Flow uses the same selector.
    const fileInput = await page.waitForSelector(selectors.video.ingredientsFileInput, {
      timeout: 3000,
      state: 'attached',
    });
    await fileInput.setInputFiles(ingredientsPaths);
    console.log(
      `[flow-video] (mock) uploaded ${ingredientsPaths.length} ingredient(s): ${ingredientsPaths.map((p) => path.basename(p)).join(', ')}`
    );
    return;
  }

  // Real Flow — re-open popover to reach Ingredients tab.
  const modeBtn = await page.waitForSelector(selectors.common.modeButton, { timeout: 2000 });
  console.log('[flow-video] re-opening mode popover for Ingredients tab');
  await modeBtn.click();
  await humanPause(page, 1000, 2000);

  const tab = await page.waitForSelector(selectors.video.ingredientsTab, { timeout: 3000 });
  console.log('[flow-video] switching to Ingredients sub-mode');
  await tab.click();
  await humanPause(page, 1000, 2000);
  await page.keyboard.press('Escape').catch(() => {});
  await humanPause(page, 800, 1600);

  // The hidden multi-file input. setInputFiles takes an array → uploads
  // all in one call (vs Frames mode which only takes 1 frame).
  const fileInput = await page.waitForSelector(
    selectors.video.ingredientsFileInput,
    { timeout: 5000, state: 'attached' }
  );
  await fileInput.setInputFiles(ingredientsPaths);
  console.log(
    `[flow-video] ingredients uploaded (${ingredientsPaths.length}): ${ingredientsPaths.map((p) => path.basename(p)).join(', ')}`
  );

  // No reliable single-selector for upload completion — match Frames-mode
  // pragmatic 12s wait. Refine later if a stable signal surfaces.
  await page.waitForTimeout(12_000);
}

async function runJob({
  prompts,
  frame_path,
  ingredients_paths,
  output_path,
  flowUrl,
  timeoutMs,
  model,
  aspect,
  overlap_seconds,
  crossfade_seconds,
  random_extends_model,
  resolution,
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

  // Mode selection: extend (default, with optional --frame) or ingredients.
  // Veo UI constraint: Frames and Ingredients sub-modes are mutually exclusive,
  // so frame_path and ingredients_paths cannot both be set.
  if (frame_path && Array.isArray(ingredients_paths) && ingredients_paths.length > 0) {
    const err = new Error('frame_path and ingredients_paths are mutually exclusive (Veo UI constraint — pick one)');
    err.error_code = 'selector_missing';
    throw err;
  }
  const useIngredients = Array.isArray(ingredients_paths) && ingredients_paths.length > 0;

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
  if (useIngredients) {
    if (ingredients_paths.length > 3) {
      const err = new Error(`ingredients_paths max 3 (got ${ingredients_paths.length})`);
      err.error_code = 'selector_missing';
      throw err;
    }
    for (const p of ingredients_paths) {
      if (!fs.existsSync(p)) {
        const err = new Error(`ingredient path does not exist: ${p}`);
        err.error_code = 'frame_invalid';
        throw err;
      }
      const ext = path.extname(p).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        const err = new Error(`ingredient must be .png/.jpg/.webp: ${p}`);
        err.error_code = 'frame_invalid';
        throw err;
      }
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
  const chosenResolution = resolution || DEFAULT_RESOLUTION;
  if (!RESOLUTION_DIMS[chosenResolution]) {
    const err = new Error(`resolution must be one of ${Object.keys(RESOLUTION_DIMS).join(', ')} (got ${JSON.stringify(chosenResolution)})`);
    err.error_code = 'selector_missing';
    throw err;
  }
  const randomExtends = Boolean(random_extends_model);
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

    // Iterate prompts. Two modes:
    //
    //   Extend mode (default, when frame_path set or no ingredients):
    //     iter 0 = initial Create on grid; iter 1..N-1 = Extend clicks
    //     within the resulting scene's detail view. Each clip seeds from
    //     the prior clip's last frame → motion continuity but cumulative
    //     character drift across scenes.
    //
    //   Ingredients mode (when ingredients_paths set, mutually exclusive
    //     with frame_path): iter 0 sets up Video + Ingredients + uploads
    //     the references once. Iter 0..N-1 each = INDEPENDENT new-scene
    //     creates with the same ingredient set as visual reference. No
    //     extend chain → no character drift (each scene re-references the
    //     ingredient image), but no motion continuity either. ffmpeg
    //     concat with crossfade smooths the cuts.
    const modelsUsed = [];
    const clipSrcs = [];
    let completedPromptCount = 0;
    for (let i = 0; i < prompts.length; i += 1) {
      const prompt = prompts[i];
      const isExtend = i > 0 && !useIngredients;
      const modelForThisClip = pickModelForIndex(i, model, randomExtends);

      try {
        // Set the model for THIS clip, using the right dropdown for the
        // current context:
        //   - iter 0 (on project grid): new-scene popover dropdown. This
        //     is what Flow consults for a Create-from-scratch.
        //   - iter 1+ extend (already in clip detail view at this point —
        //     we entered it at the END of the previous iteration): inline
        //     dropdown on the detail / extend-prompt view.
        //   - iter 1+ ingredients: back on the grid (we navigate back at
        //     end of each iter), so use the new-scene dropdown again.
        if (!isExtend) {
          await ensureVideoModeForNewScene(page, modelForThisClip, chosenAspect, isMockFixture);
          // Frames-to-video: upload the starting frame AFTER Video mode is
          // set (frames tab lives inside the mode popover).
          // Ingredients-to-video: upload up to 3 reference images (same
          // popover, different sub-mode tab). Only on iter 0 — uploads
          // persist across calls within the project session.
          if (i === 0 && frame_path) {
            await uploadFirstFrame(page, frame_path, isMockFixture);
          }
          if (i === 0 && useIngredients) {
            await setupIngredientsMode(page, ingredients_paths, isMockFixture);
          }
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
        if (i < prompts.length - 1 && !isMockFixture) {
          if (useIngredients) {
            // Ingredients mode: navigate back to project grid so next iter
            // sees the new-scene popover (Create-from-scratch context, NOT
            // extend context). Flow may have auto-navigated to scene-detail
            // after Create — page.goto() resets cleanly.
            console.log('[flow-video] navigating back to project grid for next ingredients clip');
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await humanPause(page, 2000, 3500);
          } else {
            // Extend mode: click into the newest clip's detail view so the
            // next iteration is positioned for extend (inline model dropdown
            // + Extend button). The <video> element is often display:none
            // until hovered; clicking its wrapper (xpath=..) is more robust
            // than the media element directly. Fallback to grandparent.
            const latestClipParent = page.locator(selectors.video.allVideos).first().locator('xpath=..');
            await latestClipParent.click({ force: true, timeout: 5000 }).catch(async () => {
              await page.locator(selectors.video.allVideos).first().locator('xpath=../..').click({ force: true, timeout: 5000 });
            });
            await humanPause(page, 1500, 3000);
          }

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
        if (useIngredients && i > 0) {
          // Ingredients mode mid-chain failure (independent scene N>0).
          // No "extend chain" but track partial progress so caller can
          // resume from where we stopped.
          const err = new Error(`ingredients clip ${i + 1} failed: ${e.message}`);
          err.error_code = e.error_code || 'timeout';
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
      // jobs also get the resolution scale pass.
      // Extend mode: trim per-seam overlap (Veo replays ~1s of prior
      // clip at extend-clip start) before hard-concat.
      // Ingredients mode: independent clips, no overlap to trim → use
      // xfade chain with `crossfade_seconds` (default 200ms) for smooth
      // transitions instead of hard cuts.
      let args;
      if (useIngredients && partPaths.length > 1) {
        const xfadeDur = typeof crossfade_seconds === 'number'
          ? crossfade_seconds
          : DEFAULT_CROSSFADE_SECONDS;
        console.log(
          `[flow-video] ffmpeg: ${partPaths.length} clip(s) ingredients-mode, crossfade ${xfadeDur}s, scale to ${chosenResolution} (${chosenAspect})`
        );
        args = buildFfmpegArgsXfade(partPaths, xfadeDur, chosenAspect, output_path, chosenResolution);
      } else {
        console.log(
          `[flow-video] ffmpeg: ${partPaths.length} clip(s), overlap ${overlapSeconds}s, scale to ${chosenResolution} (${chosenAspect})`
        );
        args = buildFfmpegArgs(partPaths, overlapSeconds, chosenAspect, output_path, chosenResolution);
      }
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
      resolution: chosenResolution,
      mode: useIngredients ? 'ingredients' : 'extend',
      overlap_seconds: !useIngredients && prompts.length > 1 ? overlapSeconds : null,
      crossfade_seconds: useIngredients && prompts.length > 1
        ? (typeof crossfade_seconds === 'number' ? crossfade_seconds : DEFAULT_CROSSFADE_SECONDS)
        : null,
      ingredients_count: useIngredients ? ingredients_paths.length : 0,
      clip_urls: clipSrcs,           // individual clip URLs, useful for debugging
    };
  } finally {
    if (context._ephemeral) await context.browser().close();
  }
}

module.exports = { runJob, pickModelForIndex, buildFfmpegArgs, buildFfmpegArgsXfade, RESOLUTION_DIMS };
