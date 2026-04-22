---
name: debug-flow-daemon
description: Use when debugging flow-daemon issues — `flow-cli`/`flow-video-cli` jobs that fail or produce wrong output, Flow UI drift (`selector_missing`), `extend_failed` mid-chain, video that plays only a few seconds, ffmpeg concat errors, wrong aspect ratio, image CLI returning video thumbnails. Lists the four debug tools in this repo (dev-preview server, dev-stepper, mock fixtures, daemon.log) plus known failure mode playbooks and lessons learned. Invoke BEFORE touching `lib/*.js` or `lib/selectors.js` for any reported bug.
---

# Debugging flow-daemon

## When to use

A job failed, produced wrong output, or a user reports "it used to work."
Also use before modifying `lib/selectors.js` or any worker in `lib/` — the
playbooks below short-circuit a lot of rediscovery.

## Debug tools (all local, all in this repo)

### 1. `scripts/dev-preview-server.js` — show media to the user

Terminal can't render mp4/png. The preview server serves
`tmp/dev-preview/` over Tailscale so the user can open it on any device.

```bash
# Start (binds localhost by default; set FLOW_PREVIEW_HOST=0.0.0.0 to expose)
FLOW_PREVIEW_HOST=0.0.0.0 node scripts/dev-preview-server.js &
# Tailscale URL: https://mac-mini.tailf56d7b.ts.net:47399/
```

Copy any output into `tmp/dev-preview/` with a dated filename
(`YYYY-MM-DD-HH-MM-SS-<desc>.mp4`) so the index sorts newest-first. If
the user says "I don't see the video," check in order: (a) file
permissions (0600 breaks the HTTP server — `chmod 644`), (b) mp4 `moov`
atom position (`python3 -c "print(b'moov' in open('f.mp4','rb').read(200000))"`
— False means moov is at EOF and browser stalls), (c) browser cache.

### 2. `scripts/dev-stepper.js` — interactive Playwright REPL

When a selector fails or Flow's UI changes, use dev-stepper to
step through the flow against real Flow with screenshots at each step.
Commands include: `ensure-video`, `type`, `click-create`, `wait-clip`,
`click-latest-clip`, `click-extend`, `nav-grid`, `download`,
`download-src`, `inline-model`, `dump-srcs`, `download-modal`.

**Before using:** kill the daemon first (`lsof -ti :47321 | xargs -r kill`),
otherwise you'll have two Chromiums fighting over the profile lock.

### 3. Mock fixtures — hermetic tests, no quota

`test/mock-flow.html` (image) and `test/mock-flow-video.html` (video)
mirror Flow's DOM. `node --test test/video.test.js` runs in ~30s with
zero network, zero Flow credits. If you change a selector, update the
matching fixture or the test goes red.

### 4. `~/.flow-daemon/daemon.log` — stdout+stderr

The daemon redirects both streams here. Tail it during live runs. Key
log lines to look for:
- `[flow-daemon] model for this job: <name>` — confirms model policy
- `[flow-daemon] mode popover state: ...` — confirms `modeButton` matched
- `[flow-video] setting aspect ratio: 9:16` — confirms aspect click happened
- `[flow-video] clip N rendered: <url>` — confirms clip completed
- `[flow-video] switching model: "..." → <name>` — confirms extend model click
- `[flow-video] ffmpeg: N clip(s), ...` — confirms stitch started

Missing any of these mid-run is a clue about which step broke.

## Rules when running live against Flow

- **Confirm every Create/Generate click with the user.** Each one burns
  Flow credits. Dropdown selection, tab switching, typing into prompt
  input — these do NOT need confirmation.
- **Prompts in Vietnamese** (user's established convention for this
  project's test prompts).
- **Vary prompts every run.** Identical prompts in quick succession is a
  bot-detection signal. Never loop `"test"`, `"hello"`, `"a brain"`.
- **One Chromium against the profile, always.** Kill the daemon before
  opening Chromium manually with `lsof -ti :47321 | xargs -r kill`.

## Failure mode playbook

### Video plays only a few seconds then stops
- **Check:** `moov` atom position. `python3 -c "print(b'moov' in open('f.mp4','rb').read(200000))"` → False means moov is at EOF.
- **Fix:** `-movflags +faststart` in `lib/video.js::buildFfmpegArgs` (already applied — regression risk if someone rearranges ffmpeg args).

### ffmpeg errors "Input link parameters do not match"
- **Check:** clip dimensions — `for f in /tmp/flow_video/_parts-*/clip-*.mp4; do ffprobe -v error -show_entries stream=width,height -of csv=s=x:p=0 "$f"; done`. Mixed dims (e.g. one clip 1280x720, another 720x1280) means Flow delivered inconsistent aspects.
- **Fix:** per-input `scale=TW:TH:force_original_aspect_ratio=decrease,pad=TW:TH:...` in `buildFfmpegArgs` (already applied). Output gets pillarbox/letterbox bars on the wrong-aspect clip but doesn't crash.

### Clip 0 comes out landscape when asked portrait
- **Known bug, low-priority.** `ensureVideoModeForNewScene` clicks `aspectOption('9:16')` successfully per daemon log but Flow still renders landscape. Root cause not diagnosed — possibly project-level aspect cache, or aspect selector matching wrong element. ffmpeg scale-pad masks it (pillarbox bars on clip 0).
- **If you want to fix:** use dev-stepper, screenshot after each step in `ensureVideoModeForNewScene` (`lib/video.js:148`), check which element `aspectOption('9:16')` actually matches in real Flow.

### Image CLI saves a tiny (<200KB) JPEG "image"
- **Symptom:** user reports "it looks like a video thumbnail, and I see a video on Flow."
- **Check:** `~/.flow-daemon/daemon.log` — look for `mode popover state:` line. Missing means `ensureImageModeAndCount` returned early at `modeBtn = null`.
- **Root cause:** `selectors.common.modeButton` failed to match. Previously hardcoded `crop_16_9` so it missed when Flow was in portrait state.
- **Fix:** `modeButton` must match any aspect variant: `'button:not(.flow_tab_slider_trigger):has-text("crop_")'` (already applied in `lib/selectors.js`).

### `extend_failed` mid-chain
- **Check:** response JSON has `failed_at_index` (0-indexed) and `completed_prompts`. Flow scene is kept intact; no auto-retry.
- **Common causes:** prompt too weird / got rejected by Flow's content filter, timeout (>180s), Flow session expired mid-run.
- **Fix:** user decides — retry same prompts, edit the failing prompt, or manually extend in Flow UI.

### `selector_missing` — Flow UI changed
- **Don't panic-update.** Kill daemon, start dev-stepper, navigate to project, inspect the failing element. Prefer `role`, `aria-label`, or stable text substrings. Avoid class names — Flow rotates them.
- **Single-source rule:** edit ONLY `lib/selectors.js`. Update the matching mock fixture (`test/mock-flow.html` or `test/mock-flow-video.html`). Run `npm test`.

### `--frame` job completes but clip 0 doesn't start from the frame
- **Root cause:** Flow's Frames-to-Video doesn't accept a raw `setInputFiles` on the hidden `<input type=file>`. You must walk its real UI: Start slot label → scroll library to bottom → `"Upload image"` row → `"I agree"` Terms popup (first upload per account only) → Playwright intercepts native filechooser via `page.waitForEvent('filechooser')` → `setFiles` → ~12s processing wait. If a naive earlier refactor put the upload before the mode popover, you'll get `selector_missing: Frames entry point not found` instead.
- **Verify:** `grep -iE "Start slot|Upload image|frame uploaded" ~/.flow-daemon/daemon.log` — all three lines should appear for a successful upload. If "frame uploaded" is present but the resulting video ignores the frame, Flow's state machine didn't bind (probe selector drifted).
- **Probe:** `scripts/dev-probe-frame-upload.js` runs the full path with time-series screenshots — no quota burn.

### Veo selector timeout mid-run (`crop_*` / aspect button) — transient
- **Symptom:** flow-video-cli returns `error_code: timeout` with
  `waiting for locator('button:not(.flow_tab_slider_trigger):has-text("crop_")')`
  or similar aspect-button selector. Happens on second+ run after a
  prior successful run.
- **Root cause:** Flow's Chromium page carries over sub-mode state
  between jobs (ex: stuck in Frames-to-Video after a previous
  `--frame` upload). `ensureVideoModeForNewScene` opens the popover
  but aspect options render differently in the stale sub-mode.
- **Fix:** kill the daemon + clear profile lock, then retry. Fresh
  Chromium page rehydrates to a clean state.
  ```bash
  lsof -iTCP:47321 -sTCP:LISTEN -t | xargs -r kill -TERM
  pkill -9 -f "user-data-dir=/Users/cuongnguyen/.flow-daemon/profile"
  rm -f ~/.flow-daemon/profile/Singleton{Lock,Socket,Cookie}
  ```
- **If recurring:** page cleanup step in `runJob` is missing — reset
  to grid before each new job. Track in `lib/browser.js`.

### Bash/shell breaks on Vietnamese multi-line prompts passed to flow-video-cli
- **Symptom:** `flow-video-cli generate` exits 400
  `"prompts must be non-empty strings"` despite prompts being populated
  in state.json. Python `json.loads` on a bash-quoted subprocess stdout
  can error with `Invalid control character` because user-edited textarea
  values contain real `\n` / `\r`.
- **Root cause:** shell loses data across pipe boundaries when Vietnamese
  strings contain quotes, newlines, or Unicode combining chars. `awk` /
  `sed` extracting prompts by line fails silently.
- **Fix:** use Python `subprocess.run(['flow-video-cli','generate', *prompts, ...])`
  with prompts as argv array. Python passes them as separate argv entries
  to the child — no shell escaping happens.
  ```python
  import subprocess, json, urllib.request
  d = json.loads(urllib.request.urlopen(url).read())
  subprocess.run(['flow-video-cli', 'generate', *d['video_prompts'], '--frame', frame, '--output', out, '--json'])
  ```
- **Pattern:** never use `bash | awk` or `bash | jq -r` on multi-line
  strings. Always Python in-process.

### Video output has no sound on one clip
- **Check:** each clip's streams via `ffprobe -show_streams`. Some Veo clips come back video-only.
- **Workaround:** ffmpeg concat currently assumes each input has both v+a. If one lacks audio, add `-f lavfi -i anullsrc` and route around the missing stream. Not yet hit in production.

### Daemon can't start — "Failed to create ProcessSingleton"
- **Root cause:** orphan Chromium holding `~/.flow-daemon/profile/SingletonLock`.
- **Fix:** Daemon's `cleanStaleProfileLock` (`lib/browser.js`) auto-clears if the PID is dead. If the PID is alive but isn't ours, the error is `profile_locked` with the offending PID — user must close it.

## Don't do

- **Don't use Flow's Download modal** to get the final scene. It always downloads one 8-second clip regardless of scene length. We fetch each clip directly from `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=<uuid>` (via `context.request.get` using profile cookies), then stitch with ffmpeg. See `lib/video.js` download loop.
- **Don't open a second Chromium against the same profile.** `SingletonLock` corruption, orphan processes, lost session.
- **Don't hardcode a specific aspect token** (`crop_16_9`, `crop_9_16`) in any selector. The mode button's label embeds whatever aspect is currently selected — use `has-text("crop_")` and exclude wrong matches via class / other substrings.
- **Don't copy part files directly** for the single-clip case. Always run ffmpeg (for `+faststart` and 1080p scale) — only skip for mock fixtures (data-URL parts aren't real mp4).
- **Don't scatter selectors** across multiple files. `lib/selectors.js` is the only source; UI drift is a one-file fix.

## Key files quick-reference

| File | What's in it |
|---|---|
| `lib/selectors.js` | CSS/Playwright selectors, namespaced `common`/`image`/`video` |
| `lib/image.js` | Image-mode worker (`ensureImageModeAndCount`, src-diff wait) |
| `lib/video.js` | Video-mode worker (`ensureVideoModeForNewScene`, extend loop, ffmpeg stitch) |
| `lib/browser.js` | Shared Chromium/profile lifecycle, anti-detection |
| `lib/cli-shared.js` | Shared CLI helpers (daemon auto-start, flag parsing) |
| `server.js` | HTTP routes, worker loop, dispatch by payload type |
| `bin/flow-cli.js` | Image CLI |
| `bin/flow-video-cli.js` | Video CLI |
| `test/mock-flow.html` | Image-mode Playwright fixture |
| `test/mock-flow-video.html` | Video-mode Playwright fixture |
| `scripts/dev-preview-server.js` | Tailscale-exposed static server |
| `scripts/dev-stepper.js` | Interactive Playwright REPL |
| `scripts/dev-probe-frame-upload.js` | End-to-end `--frame` upload path probe (Start slot → library scroll → Upload image → I agree → filechooser). Zero-quota. Use when `--frame` jobs break or Flow changes the Frames-to-Video UI. |
| `~/.flow-daemon/daemon.log` | Daemon stdout+stderr |
| `~/.flow-daemon/profile/` | Persistent Chromium profile (do not touch) |
