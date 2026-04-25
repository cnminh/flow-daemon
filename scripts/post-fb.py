#!/usr/bin/env python3
"""Upload a job's video to Facebook Reel + record posted state in state.json.

Usage:
    post-fb.py <job_id> --page=xomkhoemanh --caption-file=PATH
    post-fb.py <job_id> --page=PAGE_ID    --caption "inline text"

On success: patches state.json["posted_to"]["fb"] = {posted_at, page_id, caption_length}.
Gallery badge picks this up via /api/videos.
"""
import sys, json, os, subprocess, argparse, datetime

JOBS = "/Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs"

PAGES = {
    "xomkhoemanh": "61563675085664",
    "vnhn":        "61588554575395",
    "athithira":   "61577520417634",
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job_id")
    ap.add_argument("--page", default="xomkhoemanh", help="profile alias or numeric page id")
    ap.add_argument("--caption", help="inline caption text")
    ap.add_argument("--caption-file", help="caption from file")
    args = ap.parse_args()

    page_id = PAGES.get(args.page, args.page)
    if not page_id.isdigit():
        sys.exit(f"unknown page alias '{args.page}'. options: {list(PAGES.keys())} or numeric id")

    jd = f"{JOBS}/{args.job_id}"
    if not os.path.isdir(jd):
        sys.exit(f"job dir not found: {jd}")

    # Pick FB-ready file (compressed) if exists, else compress the branded one
    fb_path = f"{jd}/final-branded-fb.mp4"
    branded = f"{jd}/final-branded.mp4"
    if not os.path.exists(fb_path) or os.path.getsize(fb_path) < 1_000_000:
        if not os.path.exists(branded):
            sys.exit(f"no final-branded.mp4 in {jd}")
        print(f"compressing for FB (Playwright 50MB cap)...", flush=True)
        r = subprocess.run([
            "ffmpeg","-y","-i", branded,
            "-c:v","libx264","-preset","slow","-crf","26",
            "-c:a","aac","-b:a","128k", fb_path
        ], capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"compress failed: {r.stderr[-300:]}")
        print(f"  compressed → {os.path.getsize(fb_path)//1024//1024} MB", flush=True)

    if os.path.getsize(fb_path) > 50 * 1024 * 1024:
        sys.exit(f"compressed file still >50MB ({os.path.getsize(fb_path)//1024//1024} MB) — re-encode with higher CRF")

    cmd = ["fb-reel-cli", f"--profile={args.page}", f"--page-id={page_id}", f"--video={fb_path}"]
    if args.caption_file:
        cmd.append(f"--caption-file={args.caption_file}")
    elif args.caption:
        cmd.append(f"--caption={args.caption}")

    print(f"firing: {' '.join(cmd)}", flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    out_lines = (r.stdout + r.stderr).strip().splitlines()
    json_line = next((l for l in reversed(out_lines) if l.startswith("{")), None)
    if not json_line:
        sys.exit(f"no JSON in fb-reel-cli output:\n{r.stdout}\n{r.stderr}")
    result = json.loads(json_line)

    if result.get("status") != "posted":
        print(f"FAILED: {result.get('error')} (step={result.get('step')})")
        sys.exit(1)

    # Update state.json
    state_path = f"{jd}/state.json"
    with open(state_path) as f: state = json.load(f)
    state.setdefault("posted_to", {})["fb"] = {
        "posted_at": datetime.datetime.utcnow().isoformat() + "Z",
        "page": args.page,
        "page_id": page_id,
        "caption_length": result.get("captionLength"),
    }
    with open(state_path, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)

    print(f"\n✅ posted to {args.page} (page {page_id})")
    print(f"   caption: {result.get('captionLength')} chars")
    print(f"   state.json updated: posted_to.fb")


if __name__ == "__main__":
    main()
