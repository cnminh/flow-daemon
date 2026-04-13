#!/usr/bin/env node
// flow-cli — control the Flow daemon and run one-shot generations.
//
// Subcommands:
//   daemon                Start the HTTP daemon (foreground)
//   health                Print daemon health JSON
//   generate [PROMPT]     Enqueue an image generation, wait for completion
//
// Env:
//   FLOW_DAEMON_PORT   HTTP port for daemon (default 47321)
//   FLOW_DAEMON_URL    Override base URL (default http://127.0.0.1:$PORT)
//   FLOW_ROOT_DIR      Where the daemon writes images (default cwd for CLI)
//   FLOW_URL_OVERRIDE  Daemon-side: override https://labs.google/... URL

const PORT = process.env.FLOW_DAEMON_PORT || '47321';
const URL = process.env.FLOW_DAEMON_URL || `http://127.0.0.1:${PORT}`;

const cmd = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (cmd) {
    case 'daemon': return runDaemon();
    case 'health': return cmdHealth();
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
  // Just delegate to server.js — it has its own CLI behavior under
  // require.main === module. We re-`require` it as our main module
  // entry point so its SIGINT/SIGTERM handlers work as expected.
  require('../server.js');
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

  const projectId = parseInt(flags['project-id'], 10);
  const segmentId = parseInt(flags['segment-id'], 10);
  if (!Number.isFinite(projectId) || !Number.isFinite(segmentId)) {
    console.error('error: --project-id and --segment-id are required and must be integers');
    process.exit(1);
  }

  let enqueueRes;
  try {
    enqueueRes = await fetch(`${URL}/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: prompt.trim(),
        project_id: projectId,
        segment_id: segmentId,
      }),
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
    console.error(`[flow-cli] enqueued ${job_id}, polling...`);
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

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function printHelp() {
  process.stdout.write(`flow-cli — control the Flow daemon and generate images.

Usage:
  flow-cli daemon                              Start the HTTP daemon (foreground)
  flow-cli health                              Print daemon health JSON
  flow-cli generate [PROMPT] [flags]           Enqueue, wait, print image_path

Generate flags:
  --project-id N      (required) project id
  --segment-id N      (required) segment id
  --prompt TEXT       prompt (or use positional arg, or pipe via stdin)
  --json              print full status JSON instead of just the image path
  --quiet             suppress progress messages on stderr

Env:
  FLOW_DAEMON_PORT    HTTP port the daemon listens on (default 47321)
  FLOW_DAEMON_URL     Override the base URL (default http://127.0.0.1:$PORT)
  FLOW_ROOT_DIR       Where the daemon writes images (default cwd of daemon)

Examples:
  # In one terminal:
  flow-cli daemon

  # In another:
  flow-cli health
  flow-cli generate "a red apple on wood, 16:9" --project-id 1 --segment-id 42
  echo "a sunset" | flow-cli generate --project-id 1 --segment-id 43
  flow-cli generate --prompt "a brain" --project-id 1 --segment-id 44 --json

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
