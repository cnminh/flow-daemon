#!/usr/bin/env node
// flow-video-cli — generate videos via the Flow daemon in video mode.
//
// Subcommands:
//   generate [PROMPT...] [flags]    Variadic prompts: first creates the
//                                   initial clip, 2..N extend the same scene.
//                                   Output is one stitched mp4.
//
// Env:
//   FLOW_DAEMON_PORT   Daemon HTTP port (default 47321 — SAME as flow-cli,
//                      one daemon, one browser, one queue)
//   FLOW_DAEMON_URL    Override base URL (default http://127.0.0.1:$PORT)

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
    case 'generate':
      return cmdGenerate(args);
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

async function cmdGenerate(rawArgs) {
  const flags = parseFlags(rawArgs);

  // Collect prompts: variadic positional args, or newline-split stdin.
  let prompts = flags._ || [];
  if (prompts.length === 0 && !process.stdin.isTTY) {
    const stdinText = await readStdin();
    prompts = stdinText.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (prompts.length === 0) {
    console.error('error: at least one prompt required (positional arg, or pipe via stdin)');
    process.exit(1);
  }

  // Resolve output path (default or --output).
  let outputPath = flags.output;
  if (!outputPath) {
    const ts = Math.floor(Date.now() / 1000);
    const dir = process.env.FLOW_VIDEO_OUTPUT_DIR || '/tmp/flow_video';
    outputPath = path.join(dir, `flow-${ts}.mp4`);
  }
  if (!path.isAbsolute(outputPath)) {
    outputPath = path.resolve(process.cwd(), outputPath);
  }

  // Validate aspect / model if supplied.
  if (flags.aspect && !['16:9', '9:16'].includes(flags.aspect)) {
    console.error('error: --aspect must be "16:9" or "9:16"');
    process.exit(1);
  }

  if (flags['dry-run']) {
    // Dry-run: preview the payload that WOULD be sent, without hitting the
    // daemon or spending any Flow quota. A DOM-level dry-run (screenshot
    // before Create click) is done manually during live selector verification.
    console.error('[flow-video-cli] --dry-run: would enqueue the following payload:');
    console.log(JSON.stringify({
      prompts,
      frame_path: flags.frame || null,
      output_path: outputPath,
      model: flags.model || null,
      aspect: flags.aspect || '16:9',
    }, null, 2));
    process.exit(0);
  }

  // Auto-start the daemon if needed.
  await ensureDaemonUp({ port: PORT, url: URL, serverPath: SERVER_PATH, logDir: LOG_DIR, logFile: LOG_FILE });

  const body = {
    prompts,
    output_path: outputPath,
  };
  if (flags.frame) body.frame_path = path.resolve(flags.frame);
  if (flags.model) body.model = flags.model;
  if (flags.aspect) body.aspect = flags.aspect;
  if (flags.overlap !== undefined) {
    const val = parseFloat(flags.overlap);
    if (!Number.isFinite(val) || val < 0) {
      console.error('error: --overlap must be a non-negative number (seconds)');
      process.exit(1);
    }
    body.overlap_seconds = val;
  }

  let enqueueRes;
  try {
    enqueueRes = await fetch(`${URL}/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    console.error(`[flow-video-cli] enqueued ${job_id} (${prompts.length} prompt${prompts.length > 1 ? 's' : ''} → ${outputPath}), polling...`);
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
      continue;
    }

    if (status.status === 'done') {
      const duration_ms = Date.now() - startTime;
      if (flags.json) {
        console.log(JSON.stringify({ ...status, duration_ms }, null, 2));
      } else {
        console.log(status.video_path);
      }
      return;
    }

    if (status.status === 'error') {
      if (flags.json) {
        console.error(JSON.stringify(status, null, 2));
      } else {
        let msg = `error (${status.error_code}): ${status.error}`;
        if (status.error_code === 'extend_failed') {
          msg += ` [failed_at_index=${status.failed_at_index}, completed_prompts=${status.completed_prompts}]`;
        }
        console.error(msg);
      }
      process.exit(3);
    }
  }
}

function printHelp() {
  process.stdout.write(`flow-video-cli — generate videos via the Flow daemon.

Usage:
  flow-video-cli generate PROMPT [PROMPT ...] [flags]

Prompts:
  First prompt creates the initial ~8s clip. Each additional prompt extends
  the same Flow scene with ~7-8 more seconds. Final output is one stitched mp4.

Flags:
  --output PATH       save the stitched mp4 to PATH (absolute or relative).
                      Default: /tmp/flow_video/flow-<unix-ts>.mp4
  --frame PATH        path to .png or .jpg to seed the first clip (frames-to-video)
  --model NAME        video model (veo-3, veo-3-fast, veo-2). Default: random
  --aspect 16:9|9:16  aspect ratio. Default: 16:9
  --dry-run           print the payload that would be sent and exit 0 (no quota burn)
  --json              print full status JSON instead of just the video path
  --quiet             suppress progress messages on stderr

Env:
  FLOW_DAEMON_PORT        daemon HTTP port (default 47321, shared with flow-cli)
  FLOW_DAEMON_URL         override base URL
  FLOW_VIDEO_OUTPUT_DIR   default output directory (default /tmp/flow_video/)

Examples:
  flow-video-cli generate "a weathered lighthouse at dusk"
  flow-video-cli generate "scene starts" "something happens" "scene ends"
  flow-video-cli generate "waves grow" --frame hero.png --output out.mp4
  echo "a cat walks" | flow-video-cli generate

Exit codes:
  0  success
  1  bad arguments
  2  daemon unreachable or HTTP error
  3  generation failed (see error_code in --json output)
`);
}

main().catch((e) => {
  console.error(`flow-video-cli: ${e.message}`);
  process.exit(1);
});
