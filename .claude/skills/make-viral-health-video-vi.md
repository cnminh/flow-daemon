---
name: make-viral-health-video-vi
description: Use when the user asks for a viral Vietnamese health video with ONE short subject input — "làm video sức khoẻ về gan", "video về gừng bổ tim", "tạo video viral về stress". Orchestrates the full pipeline end-to-end: creates a picker job, hands the user a stable URL (http://mac-mini.tailf56d7b.ts.net:47399/picker.html), polls state across stages, generates 4 character variants via flow-cli, fires the 3-clip video via flow-video-cli with the user's picked frame, and reports the final video URL. The skill is the CREATIVE brain (writes prompts) + the ORCHESTRATOR (polls + fires). For dialogue/script-writing rules, inherits conventions from `write-viral-food-script-vi`.
---

# make-viral-health-video-vi

## When to use

User asks for a viral health-niche Vietnamese video with a short subject
input. Keywords: "làm video sức khoẻ…", "video về … bổ/tốt cho …",
"tạo video viral về …", "video tiktok sức khoẻ …".

Subject can be:
- **Food/plant** (fruit, veg, herb): bơ, gừng, chanh, lá neem, trà xanh…
- **Organ**: gan, tim, da, dạ dày, não, phổi, mắt, khớp…
- **Condition**: insomnia, stress, táo bón, đau đầu, lão hoá…
- **Villain**: cholesterol, đường huyết, gốc tự do, vi khuẩn…

Do NOT use for: generic image generation, video without health angle,
script-writing without execution (use `write-viral-food-script-vi` instead).

## Architecture

This skill is the **orchestrator**. The `picker.html` web UI is the user
interface. The `dev-preview-server.js` REST API is the state store. The
skill (= Claude) polls state and does creative work + fires CLIs.

```
 Claude (skill)          Server          Picker UI          User
      │                    │                │                │
      │─ picker-init ─────►│                │                │
      │──── URL to user ───┼────────────────┼───────────────►│
      │                    │                │                │
      │                    │◄── load page ──┤◄── opens URL ──┤
      │                    │                │◄── pick 5 ─────┤
      │                    │◄── submit ─────┤                │
      │  state = grid_done │                                 │
      │                                                      │
      │─ gen 4 chars ─────► flow-cli ×4                      │
      │─ update chars ────►                                  │
      │  state = char_pick                                   │
      │                                                      │
      │                    │                │◄── pick char ──┤
      │                    │◄── submit ─────┤                │
      │  state = char_picked                                 │
      │                                                      │
      │─ gen prompts + critique ─────────────────────────────│
      │─ update state ─────►                                 │
      │  state = prompts_review                              │
      │                                                      │
      │                    │                │◄── edit/regen/
      │                    │                │    approve ────┤
      │                    │◄── submit ─────┤                │
      │  state = video_gen (approved)                        │
      │   OR                                                 │
      │  state = prompts_regen_requested → regen → loop back │
      │                                                      │
      │─ gen video ─────────► flow-video-cli --frame         │
      │─ update video_url ─►                                 │
      │  state = done                                        │
      │                    │◄── poll done ──┤◄── watch ──────┤
```

## Full workflow

### Stage 0 — User invocation

User types: "làm video sức khoẻ về gan" (or similar).

Skill does:

1. Parse subject from input ("gan khoẻ" or just "gan").
2. Categorize subject:
   - food/plant → `food-hero` default protagonist suggested
   - organ → `organ-patient` default suggested
   - condition → `condition-ghost` default suggested
   - villain → `villain-takedown` default suggested

   (These are SUGGESTIONS. User picks actual protagonist on picker page.)

3. POST to create job:
   ```bash
   curl -sS -X POST -H "Content-Type: application/json" \
     -d "{\"subject\":\"<subject>\"}" \
     http://127.0.0.1:47399/api/picker-init
   ```
   Response: `{"job_id":"job_xxx","url":"/picker.html"}`.

4. Reply to user with the STABLE URL:
   > "Mở link này trên điện thoại, pick 5 lựa chọn, xong tớ tự tạo character + video:
   > http://mac-mini.tailf56d7b.ts.net:47399/picker.html"

5. Schedule first wakeup in 30-60s and begin polling loop.

### Stage 1 — Poll waiting for grid submit

Each wakeup: `curl -sS "http://127.0.0.1:47399/api/picker-status?job=<id>"`.

- `state: "init"` → user hasn't submitted yet → reschedule 60-90s wakeup
- `state: "grid_done"` → user submitted → proceed to stage 2

If no progress after ~20 min, ping user in chat: "Còn đang pick không? Link
vẫn live nhé." Then reschedule.

### Stage 2a — Generate 4 character prompts + critique (NEW review step)

Before firing image gens, write 4 character prompts as text, run
self-critique, and post to `char_prompts_review` so the user can edit /
approve / regen cheaply before burning image-gen credits.

State is `grid_done`. The state.json has:
```json
{
  "subject": "gan khoẻ",
  "grid": {
    "setting": "setting-bep-voi-nuoc",
    "treatment": "treatment-macro-asmr",
    "protagonist": "protagonist-organ-patient",
    "arc": "arc-yeu-sieu-swagger",
    "sound": "asmr"
  }
}
```

Generate 4 character prompts using the **character-variants formula** (below).
Each prompt renders the Act 1 / opening-scene pose of the character so
the user's picked image becomes a valid `--frame` seed for video.

Run a **5-dimension self-critique** per variant:

1. **Visual clarity** — Can Veo render this consistently? Distinct features?
2. **Setting integration** — Background matches picked setting?
3. **Treatment match** — Cinematic style applied correctly?
4. **Drift risks** — For non-human protagonists, no human body parts?
5. **Variety across 4** — Variants distinctly different, not just rephrased?

Post to state `char_prompts_review`:

```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -d '{"job":"<job>","patch":{
    "state":"char_prompts_review",
    "character_prompts":["<v1>","<v2>","<v3>","<v4>"],
    "character_prompts_critique":[{"notes":[…]},{"notes":[…]},{"notes":[…]},{"notes":[…]}]
  }}' http://127.0.0.1:47399/api/picker-update
```

### Stage 2b — Poll for char-prompts approval / regen

- `state: "char_prompts_review"` → user reviewing → reschedule 60-90s.
- `state: "char_prompts_regen_requested"` → user hit regen (optionally
  with `revise_comment` for direction) → regen 4 prompts (literal
  translation of comment, not inspiration), post back to
  `char_prompts_review`.
- `state: "char_prompts_approved"` → user approved (possibly-edited)
  prompts → proceed to stage 2c.

### Stage 2c — Fire 4 image gens

Read final `character_prompts` from state (user may have edited).
Fire 4 background image jobs SEQUENTIALLY (daemon queue is single-worker
anyway, parallel won't help):

```bash
mkdir -p /Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs/<job>
for i in 1 2 3 4; do
  flow-cli generate "<prompt_i>" \
    --output /Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs/<job>/char-$i.png
done
```

Use `run_in_background: true` + ScheduleWakeup to pace. Rough budget:
4 × 30-40s = ~2 min total. Check wakeup after ~150s.

Once all 4 PNGs exist, copy them to the preview-served directory so the
picker UI can load them (the picker URLs reference `/picker-jobs/<id>/…`
— extend server serving first, see Serving paths below).

Update state:
```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -d '{
    "job": "<job>",
    "patch": {
      "state": "char_pick",
      "characters": [
        {"url": "/picker-jobs/<id>/char-1.png"},
        {"url": "/picker-jobs/<id>/char-2.png"},
        {"url": "/picker-jobs/<id>/char-3.png"},
        {"url": "/picker-jobs/<id>/char-4.png"}
      ]
    }
  }' \
  http://127.0.0.1:47399/api/picker-update
```

### Stage 3 — Poll waiting for character pick

State is now `char_pick`. Picker UI loads the 4 images, user picks.
Skill polls every 60-90s.

- `state: "char_pick"` → waiting → reschedule 60-90s
- `state: "char_picked"` → user picked → proceed to stage 4

### Stage 4a — Generate prompts + self-critique (before video fire)

State has `char_index: 0..3`. The picked frame is
`tmp/picker-jobs/<job>/char-{char_index+1}.png`.

Generate 3 act prompts using the **video-prompts formula** (below),
driven by arc + protagonist + setting + treatment + sound + subject.

Then run a **self-critique** across these 5 dimensions for each prompt:

1. **Character continuity** — Do same visual cues (texture, màu, distinctive
   features) appear across all 3 acts? Any drift risk?
2. **Narrative cohesion** — Does Act 2 pay off Act 1 setup? Does Act 3
   resolve Act 1 tension (not 3 disconnected scenes)?
3. **Dialogue callback** — Does Act 3 reference something Act 1 said?
4. **Drift risks** — Non-human body parts for non-human protagonists?
   (e.g. "hai tay dang rộng" for a cholesterol blob — drops back to a
   human figure). POV shifts? Tone mismatches with arc?
5. **Content safety** — Medical claims in safe territory (general
   nutrition); no "chữa ung thư" / "thay thế thuốc" / fake scarcity.

Output per-act critique as a list of `{level, text}` notes where `level`
is `ok` / `warn` / `fail`. Example:

```json
[
  {"notes": [
    {"level":"ok", "text":"character locked (cholesterol vàng nhờn mắt đỏ)"},
    {"level":"ok", "text":"narrative cohesion: gắt setup liên kết Act 2"}
  ]},
  {"notes": [
    {"level":"ok", "text":"payoff benefits từ Act 1 threats"},
    {"level":"warn", "text":"dialogue hơi dài — lip-sync có thể rớt"}
  ]},
  {"notes": [
    {"level":"warn", "text":"Act 3 'hai tay dang rộng' là body-người — villain không có tay → risk drift"},
    {"level":"ok", "text":"content safety OK"}
  ]}
]
```

Push state → `prompts_review` with both prompts + critique:

```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -d '{
    "job": "<job>",
    "patch": {
      "state": "prompts_review",
      "video_prompts": ["<act1>","<act2>","<act3>"],
      "video_prompts_critique": [{"notes":[…]},{"notes":[…]},{"notes":[…]}]
    }
  }' \
  http://127.0.0.1:47399/api/picker-update
```

### Stage 4b — Poll waiting for review outcome

Skill polls every 60-90s.

- `state: "prompts_review"` → user still reviewing → reschedule
- `state: "prompts_regen_requested"` → user hit regen → go to stage 4c
- `state: "video_gen"` → user approved → go to stage 4d (fire video)

### Stage 4c — Regen prompts (different direction)

User requested regen. Skill MUST generate a **meaningfully different**
version — not the same prompts rephrased. Strategies to vary:

- **Swap dialogue hook style** — if Act 1 was "Formal intro" ("tao là X
  đây"), try "Casual confrontation" ("ê bọn mày") or "Historical pride"
- **Switch narrative focus** — same character + arc but different
  benefits/facts highlighted; different practical instructions in Act 3
- **Adjust dialogue rhythm** — longer/shorter sentences, different
  emotional peaks
- **Fresh metaphors** — new visual proofs in Act 2

Keep the same: arc, character, setting, treatment, sound, subject. Only
the creative execution changes.

Increment `regen_count`. Push state back → `prompts_review`. No cap —
user approves when they're ready.

### Stage 4d — Fire video

Read the FINAL `video_prompts` from state (user may have edited them
inline). Fire:
```bash
flow-video-cli generate "<act1>" "<act2>" "<act3>" \
  --frame /Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs/<job>/char-N.png \
  --output /Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs/<job>/final.mp4 \
  --json
```

Use `run_in_background: true`. ~10-12 min. Check wakeup at 330s, then
every 240s if still running.

When done, copy final.mp4 to preview dir + update state:
```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -d '{
    "job":"<job>",
    "patch": {
      "state":"done",
      "video_url":"/picker-jobs/<id>/final.mp4"
    }
  }' http://127.0.0.1:47399/api/picker-update
```

Announce in chat: "Video xong! Mở lại link picker sẽ thấy player tự bật."

### Stage 5 — Post-done revise loop (two modes)

User watching the final video has two actions in the done stage:

**🔄 Gen lại kịch bản** (`mode=regen`, requires comment)
POST `/api/picker-request-revise` with `{comment, mode:"regen"}`.
Server archives current `final.mp4` as `final-v<n>.mp4`, bumps
`video_version`, moves state → `revise_requested` with `revise_comment`.
Skill handler:

1. Read `video_prompts` (last run) + `revise_comment` (user feedback).
2. Generate REVISED prompts that **specifically address the comment**:
   - Drift complaint ("Act 3 bị lệch thành người") → tighten drifting
     act's character-lock cues, drop human-body metaphors.
   - Pacing ("prompt 2 quá dài") → trim dialogue.
   - Content ("thêm cảnh so sánh") → work it in.
   - Preserve everything user DIDN'T complain about.
3. Re-run the 5-dimension self-critique.
4. Update state → `prompts_review` with new prompts + critique + keep
   `revise_comment` visible so user sees what feedback drove the change.

Subsequent flow identical to stage 4b onwards.

**⏩ Render lại video** (`mode=rerender`, no comment needed)
POST `/api/picker-request-revise` with `{mode:"rerender"}`. Server
archives current `final.mp4`, bumps `video_version`, moves state
DIRECTLY to `video_gen` (skipping review — prompts unchanged).
Skill handler for `video_gen` that was entered from this path (detect
via archived file existing + same `video_prompts` as previous run):
just re-fire `flow-video-cli` with the existing prompts + same frame.
Useful when user liked the script but Veo's output drifted
stochastically — a fresh run gives a different Veo seed.

Both modes keep iteration history (`final-v1.mp4`, `final-v2.mp4`, …)
and allow unlimited loops.

## Bodybuilder-3D treatment (active-treatment format)

**Source:** user reference from Khỏe Đẹp 365N channel — a muscular-3D
lemon aggressively squeezing another lemon onto actual skin texture
(da gáy). The format shows **food character physically acting on a
body surface with visible result in same scene**.

**Treatment ref:** `treatment-bodybuilder-3d` — food rendered as
photorealistic 3D muscular bodybuilder, wet/glossy surface, dramatic
warm lighting, mid-action pose.

**Best pairings:**
- Protagonist: `food-hero` (not villain)
- Arc: `yeu-sieu-swagger` (power reveal) or `before-after-after`
  (action → result per scene)
- Setting: the three `setting-da-*` close-ups (gáy, mặt, tay-chân)
- Subject types: strongman foods — chanh, gừng, tỏi, ớt, nghệ

**Caveats:**
- Clashes with K-drama-romance / soft lighting — don't combine.
- Content filter occasionally rejects aggressive bodybuilder language.
  Use `"biểu cảm tự tin đầy năng lượng"` not `"mặt mày dữ tợn hét lớn"`.
- Close-up body-part settings need softening too: use
  `"bề mặt da vùng X dùng làm minh hoạ commercial beauty"`, not
  `"extreme close-up da người thật"` (filter trigger).

## 3-action showcase format (ARC VARIANT — out of v1 scope)

User-surfaced pattern: each of the 3 Veo clips shows a DIFFERENT
action + body part + benefit. E.g.:
- Clip 1: chanh chà gáy → giảm thâm gáy
- Clip 2: chanh chấm nách → khử mùi
- Clip 3: chanh xát khuỷu → mềm da

This requires **3 different starting frames** (one per clip) since
body parts differ. Current `flow-video-cli --frame` only accepts ONE
frame for clip 0; extends inherit the scene. To support 3-action
showcase properly, either:
- Extend `flow-video-cli` with `--frames f1,f2,f3`, OR
- Fire 3 independent 1-clip jobs + ffmpeg concat client-side.

Not implemented in v1. For now, use single-body-part focus (all 3 clips
on same body part with 3 different benefits/angles).

## Non-human protagonist drift protocol (CRITICAL)

When protagonist = villain / organ / condition / ghost (anything without
a human body), Act 3 is the most drift-prone act because its natural
"resolution tone" bleeds toward "helpful human narrator giving advice".

Observed failures (bơ/chuối session logs):
- Cholesterol villain + `"hai tay dang rộng chào đón"` + advisory dialogue
  → Veo substituted a human giving health advice in Act 3.

Mandatory rules for non-human Act 3:

1. **Repeat character signature at sentence start** — e.g.,
   `Cục mỡ cholesterol quái vật vàng nhờn mắt đỏ ...` as first 5-8 words.
   Don't just say "nhân vật" or assume prior context.
2. **No human body parts** — drop `tay dang rộng`, `vẫy tay`, `cúi đầu`
   etc. Replace with character-appropriate mechanics: `thân mềm lại`,
   `tan chảy thành khói`, `lơ lửng bay nhẹ`, `vỡ thành mảnh`, `biến mất`.
3. **Keep POV tone consistent** — villain dialogue should stay in
   villain voice even when "defeated". Not `"bổ sung vitamin C giúp..."`
   (wellness advisor voice) but `"các thứ này đánh bại tao rồi, bọn mày thắng"`
   (villain voice conceding).
4. **Short dialogue** — 1-2 short lines, not 4 instructions piled up.
   Long advisory lines pull Veo toward human narrator template.
5. **Show defeat/transformation mechanism visually** — user complaint
   on bơ session: "Cục mỡ biến mất nhưng không thấy vì sao". Solution:
   concrete agents (chanh warrior's sword, rau xanh's fiber ropes,
   tỏi's allicin) visibly destroying/binding the character. Makes
   narrative cohesion pay off.

## Regen with direction (vs random regen)

When user requests `prompts_regen_requested` with a comment, use the
comment as LITERAL direction, not inspiration. Ex:

- Comment: "Act 3 chưa đủ visual, thay bắn tia bằng dũng sĩ chanh tỏi
  cầm gươm chém"
- Wrong regen: try a different random angle, keep similar shooting-ray
  mechanic.
- Right regen: literally introduce personified lemon + garlic warriors,
  drop the rays, put swords in their hands, stage a chop.

Random regen (no comment) is for users who want "try again, surprise me".
Comment-driven regen is surgical — take the feedback verbatim and
translate into prompt changes. Don't overthink what the user "really
wanted" — they wrote what they wanted.

## Character-variants formula (4 angles)

Apply these 4 variants to the picked **protagonist × setting × treatment**
combo. Each variant keeps all 3 axes consistent; only the *character
angle / pose* differs so the user gets meaningful choice between takes.

Common stem (build once per job, reuse for all 4):

```
[SUBJECT_CHAR]  = description of the character based on subject + protagonist
                  e.g. subject="gan" + protagonist="organ-patient" →
                  "lá gan 3D bán trong suốt màu nâu đỏ texture chi tiết,
                  đang có vẻ mệt mỏi, mạch máu bám quanh"

[SETTING_TEXT]  = from the matching setting ref manifest entry's prompt,
                  or tailored: e.g. "setting-cho-que" → "background là
                  chợ quê Việt Nam buổi sớm với mẹt tre, nón lá vendor
                  mờ bokeh, ánh sáng sớm dưới mái bạt xanh"

[TREATMENT_TEXT]= style tags from the matching treatment ref manifest
                  entry: e.g. "treatment-macro-asmr" → "phong cách
                  macro food porn ASMR commercial, DoF cực nông, raking
                  side light làm nổi texture"
```

Then the 4 angles:

### Variant 1 — Classic portrait (Act 1 expression)

Frontal, centered, character fills ~60% of frame, clearly showing the
Act 1 emotional state (bực bội for "gắt", confessional for "yếu đuối",
mysterious half-shadow for "bí ẩn", weary "Day 1" for "before-after").

```
Cận cảnh chính diện [SUBJECT_CHAR], [ACT_1_EXPRESSION_STATE], nhìn thẳng camera, [SETTING_TEXT], [TREATMENT_TEXT], chi tiết cao, không hoạt hình
```

### Variant 2 — Dynamic action pose

Character mid-motion: pointing at camera, jumping, floating upward,
gesturing outward. Adds kinetic energy → good for extend continuity
(hand already raised means Act 2 "khoe" pose is a small move away).

```
[SUBJECT_CHAR] đang trong tư thế động — một tay chỉ thẳng camera hoặc đang bay nhẹ lên không, [ACT_1_EXPRESSION_STATE], [SETTING_TEXT], [TREATMENT_TEXT], chi tiết cao, motion dynamic
```

### Variant 3 — Cinematic close-up

Extreme close-up of character's face / expressive element (mắt, miệng,
vết cắt, nếp nhăn). Heavy DoF. High drama.

```
Extreme close-up [SUBJECT_CHAR], zoom vào biểu cảm — mắt mở to / miệng quát / vết nứt bề mặt, [ACT_1_EXPRESSION_STATE], DoF cực nông, [SETTING_TEXT] mờ bokeh, [TREATMENT_TEXT], chi tiết siêu cao
```

### Variant 4 — Context / ensemble

Character visible but not sole focus — environment storytelling dominates.
Shows the scene, implies the character is part of something bigger.

```
Wide shot [SETTING_TEXT], [SUBJECT_CHAR] nằm giữa khung, xung quanh là các elements thường thấy trong bối cảnh, [ACT_1_EXPRESSION_STATE] nhìn từ xa, [TREATMENT_TEXT], composition rộng, chi tiết cao
```

**Act 1 expression state per arc** (fill [ACT_1_EXPRESSION_STATE]):

| Arc | Act 1 expression |
|---|---|
| `arc-gat-khoe-thathu` | mặt mày bực bội, miệng mở to quát, lông mày nhíu |
| `arc-yeu-sieu-swagger` | vẻ yếu đuối xấu hổ, mắt cụp xuống, thở dài |
| `arc-bian-reveal` | nửa ẩn trong bóng tối, một mắt lộ ra bí ẩn |
| `arc-before-after-after` | trạng thái "Day 1" mệt mỏi héo úa xanh xao |

## Video-prompts formula (3 acts)

Generate 3 prompts — one per act — each 80-150 Vietnamese words. Follow
these rules (inherited from `write-viral-food-script-vi`):

- Same character description across all 3 prompts (Character continuity)
- Same background setting across all 3 (Setting continuity)
- Dialogue in quotes inside the prompt (Veo lip-syncs)
- Explicit expression + gesture per act
- No humans / no crowd shots in any act
- Natural/soft lighting default; avoid piling `rực rỡ` + `óng ánh` + `shine`
- One emotional beat per prompt

### Dialogue length + speech rate rules (CRITICAL — each Veo clip = 8s)

Each clip is ~8s. Vietnamese speech rate ≈ 3 words/second. That means
**quotes must fit in ~24 words per act** or Veo will truncate the dialogue.

- **Hard budget:** ≤24 Vietnamese words in quotes per act. Not per
  sentence — per ACT total (all quoted dialogue combined).
- **Count the quoted words literally** during self-critique. If a draft
  has 40+ words, cut ruthlessly — drop 1-2 facts rather than rush.
- **Speed hint in every prompt:** append `giọng nói nhanh gọn dứt khoát`
  near the end (before background) so Veo renders at a brisker pace.
  Examples: `"... miệng nói '<quote>', giọng nói nhanh gọn dứt khoát rõ ràng, background ..."`
- **Structure preference:** short declarative sentences > run-on clauses.
  2 short quotes better than 1 long one.
- Prior drafts that violated this rule (chuối v1, bơ v1) had 40-80 words
  per act — Veo dropped the middle clauses silently.

### Per-arc templates

#### `arc-gat-khoe-thathu` — Complaint → Pride → Forgiveness

**Act 1 (gắt):** character complains viewer has ignored them, lists
2-3 health benefits, accuses specific imported alternatives.

Template (fill \[…\]):
```
[CHARACTER_FULL_DESC], mặt mày bực bội đang gắt '[CONFRONTATIONAL_HOOK], tao là [SUBJECT] đây, tao có [FACT_1], [FACT_2], [FACT_3], mà bọn mày toàn đi ăn [IMPORTED_ALT_1] hay [IMPORTED_ALT_2] đắt tiền, quên tao', tay chỉ thẳng vào camera, miệng mở to quát tháo, [SETTING_TEXT], [TREATMENT_SOFT_TAGS], tông màu trung tính không chói
```

**Act 2 (khoe):** character brags about delivery — 3 benefits shown as
visual proofs ("tim khoẻ" + trái tim xuất hiện, "da đẹp" + làn da mịn).

Template:
```
[CHARACTER_FULL_DESC], tự tin khoe thành tích, miệng nói 'ăn tao mỗi ngày [BENEFIT_1]', vén ruột hiện ra [PROOF_1], tiếp tục nói '[BENEFIT_2]', [PROOF_2] hiện ra, tiếp tục nói '[BENEFIT_3]', ngạo nghễ đứng thẳng, [SETTING_TEXT], [TREATMENT_SOFT_TAGS], tông màu êm không chói
```

**Act 3 (tha thứ):** forgiving smile, practical consumption instructions,
origin reinforcement, inanimate-only ambient close.

Template:
```
[CHARACTER_FULL_DESC], nở nụ cười tha thứ, miệng nói 'thôi được rồi bỏ qua chuyện cũ, từ mai nhớ ăn tao nha, [INSTRUCTION_1], [INSTRUCTION_2], [INSTRUCTION_3], [SUBJECT] Việt Nam ngon bổ rẻ nhớ chưa', hai tay dang rộng chào đón, [SETTING_TEXT] với [INANIMATE_AMBIENT], ánh sáng tự nhiên ấm áp qua cửa sổ, tông màu dịu
```

Hook options for Act 1 confrontation (pick 1 randomly per video, don't
repeat the same across back-to-back videos):
- `ê bọn mày, nhìn tao cho kỹ đi`
- `tao là X đây, nghe cho rõ`
- `bao nhiêu năm tao có mặt trong mâm cơm Việt`
- `bọn mày biết tao là ai không`

#### `arc-yeu-sieu-swagger` — Weakness → Superpower → Swagger

**Act 1:** confess a notorious weakness (hôi, cay, đắng, béo, …) with
vulnerable/defensive tone.

**Act 2:** plot twist — the "weakness" IS the superpower. Show
transformation (glowing, powering up, revealing inner strength).

**Act 3:** triumphant swagger, "bất ngờ chưa" vibe, invite user.

(Full templates TBD — extend when first used.)

#### `arc-bian-reveal` — Mystery → Reveal → Celebrate

**Act 1:** character half-hidden, teasing ("một bí mật mà ít ai biết...").

**Act 2:** slow dramatic reveal + facts with "breaking" mood.

**Act 3:** celebrate, "ngờ không?", invite.

#### `arc-before-after-after` — Day 1 / Day 30 / Day 365

**Act 1:** character or scene in "Day 1" weary state.

**Act 2:** "Day 30" — improvement visible, character + viewer benefit.

**Act 3:** "Day 365" — peak transformation, testimonial-style close.

## Subject-facts research

User gives just a subject. Skill must know / infer 3-5 credible health
facts about it. Pick 2-3 for Act 1 and route 3 deliveries to Act 2.

**Do NOT make strong medical claims.** Flow rejects "chữa ung thư",
"thay thế thuốc". Stick to general nutrition:
- vitamin / mineral content (vd "kali gấp 3 lần X")
- digestive / cardiovascular / skin / sleep benefits
- traditional culinary / cultural associations

Example fact banks (extend as needed):

| Subject | Facts (pick 2-3) |
|---|---|
| **gan** | chức năng lọc độc, kali tốt cho gan, vitamin B tổng hợp, nghệ curcumin hỗ trợ, chống gan nhiễm mỡ, tái tạo tế bào |
| **gừng** | chống viêm gingerol, ấm bụng, giảm buồn nôn, tăng tuần hoàn, chống cảm cúm, detox nhẹ |
| **chanh** | vitamin C, chống oxy hoá, kiềm hoá máu, giảm sỏi thận, detox gan, da sáng |
| **stress** | cortisol tăng gây mất ngủ, magie thiếu hụt, vitamin B6 hỗ trợ thần kinh, trà xanh L-theanine, thở sâu |
| **cholesterol** | LDL "xấu" gây xơ vữa, HDL "tốt", chất xơ hoà tan giảm hấp thu, omega-3, tỏi allicin |

## Serving paths

The picker UI references images at `/picker-jobs/<id>/…` — the preview
server must serve `tmp/picker-jobs/` as a static route. Currently the
server only serves `tmp/dev-preview/`. Extend on first use:

```js
// scripts/dev-preview-server.js — add alongside existing express.static:
app.use('/picker-jobs', express.static(path.resolve(__dirname, '..', 'tmp', 'picker-jobs')));
```

(Done during skill v1 setup. Verify before first fire.)

## Error handling

- **flow-cli / flow-video-cli fails** → capture error_code + error message,
  POST /api/picker-update with `state: "error"` and `error: "..."`. Picker
  UI will show red error banner. Announce in chat.
- **User closes Claude mid-flow** → polling stops. State file survives.
  When user returns + invokes skill again, read existing job + resume.
- **Daemon restart mid-job** → flow-cli / flow-video-cli auto-restart daemon,
  job resumes from whatever state the file has.
- **Timeout on user action** (no grid submit after 30min) → announce in
  chat + stop polling. User can restart.

## Credit budget per video

| Step | Cost |
|---|---|
| Character gen (4 images) | ~4 credits |
| Video gen (3 clips) | ~3-9 credits (depends on model tier) |
| **Total per video** | **~7-13 credits** |

Plus the ref library (~25 one-time) which is already paid.

## Testing

First-run check:
1. Daemon running: `curl http://127.0.0.1:47321/health`
2. Preview server running + extended: `curl http://127.0.0.1:47399/api/picker-current`
3. Ref library present: `ls ~/projects/flow-daemon/tmp/dev-preview/skill-refs/ | wc -l` should be ≥ 26
4. Stable URL resolvable: open http://mac-mini.tailf56d7b.ts.net:47399/picker.html
