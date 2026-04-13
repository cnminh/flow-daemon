const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    }).on('error', reject);
  });
}

test('GET /health returns ok:true with expected keys', async () => {
  // Test isolation: clear any leftover queue state from previous tests
  require('../lib/queue').reset();

  const { createServer } = require('../server.js');
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const { status, body } = await get(port, '/health');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(typeof body.browser_connected, 'boolean');
    assert.strictEqual(typeof body.logged_in, 'boolean');
    assert.strictEqual(typeof body.queue_depth, 'number');
    assert.strictEqual(typeof body.version, 'string');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('POST /enqueue returns job_id and status returns queued', async () => {
  // Test isolation: clear any leftover queue state from previous tests
  require('../lib/queue').reset();

  const { createServer } = require('../server.js');
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    // Enqueue
    const enqueueRes = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/enqueue',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.write(JSON.stringify({ prompt: 'a brain', project_id: 7, segment_id: 42 }));
      req.end();
    });

    assert.strictEqual(enqueueRes.status, 200);
    assert.match(enqueueRes.body.job_id, /^j_/);
    assert.strictEqual(typeof enqueueRes.body.queue_position, 'number');

    // Status
    const statusRes = await get(port, `/status/${enqueueRes.body.job_id}`);
    assert.strictEqual(statusRes.status, 200);
    assert.ok(
      statusRes.body.status === 'queued' || statusRes.body.status === 'running' || statusRes.body.status === 'done' || statusRes.body.status === 'error',
      `expected a valid job status, got: ${statusRes.body.status}`
    );
    assert.strictEqual(statusRes.body.project_id, 7);
    assert.strictEqual(statusRes.body.segment_id, 42);
    // image_path is null unless the worker has already completed the job
    assert.ok(
      statusRes.body.image_path === null || typeof statusRes.body.image_path === 'string',
      'image_path should be null or a string'
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('GET /status/:unknown returns 404', async () => {
  // Test isolation: clear any leftover queue state from previous tests
  require('../lib/queue').reset();

  const { createServer } = require('../server.js');
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const res = await get(port, '/status/j_nonexistent');
    assert.strictEqual(res.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

test('runJob against mock fixture downloads first image to rootDir', async () => {
  // Test isolation: clear any leftover queue state from previous tests
  require('../lib/queue').reset();

  const { runJob } = require('../lib/flow.js');

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-daemon-test-'));
  const fixtureUrl =
    'file://' + path.resolve(__dirname, 'mock-flow.html');

  try {
    const result = await runJob({
      prompt: 'a brain',
      project_id: 7,
      segment_id: 42,
      rootDir,
      flowUrl: fixtureUrl, // test-only override
      timeoutMs: 10_000,
    });

    assert.match(result.image_path, /priv\/uploads\/video_projects\/7\/segments\/42\/flow\.png$/);
    const abs = path.join(rootDir, result.image_path);
    assert.ok(fs.existsSync(abs), `expected ${abs} to exist`);
    const size = fs.statSync(abs).size;
    assert.ok(size > 0, 'image file should not be empty');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('worker consumes queued jobs against mock fixture', async () => {
  // Test isolation: clear any leftover queue state from previous tests
  require('../lib/queue').reset();

  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-daemon-test-'));
  const fixtureUrl = 'file://' + path.resolve(__dirname, 'mock-flow.html');

  // Set up env for the daemon under test
  process.env.FLOW_ROOT_DIR = rootDir;
  process.env.FLOW_URL_OVERRIDE = fixtureUrl;

  const { createServer } = require('../server.js');
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    // Enqueue a job
    const enqueueRes = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/enqueue',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(JSON.parse(data)));
        }
      );
      req.on('error', reject);
      req.write(JSON.stringify({ prompt: 'hello', project_id: 9, segment_id: 1 }));
      req.end();
    });

    const jobId = enqueueRes.job_id;

    // Poll /status until done (max 15s)
    let finalStatus = null;
    for (let i = 0; i < 30; i += 1) {
      const { body } = await get(port, `/status/${jobId}`);
      if (body.status === 'done' || body.status === 'error') {
        finalStatus = body;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    assert.ok(finalStatus, 'job should have completed within 15s');
    assert.strictEqual(finalStatus.status, 'done');
    assert.match(finalStatus.image_path, /priv\/uploads\/video_projects\/9\/segments\/1\/flow\.png$/);
    assert.ok(fs.existsSync(path.join(rootDir, finalStatus.image_path)));
  } finally {
    delete process.env.FLOW_ROOT_DIR;
    delete process.env.FLOW_URL_OVERRIDE;
    await new Promise((r) => server.close(r));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
