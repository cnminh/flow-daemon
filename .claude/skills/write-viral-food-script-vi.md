---
name: write-viral-food-script-vi
description: Use when the user asks to create a viral Vietnamese food/ingredient video in the "personified fruit character" format — "làm video về X", "viết script video đu đủ / cà rốt / gạo lứt / bất cứ món gì", "create a video about <ingredient>", "write a 3-scene script for viral food content". Produces a 3-prompt Vietnamese script following the gắt → khoe → tha thứ emotional arc (angry → proud → forgiving). This skill WRITES the script only — it does NOT fire the CLI. Stop after the user approves the script, then hand off to the `test-flow-live` skill for the actual generation.
---

# Writing a viral Vietnamese food-character video script

## When to use

User wants a 3-scene Vietnamese-style TikTok video where an ingredient
(đu đủ, gạo lứt, cà rốt, nghệ, trà xanh, etc.) is personified as a
character with a face, hands, and a voice — complaining about being
overlooked, bragging about its benefits, then forgiving and inviting
the viewer to consume.

This skill **ONLY writes the script**. It does NOT fire `flow-video-cli`.
After the user approves the 3 prompts, invoke the `test-flow-live` skill
to run the generation.

## What you'll produce

A JSON-ish block the user can paste into a `flow-video-cli` command:

```
prompt 1: "<Vietnamese, ~80-150 words, Act 1 — gắt/complaint>"
prompt 2: "<Vietnamese, ~80-150 words, Act 2 — khoe/pride>"
prompt 3: "<Vietnamese, ~80-150 words, Act 3 — tha thứ/forgiveness>"
```

Portrait orientation (`--orientation portrait`) is the default for this
format — social feeds are vertical.

## Inputs to gather from the user

Before drafting, confirm:

1. **Subject** — which ingredient/food/dish. If vague ("làm video về đồ
   ăn Việt"), ask for one concrete choice.
2. **2-3 key facts** — nutritional, cultural, or health benefits. Concrete
   ("vitamin C gấp đôi cam", "enzyme papain tiêu hóa mạnh") beats vague
   ("tốt cho sức khỏe").
3. **Setting/background** — where does the character live visually?
   (vườn đu đủ, bếp quê, ruộng lúa). One setting, reused across 3 scenes.
4. **Style preference** — user previously said NO "phong cách hoạt hình
   3D". Default to realistic/natural unless user specifies.

## The 3-act formula

### Act 1 — Gắt (complaint, ~8s)
The character is **angry** that viewers eat imported alternatives
(táo, nho nhập khẩu, khoai tây chiên, ngũ cốc Mỹ) instead of them.
- Opens with character description: shape, cross-section, face
- Lists 2-3 concrete benefits: "tao chứa vitamin C gấp đôi quả cam, enzyme papain tiêu hóa cực mạnh"
- Directly accuses: "mà bọn mày toàn đi ăn táo nhập khẩu, quên tao"
- Visual: `tay chỉ thẳng vào camera`, `miệng mở to quát tháo`, `vẻ khó chịu gay gắt`
- Setting: home environment (vườn X, ruộng X)

### Act 2 — Khoe (pride, ~8s)
Character **brags** about what they deliver, shows proof visually.
- Opens with character in confident pose: `tự tin`, `ngạo nghễ`
- Uses pattern: `miệng nói "ăn tao mỗi ngày [X]"` repeated 2-3 times
- Visual proof: `vỏ da shine lên óng ánh`, `vén ruột hiện ra dạ dày khoẻ đẹp sáng láng đang nở nụ cười`
- Color cue: `rực rỡ`, `óng ánh`
- Same setting as Act 1

### Act 3 — Tha thứ (forgiveness, ~8s)
Character **softens**, gives consumption instructions, warm invitation.
- Opens: `nở nụ cười tha thứ`
- Dialogue: `"thôi được rồi bỏ qua chuyện cũ, từ mai nhớ ăn tao nha"`
- Practical instruction: when/how/with what (`ăn vào buổi sáng sau bữa ăn`, `pha với mật ong`)
- Origin reinforcement: `đu đủ/gạo/trà Việt Nam ngon bổ rẻ nhớ chưa`
- Closing visual: `hai tay dang rộng chào đón`, inanimate ambience (e.g. `vài quả X khác trên bàn đá bên cạnh`, `ánh sáng tự nhiên ấm áp qua cửa sổ`), `ấm áp` — NO humans, NO crowd shots

## Prompt writing rules

- **Start with subject + state + setting.** `Đu đủ vỏ xanh đã bổ, mặt bực bội, trong vườn đu đủ xanh mướt.`
- **Put dialogue in quotes inside the prompt.** `miệng nói 'ăn tao mỗi ngày da đẹp'`. Veo renders the dialogue as lip-sync.
- **Explicit expression + gesture.** Don't rely on "angry" — spell it out: `mặt mày bực bội, miệng mở to quát tháo, tay chỉ thẳng vào camera`.
- **One emotional beat per prompt.** Don't cram "angry then happy" into Act 1 — that's what the 3-act structure is for.
- **Consistent character + background across all 3 prompts.** Same fruit, same face shape, same vườn/setting. Otherwise extends produce jarring jump cuts.
- **Color/lighting words work well with Veo:** `sáng láng`, `ấm áp`, `dịu`, `tự nhiên`. Use `rực rỡ` / `óng ánh` **sparingly** — user feedback on the chuối v1 was "tông màu sáng chói quá". Default to natural/soft lighting (`ánh sáng tự nhiên dịu nhẹ qua cửa sổ`, `tông màu trung tính không chói`) unless the brief genuinely calls for saturated.
- **No humans in background.** The character is the entire cast. Do NOT add `phía sau người người ăn X ngon miệng` or similar crowd shots — user explicitly removed this after the chuối v1 (and it was also in the original đu đủ template). Replace with inanimate ambience: same-ingredient fruits on a table, kitchen props, garden plants.
- **Don't over-specify style.** Avoid `phong cách hoạt hình 3D` (user explicitly removed it). Let Veo choose its own visual register based on the realistic subject description.
- **Keep each prompt ~80-150 Vietnamese words.** Longer prompts cause Veo to drop details; shorter prompts produce bland output.

## Continuity checklist (verify before showing user)

- [ ] Same fruit/ingredient across all 3 prompts — same shape, cross-section style, face features
- [ ] Same background theme (vườn / bếp / ruộng / bếp-cạnh-vòi-nước) across all 3
- [ ] Tone isn't over-bright. No `rực rỡ` + `óng ánh` + `shine` piled up in one prompt; default is `ánh sáng tự nhiên dịu` / `tông trung tính`
- [ ] **No humans in any prompt** — character is the only cast member; backgrounds use inanimate props only
- [ ] Act 1 facts ≠ Act 2 facts (don't repeat the same benefit — Act 1 is "what you're missing", Act 2 is "this is what I deliver")
- [ ] Act 3 has a practical instruction + warm ending (not just another brag)

## Reference template — đu đủ video (the original)

This is the script that worked. Use as anchor when the genre isn't clear:

```
Prompt 1 (Gắt):
"Đu đủ vỏ màu xanh đã bổ góc 1/4, hiển thị rõ thịt màu đỏ óng ánh và
hạt đen bên trong, mặt mày bực bội đang gắt 'tao là đu đủ đây, nghe
cho rõ, tao chứa vitamin C gấp đôi quả cam, enzyme papain tiêu hóa cực
mạnh, mà bọn mày toàn đi ăn táo ăn nho nhập khẩu đắt tiền, quên tao',
tay chỉ thẳng vào camera, miệng mở to quát tháo, vẻ khó chịu gay gắt,
background là vườn đu đủ xanh mướt trĩu quả chín vàng, màu xanh đỏ
rực rỡ"

Prompt 2 (Khoe):
"Đu đủ vỏ xanh thịt đỏ tự tin khoe thành tích, miệng nói 'ăn tao mỗi
ngày da đẹp', vỏ da đu đủ shine lên óng ánh, tiếp tục nói 'dạ dày
khỏe', vén ruột hiện ra dạ dày khoẻ đẹp sáng láng đang nở nụ cười,
ngạo nghễ, màu sắc rực rỡ"

Prompt 3 (Tha thứ):
"Đu đủ vỏ xanh thịt đỏ nở nụ cười tha thứ, miệng nói 'thôi được rồi
bỏ qua chuyện cũ, từ mai nhớ ăn tao nha, ăn vào buổi sáng sau bữa ăn,
đu đủ Việt Nam ngon bổ rẻ nhớ chưa', hai tay dang rộng chào đón, vài
quả đu đủ khác trên bàn gỗ bên cạnh, ánh sáng tự nhiên ấm áp qua cửa
sổ, ấm áp"

(Note: the original v1 đu đủ prompt 3 ended with `phía sau người người
ăn đu đủ ngon miệng`. Current practice removed that — no humans in any
frame. Same rule applied to the chuối v1 → v2 iteration.)
```

## Workflow

1. **Gather** — confirm the 4 inputs above (subject, facts, setting, style).
2. **Draft** — write all 3 prompts following the formula + rules.
3. **Self-check** — run the continuity checklist.
4. **Show to user** — present the 3 prompts as a reviewable block. Do
   NOT fire yet. Ask: "OK với script này chưa? Sửa gì không?"
5. **Iterate if needed** — user may tweak dialogue, swap facts, change
   background. Re-check continuity after edits.
6. **Hand off** — once user approves, invoke `test-flow-live` skill to
   fire `flow-video-cli generate` with the 3 prompts.

**Do not skip step 4.** Firing spends ~8 credits per run. A one-minute
review saves wasted generations.

## Gotchas

- **Flow may reject strong medical claims.** "Chữa bệnh ung thư" or
  "thay thế thuốc" will trigger content filter → `extend_failed`.
  Stick to general nutrition ("giàu vitamin C", "tốt cho tiêu hóa").
- **Dialogue too long = poor lip-sync.** If a quote exceeds ~12-15
  Vietnamese words, break into two shorter lines with `tiếp tục nói`
  between (see Act 2 example).
- **Politically sensitive comparisons** (e.g. đu đủ Việt vs đu đủ Thái)
  can be fine but avoid "đồ Trung Quốc hại sức khỏe" etc.
- **Veo sometimes flips aspect on clip 0** even with `--orientation
  portrait` — known flow-daemon bug. Output still portrait shape via
  pillarbox pad. Don't let it delay the script-writing step; just warn
  the user it may happen.
- **Same-character continuity isn't guaranteed** — Veo may draw the
  character slightly differently clip-to-clip. Keep the shape/color
  description identical across prompts to minimize drift.
