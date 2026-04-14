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
npm install -g .          # makes `flow-cli` available globally
```

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

---

## CLI

`flow-cli generate` has **three output modes**, in precedence order:

| Flags | Where the image lands | Use case |
|---|---|---|
| `--output PATH` | exactly `PATH` (absolute), or `<FLOW_ROOT_DIR>/PATH` (relative) | explicit one-off saves |
| `--project-id N --segment-id M` | `<FLOW_ROOT_DIR>/priv/uploads/video_projects/N/segments/M/flow.png` | Content Hub integration |
| *(no flags)* | `/tmp/flow_content/flow-<unix-timestamp>.png` | casual standalone default |

Examples:

```bash
flow-cli daemon                                            # foreground HTTP daemon (Ctrl+C exits)
flow-cli health                                            # JSON health check

# Standalone — image saved under /tmp/flow_content/
flow-cli generate "a red apple on wood, 16:9"

# Custom output path (absolute)
flow-cli generate "a cat on a bench" --output ~/Pictures/cat.png

# Custom output path (relative to daemon's FLOW_ROOT_DIR)
flow-cli generate "a dog" --output custom/dog.png

# Content Hub integration — saves under video_projects/<p>/segments/<s>/flow.png
flow-cli generate "neurons firing" --project-id 1 --segment-id 42

# Prompt via stdin (any mode)
echo "a sunset over the ocean" | flow-cli generate

# Full JSON output (image_path + timing + status + error_code)
flow-cli generate --prompt "a brain" --project-id 1 --segment-id 44 --json
```

On success the CLI prints the image path to stdout (or full JSON with `--json`).
Exit codes: `0` ok, `1` bad args, `2` daemon unreachable, `3` generation failed.

---

## HTTP API (for non-CLI callers, e.g. Content Hub's Elixir)

The daemon exposes three endpoints on `127.0.0.1:47321`:

```
GET  /health             → {ok, browser_connected, logged_in, queue_depth, version}
POST /enqueue            → body + returns
GET  /status/:job_id     → {status, image_path, output_path, error_code, ...}
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
| `network` | Image download failed — retry |

---

## Layout

```
flow-daemon/
├── bin/flow-cli.js       # CLI entry point
├── server.js             # Express HTTP server + worker loop + graceful shutdown
├── lib/
│   ├── flow.js           # Playwright automation (image mode toggle, src-diff, download)
│   ├── queue.js          # In-memory FIFO job queue
│   └── selectors.js      # Single source of CSS/Playwright selectors
└── test/
    ├── daemon.test.js    # Unit tests against a local mock-flow.html fixture
    ├── e2e-wizard.js     # System test (requires Content Hub running on :4000)
    └── mock-flow.html    # Local Flow look-alike for hermetic Playwright tests
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

Don't scatter selectors across `flow.js`. Keeping them all in
`selectors.js` means UI drift is a one-file fix.

---

## Anti-detection measures (already in place)

- Headed Chromium, persistent profile (vs. headless which Google blocks)
- Per-character typing delay (40-90ms jitter, ~60-100 WPM)
- Random pauses before/after typing (read + proofread mimicry)
- 5–15s cooldown between jobs (no tight loops)
- `navigator.webdriver = false` via `addInitScript`
- Stale `SingletonLock` cleanup on startup so kill -9 doesn't brick the profile
- Graceful SIGINT/SIGTERM shutdown

These are the high-impact basics. For a personal tool driving your own
account, this is enough — Google's bot detection is much more aggressive
against headless scrapers than against headed automation with real session
cookies and humanized timing.

---

## License

Personal use. Don't deploy publicly. Driving Google Flow via automation
is against ToS in spirit and could risk your Google account suspension if
abused.
