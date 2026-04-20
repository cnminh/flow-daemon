// In-memory FIFO job queue. Jobs live here until daemon restart.
// The queue is payload-agnostic — each job carries an opaque `payload`
// object that the caller (image worker, video worker) destructures as it
// needs. This keeps the queue free of mode-specific field names.

let nextSeq = 0;
const jobs = new Map(); // jobId -> job object
const pending = []; // jobIds in FIFO order (queued only)

function newId() {
  nextSeq += 1;
  return `j_${Date.now().toString(36)}${nextSeq}`;
}

// payload is any JSON-serializable object. The worker that consumes this job
// is responsible for knowing which fields to read.
function enqueue(payload) {
  const jobId = newId();
  const job = {
    job_id: jobId,
    status: 'queued',
    payload,
    // Result fields populated by markDone/markError:
    result: null,
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

function markDone(jobId, result) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'done';
  job.result = result; // worker-shaped: { image_path } or { video_path, ... }
  job.finished_at = new Date().toISOString();
}

function markError(jobId, { error, error_code, ...extra }) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'error';
  job.error = error;
  job.error_code = error_code;
  // Extra fields (e.g. failed_at_index, completed_prompts) flow through to
  // the status response.
  Object.assign(job, extra);
  job.finished_at = new Date().toISOString();
}

function depth() {
  return pending.length;
}

function currentJob() {
  for (const job of jobs.values()) {
    if (job.status === 'running') return job;
  }
  return null;
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
  currentJob,
  reset,
};
