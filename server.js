const express = require('express');
const path = require('node:path');
const queue = require('./lib/queue');
const { runJob, closeBrowser } = require('./lib/flow');

const VERSION = '0.1.0';

let browserConnected = false;
let loggedIn = false;
let workerBusy = false;

async function drainQueue() {
  if (workerBusy) return;
  const jobId = queue.shiftNext();
  if (!jobId) return;

  // Read env vars at call time so tests can set them before enqueueing.
  const rootDir = process.env.FLOW_ROOT_DIR || path.resolve(__dirname, '..', '..');
  const flowUrl = process.env.FLOW_URL_OVERRIDE || null;

  workerBusy = true;
  queue.markRunning(jobId);
  const job = queue.get(jobId);

  try {
    const { image_path } = await runJob({
      prompt: job.prompt,
      project_id: job.project_id,
      segment_id: job.segment_id,
      rootDir,
      flowUrl,
    });
    queue.markDone(jobId, { image_path });
    browserConnected = true;
    loggedIn = true;
  } catch (e) {
    queue.markError(jobId, {
      error: e.message || String(e),
      error_code: e.error_code || 'selector_missing',
    });
    if (e.error_code === 'browser_crashed') browserConnected = false;
    if (e.error_code === 'not_logged_in') loggedIn = false;
  } finally {
    workerBusy = false;
    // Cooldown between jobs so we don't look like a machine running a tight
    // loop. Random 5-15s jitter mimics a human glancing at the result before
    // starting the next prompt. Skipped in test mode (FLOW_URL_OVERRIDE is
    // set) so the mock-fixture test suite doesn't take forever.
    if (queue.depth() > 0 && !flowUrl) {
      const cooldown = 5000 + Math.floor(Math.random() * 10_000);
      setTimeout(drainQueue, cooldown);
    } else {
      setImmediate(drainQueue);
    }
  }
}

function createServer() {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      browser_connected: browserConnected,
      logged_in: loggedIn,
      queue_depth: queue.depth(),
      version: VERSION,
    });
  });

  app.post('/enqueue', (req, res) => {
    const { prompt, project_id, segment_id } = req.body || {};
    if (!prompt || typeof project_id !== 'number' || typeof segment_id !== 'number') {
      return res.status(400).json({ error: 'prompt, project_id, segment_id required' });
    }
    const jobId = queue.enqueue({ prompt, project_id, segment_id });
    setImmediate(drainQueue);
    res.json({ job_id: jobId, queue_position: queue.queuePositionOf(jobId) });
  });

  app.get('/status/:jobId', (req, res) => {
    const job = queue.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'unknown job' });
    res.json({
      status: job.status,
      project_id: job.project_id,
      segment_id: job.segment_id,
      image_path: job.image_path,
      error: job.error,
      error_code: job.error_code,
      started_at: job.started_at,
      finished_at: job.finished_at,
    });
  });

  return require('http').createServer(app);
}

module.exports = { createServer };

if (require.main === module) {
  const port = parseInt(process.env.FLOW_DAEMON_PORT || '47321', 10);
  const rootDir = process.env.FLOW_ROOT_DIR || path.resolve(__dirname, '..', '..');
  const server = createServer();
  server.listen(port, () => {
    console.log(`[flow-daemon] listening on 127.0.0.1:${port}`);
    console.log(`[flow-daemon] root dir: ${rootDir}`);
  });

  // Graceful shutdown: close Chromium cleanly so the profile's SingletonLock
  // gets released. If we skip this, the next daemon launch fails with
  // "Failed to create ProcessSingleton" because the lock still points at
  // a now-dead PID.
  const shutdown = async (signal) => {
    console.log(`[flow-daemon] ${signal} received, shutting down...`);
    server.close();
    await closeBrowser();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
