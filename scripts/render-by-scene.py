#!/usr/bin/env python3
"""Per-scene renderer: char-conditioned start frame per scene + video gen.

Workflow:
  1. For each scene N:
     a. flow-cli generate "<frame_prompt_N>" --reference <char> → scene-N-frame.png
     b. flow-video-cli generate "<video_prompt_N>" --frame scene-N-frame.png → scene-N.mp4
  2. ffmpeg concat all scene-N.mp4 with crossfade → final.mp4

Compared to ingredients-mode (4 char-conditioned videos, jump cuts) this
gives:
  + each scene's start frame is char-locked → tighter character consistency
  + each scene independent → no cumulative drift
  - 4 image gens + 4 video gens = ~2x credits, ~2x time vs ingredients-mode

Usage:
  python3 scripts/render-by-scene.py JOB_ID --char PATH \\
      --frame-prompts "<frame1>" "<frame2>" "<frame3>" "<frame4>" \\
      --video-prompts "<video1>" "<video2>" "<video3>" "<video4>" \\
      --output PATH

Or use a JSON config file:
  python3 scripts/render-by-scene.py JOB_ID --config scenes.json

scenes.json:
  {
    "char": "/abs/path/to/char.png",
    "scenes": [
      {"frame_prompt": "...", "video_prompt": "..."},
      ...
    ],
    "output": "/abs/path/to/final.mp4",
    "aspect": "9:16",
    "crossfade": 0.2
  }
"""
import argparse, json, os, subprocess, sys, time

REPO = "/Users/cuongnguyen/projects/flow-daemon"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def gen_frame(char_path, prompt, out_path, aspect="9:16", gallery_dst=None):
    """Image gen with --reference char → scene-specific start frame.

    If `gallery_dst` is given, the frame is also copied there so it shows
    up in the chars gallery alongside other variants.
    """
    log(f"  gen frame: {os.path.basename(out_path)}")
    r = subprocess.run([
        "node", f"{REPO}/bin/flow-cli.js", "generate", prompt,
        "--reference", char_path,
        "--aspect", aspect,
        "--output", out_path,
    ], capture_output=True, text=True, timeout=300)
    if r.returncode != 0 or not os.path.exists(out_path):
        raise RuntimeError(f"frame gen failed: {r.stderr[-300:] or r.stdout[-300:]}")
    log(f"    → {os.path.getsize(out_path)//1024}KB")
    if gallery_dst:
        os.makedirs(os.path.dirname(gallery_dst), exist_ok=True)
        import shutil
        shutil.copy2(out_path, gallery_dst)
        log(f"    → gallery: {gallery_dst}")


def gen_video(frame_path, prompt, out_path, aspect="9:16"):
    """Video gen with --frame scene-frame → 1 clip seeded from controlled frame."""
    log(f"  gen video: {os.path.basename(out_path)}")
    r = subprocess.run([
        "node", f"{REPO}/bin/flow-video-cli.js", "generate", prompt,
        "--frame", frame_path,
        "--aspect", aspect,
        "--output", out_path,
        "--json",
    ], capture_output=True, text=True, timeout=600)
    if r.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) < 500_000:
        raise RuntimeError(f"video gen failed: {r.stderr[-400:] or r.stdout[-400:]}")
    log(f"    → {os.path.getsize(out_path)//1024//1024}MB")


def concat_with_crossfade(clip_paths, out_path, crossfade_sec=0.2, aspect="9:16"):
    """ffmpeg xfade chain: smooth transitions between independent scenes."""
    log(f"ffmpeg concat ({len(clip_paths)} clips, xfade {crossfade_sec}s)")
    if len(clip_paths) == 1:
        subprocess.run(["ffmpeg", "-y", "-i", clip_paths[0], "-c", "copy", out_path], check=True)
        return

    # Probe duration of each clip
    durations = []
    for p in clip_paths:
        r = subprocess.run([
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", p,
        ], capture_output=True, text=True, check=True)
        durations.append(float(r.stdout.strip()))
    log(f"  durations: {[f'{d:.2f}s' for d in durations]}")

    # Target dimensions for scale-pad
    if aspect == "16:9":
        target_w, target_h = 3840, 2160
    else:
        target_w, target_h = 2160, 3840
    scale_pad = (
        f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    )

    # Build filter_complex
    args = ["ffmpeg", "-v", "error", "-y"]
    for p in clip_paths:
        args.extend(["-i", p])

    filters = []
    for i in range(len(clip_paths)):
        filters.append(f"[{i}:v]{scale_pad},setpts=PTS-STARTPTS[s{i}]")
        filters.append(f"[{i}:a]asetpts=PTS-STARTPTS[t{i}]")

    # First xfade: clip 0 → clip 1
    run_out = durations[0]
    filters.append(
        f"[s0][s1]xfade=transition=fade:duration={crossfade_sec}:"
        f"offset={run_out - crossfade_sec:.3f}[v01]"
    )
    filters.append(f"[t0][t1]acrossfade=d={crossfade_sec}[a01]")
    last_v, last_a = "v01", "a01"
    run_out = run_out + durations[1] - crossfade_sec

    for i in range(2, len(clip_paths)):
        next_v, next_a = f"v0{i}", f"a0{i}"
        filters.append(
            f"[{last_v}][s{i}]xfade=transition=fade:duration={crossfade_sec}:"
            f"offset={run_out - crossfade_sec:.3f}[{next_v}]"
        )
        filters.append(f"[{last_a}][t{i}]acrossfade=d={crossfade_sec}[{next_a}]")
        last_v, last_a = next_v, next_a
        run_out = run_out + durations[i] - crossfade_sec

    args.extend(["-filter_complex", "; ".join(filters)])
    args.extend(["-map", f"[{last_v}]", "-map", f"[{last_a}]"])
    args.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "20"])
    args.extend(["-c:a", "aac", "-movflags", "+faststart", out_path])

    subprocess.run(args, check=True)
    log(f"  → {os.path.getsize(out_path)//1024//1024}MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job_id")
    ap.add_argument("--char", help="absolute path to char image")
    ap.add_argument("--frame-prompts", nargs="+", help="prompts for per-scene frame gens")
    ap.add_argument("--video-prompts", nargs="+", help="prompts for per-scene video gens")
    ap.add_argument("--output", help="absolute path for final.mp4")
    ap.add_argument("--aspect", default="9:16")
    ap.add_argument("--crossfade", type=float, default=0.2)
    ap.add_argument("--config", help="JSON config file (overrides flags)")
    ap.add_argument("--frames-only", action="store_true",
                    help="gen start frames only, skip video render + concat (preview frames first)")
    ap.add_argument("--reuse-frames", action="store_true",
                    help="skip frame gen if scene-N-frame.png already exists in scenes_dir (saves image credits)")
    args = ap.parse_args()

    if args.config:
        with open(args.config) as f:
            cfg = json.load(f)
        char = cfg["char"]
        frame_prompts = [s["frame_prompt"] for s in cfg["scenes"]]
        video_prompts = [s["video_prompt"] for s in cfg["scenes"]]
        output = cfg["output"]
        aspect = cfg.get("aspect", "9:16")
        crossfade = cfg.get("crossfade", 0.2)
    else:
        char = args.char
        frame_prompts = args.frame_prompts
        video_prompts = args.video_prompts
        output = args.output
        aspect = args.aspect
        crossfade = args.crossfade

    # video_prompts are not needed in --frames-only mode (no video gen).
    if args.frames_only:
        if not (char and frame_prompts):
            ap.error("--char, --frame-prompts required (or use --config)")
        if not video_prompts:
            video_prompts = [""] * len(frame_prompts)
    else:
        if not (char and frame_prompts and video_prompts and output):
            ap.error("--char, --frame-prompts, --video-prompts, --output all required (or use --config)")
        if len(frame_prompts) != len(video_prompts):
            ap.error(f"frame-prompts ({len(frame_prompts)}) != video-prompts ({len(video_prompts)})")

    job_dir = f"{REPO}/tmp/picker-jobs/{args.job_id}"
    os.makedirs(job_dir, exist_ok=True)
    scenes_dir = f"{job_dir}/scenes"
    os.makedirs(scenes_dir, exist_ok=True)

    # Derive gallery slug from char path:
    # tmp/chars/<slug>/v<N>/<idx>.png  →  slug = parent of parent of char
    # Falls back to None if char path doesn't match this layout.
    gallery_slug = None
    norm_char = os.path.normpath(char)
    parts = norm_char.split(os.sep)
    if "chars" in parts:
        idx = parts.index("chars")
        if idx + 1 < len(parts):
            gallery_slug = parts[idx + 1]
    job_short = args.job_id.replace("job_", "")[:10]
    gallery_version = f"scenes-{job_short}"

    log(f"=== render-by-scene: {len(frame_prompts)} scenes ===")
    log(f"  char: {char}")
    log(f"  output: {output}")
    if gallery_slug:
        gallery_dir = f"{REPO}/tmp/chars/{gallery_slug}/{gallery_version}"
        log(f"  gallery: {gallery_dir}/")
        os.makedirs(gallery_dir, exist_ok=True)
        # Record source char so chars-gallery can link shoot row → char that
        # was used. Char code derived from char path: tmp/chars/<slug>/v<N>/<idx>.png
        char_parts = norm_char.split(os.sep)
        char_code = None
        if "chars" in char_parts:
            ci = char_parts.index("chars")
            if ci + 3 < len(char_parts):
                char_subject = char_parts[ci + 1]
                char_version = char_parts[ci + 2]
                char_idx = os.path.splitext(char_parts[ci + 3])[0]
                char_code = f"{char_subject}-{char_version}-{char_idx}"
        meta = {
            "source_char_path": char,
            "source_char_code": char_code,
            "job_id": args.job_id,
            "scene_count": len(frame_prompts),
        }
        with open(f"{gallery_dir}/_meta.json", "w") as f:
            json.dump(meta, f, indent=2)

    clip_paths = []
    for i, (fp, vp) in enumerate(zip(frame_prompts, video_prompts), 1):
        log(f"\n--- Scene {i}/{len(frame_prompts)} ---")
        frame_path = f"{scenes_dir}/scene-{i}-frame.png"
        clip_path = f"{scenes_dir}/scene-{i}.mp4"
        gallery_dst = (
            f"{REPO}/tmp/chars/{gallery_slug}/{gallery_version}/{i}.png"
            if gallery_slug else None
        )
        if args.reuse_frames and os.path.exists(frame_path) and os.path.getsize(frame_path) > 50_000:
            log(f"  reuse frame: {os.path.basename(frame_path)} ({os.path.getsize(frame_path)//1024}KB)")
        else:
            gen_frame(char, fp, frame_path, aspect=aspect, gallery_dst=gallery_dst)
        if args.frames_only:
            continue
        gen_video(frame_path, vp, clip_path, aspect=aspect)
        clip_paths.append(clip_path)

    if args.frames_only:
        log(f"\n=== FRAMES DONE (--frames-only) ===")
        log(f"  {len(frame_prompts)} frames in {scenes_dir}")
        if gallery_slug:
            log(f"  gallery: tmp/chars/{gallery_slug}/{gallery_version}/")
        return

    log(f"\n--- Concat with crossfade ---")
    concat_with_crossfade(clip_paths, output, crossfade_sec=crossfade, aspect=aspect)
    log(f"\n=== DONE ===")
    log(f"  final: {output} ({os.path.getsize(output)//1024//1024}MB)")


if __name__ == "__main__":
    main()
