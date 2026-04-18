#!/usr/bin/env node
// flow-cli — control the Flow daemon and run one-shot generations.
//
// Subcommands:
//   daemon                Start the HTTP daemon (foreground)
//   health                Print daemon health JSON
//   status                Human-readable idle/busy snapshot
//   generate [PROMPT]     Enqueue an image generation, wait for completion.
//                         Auto-starts the daemon in the background if not
//                         running. Kills any zombie holding the port first.
//                         Daemon logs go to ~/.flow-daemon/daemon.log.
//
// Env:
//   FLOW_DAEMON_PORT   HTTP port for daemon (default 47321)
//   FLOW_DAEMON_URL    Override base URL (default http://127.0.0.1:$PORT)
//   FLOW_ROOT_DIR      Where the daemon writes images (default cwd for CLI)
//   FLOW_URL_OVERRIDE  Daemon-side: override https://labs.google/... URL

const path = require('node:path');
const os = require('node:os');
const {
  sleep,
  parseFlags,
  readStdin,
  ensureDaemonUp,
} = require('../lib/cli-shared');

const PORT = process.env.FLOW_DAEMON_PORT || '47321';
const URL = process.env.FLOW_DAEMON_URL || `http://127.0.0.1:${PORT}`;
const LOG_DIR = path.join(os.homedir(), '.flow-daemon');
const LOG_FILE = path.join(LOG_DIR, 'daemon.log');
const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');

const cmd = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (cmd) {
    case 'daemon': return runDaemon();
    case 'health': return cmdHealth();
    case 'status': return cmdStatus();
    case 'generate': return cmdGenerate(args);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      printHelp();
      process.exit(1);
  }
}

function runDaemon() {
  // Delegate to server.js's exported start() — bind port, install signal
  // handlers, log readiness. The function returns the http.Server which we
  // ignore here; the event loop stays alive because of the listening socket.
  const { start } = require('../server.js');
  start();
}

async function cmdHealth() {
  let res;
  try {
    res = await fetch(`${URL}/health`);
  } catch (e) {
    console.error(`daemon not reachable on ${URL}: ${e.message}`);
    process.exit(2);
  }
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
}

// Short, human-readable snapshot: is the daemon busy right now?
async function cmdStatus() {
  let body;
  try {
    const res = await fetch(`${URL}/health`);
    body = await res.json();
  } catch (e) {
    console.error(`daemon not reachable on ${URL}: ${e.message}`);
    process.exit(2);
  }

  if (body.worker_busy && body.current_job) {
    const j = body.current_job;
    const startedMs = j.started_at ? Date.now() - new Date(j.started_at).getTime() : 0;
    const elapsed = Math.floor(startedMs / 1000);
    console.log(`busy: generating (${elapsed}s elapsed)`);
    console.log(`  job_id: ${j.job_id}`);
    console.log(`  prompt: ${j.prompt || ''}`);
    if (j.output_path) console.log(`  target: ${j.output_path}`);
    else if (j.project_id !== undefined)
      console.log(`  target: project=${j.project_id} segment=${j.segment_id}`);
    if (body.queue_depth > 0) console.log(`  queued: ${body.queue_depth} more`);
  } else if (body.queue_depth > 0) {
    // Shouldn't normally happen — worker kicks in immediately — but possible
    // during the brief window between enqueue and drainQueue firing.
    console.log(`idle but ${body.queue_depth} job(s) queued (worker about to start)`);
  } else {
    console.log('idle');
  }

  if (!body.browser_connected) console.log('  warn: browser_connected=false');
  if (!body.logged_in) console.log('  warn: logged_in=false');
}

async function cmdGenerate(rawArgs) {
  const flags = parseFlags(rawArgs);

  let prompt = flags.prompt || flags._[0];
  if (!prompt && !process.stdin.isTTY) {
    prompt = await readStdin();
  }
  if (!prompt || !prompt.trim()) {
    console.error('error: missing prompt (use --prompt, positional arg, or pipe via stdin)');
    process.exit(1);
  }

  // Auto-start the daemon if it isn't already running.
  await ensureDaemonUp({ port: PORT, url: URL, serverPath: SERVER_PATH, logDir: LOG_DIR, logFile: LOG_FILE });

  // Three modes:
  //   1. Standalone (default):   no flags → save to /tmp/flow_content/flow-<ts>.png
  //   2. Custom output path:     --output /some/path.png  (absolute or relative to daemon's FLOW_ROOT_DIR)
  //   3. Content Hub integration: --project-id N --segment-id N  (legacy path pattern)
  const projectFlag = flags['project-id'];
  const segmentFlag = flags['segment-id'];
  const outputFlag = flags.output;

  let bodyFields;
  let modeLabel;
  if (outputFlag) {
    bodyFields = { output_path: outputFlag };
    modeLabel = `output=${outputFlag}`;
  } else if (projectFlag !== undefined || segmentFlag !== undefined) {
    const projectId = parseInt(projectFlag, 10);
    const segmentId = parseInt(segmentFlag, 10);
    if (!Number.isFinite(projectId) || !Number.isFinite(segmentId)) {
      console.error('error: --project-id and --segment-id must both be integers when provided');
      console.error('       omit both (or use --output) to run in standalone mode');
      process.exit(1);
    }
    bodyFields = { project_id: projectId, segment_id: segmentId };
    modeLabel = `project=${projectId} segment=${segmentId}`;
  } else {
    const ts = Math.floor(Date.now() / 1000);
    bodyFields = { output_path: `/tmp/flow_content/flow-${ts}.png` };
    modeLabel = `standalone → ${bodyFields.output_path}`;
  }

  let enqueueRes;
  try {
    enqueueRes = await fetch(`${URL}/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.trim(), ...bodyFields }),
    });
  } catch (e) {
    console.error(`daemon not reachable on ${URL}: ${e.message}`);
    process.exit(2);
  }

  if (!enqueueRes.ok) {
    console.error(`enqueue failed: HTTP ${enqueueRes.status} — ${await enqueueRes.text()}`);
    process.exit(2);
  }

  const { job_id } = await enqueueRes.json();
  if (!flags.quiet && !flags.json) {
    console.error(`[flow-cli] enqueued ${job_id} (${modeLabel}), polling...`);
  }

  const startTime = Date.now();
  while (true) {
    await sleep(2000);
    let status;
    try {
      const r = await fetch(`${URL}/status/${job_id}`);
      if (!r.ok) {
        console.error(`status check failed: HTTP ${r.status}`);
        process.exit(2);
      }
      status = await r.json();
    } catch (e) {
      // Transient blip — keep polling
      continue;
    }

    if (status.status === 'done') {
      const duration_ms = Date.now() - startTime;
      if (flags.json) {
        console.log(JSON.stringify({ ...status, duration_ms }, null, 2));
      } else {
        console.log(status.image_path);
      }
      return;
    }

    if (status.status === 'error') {
      if (flags.json) {
        console.error(JSON.stringify(status, null, 2));
      } else {
        console.error(`error (${status.error_code}): ${status.error}`);
      }
      process.exit(3);
    }
    // queued or running → keep polling silently
  }
}

function printHelp() {
  process.stdout.write(`flow-cli — control the Flow daemon and generate images.

Usage:
  flow-cli daemon                              Start the HTTP daemon (foreground)
  flow-cli health                              Print full daemon health JSON
  flow-cli status                              Human-readable: idle or busy+elapsed
  flow-cli generate [PROMPT] [flags]           Enqueue, wait, print image_path
                                               (auto-starts the daemon in the
                                                background if it isn't running)

Generate flags:
  --output PATH       save the generated image to PATH (absolute or relative
                      to the daemon's FLOW_ROOT_DIR). Takes precedence over
                      --project-id / --segment-id.
  --project-id N      Content Hub project id (pair with --segment-id) —
  --segment-id N        saves to priv/uploads/video_projects/<p>/segments/<s>/flow.png
  --prompt TEXT       prompt (or use positional arg, or pipe via stdin)
  --json              print full status JSON instead of just the image path
  --quiet             suppress progress messages on stderr

Default (no flags): standalone mode. Image saved to /tmp/flow_content/flow-<ts>.png

Env:
  FLOW_DAEMON_PORT    HTTP port the daemon listens on (default 47321)
  FLOW_DAEMON_URL     Override the base URL (default http://127.0.0.1:$PORT)
  FLOW_ROOT_DIR       Where the daemon writes images (default cwd of daemon)

Examples:
  # In one terminal:
  flow-cli daemon

  # In another:
  flow-cli health
  flow-cli generate "a red apple on wood, 16:9"                # → /tmp/flow_content/flow-<ts>.png
  echo "a sunset" | flow-cli generate                          # stdin prompt, standalone
  flow-cli generate "a cat" --output ~/Pictures/cat.png        # explicit path
  flow-cli generate "a brain" --project-id 1 --segment-id 42   # Content Hub path
  flow-cli generate "a brain" --project-id 1 --segment-id 42 --json

Exit codes:
  0  success
  1  bad arguments
  2  daemon unreachable or HTTP error
  3  generation failed (see error_code in --json output)
`);
}

main().catch((e) => {
  console.error(`flow-cli: ${e.message}`);
  process.exit(1);
});
