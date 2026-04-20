const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Hermetic fixture path. The video mock lives at test/mock-flow-video.html.
const MOCK_URL = 'file://' + path.resolve(__dirname, 'mock-flow-video.html');

const PROMPT_POOL = [
  'A weathered wooden bridge over a mountain stream in late autumn, morning mist, cinematic 16:9',
  'An elderly woman reading under a reading lamp in a cozy library, warm tungsten light',
  'A lone fisherman in a wooden boat at sunrise on a glass-calm lake, silhouette',
  'A misty pine forest at dawn, shafts of golden sunlight piercing the fog',
];

function randomPrompt() {
  return PROMPT_POOL[Math.floor(Math.random() * PROMPT_POOL.length)];
}

test('video.runJob produces an mp4 from a single prompt (mock fixture)', async () => {
  require('../lib/queue').reset();

  const { runJob } = require('../lib/video');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-test-'));
  const outputPath = path.join(outputDir, 'single.mp4');

  try {
    const result = await runJob({
      prompts: [randomPrompt()],
      output_path: outputPath,
      flowUrl: MOCK_URL,
      timeoutMs: 10_000,
    });

    assert.strictEqual(result.video_path, outputPath);
    assert.strictEqual(result.prompt_count, 1);
    assert.ok(fs.existsSync(outputPath), `expected ${outputPath} to exist`);
    assert.ok(fs.statSync(outputPath).size > 0, 'mp4 should not be empty');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('video.runJob handles a 3-prompt extend chain (mock fixture)', async () => {
  require('../lib/queue').reset();

  const { runJob } = require('../lib/video');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-test-'));
  const outputPath = path.join(outputDir, 'three-clip.mp4');

  try {
    const result = await runJob({
      prompts: [randomPrompt(), randomPrompt(), randomPrompt()],
      output_path: outputPath,
      flowUrl: MOCK_URL,
      timeoutMs: 10_000,
    });

    assert.strictEqual(result.prompt_count, 3);
    assert.ok(fs.existsSync(outputPath));
    assert.ok(fs.statSync(outputPath).size > 0);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('video.runJob fails with extend_failed at index 1 when clip 2 does not render', async () => {
  require('../lib/queue').reset();

  const { runJob } = require('../lib/video');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-test-'));
  const outputPath = path.join(outputDir, 'failed.mp4');

  try {
    await assert.rejects(
      async () => {
        await runJob({
          prompts: [randomPrompt(), randomPrompt(), randomPrompt()],
          output_path: outputPath,
          // failat=2 → the 2nd Create click (first Extend's Create) produces
          // no <video>, simulating a clip that never finishes rendering.
          flowUrl: MOCK_URL + '?failat=2',
          timeoutMs: 2_000,
        });
      },
      (err) => {
        assert.strictEqual(err.error_code, 'extend_failed');
        assert.strictEqual(err.failed_at_index, 1);
        assert.strictEqual(err.completed_prompts, 1);
        return true;
      }
    );
    assert.ok(!fs.existsSync(outputPath), 'no mp4 should have been written');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('video.runJob with valid --frame uploads and produces mp4', async () => {
  require('../lib/queue').reset();

  const { runJob } = require('../lib/video');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-test-'));
  const outputPath = path.join(outputDir, 'with-frame.mp4');

  // Write a tiny valid 1x1 red PNG.
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64'
  );
  const framePath = path.join(outputDir, 'hero.png');
  fs.writeFileSync(framePath, pngBytes);

  try {
    const result = await runJob({
      prompts: [randomPrompt()],
      frame_path: framePath,
      output_path: outputPath,
      flowUrl: MOCK_URL,
      timeoutMs: 10_000,
    });

    assert.strictEqual(result.video_path, outputPath);
    assert.ok(fs.existsSync(outputPath));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('video.runJob rejects missing frame with frame_invalid', async () => {
  require('../lib/queue').reset();

  const { runJob } = require('../lib/video');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-test-'));

  try {
    await assert.rejects(
      async () => {
        await runJob({
          prompts: [randomPrompt()],
          frame_path: '/does/not/exist.png',
          output_path: path.join(outputDir, 'x.mp4'),
          flowUrl: MOCK_URL,
          timeoutMs: 5_000,
        });
      },
      (err) => {
        assert.strictEqual(err.error_code, 'frame_invalid');
        return true;
      }
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('video.runJob rejects non-image frame path with frame_invalid', async () => {
  require('../lib/queue').reset();

  const { runJob } = require('../lib/video');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-test-'));
  const notAnImage = path.join(outputDir, 'notes.txt');
  fs.writeFileSync(notAnImage, 'hello world');

  try {
    await assert.rejects(
      async () => {
        await runJob({
          prompts: [randomPrompt()],
          frame_path: notAnImage,
          output_path: path.join(outputDir, 'x.mp4'),
          flowUrl: MOCK_URL,
          timeoutMs: 5_000,
        });
      },
      (err) => {
        assert.strictEqual(err.error_code, 'frame_invalid');
        return true;
      }
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
