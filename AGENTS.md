# AGENTS.md

Brief for AI agents (Claude, Codex, Gemini, etc.) working on this repo.
If you're a human, read [README.md](README.md) instead — it covers everything
below from a user's perspective.

---

## What this project is

`flow-daemon` is a Node.js HTTP daemon + CLI that drives
[Google Flow](https://labs.google/fx/tools/flow/) via Playwright to generate
AI images from text prompts. It's a personal tool — no deployment, no SaaS,
no multi-user anything. One user, one logged-in Chromium profile, localhost
HTTP only.

It's the extracted sidecar for [content-hub](https://github.com/cnminh/content-hub)
but the HTTP surface is generic enough to be called by anything.

---

## Invariants — do not break these

1. **Single daemon, single browser, single job at a time.** The `workerBusy`
   flag in `server.js` gates concurrency. Don't try to parallelize jobs — Flow
   is one session, and concurrent clicks will race the Playwright page state.
2. **Selectors live in `lib/selectors.js` — nowhere else.** When Google ships
   a UI change, one-file edit.
3. **Anti-detection timing must stay.** The humanized typing delay (40–90ms
   jitter), pre/post-typing pauses, 5–15s cooldown between jobs, and
   `navigator.webdriver` erasure are all load-bearing against Google's bot
   detection. Don't "optimize" them away.
4. **The daemon never takes credentials.** The whole point of persistent
   profile + manual first-login is so passwords never touch automation code.
   Don't add a `/login` endpoint or a `GOOGLE_PASSWORD` env var.
5. **Only bind to `127.0.0.1`.** Never `0.0.0.0`. This daemon drives a
   logged-in browser — anyone on your network could hijack it. If you
   genuinely need remote access, use SSH port-forwarding or Tailscale.

---

## Three output modes (core contract)

`POST /enqueue` accepts a prompt plus **either** `output_path` **or** the
Content Hub `(project_id, segment_id)` pair. The server resolves the target
path in `server.js::drainQueue` and `lib/flow.js::runJob`:

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
flow-cli (CLI)                       External caller (Elixir FlowClient, curl, etc.)
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
                 ▼
          lib/flow.js::runJob
                 │  ensureContextForUrl (persistent or ephemeral)
                 │  findOrCreatePage
                 │  detect login / captcha
                 │  ensureImageMode
                 │  type prompt with jitter
                 │  click Create
                 │  waitForFunction on new output src
                 │  download bytes (data: or HTTPS)
                 │  write to disk
                 ▼
          queue.markDone / markError
                 │
                 ▼
          /status/:job_id polled by caller
```

Module responsibilities:

- `bin/flow-cli.js` — argv parsing, mode resolution (standalone / output /
  ids), HTTP calls to the daemon, polling, exit codes. No Playwright here.
- `server.js` — Express routes, worker loop, graceful shutdown, env var
  reading. Also calls `closeBrowser()` from `lib/flow.js` on SIGINT/SIGTERM.
- `lib/flow.js` — everything Playwright. `runJob` is the main export;
  `closeBrowser` for shutdown; `ensureImageMode` for the Flow UI dance.
- `lib/queue.js` — FIFO singleton with module-level state. Exposes a
  `reset()` function used only in tests.
- `lib/selectors.js` — CSS/Playwright selectors. **Single source.**
- `test/mock-flow.html` — static HTML fixture that mimics Flow's DOM
  (textbox + Create button + output images). Must stay in lockstep with
  `selectors.js`.

---

## Coding conventions

- Plain Node, no bundler, no TypeScript. Require-style imports.
- Formatted like existing code: 2-space indent, single quotes, trailing
  commas in multi-line objects/arrays.
- Keep modules small. Each `lib/*.js` file has one clear responsibility.
  When `lib/flow.js` grows beyond ~300 lines, extract (e.g. `lib/download.js`,
  `lib/mode-toggle.js`).
- Error handling: throw `Error` objects with `err.error_code` set to one of
  the documented codes (`not_logged_in`, `captcha`, `quota_exceeded`,
  `timeout`, `selector_missing`, `browser_crashed`, `network`). The worker
  loop in `server.js` maps these into the HTTP response.
- HTTP requests from the CLI: use built-in `fetch` (Node 18+). No axios, no
  node-fetch dep.
- Tests: `node --test` runner, plain `assert`. No Jest, no Mocha.

---

## When you're asked to change something

- **Adding a selector:** put it in `lib/selectors.js`. Update the mock
  fixture in `test/mock-flow.html` to match. Run `npm test`.
- **Changing timing / anti-detection:** discuss first. These values are
  load-bearing against Google's detection heuristics.
- **Adding an HTTP endpoint:** update `server.js` (route) + README (HTTP API
  section) + AGENTS.md (Three output modes or new section). Keep the route
  set minimal — this isn't a REST API.
- **Adding a CLI subcommand:** update `bin/flow-cli.js` (switch in `main()`)
  + help text + README.md CLI section.
- **Changing the output path logic:** touch both `server.js` (validation)
  AND `lib/flow.js::runJob` (actual write) AND `bin/flow-cli.js` (client-
  side mode resolution). Keep all three consistent. Run the mock-fixture
  test to verify.
- **Bug fixes for Google UI drift:** selectors only, 99% of the time.

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
