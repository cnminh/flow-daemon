// System test: end-to-end Google Flow image generation via the wizard UI.
//
// Preconditions:
//   - Phoenix running on http://localhost:4000
//   - Flow daemon running on http://127.0.0.1:47321
//   - Chromium profile at ~/.content-hub/flow-profile has a valid Google
//     session (Task 15 first-run login)
//   - video_projects.id=1 exists with at least one segment whose
//     image_prompt is set (we use segment id 249)
//
// What it verifies:
//   1. Wizard lands directly on Step 4 (reload-persistence)
//   2. Clicking "🎨 Tạo ảnh" on a segment triggers a real Flow generation
//   3. The daemon saves the image + DB updates within 3 minutes
//   4. The thumbnail appears in the UI
//   5. Clicking the thumbnail opens the fullscreen modal
//   6. Clicking ✕ closes the modal
//
// Runtime: ~2-3 minutes (one real Flow generation).
// Usage:   npm run test:e2e

const { chromium } = require('playwright');
const { execSync } = require('node:child_process');
const assert = require('node:assert/strict');

const BASE_URL = 'http://localhost:4000';
const SEGMENT_ID = 249; // Row id of segment at position 1 of project 1
const POLL_MAX_MS = 180_000; // 3 minutes

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// Reset the segment's generation state so the test always has a fresh
// "needs image" case to exercise.
function resetSegment() {
  log(`Resetting segment ${SEGMENT_ID} (media_path=NULL, flow_job_id=NULL)`);
  execSync(
    `psql -d content_hub_dev -c "UPDATE video_segments SET media_path = NULL, flow_job_id = NULL WHERE id = ${SEGMENT_ID}"`,
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );
}

async function ensureDaemonUp() {
  const res = await fetch('http://127.0.0.1:47321/health').catch(() => null);
  if (!res || !res.ok) throw new Error('Flow daemon not running on :47321');
  const body = await res.json();
  log(`Daemon: connected=${body.browser_connected} loggedIn=${body.logged_in} queue=${body.queue_depth}`);
}

async function main() {
  await ensureDaemonUp();
  resetSegment();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });

  try {
    // ── Step 1: Land on wizard ────────────────────────────────────────
    log(`Navigating to ${BASE_URL}/videos/1`);
    await page.goto(`${BASE_URL}/videos/1`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500); // let the LiveView websocket connect

    // ── Step 2: Verify we're on Step 4 ────────────────────────────────
    const step4Heading = page.locator('text=Bước 4: Tạo hình ảnh bằng Google Flow');
    await step4Heading.waitFor({ timeout: 5000 });
    log('✓ Landed directly on Step 4 (reload persistence works)');

    // ── Step 3: Locate segment 1's "🎨 Tạo ảnh" button ───────────────
    // The button has phx-value-segment-id with the segment's DB id.
    const genButton = page.locator(`button[phx-value-segment-id="${SEGMENT_ID}"]:has-text("Tạo ảnh")`);
    await genButton.waitFor({ timeout: 5000 });
    const enabled = await genButton.isEnabled();
    assert.equal(enabled, true, 'Generate button should be enabled when prompt is set');
    log('✓ Segment 1 "🎨 Tạo ảnh" button is visible and enabled');

    // ── Step 4: Click Generate ────────────────────────────────────────
    log('Clicking "🎨 Tạo ảnh"...');
    await genButton.click();

    // ── Step 5: Verify loading state appears ─────────────────────────
    // The segment's row should switch to showing a spinner + status label.
    await page.waitForTimeout(500);
    const statusText = await page.locator('text=/Trong hàng đợi|Đang tạo ảnh/').first().isVisible();
    assert.equal(statusText, true, 'Expected "queued" or "running" status to appear');
    log('✓ Loading state appeared (queued or running)');

    // ── Step 6: Wait up to 3 minutes for the thumbnail to show up ────
    log('Waiting up to 3 minutes for Flow to generate + polling to save...');
    const doneLabel = page.locator(`button[phx-value-segment-id="${SEGMENT_ID}"]:has-text("Regenerate")`);
    await doneLabel.waitFor({ timeout: POLL_MAX_MS, state: 'visible' });
    log('✓ "Regenerate" button appeared — job completed');

    // ── Step 7: Verify thumbnail img exists ──────────────────────────
    const thumbnail = page.locator('img[title="Click để xem ảnh lớn"]').first();
    await thumbnail.waitFor({ timeout: 2000 });
    const src = await thumbnail.getAttribute('src');
    assert.ok(
      /priv\/uploads\/video_projects\/1\/segments\/\d+\/flow\.png/.test(src),
      `Thumbnail src should point to local upload path; got: ${src}`
    );
    log(`✓ Thumbnail rendered: ${src}`);

    // ── Step 8: Click thumbnail to open modal ─────────────────────────
    log('Clicking thumbnail to open modal...');
    await thumbnail.click();
    await page.waitForTimeout(500);

    // ── Step 9: Verify modal is visible ───────────────────────────────
    const modalSelector = `#image-modal-${SEGMENT_ID}`;
    const modalVisible = await page.locator(modalSelector).isVisible();
    assert.equal(modalVisible, true, 'Modal should be visible after clicking thumbnail');

    const modalImg = page.locator(`${modalSelector} img`);
    const modalSrc = await modalImg.getAttribute('src');
    assert.equal(modalSrc, src, "Modal's full-size image src should match thumbnail's src");
    log('✓ Modal opened with full-size image');

    // ── Step 10: Close modal via ✕ button ────────────────────────────
    log('Clicking ✕ to close modal...');
    const closeBtn = page.locator(`${modalSelector} button[title="Close"]`);
    await closeBtn.click();
    await page.waitForTimeout(500);

    const modalHidden = !(await page.locator(modalSelector).isVisible());
    assert.equal(modalHidden, true, 'Modal should be hidden after clicking ✕');
    log('✓ Modal closed');

    // ── Step 11: Re-open and test backdrop-click to close ─────────────
    log('Testing backdrop-click to close...');
    await thumbnail.click();
    await page.waitForTimeout(500);
    // Click the outer modal container (the black backdrop) — not the inner
    // image container. Playwright's click targets the element center, which
    // for the backdrop is "empty space" not the image.
    await page.locator(modalSelector).click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(500);
    const modalHidden2 = !(await page.locator(modalSelector).isVisible());
    assert.equal(modalHidden2, true, 'Modal should close when clicking the backdrop');
    log('✓ Modal closes on backdrop click');

    log('');
    log('🎉 ALL END-TO-END CHECKS PASSED');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('❌ FAILED:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
