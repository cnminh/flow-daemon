// Shared helpers for flow-cli and flow-video-cli: daemon lifecycle, flag
// parsing, stdin, HTTP polling. No mode-specific logic here.

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const DAEMON_STARTUP_TIMEOUT_MS = 15000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function isDaemonHealthy(url) {
  try {
    const r = await fetch(`${url}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

function findProcessOnPort(port) {
  try {
    const out = execSync(`lsof -ti :${port}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    return parseInt(out.split(/\s+/)[0], 10) || null;
  } catch {
    return null;
  }
}

function spawnDaemon({ serverPath, logDir, logFile }) {
  fs.mkdirSync(logDir, { recursive: true });
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();
  return child.pid;
}

// Bring the daemon up if it isn't already. If something's holding the port
// but not responding, probe briefly then kill it. Then spawn a fresh daemon
// detached, poll /health until it answers.
async function ensureDaemonUp({ port, url, serverPath, logDir, logFile }) {
  if (await isDaemonHealthy(url)) return;

  const zombie = findProcessOnPort(port);
  if (zombie) {
    console.error(`[cli] port ${port} held by PID ${zombie} — probing for 3s before deciding`);
    let settledHealthy = false;
    for (let i = 0; i < 6; i += 1) {
      await sleep(500);
      if (await isDaemonHealthy(url)) {
        settledHealthy = true;
        break;
      }
    }
    if (settledHealthy) {
      console.error(`[cli] port ${port} was booting, now healthy — proceeding`);
      return;
    }
    console.error(`[cli] PID ${zombie} still not responding after probe — killing`);
    try { process.kill(zombie, 'SIGKILL'); } catch {}
    await sleep(1000);
  }

  console.error('[cli] daemon not running — starting in background');
  const pid = spawnDaemon({ serverPath, logDir, logFile });
  console.error(`[cli] daemon PID ${pid} (log: ${logFile})`);

  const started = Date.now();
  while (Date.now() - started < DAEMON_STARTUP_TIMEOUT_MS) {
    await sleep(500);
    if (await isDaemonHealthy(url)) {
      const secs = Math.round((Date.now() - started) / 1000);
      console.error(`[cli] daemon ready after ${secs}s`);
      return;
    }
  }

  console.error(`[cli] daemon did not respond within ${DAEMON_STARTUP_TIMEOUT_MS / 1000}s`);
  console.error(`[cli] check ${logFile} for errors`);
  process.exit(2);
}

module.exports = {
  sleep,
  parseFlags,
  readStdin,
  isDaemonHealthy,
  findProcessOnPort,
  spawnDaemon,
  ensureDaemonUp,
};
