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
      output_path: job.output_path,
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
    const current = queue.currentJob();
    res.json({
      ok: true,
      browser_connected: browserConnected,
      logged_in: loggedIn,
      worker_busy: workerBusy,
      queue_depth: queue.depth(),
      current_job: current
        ? {
            job_id: current.job_id,
            prompt: current.prompt && current.prompt.length > 120
              ? current.prompt.slice(0, 120) + '...'
              : current.prompt,
            started_at: current.started_at,
            output_path: current.output_path,
            project_id: current.project_id,
            segment_id: current.segment_id,
          }
        : null,
      version: VERSION,
    });
  });

  app.post('/enqueue', (req, res) => {
    const { prompt, project_id, segment_id, output_path } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ error: 'prompt required' });
    }
    // Either output_path OR (project_id + segment_id) must be provided so
    // the daemon knows where to save the file.
    const hasOutputPath = typeof output_path === 'string' && output_path.length > 0;
    const hasIds = typeof project_id === 'number' && typeof segment_id === 'number';
    if (!hasOutputPath && !hasIds) {
      return res.status(400).json({
        error: 'either output_path OR (project_id + segment_id) required',
      });
    }
    const jobId = queue.enqueue({ prompt, project_id, segment_id, output_path });
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
      output_path: job.output_path,
      image_path: job.image_path,
      error: job.error,
      error_code: job.error_code,
      started_at: job.started_at,
      finished_at: job.finished_at,
    });
  });

  return require('http').createServer(app);
}

// Start the daemon: bind the HTTP server, install signal handlers, log.
// Exported so flow-cli (or another embedder) can launch the daemon
// without relying on `require.main === module` semantics.
function start({ port = parseInt(process.env.FLOW_DAEMON_PORT || '47321', 10),
                 rootDir = process.env.FLOW_ROOT_DIR || path.resolve(__dirname) } = {}) {
  const server = createServer();
  server.listen(port, () => {
    console.log(`[flow-daemon] listening on 127.0.0.1:${port}`);
    console.log(`[flow-daemon] root dir: ${rootDir}`);
  });

  // Graceful shutdown: close Chromium cleanly so the profile's SingletonLock
  // gets released. Skipping this means the next launch fails with
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

  return server;
}

module.exports = { createServer, start };

if (require.main === module) {
  start();
}
