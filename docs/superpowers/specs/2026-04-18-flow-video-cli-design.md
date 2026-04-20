# `flow-video-cli` — Design

**Date:** 2026-04-18
**Branch:** `feat/video-cli`
**Repo:** `flow-daemon` (same repo as the existing `flow-cli`, no new repo)

## 1. Problem & Scope

### What we're building

A second CLI command, `flow-video-cli`, that drives Google Flow in **video mode**
to produce `.mp4` files, as a sibling to the existing `flow-cli` which drives
Flow in image mode to produce `.png` files.

### Core shape

`flow-video-cli generate` takes **1..N variadic prompts**:

- 1 prompt → one ~8-second Veo clip.
- 2+ prompts → initial clip, then Flow's **Extend** feature is used once per
  additional prompt to continue the same scene. The output is the stitched
  scene as a single `.mp4`.

Optional **frames-to-video**: `--frame PATH` uploads a `.png` / `.jpg` to seed
the first clip as the starting frame.

### In scope for v1

- Text-to-video (variadic prompts, 1..N)
- Frames-to-video via `--frame` (first-frame only)
- Extend loop for multi-prompt chains (runs inside one Flow scene)
- Stitched scene download as one `.mp4`
- Standalone-only output: `--output PATH` or default `/tmp/flow_video/flow-<unix-ts>.mp4`
- `--dry-run` flag for selector verification without burning Flow quota
- `--model`, `--aspect`, `--json`, `--quiet` flags
- stdin fallback: newline-separated prompts if no positional args
- Unified daemon: **same daemon, same Chrome, same queue** as today's image tool
- Unit tests against a new `test/mock-flow-video.html` fixture, hermetic

### Out of scope for v1

- Content Hub integration (no `--project-id` / `--segment-id` pathing)
- Extending an old clip from a previous run (would require handle-based state
  across calls — YAGNI for now)
- Last-frame / "Ingredients to video" two-reference interpolation
- Negative prompts, seed control
- Parallel jobs (single worker, same as today)
- `--save-segments` to also write intermediate clips (default is stitched only)

## 2. Why unify with the existing daemon (one queue, one browser)

The image tool and the video tool drive the **same Google Flow product** under
the **same Google account**. Running them as two independent daemons would mean:

- Two Chromium profiles requiring two separate first-time logins to the same account
- Two simultaneous automated sessions on one account — a louder bot signal to
  Google's detection than one
- Potential for two browsers typing at Flow at the same second if both CLIs are
  fired concurrently

The correct design: **one daemon, one Chromium, one queue.** Both CLIs are thin
HTTP clients against the same `http://127.0.0.1:47321`. Jobs take turns in
FIFO order regardless of type. The worker peeks at each job's shape and runs
the right routine (image or video). Flipping Flow's UI mode between jobs is
cheap (~2 seconds of clicking the mode popover).

This respects the existing invariants in `AGENTS.md`:

- **Invariant #1** (single daemon, single browser, single job at a time) — the
  `workerBusy` gate in `server.js` already enforces this.
- **Invariant #2** (never two sessions on `~/.flow-daemon/profile/`) — there is
  still only one session on the profile, just now capable of driving two modes.

## 3. Code reorganization

The existing `lib/flow.js` (469 lines) mixes mode-agnostic browser lifecycle
with image-specific Playwright choreography. Split it into three files:

### Shared (mode-agnostic)

- **`lib/browser.js`** (new, ~180 lines extracted verbatim from `flow.js`):
  - `PROFILE_DIR`, module-level `browserContext`
  - `jitter`, `humanPause`, `pidAlive`, `removeLockFiles`
  - `cleanStaleProfileLock` (the `SingletonLock` orphan-kill logic)
  - `ensureContext`, `ensureContextForUrl`, `findOrCreatePage`
  - `navigator.webdriver` erase init script
  - `closeBrowser`
- **`lib/queue.js`** (existing, small change): generalize `enqueue(payload)` so
  it accepts any opaque job record. Currently hard-codes image field names in
  `job.prompt`, `job.project_id`, `job.segment_id`, `job.output_path`; the
  generalized version stores the payload as-is and lets each mode's runJob
  destructure its own fields.
- **`lib/selectors.js`** (existing, reorganized): split internally into three
  namespaces — `common` (prompt input, captcha, quota), `image` (today's
  image popover selectors), `video` (new).
- **`lib/cli-shared.js`** (new, extracted from `bin/flow-cli.js`):
  `isDaemonHealthy`, `findProcessOnPort`, `spawnDaemon`, `ensureDaemonUp`,
  `parseFlags`, `readStdin`, `sleep`. Parameterized by `{ port, logDir,
  serverPath }` so both bins can reuse.

### Mode-specific (forks)

- **`lib/image.js`** (new, renamed from what's left of `flow.js`): the
  image-specific `runJob` — `ensureImageModeAndCount`, image src-diff wait
  loop, `data:` / HTTPS download, `.png` write, output-path resolution (retains
  Content Hub fallback for back-compat).
- **`lib/video.js`** (new): the video-specific `runJob` —
  `ensureVideoModeAndSettings`, optional frame upload, type-prompt-create-wait
  loop, extend chain, scene download, `.mp4` write. Standalone-only output
  resolution (no Content Hub fallback).

### Top-level

- **`server.js`** (existing): one new line in `drainQueue` — dispatch to
  `image.runJob` or `video.runJob` based on payload shape. `/enqueue` learns
  to accept two body shapes; `/status/:id` gains a `video_path` field; `/health`'s
  `current_job` gains a `type` field.
- **`bin/flow-cli.js`** (existing): unchanged user-facing surface. Internally,
  extract shared helpers into `lib/cli-shared.js` so both bins use the same
  daemon-lifecycle code.
- **`bin/flow-video-cli.js`** (new): thin CLI, same daemon-lifecycle helpers.
- **`package.json`** (existing): add `flow-video-cli` to the `bin` map.

## 4. CLI contract: `flow-video-cli`

### Subcommand

`flow-video-cli generate [PROMPT...] [flags]` — the only subcommand. `help`,
`--help`, `-h` print usage; `health` and `status` are routed via `flow-cli`
(same daemon).

### Flags

| Flag | Purpose |
|---|---|
| `--output PATH` | save the final `.mp4` to PATH (absolute, or relative to cwd). Default: `/tmp/flow_video/flow-<unix-ts>.mp4`. |
| `--frame PATH` | absolute path to a `.png` / `.jpg` to seed the first clip (frames-to-video). Optional. |
| `--model NAME` | video model: `veo-3`, `veo-3-fast`, `veo-2`. Default: random across available. |
| `--aspect RATIO` | `16:9` or `9:16`. Default `16:9`. |
| `--dry-run` | walk the flow up to the final Create click, save a screenshot of the Chromium window, exit 0 without clicking. No quota burned. |
| `--json` | print full status JSON instead of just the mp4 path. |
| `--quiet` | suppress progress messages on stderr. |

### Positional args

1..N prompts. First is the initial clip; 2..N are extensions in order.

### Stdin

If no positional prompts are given and stdin is a pipe, read stdin and split
on newlines. Each non-empty line becomes one prompt.

### Auto-start

Same behavior as `flow-cli generate` today: if the daemon isn't responding,
spawn `node server.js` detached, wait up to 15s for `/health`, proceed.

### Output

**Success (default):** the absolute mp4 path on stdout.

```
/tmp/flow_video/flow-1776184993.mp4
```

**Success (`--json`):**

```jsonc
{
  "status": "done",
  "video_path": "/tmp/flow_video/flow-1776184993.mp4",
  "prompt_count": 3,
  "duration_approx_s": 24,
  "model": "veo-3",
  "aspect": "16:9",
  "duration_ms": 253871
}
```

**Error:** error message to stderr (or full status JSON with `--json`). Exit
code 3 for generation failures, matching `flow-cli`.

### Exit codes

- `0` success
- `1` bad args
- `2` daemon unreachable / HTTP error
- `3` generation failed (see `error_code`)

## 5. HTTP API changes

All three existing endpoints stay at `http://127.0.0.1:47321`. Back-compat is
preserved for Content Hub's Elixir `FlowClient`.

### `POST /enqueue`

Two body shapes accepted. Dispatch is by shape of body, not by an explicit
`type` field, so existing callers don't have to change:

**Image (unchanged):**

```jsonc
{ "prompt": "string", "output_path": "/abs/x.png" }
// or
{ "prompt": "string", "project_id": 1, "segment_id": 2 }
```

**Video (new):**

```jsonc
{
  "prompts": ["string", ...],    // 1..N, required
  "frame_path": "/abs/hero.png", // optional
  "output_path": "/abs/out.mp4", // required (standalone-only)
  "model": "veo-3-fast",         // optional
  "aspect": "16:9"               // optional, default 16:9
}
```

Discriminator: presence of `prompts` array → video; presence of single
`prompt` string → image. Either must be provided or `400`.

Validation (video):

- `prompts` must be a non-empty array of non-empty strings
- `output_path` required and must be an absolute path
- `frame_path`, if given, must exist and be `image/png` or `image/jpeg`;
  otherwise reject with `error_code: "frame_invalid"` before enqueueing
- `model`, if given, must be one of the allowed names
- `aspect`, if given, must be `"16:9"` or `"9:16"`

Response: `{ job_id: "j_...", queue_position: N }` — same as today.

### `GET /status/:jobId`

Image response shape unchanged. Video response adds new fields:

```jsonc
// video done:
{
  "status": "done",
  "video_path": "/tmp/flow_video/flow-1776184993.mp4",
  "prompt_count": 3,
  "model": "veo-3",
  "aspect": "16:9",
  "started_at": "...",
  "finished_at": "..."
}

// video error mid-extend:
{
  "status": "error",
  "error_code": "extend_failed",
  "error": "timeout waiting for clip 2 to finish after 180s",
  "failed_at_index": 1,
  "completed_prompts": 1
}
```

### `GET /health`

`current_job` gains a `type` field (`"image"` or `"video"`). For video, also
includes `prompt_count` instead of `prompt`:

```jsonc
{
  "ok": true,
  "browser_connected": true,
  "logged_in": true,
  "worker_busy": true,
  "queue_depth": 0,
  "current_job": {
    "job_id": "j_xxx",
    "type": "video",
    "prompt_count": 3,
    "started_at": "2026-04-18T09:10:32Z",
    "output_path": "/tmp/flow_video/flow-1776184993.mp4"
  },
  "version": "0.2.0"
}
```

`flow-cli status`'s human-readable snapshot learns to print
`"busy: generating video (45s elapsed, 3 prompts)"` based on `type`.

## 6. Playwright flow for a video job

Worker execution, top to bottom:

1. **Navigate to Flow project tab** via `ensureContextForUrl` + `findOrCreatePage`
   (shared with image mode).
2. **Login check** — wait for `selectors.common.promptInput`; if missing,
   throw `not_logged_in`.
3. **Captcha / quota check** — if `selectors.common.captchaFrame` or
   `selectors.common.quotaBanner` is visible, throw `captcha` /
   `quota_exceeded`.
4. **Switch Flow to Video mode** — reuse the existing `modeButton` label-read
   pattern. If the label indicates image mode (contains a known image model
   name or lacks "Video"), open the popover, click `selectors.video.videoModeTab`,
   select model + aspect, press Escape.
5. **If `--frame` given, upload the starting frame** — click into Flow's
   Frames entry for the scene, use Playwright's `setInputFiles` on the file
   input element, wait for the preview thumbnail to become visible. Throw
   `frame_invalid` if the upload is rejected or the preview doesn't appear
   within 20 seconds.
6. **Type prompt #1** — per-character humanized typing loop (120–270ms
   jitter), identical to image mode.
7. **Click Create** — wait for a new `<video>` element with a real `src`
   (not a placeholder) to appear in the scene panel. Timeout 180s (same
   per-clip cap as image timeouts).
8. **Loop for prompts 2..N:**
   - Click `selectors.video.extendButton` next to the most recent clip
   - Humanized typing for the next prompt
   - Click Create (or the equivalent "continue" affordance — identified live per §9)
   - Wait for the new `<video>` element, same timeout
   - Random 5–15s cooldown between extends (mirrors the inter-job cooldown
     in `server.js::drainQueue`)
9. **Download the stitched scene** — click `selectors.video.downloadSceneButton`,
   intercept the mp4 via Playwright's download handler, write bytes to
   `output_path`. Confirm file size > 0.
10. **Return** `{ video_path, prompt_count, model, aspect }`.

### Selectors that need live verification

These are selectors I do NOT yet know from existing working code. They
must be identified against real `labs.google/fx/tools/flow/...` during
implementation, using the screenshot-confirm workflow (see §9):

- `selectors.video.videoModeTab` — the Video tab in the mode popover
- `selectors.video.videoModelDropdown` + `selectors.video.videoModelOption(name)`
- `selectors.video.aspectOption(ratio)`
- `selectors.video.framesTab` and the frame-upload file input
- `selectors.video.extendButton` — exact label and DOM position
- `selectors.video.downloadSceneButton` — may be a direct button, a gear menu
  item, or a right-click Export. Identified live per §9.
- Whether Flow's scene-download yields a single stitched mp4 or one file per
  clip. The design assumes single stitched; if Flow's export is per-clip, the
  worker would need to concatenate with `ffmpeg` before returning. That fork
  resolves during §12 step 7.
- Video completion signal — which DOM change indicates "clip finished
  rendering" (likely a `<video>` with a blob-URL `src` replacing a spinner).

### Selectors already known from existing working code

- `selectors.common.promptInput` = `[role="textbox"]`
- `selectors.common.generateButton` = `text=arrow_forwardCreate`
- `selectors.common.modeButton` = `button:has-text("crop_16_9")`
- `selectors.common.captchaFrame` = `iframe[src*="recaptcha"]`
- `selectors.common.quotaBanner` = `text=/no credits/i`

## 7. Error handling

### Inherited codes (unchanged behavior)

`not_logged_in`, `captcha`, `quota_exceeded`, `timeout`, `selector_missing`,
`browser_crashed`, `profile_locked`, `network` — semantics match today's image
flow. The worker loop in `server.js` maps these into HTTP status responses.

### New codes

- **`extend_failed`** — a specific extend step in a multi-prompt chain did
  not complete. Response includes:
  - `failed_at_index` — zero-indexed; `1` means prompt #2 failed
  - `completed_prompts` — how many clips succeeded before failure
  - `error` — human-readable cause
  - The Flow scene is **not cleaned up**. The partial arc remains in Flow's
    history so the user can inspect in Chromium. No auto-retry.
- **`frame_invalid`** — `--frame PATH` failed validation. Reasons:
  - file does not exist
  - file is not a readable `image/png` or `image/jpeg`
  - Flow rejects the upload during step 5
  - Flagged before any quota-spending click where possible.

### No retries

The video flow does not retry on failure. The cost of a retry (re-typing,
re-generating, potentially re-uploading the frame) is high in quota and
time; the caller decides whether to retry. This matches today's image
flow behavior and AGENTS.md "What NOT to do" guidance.

### CLI exit semantics

Exit code 3 on any generation failure, regardless of sub-type. Error surface
to the user:

- Default: `error (<error_code>): <message>` on stderr, including
  `failed_at_index` and `completed_prompts` for `extend_failed`.
- `--json`: the full status response on stderr (includes everything).

## 8. Testing

### Unit tests (`test/video.test.js`)

Hermetic, run with `node --test`, no network, no Flow quota. Pattern mirrors
the existing `test/daemon.test.js` + `test/mock-flow.html` setup.

**New fixture: `test/mock-flow-video.html`** — a static HTML file that
replicates Flow's video UI just enough to exercise our Playwright paths:

- Prompt input (`[role="textbox"]`)
- A fake mode popover with Video/Image tabs and a model dropdown
- A fake Extend button per generated clip
- A fake `<video>` element that "finishes" after a short setTimeout
- A fake Download-scene button that serves a tiny valid `.mp4` blob

Tests cover:

- Switching to Video mode from a page that starts in Image mode
- Frame upload — valid png accepted, corrupt file rejected as `frame_invalid`
- Single-prompt generation — one clip, one download
- Multi-prompt chain — 3-prompt generate produces 3 clips and one stitched
  download
- Extend failure mid-chain — second clip's fake "finish" is delayed past
  timeout, verify response has `extend_failed` with `failed_at_index: 1`
  and `completed_prompts: 1`
- Queue back-compat — an image job enqueued with today's body shape still
  goes through image flow unaffected when a video job is in the queue

### E2E test

No changes to `test/e2e-wizard.js`. The existing E2E test is Content Hub
specific and doesn't cover video (by design — video is standalone-only).

### Manual smoke test

```
flow-video-cli generate "a weathered lighthouse at dusk" --dry-run
```

Runs the full Playwright path up to (but not including) the Create click.
Saves a screenshot of the Chromium state to a known path
(`/tmp/flow_video/dryrun-<ts>.png`). Exits 0 without spending Flow quota.
Use anytime Flow's UI changes to verify selectors still match.

## 9. Dev-time workflow: screenshot-confirm before real Flow clicks

During implementation, before any click that would spend Flow quota (the
Create button, the Extend button, the Download-scene button), I follow
this protocol:

1. Take a Playwright screenshot of the full Chromium window with the target
   element highlighted (bounding-box overlay or a text description).
2. Write the screenshot to `tmp/dev-preview/<timestamp>.png`.
3. Send the user a Tailscale URL
   (`https://mac-mini.tailf56d7b.ts.net:47399/<timestamp>.png`) plus a
   one-line description of what I'm about to click.
4. Wait for explicit "ok" / "go" / "yes" before clicking.
5. Only then perform the real click.

### Dev preview server

- Lives at `scripts/dev-preview-server.js` — small Node/Express static server
  (~30 lines).
- Binds `127.0.0.1:47399`, serves `tmp/dev-preview/`.
- `tmp/dev-preview/` is gitignored.
- Started manually in the background during development; stopped when not
  needed. Never installed as a global command, never in `package.json`'s
  `bin` section, never part of the shipping CLI.
- Serves both screenshots (for confirmation) and downloaded `.mp4`s (so the
  user can review generated video from their phone via Tailscale).

Rationale: terminal cannot display images or video; the user has a Tailscale
mesh already running. Using a local HTTP server + Tailscale URL is the
lightest path. (The user's `bridge` tool is text-only per their own CLAUDE.md
and was explicitly excluded from this use case.)

## 10. Configuration

No new required env vars. Optional:

| Env var | Default | Purpose |
|---|---|---|
| `FLOW_DAEMON_PORT` | `47321` | HTTP port (unchanged — shared by both CLIs) |
| `FLOW_DAEMON_URL` | `http://127.0.0.1:$PORT` | CLI override |
| `FLOW_DAEMON_IDLE_TIMEOUT_MIN` | `30` | Idle shutdown (unchanged) |
| `FLOW_URL_OVERRIDE` | unset | Test-only, same as today |
| `FLOW_VIDEO_OUTPUT_DIR` | `/tmp/flow_video/` | Default directory for standalone mp4s when `--output` is not given |

`FLOW_ROOT_DIR` is image-mode-only and remains unchanged.

## 11. Anti-detection discipline

Everything in the existing image flow's anti-detection playbook applies
equally to video jobs. Video must NOT regress any of these:

- Headed Chromium with persistent profile (not headless)
- Per-character typing jitter (120–270ms), resampled per keystroke
- Pre-typing read pause (600–1500ms), post-typing proofread pause (1000–2500ms)
- Popover click pauses (1200–2500ms around each mode/setting flip)
- Inter-clip cooldown for extends (5–15s random, matches inter-job cooldown)
- `navigator.webdriver = false` via `addInitScript`
- `SingletonLock` cleanup on startup (inherited via `lib/browser.js`)

Additional video-specific anti-detection: **do not retry failed clips**. A
retry after a timeout or a "Create" click that didn't visibly finish is a
strong bot signal (humans would reload the page or walk away). Fail-fast and
let the caller decide.

## 12. Rollout plan

Implementation order, smallest-safe-change-first:

1. **Refactor existing code without behavior change**: extract `lib/browser.js`,
   split `lib/selectors.js` namespaces, extract `lib/cli-shared.js`. Rename
   `lib/flow.js` → `lib/image.js` after extracting the shared parts. Update
   `server.js` and `bin/flow-cli.js` to use the new module paths. Run
   existing unit tests — must still pass with zero changes to behavior.
   Commit as one refactor.

2. **Generalize the queue**: loosen `lib/queue.js::enqueue` to take an opaque
   payload. Verify existing tests still pass. Commit.

3. **Add `POST /enqueue` video body discrimination**: accept the new video
   body shape, reject with `400` if neither shape matches. Still no video
   worker yet — the daemon just understands the shape. Add a test.
   Commit.

4. **Implement `lib/video.js` against the mock fixture**:
   - Build `test/mock-flow-video.html`
   - Write `test/video.test.js` tests against it
   - Implement `lib/video.js::runJob` to pass those tests
   - Wire `server.js::drainQueue` to dispatch to `video.runJob` for video jobs
   Commit when all mock tests pass.

5. **Write `bin/flow-video-cli.js`**: thin CLI, uses `lib/cli-shared.js`.
   Add to `package.json` bin map.
   Commit.

6. **Add the dev preview server**: `scripts/dev-preview-server.js` plus the
   `.gitignore` entry for `tmp/dev-preview/`. Commit.

7. **Live-test the Playwright flow against real Flow**, using the
   screenshot-confirm protocol from §9, iterating on the video selectors
   until each step passes. During this phase, selectors may churn — each
   update is a small commit.

8. **Update documentation** — README (usage examples for video), AGENTS.md
   (add a "Three output modes" parallel for video, update the architecture
   one-pager). Commit.

9. **Final sanity pass**: run `npm test`, run one full live `flow-video-cli
   generate "..."`, verify the mp4 opens and plays correctly. Merge.

Each commit on the `feat/video-cli` branch is independently reviewable.

## 13. Open questions

None at design time. All decisions above have been confirmed with the user
during brainstorming:

- Name: `flow-video-cli` (sibling to `flow-cli`)
- Same repo, split internally
- Standalone output only (no Content Hub mirror)
- Variadic prompts = text + N-1 extends; one stitched mp4 output
- Unified daemon, one queue, type dispatched by body shape
- Screenshot-confirm dev workflow via a local static server (not the `bridge`)

Selector-level questions (video tab label, extend button exact DOM) are
deferred to live implementation in §12 step 7, and will be resolved by the
screenshot-confirm protocol, not by guessing.
