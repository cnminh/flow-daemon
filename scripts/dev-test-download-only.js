#!/usr/bin/env node
// Zero-quota test: exercise ONLY the new download path in lib/video.js
// against the clip we already generated (263ee334-...). Does NOT click
// Create or Extend. Proves the fetch-via-currentSrc strategy works
// end-to-end under real Flow DOM.
//
// Steps:
//   1. Launch Chromium against ~/.flow-daemon/profile/.
//   2. Navigate to the Flow project grid.
//   3. Click the first <video> clip (the newest = our lighthouse).
//   4. Run the exact download block that's now in lib/video.js:
//        - enumerate <video> srcs
//        - filter out gstatic.com motion presets
//        - fetch candidateSrcs[0] via context.request.get
//        - write bytes to output path
//   5. Verify the mp4.

const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { PROFILE_DIR } = require('../lib/browser');
const selectors = require('../lib/selectors');

const FLOW_URL = 'https://labs.google/fx/tools/flow/project/bcc73489-69d9-4621-974a-7168318a59d2';
const OUT = '/tmp/flow_video/download-only-test.mp4';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
try { fs.unlinkSync(OUT); } catch {}

(async () => {
  console.log(`[dl-only] opening ${FLOW_URL}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  await page.goto(FLOW_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(3000);

  // NEW: mirror the post-fix runJob — do NOT click into detail view;
  // read videos[0] directly from the grid (page.goto already landed here).
  // This validates the navigate-to-grid fix in commit 71fd93a.
  const videoSrcs = await page.$$eval(selectors.video.allVideos, (els) =>
    els.map((el) => el.currentSrc || el.src).filter((s) => !!s)
  );
  console.log(`[dl-only] ${videoSrcs.length} total <video> srcs found`);
  const candidateSrcs = videoSrcs.filter(
    (s) => !s.includes('gstatic.com') && !s.includes('/flow_camera/')
  );
  console.log(`[dl-only] ${candidateSrcs.length} candidate srcs after filtering presets`);
  if (candidateSrcs.length === 0) {
    console.error('[dl-only] FAIL: no downloadable src');
    process.exit(1);
  }
  const downloadSrc = candidateSrcs[0];
  console.log(`[dl-only] downloading ${downloadSrc.slice(0, 140)}`);

  let bytes;
  if (downloadSrc.startsWith('data:')) {
    const base64 = downloadSrc.split(',', 2)[1];
    bytes = Buffer.from(base64, 'base64');
  } else {
    const resp = await context.request.get(downloadSrc);
    if (!resp.ok()) {
      console.error(`[dl-only] FAIL: HTTP ${resp.status()}`);
      process.exit(1);
    }
    bytes = await resp.body();
  }

  fs.writeFileSync(OUT, bytes);
  const stat = fs.statSync(OUT);
  console.log(`[dl-only] wrote ${stat.size} bytes to ${OUT}`);

  // Also copy into tmp/dev-preview/ so user can watch on the preview page.
  const previewCopy = path.resolve(__dirname, '..', 'tmp', 'dev-preview', path.basename(OUT));
  fs.copyFileSync(OUT, previewCopy);
  console.log(`[dl-only] preview copy: ${path.basename(previewCopy)}`);

  // Cleanly close the context so we don't hold the profile lock.
  await context.close();
  console.log('[dl-only] done — SUCCESS');
  process.exit(0);
})().catch((e) => {
  console.error(`[dl-only] threw: ${e.message}`);
  process.exit(1);
});
