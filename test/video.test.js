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
