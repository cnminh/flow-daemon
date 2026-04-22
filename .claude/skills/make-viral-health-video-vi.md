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
      │                    │                │                │
      │                    │                │                │
      │──── URL to user ───┼────────────────┼───────────────►│
      │                    │                │                │
      │  poll status ◄────►│                │                │
      │                    │                │                │
      │                    │◄── load page ──┤◄── opens URL ──┤
      │                    │─ ref manifest ►│                │
      │                    │  poll status ◄►│                │
      │                    │                │                │
      │                    │                │◄── pick 5 ─────┤
      │                    │◄── submit ─────┤                │
      │  state = grid_done │                │                │
      │                    │                │                │
      │─ gen 4 chars ─────►│  flow-cli ×4   │                │
      │─ update chars ────►│                │                │
      │  state = char_pick │                │                │
      │                    │                │                │
      │                    │                │◄── pick char ──┤
      │                    │◄── submit ─────┤                │
      │  state = char_picked                                 │
      │                                                      │
      │─ gen video ─────────────► flow-video-cli --frame     │
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

### Stage 2 — Generate 4 character variants

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

### Stage 4 — Generate 3-act video + fire

State has `char_index: 0..3`. The picked frame is
`tmp/picker-jobs/<job>/char-{char_index+1}.png`.

Generate 3 act prompts using the **video-prompts formula** (below),
driven by arc + protagonist + setting + treatment + sound + subject.

Fire:
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
