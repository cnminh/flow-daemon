# AGENTS.md

Brief for AI agents (Claude, Codex, Gemini, etc.) working on this repo.
If you're a human, read [README.md](README.md) instead — it covers everything
below from a user's perspective.

---

## What this project is

`flow-daemon` is a Node.js HTTP daemon + two CLIs (`flow-cli` for images,
`flow-video-cli` for videos) that drive [Google Flow](https://labs.google/fx/tools/flow/)
via Playwright. The daemon is unified — one process, one Chromium, one FIFO
queue; jobs are discriminated by body shape (image vs video). Invariant #1
(single job at a time) still holds across both kinds.

It's a personal tool — no deployment, no SaaS, no multi-user anything. One
user, one logged-in Chromium profile, localhost HTTP only.

It's the extracted sidecar for [content-hub](https://github.com/cnminh/content-hub)
but the HTTP surface is generic enough to be called by anything.

---

## Invariants — do not break these

1. **Single daemon, single browser, single job at a time.** The `workerBusy`
   flag in `server.js` gates concurrency. Don't try to parallelize jobs — Flow
   is one session, and concurrent clicks will race the Playwright page state.
2. **Never open a second session against `~/.flow-daemon/profile/`.** If you
   need to inspect the browser manually (e.g. debugging Flow UI changes),
   kill the daemon first. Two chromium instances fighting over one profile
   corrupts `SingletonLock` and leaves orphan processes.
3. **Selectors live in `lib/selectors.js` — nowhere else.** When Google ships
   a UI change, one-file edit.
4. **Anti-detection timing must stay.** These values are load-bearing
   against Google's bot detection — don't "optimize" them away:
   - Per-character typing delay (120–270ms jitter) sampled **per keystroke**
     via a manual loop, *not* Playwright's `{delay: N}` option (which uses
     a fixed N for the whole string — previously flagged as "unusual activity")
   - Random pauses around settings-popover clicks (1200–2500ms)
   - Pre-typing read pause (600–1500ms), post-typing proofread pause (1000–2500ms)
   - 5–15s random cooldown between jobs
   - `navigator.webdriver` erased via `addInitScript`
5. **The daemon never takes credentials.** The whole point of persistent
   profile + manual first-login is so passwords never touch automation code.
   Don't add a `/login` endpoint or a `GOOGLE_PASSWORD` env var.
6. **Only bind to `127.0.0.1`.** Never `0.0.0.0`. This daemon drives a
   logged-in browser — anyone on your network could hijack it. If you
   genuinely need remote access, use SSH port-forwarding or Tailscale.
7. **Output count is `x1` and that's deliberate.** We download one image
   per job; generating more wastes Flow quota and generation time. The
   `ensureImageModeAndCount(page, 1)` call in `runJob` sets this. Don't
   raise the default.
8. **The profile path is `~/.flow-daemon/profile/`** (not
   `~/.content-hub/...` — that was before the repo was extracted). Don't
   reintroduce references to the content-hub path.

---

## Three output modes (core contract)

`POST /enqueue` accepts a prompt plus **either** `output_path` **or** the
Content Hub `(project_id, segment_id)` pair. The server resolves the target
path in `server.js::drainQueue` and `lib/image.js::runJob`:

| Input | Target path |
|---|---|
| `output_path: "/abs/path.png"` (absolute) | used as-is |
| `output_path: "custom/rel.png"` (relative) | `<FLOW_ROOT_DIR>/custom/rel.png` |
| `project_id, segment_id` | `<FLOW_ROOT_DIR>/priv/uploads/video_projects/<p>/segments/<s>/flow.png` |

CLI defaults (`bin/flow-cli.js::cmdGenerate`):

- No flags → `output_path: /tmp/flow_content/flow-<unix-ts>.png` (standalone)
- `--output PATH` → `output_path: PATH`
- `--project-id / --segment-id` → legacy Content Hub path

**Back-compat rule:** the legacy `{project_id, segment_id}` body shape must
keep working. Content Hub's Elixir `FlowClient` relies on it. Don't remove
that code path.

---

## Build, run, test

```bash
npm install                                          # deps
npx playwright install chromium                      # browser binary
npm install -g .                                     # global `flow-cli` command

flow-cli daemon                                      # foreground daemon on :47321
flow-cli health
flow-cli generate "a bowl of ramen, 16:9"            # standalone → /tmp/flow_content/
flow-cli generate "x" --project-id 1 --segment-id 2  # Content Hub path

npm test                                             # unit tests (hermetic, ~10s)
npm run test:e2e                                     # e2e vs Content Hub (needs Phoenix on :4000)
```

The unit tests run real headless Playwright against `test/mock-flow.html`
over `file://`. No network. Safe in any environment.

The daemon uses env vars — see README "Config" section. Key ones:
`FLOW_DAEMON_PORT`, `FLOW_ROOT_DIR`, `FLOW_URL_OVERRIDE` (test-only).

---

## Architecture one-pager

```
flow-cli / flow-video-cli (CLIs)     External caller (Elixir FlowClient, curl, etc.)
    │                                        │
    └──── HTTP POST /enqueue ────────────────┘
                 │
                 ▼
          server.js  (Express, :47321)
                 │  enqueues to queue.js
                 │  setImmediate(drainQueue)
                 ▼
          queue.js  (FIFO, in-memory, singleton)
                 │
                 ▼
          server.js::drainQueue
                 │  workerBusy=true
                 │  queue.markRunning()
                 │  dispatches by payload.type:
                 ├── image → lib/image.js::runJob
                 │           ensureImageMode, type prompt, download png
                 └── video → lib/video.js::runJob
                             ensureVideoMode, optional frame-upload,
                             extend loop, download mp4
                 ▼
          queue.markDone / markError
                 │
                 ▼
          /status/:job_id polled by caller
```

Module responsibilities:

- `bin/flow-cli.js` — image CLI (unchanged surface). Argv parsing, mode resolution
  (standalone / output / Content Hub ids), HTTP calls to the daemon, polling,
  exit codes. Uses `lib/cli-shared.js` for daemon-lifecycle + flag parsing.
- `bin/flow-video-cli.js` — video CLI. Variadic prompts + `--frame` + `--model`
  + `--aspect` + `--json` + `--dry-run`. Same shared helpers.
- `server.js` — Express routes, worker loop (`drainQueue`), idle watchdog,
  signal handlers. Dispatches each job to `lib/image.js::runJob` or
  `lib/video.js::runJob` based on `payload.type`.
- `lib/browser.js` — shared Playwright/profile lifecycle: `launchPersistentContext`,
  `cleanStaleProfileLock` (orphan-kill machinery), `navigator.webdriver` erase,
  humanized pause/jitter helpers, page-find-or-create.
- `lib/image.js` — image-mode Playwright worker. `ensureImageModeAndCount`,
  random model pick across Nano Banana Pro / Nano Banana 2 / Imagen 4,
  image src-diff wait loop, download + write.
- `lib/video.js` — video-mode Playwright worker. `ensureVideoMode`, optional
  frame-upload, extend loop, stitched-scene download, `extend_failed` /
  `frame_invalid` error tagging.
- `lib/cli-shared.js` — shared CLI helpers: `ensureDaemonUp`, `findProcessOnPort`,
  `spawnDaemon`, `parseFlags`, `readStdin`, `sleep`. Parameterized by
  `{ port, url, serverPath, logDir, logFile }` so both CLIs can reuse.
- `lib/queue.js` — FIFO singleton. Payload-agnostic: each job carries an
  opaque `payload` object that the worker destructures as it needs.
- `lib/selectors.js` — single source of CSS/Playwright selectors, split into
  three namespaces: `common` (both modes), `image` (image-mode popover),
  `video` (video-mode popover + extend + download).
- `test/mock-flow.html` + `test/mock-flow-video.html` — static HTML fixtures
  that mimic Flow's DOM for hermetic Playwright tests. Must stay in lockstep
  with `selectors.js`.

---

## Coding conventions

- Plain Node, no bundler, no TypeScript. Require-style imports.
- Formatted like existing code: 2-space indent, single quotes, trailing
  commas in multi-line objects/arrays.
- Keep modules small. Each `lib/*.js` file has one clear responsibility.
  The split is already done: `lib/image.js`, `lib/video.js`, `lib/browser.js`,
  `lib/cli-shared.js`. Don't merge them back.
- Error handling: throw `Error` objects with `err.error_code` set to one of
  the documented codes. The worker loop in `server.js` maps these into the
  HTTP response; `browser_crashed` and `profile_locked` additionally clear
  the `browserConnected` health flag. Full taxonomy:
  - `not_logged_in` — Flow page doesn't show a prompt box; session expired.
  - `captcha` — CAPTCHA challenge detected in Chromium.
  - `quota_exceeded` — Flow's daily generation limit hit.
  - `timeout` — generation took >180s with no result.
  - `selector_missing` — expected DOM element not found; Flow UI drifted.
  - `browser_crashed` — Playwright page/context error; daemon restart needed.
  - `profile_locked` — `SingletonLock` held by a non-daemon process.
  - `network` — image/video download failed after generation.
  - `extend_failed` — video only. A mid-chain extend step didn't complete.
    Response includes `failed_at_index` (0-indexed) and `completed_prompts`
    (clips that succeeded before failure). The Flow scene is kept intact;
    no auto-retry. Caller decides.
  - `frame_invalid` — video only. `--frame PATH` failed validation: missing
    file, non-png/jpg, or Flow rejected the upload.
- HTTP requests from the CLI: use built-in `fetch` (Node 18+). No axios, no
  node-fetch dep.
- Tests: `node --test` runner, plain `assert`. No Jest, no Mocha.

---

## When you're asked to change something

- **Adding a selector:** put it in `lib/selectors.js`. Update the mock
  fixture in `test/mock-flow.html` to match. Run `npm test`.
- **Adding a video selector:** put it in `lib/selectors.js` under the `video`
  namespace. Update the `test/mock-flow-video.html` fixture to match. Run
  `node --test test/video.test.js`.
- **Video generation fails with `selector_missing`:** follow the same
  Flow-UI-drift playbook as images — kill daemon, open Chromium manually
  on the Flow project, inspect, update `lib/selectors.js`. Video selectors
  are under `selectors.video.*`.
- **Changing timing / anti-detection:** discuss first. These values are
  load-bearing against Google's detection heuristics.
- **Adding an HTTP endpoint:** update `server.js` (route) + README (HTTP API
  section) + AGENTS.md (Three output modes or new section). Keep the route
  set minimal — this isn't a REST API.
- **Adding a CLI subcommand:** update `bin/flow-cli.js` (switch in `main()`)
  + help text + README.md CLI section.
- **Changing the output path logic:** touch both `server.js` (validation)
  AND `lib/image.js::runJob` (actual write for images) AND `bin/flow-cli.js`
  (client-side mode resolution). Keep all three consistent. Run the
  mock-fixture test to verify.
- **Bug fixes for Google UI drift:** selectors only, 99% of the time.
- **Testing against real Flow:** use meaningful, varied prompts —
  NEVER loop "test", "hello", "a brain", etc. Identical prompts in
  quick succession is itself a bot signal. A good test prompt looks
  like: *"A weathered wooden bridge over a mountain stream in late
  autumn, golden leaves, morning mist, cinematic 16:9"*.
- **If a live test hits a "Failed — unusual activity" error from Flow,
  stop.** Wait at least 15 minutes before trying again. Don't retry
  immediately — that compounds the flag. Don't restart the daemon or
  clear the profile — the logged-in state is fine, you just need
  Google's detection cooldown to elapse.

---

## What NOT to do

- Don't add retry loops around Playwright calls. Flow generations take 60–120
  seconds; a retry cascade can double up jobs and burn quota. Each job is
  one shot.
- Don't add per-segment concurrency. Same reason as above.
- Don't swap Playwright for Puppeteer, Selenium, or CDP-by-hand. Playwright's
  auto-waiting and selector engine are why this works at all.
- Don't add logging to a file by default. `stdout`/`stderr` only. If a user
  wants logs, they `> flow-daemon.log 2>&1`.
- Don't embed prompts, model selection, or aspect-ratio heuristics into the
  daemon. The caller owns the prompt. The daemon types what it's given and
  saves what comes back.

---

## Related repos

- [content-hub](https://github.com/cnminh/content-hub) — the Phoenix app
  that calls this daemon from its video production wizard. Its
  `ContentHub.Video.FlowClient` module is the reference Elixir consumer of
  the HTTP API.
