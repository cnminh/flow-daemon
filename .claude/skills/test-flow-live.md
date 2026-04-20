---
name: test-flow-live
description: Use when the user asks to run a live flow-daemon test — "generate a video", "fire a job", "test end-to-end against real Flow", "show me N clips", "try with M prompts" — or before sharing any generated image/video with the user. Encodes the standardized preflight (kill old daemon, absolute paths), fire step (background task + correct ScheduleWakeup delay), and postcheck (ffprobe, chmod, moov atom, copy to tmp/dev-preview/, Tailscale URL). Firing live Flow spends credits — this skill also includes the prompt rules (Vietnamese, varied, confirm before every Create click).
---

# Running a live flow-daemon test

## When to use

User asks to fire a real generation against Flow (image or video), OR you
need to share a generated file with the user. This covers the full loop:
preflight → fire → report.

For debugging a broken job, use `debug-flow-daemon` instead.

## Preflight (always do these)

1. **Kill the old daemon** if your last change touched `lib/*.js` or
   `bin/*.js`. The running daemon has the old code `require`d into memory;
   it won't pick up edits until restart.
   ```bash
   lsof -iTCP:47321 -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -TERM; sleep 3
   ```

2. **Use absolute paths in Bash commands.** The shell's cwd can reset
   between turns (especially after a long-running background task).
   Always prefix with `cd /Users/cuongnguyen/projects/flow-daemon &&` or
   reference the CLI via `flow-cli` / `flow-video-cli` which are on PATH
   after `npm install -g .`.

3. **Confirm with the user before every `Create`/`Generate` click.**
   This is the quota-spending step. Dropdowns, tabs, typing text — no
   confirmation needed. CLI invocations are the confirmation themselves,
   but if you're about to fire an unplanned extra run, ask first.

## Prompts — mandatory rules

- **Prompts in Vietnamese.** User's established convention. Don't write
  English test prompts unless user explicitly asks.
- **Vary prompts every run.** Identical prompts in quick succession is
  a bot-detection signal. Never loop `"test"`, `"hello"`, `"a brain"`,
  `"một con mèo"` etc. — each run should have meaningfully different
  content.
- **Keep prompts concrete and grounded.** Veo handles cinematic
  descriptions well. Abstract prompts ("tình yêu", "hạnh phúc") produce
  worse results than concrete ones ("một con mèo trắng ngồi trên cửa
  sổ, tuyết rơi ngoài trời").

## Fire step

Use `run_in_background: true` for any multi-clip video — they take
minutes and would block the foreground otherwise.

```bash
# Video example: 3-clip portrait narrative
cd /Users/cuongnguyen/projects/flow-daemon && flow-video-cli generate \
  "prompt 1 (initial clip)" \
  "prompt 2 (extend)" \
  "prompt 3 (extend)" \
  --output /tmp/flow_video/mytest-$(date +%s).mp4 \
  --json 2>&1
```

Timeout rule of thumb: **180 s per clip** + 60 s slack for daemon cold
start and ffmpeg. So 5 clips ≈ 600000 ms in the Bash `timeout` arg.

## ScheduleWakeup timing

Pick delay based on clip count (each clip is ~60–90 s plus Flow variance):

| Clips | First check at | Full window |
|---|---|---|
| 1 | 150 s | ≤ 180 s |
| 2 | 240 s | ≤ 300 s |
| 3 | 270 s | ≤ 360 s |
| 5 | 270 s (partial), re-schedule for full | ≤ 600 s |

If the job isn't done at first check, re-schedule another 150-240 s wakeup
rather than polling in a tight sleep loop (burns context + cache).

## Postcheck (always do these before sharing URL)

1. **Probe the output.** Confirm dims, duration, bit-rate plausible.
   ```bash
   ffprobe -v error -show_entries stream=codec_name,width,height,duration -of default=noprint_wrappers=1 /tmp/flow_video/mytest.mp4
   ```

2. **Check mp4 `moov` atom position.** If it's at EOF, browsers stall
   mid-playback (mobile especially). `lib/video.js::buildFfmpegArgs`
   includes `-movflags +faststart` so fresh jobs are fine, but stale
   outputs from older code may need re-encoding. Quick check:
   ```bash
   python3 -c "print(b'moov' in open('/tmp/flow_video/mytest.mp4','rb').read(200000))"
   # True = moov at start (good); False = at EOF (fix with ffmpeg -c copy -movflags +faststart)
   ```

3. **Copy to `tmp/dev-preview/`** with a dated name so the index sorts
   newest-first and the user can find it on the Tailscale page.
   ```bash
   TS=$(date +%Y-%m-%d-%H-%M-%S)
   cp /tmp/flow_video/mytest.mp4 ~/projects/flow-daemon/tmp/dev-preview/${TS}-mytest.mp4
   chmod 644 ~/projects/flow-daemon/tmp/dev-preview/${TS}-mytest.mp4
   ```
   The `chmod 644` matters because Flow's mp4s sometimes land with `600`
   perms (umask quirk), which the preview server can technically read
   but some browsers fail to stream.

4. **Report the Tailscale URL.** Format:
   `https://mac-mini.tailf56d7b.ts.net:47399/<filename>` — always the
   direct link, not just "check the index page" (user may have cache).

## Gotchas

- **Stale daemon running old code** is the #1 cause of "my fix doesn't
  work." Always re-kill after `lib/` edits.
- **`cd` doesn't persist** between Bash tool turns. Each call starts
  fresh from wherever; use absolute paths or chain with `&&`.
- **Task notifications from expired wakeups** may fire after the task
  already finished. Ignore them if the file is already published; don't
  re-do the postcheck.
- **Preview dir is in a worktree** sometimes. Current canonical path:
  `/Users/cuongnguyen/projects/flow-daemon/tmp/dev-preview/`. If the
  worktree is deleted, the dir goes with it — back up or copy to a
  stable location first.
- **Flow's aspect occasionally slips** — clip 0 may come back landscape
  even when `--orientation portrait` logged success. ffmpeg scale-pad
  masks this as pillarbox bars. Known bug, see `debug-flow-daemon`.

## Quick-reference URLs

- Preview index: https://mac-mini.tailf56d7b.ts.net:47399/
- Daemon health: `curl -sS http://127.0.0.1:47321/health`
- Daemon log: `tail -20 ~/.flow-daemon/daemon.log`
