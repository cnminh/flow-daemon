const express = require('express');
const path = require('node:path');
const queue = require('./lib/queue');
const imageRunner = require('./lib/image');
const videoRunner = require('./lib/video');
const { closeBrowser } = require('./lib/browser');

const VERSION = '0.2.0';

// Idle auto-shutdown: after N minutes of no activity (queue empty + worker
// idle + no enqueues), the daemon closes Chromium cleanly and exits. The
// CLI's auto-start handles bringing it back up on the next `flow-cli
// generate` call. Set FLOW_DAEMON_IDLE_TIMEOUT_MIN=0 to disable.
const IDLE_TIMEOUT_MIN = parseInt(process.env.FLOW_DAEMON_IDLE_TIMEOUT_MIN || '30', 10);

let browserConnected = false;
let loggedIn = false;
let workerBusy = false;
let lastActivityAt = Date.now();

function touchActivity() {
  lastActivityAt = Date.now();
}

async function drainQueue() {
  if (workerBusy) return;
  const jobId = queue.shiftNext();
  if (!jobId) return;

  const rootDir = process.env.FLOW_ROOT_DIR || path.resolve(__dirname, '..', '..');
  const flowUrl = process.env.FLOW_URL_OVERRIDE || null;

  workerBusy = true;
  touchActivity();
  queue.markRunning(jobId);
  const job = queue.get(jobId);
  const p = job.payload;

  try {
    let result;
    if (p.type === 'video') {
      result = await videoRunner.runJob({
        prompts: p.prompts,
        frame_path: p.frame_path || null,
        output_path: p.output_path,
        flowUrl,
        model: p.model,
        aspect: p.aspect,
        overlap_seconds: p.overlap_seconds,
      });
    } else {
      result = await imageRunner.runJob({
        prompt: p.prompt,
        project_id: p.project_id,
        segment_id: p.segment_id,
        output_path: p.output_path,
        rootDir,
        flowUrl,
      });
    }
    queue.markDone(jobId, result);
    browserConnected = true;
    loggedIn = true;
  } catch (e) {
    queue.markError(jobId, {
      error: e.message || String(e),
      error_code: e.error_code || 'selector_missing',
      failed_at_index: e.failed_at_index,
      completed_prompts: e.completed_prompts,
    });
    if (e.error_code === 'browser_crashed') browserConnected = false;
    if (e.error_code === 'profile_locked') browserConnected = false;
    if (e.error_code === 'not_logged_in') loggedIn = false;
  } finally {
    workerBusy = false;
    touchActivity();
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
    let currentJobInfo = null;
    if (current) {
      const p = current.payload;
      currentJobInfo = {
        job_id: current.job_id,
        type: p.type || 'image',
        started_at: current.started_at,
        output_path: p.output_path,
      };
      if (p.type === 'video') {
        currentJobInfo.prompt_count = p.prompts ? p.prompts.length : null;
      } else {
        currentJobInfo.prompt = p.prompt && p.prompt.length > 120
          ? p.prompt.slice(0, 120) + '...'
          : p.prompt;
        currentJobInfo.project_id = p.project_id;
        currentJobInfo.segment_id = p.segment_id;
      }
    }
    res.json({
      ok: true,
      browser_connected: browserConnected,
      logged_in: loggedIn,
      worker_busy: workerBusy,
      queue_depth: queue.depth(),
      current_job: currentJobInfo,
      version: VERSION,
    });
  });

  app.post('/enqueue', (req, res) => {
    const body = req.body || {};

    // Discriminate by body shape: `prompts` array → video; `prompt` string → image.
    if (Array.isArray(body.prompts)) {
      const { prompts, frame_path, output_path, model, aspect, overlap_seconds } = body;
      if (!prompts.every((p) => typeof p === 'string' && p.length > 0)) {
        return res.status(400).json({ error: 'prompts must be non-empty strings' });
      }
      if (typeof output_path !== 'string' || !path.isAbsolute(output_path)) {
        return res.status(400).json({ error: 'output_path required and must be absolute for video jobs' });
      }
      if (aspect && !['16:9', '9:16'].includes(aspect)) {
        return res.status(400).json({ error: 'aspect must be "16:9" or "9:16"' });
      }
      if (overlap_seconds !== undefined && (typeof overlap_seconds !== 'number' || overlap_seconds < 0)) {
        return res.status(400).json({ error: 'overlap_seconds must be a non-negative number' });
      }
      const jobId = queue.enqueue({
        type: 'video',
        prompts,
        frame_path: frame_path || null,
        output_path,
        model: model || null,
        aspect: aspect || '9:16',
        overlap_seconds,
      });
      touchActivity();
      setImmediate(drainQueue);
      return res.json({ job_id: jobId, queue_position: queue.queuePositionOf(jobId) });
    }

    // Image path (unchanged back-compat).
    const { prompt, project_id, segment_id, output_path } = body;
    if (!prompt) {
      return res.status(400).json({ error: 'prompt required' });
    }
    const hasOutputPath = typeof output_path === 'string' && output_path.length > 0;
    const hasIds = typeof project_id === 'number' && typeof segment_id === 'number';
    if (!hasOutputPath && !hasIds) {
      return res.status(400).json({
        error: 'either output_path OR (project_id + segment_id) required',
      });
    }
    const jobId = queue.enqueue({
      type: 'image',
      prompt,
      project_id,
      segment_id,
      output_path: output_path || null,
    });
    touchActivity();
    setImmediate(drainQueue);
    res.json({ job_id: jobId, queue_position: queue.queuePositionOf(jobId) });
  });

  app.get('/status/:jobId', (req, res) => {
    const job = queue.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'unknown job' });
    const p = job.payload;
    const r = job.result || {};

    const base = {
      status: job.status,
      type: p.type || 'image',
      output_path: p.output_path,
      error: job.error,
      error_code: job.error_code,
      started_at: job.started_at,
      finished_at: job.finished_at,
    };

    if (p.type === 'video') {
      return res.json({
        ...base,
        video_path: r.video_path || null,
        prompt_count: r.prompt_count || (p.prompts ? p.prompts.length : null),
        model: r.model || null,
        aspect: r.aspect || null,
        failed_at_index: job.failed_at_index,
        completed_prompts: job.completed_prompts,
      });
    }
    res.json({
      ...base,
      project_id: p.project_id,
      segment_id: p.segment_id,
      image_path: r.image_path || null,
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
    if (IDLE_TIMEOUT_MIN > 0) {
      console.log(`[flow-daemon] idle auto-shutdown after ${IDLE_TIMEOUT_MIN}min`);
    }
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

  // Idle watchdog: every minute, if nothing is queued/running and we've been
  // idle for >= IDLE_TIMEOUT_MIN minutes, shut down. The CLI's ensureDaemonUp
  // restarts us on the next generate. Setting the env var to 0 disables it.
  if (IDLE_TIMEOUT_MIN > 0) {
    setInterval(async () => {
      if (workerBusy || queue.depth() > 0) return;
      const idleMs = Date.now() - lastActivityAt;
      if (idleMs < IDLE_TIMEOUT_MIN * 60_000) return;
      console.log(
        `[flow-daemon] idle ${Math.round(idleMs / 60_000)}min ≥ ${IDLE_TIMEOUT_MIN}min — shutting down`
      );
      server.close();
      await closeBrowser();
      process.exit(0);
    }, 60_000).unref();
  }

  return server;
}

module.exports = { createServer, start };

if (require.main === module) {
  start();
}
