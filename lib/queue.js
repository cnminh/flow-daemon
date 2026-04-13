// In-memory FIFO job queue. Jobs live here until daemon restart.
// Public API: enqueue(job) -> jobId, get(jobId), queuePositionOf(jobId),
//             shiftNext() -> jobId, markRunning(jobId),
//             markDone(jobId, {image_path}), markError(jobId, {error, error_code}),
//             depth(), reset()

let nextSeq = 0;
const jobs = new Map(); // jobId -> job object
const pending = []; // jobIds in FIFO order (queued only)

function newId() {
  nextSeq += 1;
  return `j_${Date.now().toString(36)}${nextSeq}`;
}

function enqueue({ prompt, project_id, segment_id }) {
  const jobId = newId();
  const job = {
    job_id: jobId,
    status: 'queued',
    prompt,
    project_id,
    segment_id,
    image_path: null,
    error: null,
    error_code: null,
    started_at: null,
    finished_at: null,
  };
  jobs.set(jobId, job);
  pending.push(jobId);
  return jobId;
}

function get(jobId) {
  return jobs.get(jobId) || null;
}

function queuePositionOf(jobId) {
  const idx = pending.indexOf(jobId);
  return idx < 0 ? null : idx + 1;
}

function shiftNext() {
  return pending.shift() || null;
}

function markRunning(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'running';
  job.started_at = new Date().toISOString();
}

function markDone(jobId, { image_path }) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'done';
  job.image_path = image_path;
  job.finished_at = new Date().toISOString();
}

function markError(jobId, { error, error_code }) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'error';
  job.error = error;
  job.error_code = error_code;
  job.finished_at = new Date().toISOString();
}

function depth() {
  return pending.length;
}

// Test-only: clear all queue state. Not exposed over HTTP.
function reset() {
  nextSeq = 0;
  jobs.clear();
  pending.length = 0;
}

module.exports = {
  enqueue,
  get,
  queuePositionOf,
  shiftNext,
  markRunning,
  markDone,
  markError,
  depth,
  reset,
};
