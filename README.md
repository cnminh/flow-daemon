# flow-daemon

Playwright-driven HTTP daemon + CLI that generates images via
[Google Flow](https://labs.google/flow/) using your logged-in browser session.

Originally extracted from
[content-hub](https://github.com/cnminh/content-hub) where it powers Step 4
of the video production wizard. This is a **local personal tool** —
don't deploy it, don't expose the port, don't run it on shared machines.
Google Flow's ToS doesn't love automated access; you're driving your own
account at your own risk.

---

## Install

```bash
git clone https://github.com/cnminh/flow-daemon.git
cd flow-daemon
npm install
npx playwright install chromium
npm install -g .          # makes `flow-cli` and `flow-video-cli` globally
```

`flow-video-cli` also needs `ffmpeg` on PATH (used to trim + concat +
scale each multi-clip scene to 1080p). On macOS: `brew install ffmpeg`.

---

## First-time setup

The daemon launches a dedicated Chromium with a persistent profile at
`~/.flow-daemon/profile/`. On the first run it'll be logged-out;
sign in to your Google account in that Chromium window once and the
session is saved forever.

```bash
flow-cli daemon          # starts the HTTP server + opens Chromium
# In Chromium: navigate to https://accounts.google.com, log in, then
# https://labs.google/fx/tools/flow/ — make sure you can see the prompt input.
# Ctrl+C the daemon when done with first-run setup.
```

After first-run login, you don't need to run `flow-cli daemon` by hand
anymore — `flow-cli generate` auto-starts the daemon if it isn't already
running, and the daemon auto-shuts-down after 30min of idleness.

---

## CLI

Subcommands:

| Command | Purpose |
|---|---|
| `flow-cli daemon` | Start the HTTP daemon in the foreground (Ctrl+C to stop) |
| `flow-cli health` | Full daemon health JSON |
| `flow-cli status` | Short human-readable snapshot: `idle` or `busy: generating (Ns elapsed)` |
| `flow-cli generate [PROMPT] [flags]` | Generate an image. **Auto-starts the daemon if it's not running** |
| `flow-video-cli generate [PROMPT...] [flags]` | Generate a video (variadic prompts = chained extends). Uses the same daemon. |
| `flow-cli help` / `--help` / `-h` | Print help |

`flow-cli generate` has **three output modes**, in precedence order:

| Flags | Where the image lands | Use case |
|---|---|---|
| `--output PATH` | exactly `PATH` (absolute), or `<FLOW_ROOT_DIR>/PATH` (relative) | explicit one-off saves |
| `--project-id N --segment-id M` | `<FLOW_ROOT_DIR>/priv/uploads/video_projects/N/segments/M/flow.png` | Content Hub integration |
| *(no flags)* | `/tmp/flow_content/flow-<unix-timestamp>.png` | casual standalone default |

Examples:

```bash
# Standalone — no flags, image saved under /tmp/flow_content/
flow-cli generate "A weathered wooden bridge over a mountain stream in late autumn, 16:9"

# Custom output path (absolute)
flow-cli generate "A ceramic coffee cup on a worn leather journal" --output ~/Pictures/coffee.png

# Custom output path (relative to daemon's FLOW_ROOT_DIR)
flow-cli generate "a misty pine forest at dawn" --output custom/forest.png

# Content Hub integration — saves under video_projects/<p>/segments/<s>/flow.png
flow-cli generate "neurons firing, cinematic macro, 16:9" --project-id 1 --segment-id 42

# Prompt via stdin (any mode)
echo "a sunset over the Pacific, long exposure clouds" | flow-cli generate

# Full JSON output (image_path + timing + status + error_code)
flow-cli generate "an elderly man reading under lamplight" --output out.png --json

# Check if daemon is running (returns exit code 0/2)
flow-cli status
```

On success the CLI prints the image path to stdout (or full JSON with `--json`).
Exit codes: `0` ok, `1` bad args, `2` daemon unreachable, `3` generation failed.

### `flow-video-cli` — video mode

A sibling CLI that drives Flow in **video mode** alongside `flow-cli`'s
image mode. Same daemon, same Chrome, same queue — video jobs take turns
with image jobs.

~~~bash
# One prompt → one ~8-second clip, portrait by default
flow-video-cli generate "a weathered lighthouse at dusk"

# Variadic prompts → Flow's Extend feature chains them in one scene.
# Output is one stitched mp4; each extend clip has ~1s of overlap at
# its head trimmed before concat.
flow-video-cli generate "scene opens" "something happens" "scene closes"

# Landscape instead of default portrait
flow-video-cli generate "a pine forest at dawn" --orientation landscape

# Seed the first clip from a still image (frames-to-video)
flow-video-cli generate "waves grow bigger" --frame hero.png

# Pipe from flow-cli for the hero-image → video pipeline
flow-cli generate "a lighthouse at dusk" --output hero.png
flow-video-cli generate "waves grow bigger" --frame hero.png --output out.mp4
~~~

Default output path: `/tmp/flow_video/flow-<unix-ts>.mp4`. Override with
`--output PATH` (absolute or relative). No Content Hub pathing — use
`--output` when integrating with Content Hub.

Output is scaled to **1080p** (1920×1080 landscape, 1080×1920 portrait)
using lanczos resize — not a learned upscale, so quality is bounded by the
720p Flow source. Requires `ffmpeg` on PATH.

Video-specific flags:

- `--frame PATH` — starting image (frames-to-video)
- `--model NAME` — Veo 3.1 model (`Veo 3.1 - Quality`, `Veo 3.1 - Fast`,
  `Veo 3.1 - Lite`). Default: Quality for the first clip, random
  Quality/Fast for each extend (Lite is skipped — too blocky for long chains)
- `--orientation portrait|landscape` — default `portrait`. Maps to `--aspect`.
  Only applies to the first clip; extends inherit the scene's aspect.
- `--aspect 9:16|16:9` — lower-level alias; default `9:16`
- `--overlap SECONDS` — trim amount at each extend seam. Default `1.0` —
  matches Veo's extend feature, which replays ~1s of the prior clip at the
  start of each extension for temporal continuity.
- `--dry-run` — print the payload that would be sent and exit 0, no quota burn

Video-specific error codes (in addition to the image-side ones):

| code | what to do |
|---|---|
| `extend_failed` | A specific extend step timed out. Response includes `failed_at_index` (0-indexed prompt that failed) and `completed_prompts`. The Flow scene is kept for manual inspection. |
| `frame_invalid` | `--frame PATH` doesn't exist, isn't png/jpg, or Flow rejected the upload. |

---

### Daemon lifecycle

You almost never need to manage the daemon by hand. The CLI handles it:

- `flow-cli generate` auto-starts the daemon if not running (spawns it
  detached in the background, waits up to 15s for it to respond, then
  proceeds with the enqueue). First call after a cold start adds ~2s.
- The daemon **auto-shuts-down after 30 minutes of idleness** (no queued
  jobs, no running worker, no enqueues). Override with
  `FLOW_DAEMON_IDLE_TIMEOUT_MIN` env var (set to `0` to disable).
- Background daemon logs go to `~/.flow-daemon/daemon.log` (append-only).
- To stop the daemon manually: `kill $(lsof -ti :47321)` — sends SIGTERM
  which closes Chromium cleanly so the profile's `SingletonLock` is
  released.

### When a generation fails

Three error codes need you to act in the Chromium window (the CLI cannot
recover these automatically):

- `not_logged_in` — sign back into Google in the Chromium window, then retry
- `captcha` — solve the CAPTCHA in the Chromium window, then retry
- `quota_exceeded` — wait for daily quota reset (Flow credits)

Other errors (`timeout`, `network`, `selector_missing`, `browser_crashed`)
are transient or require a code fix. Just wait a minute and retry — do
**not** restart the daemon for every transient failure, that thrashes the
browser profile and wastes the logged-in session.

---

## HTTP API (for non-CLI callers, e.g. Content Hub's Elixir)

The daemon exposes three endpoints on `127.0.0.1:47321`:

```
GET  /health             → {ok, browser_connected, logged_in, worker_busy,
                            queue_depth, current_job, version}
POST /enqueue            → body + returns
GET  /status/:job_id     → {status, image_path, output_path, error_code, ...}
```

`/health` includes a `current_job` object describing what's being generated
right now (or `null` if idle), plus `worker_busy` to distinguish "idle" from
"actively running a job" — `queue_depth: 0` alone is ambiguous:

```jsonc
{
  "ok": true,
  "browser_connected": true,
  "logged_in": true,
  "worker_busy": true,
  "queue_depth": 0,
  "current_job": {
    "job_id": "j_mnv2ub731",
    "prompt": "A weathered wooden bridge over a mountain stream...",
    "started_at": "2026-04-14T17:10:32Z",
    "output_path": "/tmp/flow_content/flow-1776176358.png",
    "project_id": null,
    "segment_id": null
  },
  "version": "0.2.0"
}
```

`POST /enqueue` body:

```jsonc
{
  "prompt": "string (required)",
  // Provide either output_path OR (project_id + segment_id):
  "output_path": "string",    // absolute, or relative to FLOW_ROOT_DIR
  "project_id": 0,            // integer, legacy Content Hub pattern
  "segment_id": 0             // integer, legacy Content Hub pattern
}
// → {"job_id": "j_...", "queue_position": 1}
```

When both are supplied, `output_path` wins. When neither is supplied, the
endpoint returns `400`.

For video jobs, `POST /enqueue` also accepts a video body shape:

```jsonc
{
  "prompts": ["first prompt", "extend prompt 2"],  // 1..N
  "output_path": "/abs/path.mp4",                  // required, absolute
  "frame_path": "/abs/hero.png",                   // optional starting frame
  "model": "Veo 3.1 - Fast",                       // optional; pins the whole
                                                   // chain to this model
  "aspect": "9:16",                                // optional, "9:16" (default) or "16:9"
  "overlap_seconds": 1.0                           // optional, default 1.0 — ffmpeg
                                                   // trim amount at each extend seam
}
```

Body discrimination: presence of `prompts` array → video job; presence of
single `prompt` string → image job (existing behavior unchanged).

`image_path` in the `/status` response is the path the image was actually
written to — same as what the CLI prints on stdout.

`error_code` taxonomy when `status: "error"`:

| code | what to do |
|---|---|
| `not_logged_in` | Sign in to Flow in the Chromium window, retry |
| `captcha` | Solve the CAPTCHA in the Chromium window, retry |
| `quota_exceeded` | Wait until daily quota resets |
| `timeout` | Flow took >180s — retry |
| `selector_missing` | Flow UI changed — see "When Flow UI changes" below |
| `browser_crashed` | Restart the daemon |
| `profile_locked` | Another Chromium is using `~/.flow-daemon/profile/` and it's not ours. The error message shows the offending PID — close it manually and retry. (If it IS an orphan of ours, the daemon auto-kills it; this error only fires when the lock-holder is an unrelated process.) |
| `network` | Image download failed — retry |
| `extend_failed` | Video only. A mid-chain extend step timed out. Status response includes `failed_at_index` and `completed_prompts`; no auto-retry. |
| `frame_invalid` | Video only. `--frame` path doesn't exist, isn't png/jpg, or Flow rejected the upload. |

---

## Layout

```
flow-daemon/
├── bin/
│   ├── flow-cli.js                # CLI for image generation
│   └── flow-video-cli.js          # CLI for video generation
├── server.js                      # Express HTTP server + worker loop + dispatch by job type
├── lib/
│   ├── browser.js                 # Shared Playwright/profile lifecycle, anti-detection
│   ├── cli-shared.js              # Shared daemon lifecycle + flag parsing (used by both CLIs)
│   ├── image.js                   # Image-mode Playwright worker
│   ├── video.js                   # Video-mode Playwright worker (frames-to-video + extend + ffmpeg stitch to 1080p)
│   ├── queue.js                   # In-memory FIFO job queue (payload-agnostic)
│   └── selectors.js               # Single source of CSS/Playwright selectors (common/image/video)
├── scripts/
│   ├── dev-preview-server.js      # Dev-time static server serving tmp/dev-preview/ over Tailscale (not shipped)
│   └── dev-stepper.js             # Interactive Playwright REPL for live-inspecting Flow selectors (not shipped)
└── test/
    ├── daemon.test.js             # HTTP + dispatch tests (image + video)
    ├── video.test.js              # Video-worker tests against mock-flow-video.html
    ├── mock-flow.html             # Image-mode Playwright fixture
    ├── mock-flow-video.html       # Video-mode Playwright fixture
    └── e2e-wizard.js              # System test (requires Content Hub)
```

---

## Config

| env var | default | purpose |
|---|---|---|
| `FLOW_DAEMON_PORT` | `47321` | HTTP port |
| `FLOW_DAEMON_URL` | `http://127.0.0.1:$PORT` | (CLI only) base URL when calling daemon |
| `FLOW_ROOT_DIR` | parent of `server.js` (resolves to repo root) | base dir for *relative* output paths. Absolute `output_path` values bypass it entirely. Default Content Hub pattern lives under this dir. |
| `FLOW_URL_OVERRIDE` | unset | (test only) navigate to this URL instead of `labs.google/fx/tools/flow/...` |
| `FLOW_DAEMON_IDLE_TIMEOUT_MIN` | `30` | Minutes of idleness (queue empty + no running job + no enqueues) before the daemon shuts itself down cleanly. Set to `0` to disable. The CLI auto-restarts it on the next `flow-cli generate`. |
| `FLOW_VIDEO_OUTPUT_DIR` | `/tmp/flow_video/` | (`flow-video-cli` only) Default directory for `flow-video-cli generate` when `--output` is not given. |

For Content Hub use, the daemon should be started with `FLOW_ROOT_DIR`
pointing at the Phoenix app root (so images land where Plug.Static can
serve them):

```bash
FLOW_ROOT_DIR=/Users/cuongnguyen/projects/content-hub/content_hub flow-cli daemon
```

---

## Testing

```bash
npm test                  # unit tests (~10s, hermetic — uses mock fixture)
npm run test:e2e          # system test (requires Content Hub running locally; ~30s)
```

The unit tests launch a real headless Chromium against a local
`test/mock-flow.html` fixture, so they don't hit Google. Safe in CI or
without internet.

The E2E test is opt-in; it expects a running Phoenix app on `:4000` with
`content_hub_dev` Postgres and a `video_projects.id=1` row containing a
segment with id 249 and a populated `image_prompt`.

---

## When Flow UI changes

Google ships UI tweaks to Flow occasionally. When jobs start failing
with `selector_missing`:

1. Run `flow-cli daemon` — Chromium opens.
2. Navigate to your Flow project. The prompt input should be visible.
3. Right-click elements → Inspect. Prefer stable attributes:
   `aria-label`, `data-testid`, `role`. Avoid class names — they rotate.
4. Edit `lib/selectors.js` — the only file with selectors. Save.
5. Restart the daemon. Retry a job.

Don't scatter selectors across the worker files (`image.js`, `video.js`).
Keeping them all in `selectors.js` means UI drift is a one-file fix.

---

## Anti-detection measures (already in place)

- Headed Chromium, persistent profile (vs. headless which Google blocks)
- **Per-character random typing delay** (120–270ms jitter, ~30 WPM). The
  jitter value is resampled *each keystroke* via a manual loop, not
  Playwright's `{delay: N}` option which uses a single fixed N for the
  whole string — that earlier shape was flagged as "unusual activity".
- Random pauses before/after typing (600–1500ms read, 1000–2500ms proofread)
- Random pauses around every settings-popover click (1200–2500ms). The
  previous 400–800ms was fast enough to trigger Google's detection when
  combined with fast typing.
- 5–15s random cooldown between jobs (no tight loops)
- `x1` output count by default — halves both generation time and quota
  burn per call
- `navigator.webdriver = false` via `addInitScript`
- Stale `SingletonLock` cleanup on startup so kill -9 doesn't brick the profile
- Graceful SIGINT/SIGTERM shutdown

These are the high-impact basics. For a personal tool driving your own
account, this is enough — Google's bot detection is much more aggressive
against headless scrapers than against headed automation with real session
cookies and humanized timing.

---

## Best practices

Collected lessons from actually running this against real Flow:

1. **Vary your prompts.** Don't hammer the same prompt ("a brain", "hello",
   "test") repeatedly — identical prompts from the same account in quick
   succession is itself a bot signal. Use real, meaningful, varied
   descriptions when testing. Every prompt should look like something a
   real person would type.
2. **Don't open multiple sessions of the same profile.** The daemon
   auto-manages its one Chromium instance with the profile at
   `~/.flow-daemon/profile/`. Never launch a second Chromium against the
   same profile — it'll fight for `SingletonLock`, one of them crashes,
   and you get orphan chromium processes. If you need to manually
   inspect the browser, kill the daemon first.
3. **Let transient failures clear naturally.** If a generation fails
   with `timeout` or `selector_missing` once, don't panic-restart the
   daemon. Wait a minute, retry within the same session. The logged-in
   state and browser warmth are valuable; throwing them away on every
   error just thrashes.
4. **Don't burn jobs in a loop.** The built-in 5–15s cooldown between
   jobs is deliberate. Don't add a wrapper script that hammers
   generations back-to-back with no gap — that's textbook bot behavior.
5. **If Google flags the account with "unusual activity", stop for
   ~15 minutes** before trying again. Don't retry immediately. The
   flag usually clears within that window. If it persists, log into
   Flow as a human for a few minutes (browse projects, view images)
   before resuming automation.
6. **Keep the profile on one machine.** Don't try to sync
   `~/.flow-daemon/profile/` across devices — Google's session binding
   makes session cookies tied to a particular device fingerprint.
   Copying the profile to another machine triggers re-verification.
7. **Rotate your prompts through your own pool when doing batch work.**
   For Content Hub's 12-segment batches, the PromptEnricher already
   makes each prompt distinct because it's derived from different
   script text. If you write your own batch tooling, do the same —
   never send 12 identical prompts.

---

## License

Personal use. Don't deploy publicly. Driving Google Flow via automation
is against ToS in spirit and could risk your Google account suspension if
abused.
