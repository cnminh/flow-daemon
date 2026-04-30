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

## Viral Food Hero Formula v1 — Recommended preset (food/plant subjects)

Proven pattern from successful chuối + gừng videos. Applies when subject
is a food/plant (trái cây, rau củ, gia vị, lá thuốc).

**NOT auto-selected.** The skill still presents the grid menu per the
"offer menu over autopick" rule. But when pitching options in chat or
annotating the picker's default picks, flag this combo as
**"recommended preset — pattern proven từ chuối/gừng"** so the user
knows it's battle-tested.

### Grid picks (recommended)

| Axis | Value | Why |
|---|---|---|
| Setting | `setting-bep-que` | bếp củi + nồi đất + mái lá = cultural warmth, trust |
| Treatment | `treatment-bodybuilder-3d` | cơ bắp + bóng ướt = healthy vibe trực quan |
| Protagonist | `protagonist-food-hero` | food là POV, không narrator ngoài |
| Arc | `arc-gat-khoe-thathu` | hook (Act 1 gắt) + payoff (Act 2 khoe) + CTA (Act 3) |
| Sound | `dialogue` | POV + Vietnamese lip-sync = high retention |
| Char index | `0` (classic portrait) | Act 1 expression lock, best video seed |

### Script structure (proven)

- **Act 1 — Gắt chê đối thủ**: "ê bọn mày toàn ăn [COMPETITOR_IMPORTED],
  quên tao à, tao là [SUBJECT] Việt, [FACT_1] [FACT_2] [FACT_3] đủ cả".
  Định vị nguyên liệu Việt vs đối thủ ngoại (thanh protein / thuốc bổ /
  supplement ngoại).
- **Act 2 — Khoe với visible mechanism**: 3 benefits cụ thể + động tác
  muscle/flex có mechanism thấy được (trái tim đập, cơ bắp săn, nâng tạ,
  kết tủa vỡ). Mỗi benefit 1 câu ngắn. Mechanism visible > advisory claim.
- **Act 3 — Tha thứ + CTA cụ thể**: tha thứ vibe qua VISUAL (smile +
  product trên mâm/đĩa), CTA phải cụ thể ("sáng 1 quả sau cà phê, tối
  nửa quả, khoẻ ngay nha"). KHÔNG dùng filler "thôi bỏ qua".

### Callback 3-facts rule

- Act 1 nêu 3 chất dinh dưỡng (vd kali / magie / tryptophan cho chuối).
- Act 2 map 1-1 sang 3 symptom relief (chuột rút / tim / ngủ).
- Tạo cảm giác "có khoa học" — không mơ hồ, không lộ thông tin vô căn cứ.

### When to deviate from the preset

- **Subject là villain/organ/condition** (cholesterol, gan, stress):
  dùng `villain-takedown` hoặc `condition-ghost` arc thay vì
  gắt-khoe-thathu. Non-human drift protocol áp dụng (xem section dưới).
- **Subject cần body-contact demo** (chanh chà gáy, tỏi đắp vết): dùng
  3-action showcase format (out of v1 scope).
- **User yêu cầu tone trầm/bình yên**: bodybuilder-3D clashes với soft
  moods — chuyển sang `treatment-macro-asmr`.

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

### Stage 2c — Fire char gen (1 call, 4 images via --count)

Read final `character_prompts` from state. Use `flow-cli generate` with
`--count 4` flag (added 2026-04-29) to gen 4 variants in ONE call (1 popover
toggle, ~50-60s total — vs 4 separate calls × 30-40s = 2-3 min). Variants
share the same character prompt; Imagen returns 4 variations naturally.

```bash
flow-cli generate "<character_prompt>" \
  --aspect 9:16 \
  --count 4 \
  --output /Users/cuongnguyen/projects/flow-daemon/tmp/chars/<subject-slug>/v1/1.png
```

Output naming: `1.png` + `1_1.png` + `1_2.png` + `1_3.png` (first keeps base
name, rest append `_N` suffix). Check wakeup after ~90s.

If user doesn't like all 4, regen with prompt edit (next version becomes
`v2`): `tmp/chars/<subject-slug>/v2/1.png` etc. Bumping version preserves
history and avoids overwriting earlier picks.

### Chars Gallery

All character renders live under a single browsable URL so user can compare
across subjects + versions without hunting through job dirs:

**URL:** `http://mac-mini.tailf56d7b.ts.net:47399/chars-gallery.html`

**Path convention:**
```
tmp/chars/<subject-slug>/v<N>/<index>.png
       │           │       │       │
       │           │       │       └── index 1-4 from --count
       │           │       └────────── version (v1 = first gen, v2 = regen, …)
       │           └────────────────── lowercase slug, dashes (e.g. "rau-den-do", "muop-dang")
       └──────────────────────────── parent dir for all chars (preview server serves it as /chars/)
```

**Char code format** (for user reference): `<subject-slug>-v<N>-<index>`
- `rau-den-do-v1-1` → tmp/chars/rau-den-do/v1/1.png
- `cantay-v1-3` → tmp/chars/cantay/v1/3.png
- `muop-dang-v2-2` → tmp/chars/muop-dang/v2/2.png

User picks by code: "render rau-den-do-v1-3 với prompt act1/2/3/4" → skill
copies `tmp/chars/rau-den-do/v1/3.png` → `tmp/picker-jobs/<new-job>/char-1.png`
+ fires video render.

**Why centralize:**
- Single URL to bookmark — user doesn't navigate per-job
- Future-proofs char reuse: same char across multiple subject videos / variants
- Auto-discovered by gallery — no manual register
- Versioning preserves regen history (compare v1 vs v2 visually)

**Server impl:** `dev-preview-server.js` should:
1. Serve `tmp/chars/` static at `/chars/`
2. Provide `chars-gallery.html` (auto-list all chars, group by subject, show
   code + thumbnail + click-to-fullscreen)
3. Optional API `/api/chars` returning `[{code, url, subject, version}]`

Once all 4 PNGs exist, copy them to the preview-served directory so the
picker UI can load them.

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

Then run a **self-critique** across these 8 dimensions for each prompt:

1. **Character continuity** — Do same visual cues (texture, màu, distinctive
   features) appear across all acts? Any drift risk?
2. **Narrative cohesion** — Does Act 2 pay off Act 1 setup? Does Act 3
   resolve Act 1 tension (not disconnected scenes)?
3. **Dialogue callback** — Does Act 3 reference something Act 1 said?
4. **Drift risks** — Non-human body parts for non-human protagonists?
   (e.g. "hai tay dang rộng" for a cholesterol blob — drops back to a
   human figure). POV shifts? Tone mismatches with arc? Anti-human
   guardrail present in every prompt? ("TUYỆT ĐỐI KHÔNG có người…")
5. **Content safety** — Medical claims in safe territory (general
   nutrition); no "chữa ung thư" / "thay thế thuốc" / fake scarcity.
6. **Subject-mechanism authenticity** — Does Act 2 action match how
   Vietnamese ACTUALLY use this subject? See lookup table below. ❌ FAIL
   examples: "vắt nước mướp đắng tươi uống" (no one drinks raw bitter
   melon juice — should be DRY-LEAF tea or stuffed-meat soup); "giã
   chuối thành bột" (chuối eaten whole, not ground); "vò lá tỏi" (no
   such thing — tỏi is a bulb, not leaves).
7. **Visual specificity / food-stylist level** — Does each món ăn /
   dụng cụ in Act 2-4 have ≥3 concrete details? Required: (a) **color
   accurate to reality** — vd canh có nước TRONG VẮT (broth) với rau
   nổi bên trên xanh, KHÔNG phải "nước xanh"; (b) **specific topping
   /garnish** (lá hành thái nhỏ, rau ngò, lát chanh, mè rang); (c)
   **specific vessel** (bát đất nung Việt nâu trầm, ly thuỷ tinh khắc
   tinh tế cao, ấm trà sứ trắng). Generic "ly thuỷ tinh có đá" = ❌ FAIL.
8. **Stunt narrative fit** — Does the visual stunt origin (giàn / thớt
   / rổ / ấm / nồi) match the subject's natural habitat? Mướp đắng →
   giàn (vine) ✅, thớt ❌ (copy-paste from cà chua); lá tía tô → bụi
   tươi ✅, rổ ❌; cá thu → mâm cá tươi ✅, vườn ❌.

### Health claim discipline — use "hỗ trợ" framing (CRITICAL — 2026-04-30)

User feedback (cần tây v3 dialogue review): "huyết áp ổn hết đau" sợ
viewer hiểu nhầm là cure-promise. Dùng `hỗ trợ` thôi cho chắc.

**Rules:**

1. **Framing — "ăn thêm / uống thêm", KHÔNG prescribe regularity**:
   - ❌ "mỗi ngày tối 1 đĩa, sáng 1 ly" (overprescription)
   - ❌ "thường xuyên ăn..." / "đều đặn uống..." (vẫn implies regimen)
   - ✅ "ăn thêm cần tây xào thịt bò, uống nước ép cần tây..."

   "Ăn thêm / uống thêm" framing positions subject as a SUPPLEMENT to
   normal diet — not a regimen, not a cure. Safest framing.

2. **Default to "hỗ trợ" framing**, NOT outcome-promise:
   - ❌ `"huyết áp ổn hết đau"`, `"khỏi gout"`, `"chữa lành gan"`
   - ✅ `"hỗ trợ hạ huyết áp"`, `"hỗ trợ giảm acid uric"`, `"hỗ trợ
     gan"`, `"giúp tiêu hoá"`

3. **Avoid absolute words**: bỏ `hết` / `khỏi` / `chữa lành` / `dứt
   điểm` → dùng `giảm` / `đỡ` / `ổn` / `hỗ trợ` / `giúp`.

4. **Time-frame OK only if backed by source** (Vinmec, BV, etc.).
   "2 tuần" / "1 tháng" only if claim is in published medical
   reference. If unsure, drop the time-frame claim entirely.

5. **No medication-replacement implication**: never imply replacing
   prescribed medicine. "Hỗ trợ ngoài thuốc" / "kết hợp với điều trị"
   if mentioned at all.

**Why this matters:** flagging as medical disinformation by FB / TikTok
algos drops reach + risk strikes. Soft framing keeps the script in
"educational lifestyle" lane, not "medical advice" lane.

### Verify dish authenticity BEFORE writing Act 2/3 prompts (CRITICAL — 2026-04-30)

User feedback (cần tây v3 review): "cần tây hầm xương có phổ biến không?
có thật không hay bịa?" — and the answer was "no, made up by transferring
'hầm xương' template from atisô/củ sen". Inventing a dish that doesn't
exist in VN cuisine breaks viewer trust + signals AI slop.

**3-step verify before drafting Act 2/3 visual + dialogue:**

1. **List 3 candidate dishes** for the subject (Act 2 = mechanism, Act
   3 = full meal). Don't pick "first that comes to mind" — that's
   often a template borrowed from previous subject.

2. **WebSearch each candidate** on 2-3 VN-specific sources:
   - `cookpad.com/vn` (community recipes — proxy for popularity)
   - `monngonmoingay.com` (popular VN cooking site)
   - `vi.wikipedia.org` (ingredient overview + traditional uses)
   - Google with `site:.vn` filter for VN-domain content only
   - For health benefit claims: `vinmec.com` or `hellobacsi.com`

3. **Reject if:**
   - <3 cookpad hits OR
   - 0 Wikipedia mention OR
   - Top results are AI-generated blogs / Pinterest / TripAdvisor
     (signal: thin content, no specific recipe steps) OR
   - Search returns the dish under a DIFFERENT name (e.g. "cần tây
     hầm xương" → "canh sườn nấu cần tây" — confirm template name
     was wrong)

**Save verified pool to memory** under
`project_verified_dishes_<subject>.md` — list 3-5 verified dishes per
subject. Reuse for future videos of the same subject (avoid
re-verifying).

**Anti-pattern: template transfer.** Patterns like `hầm xương`, `kho
tộ`, `rim mật`, `cuốn lá lốt` are subject-specific — atisô hầm xương
real, củ sen hầm sườn real, cần tây hầm xương INVENTED. Always
re-verify when applying a cooking template to a new subject.



| Subject type | Examples | Act 2 mechanism (real Vietnamese use) |
|---|---|---|
| **Quả mọng nước** | cam, chanh, dưa hấu, cà chua, bưởi | Vắt/ép lấy nước uống ✅ |
| **Quả đắng/cứng** | mướp đắng, khổ qua | KHÔNG vắt tươi. Lát mỏng phơi khô → trà; nhồi thịt → canh; xào trứng |
| **Củ rễ** | gừng, tỏi, nghệ, riềng | Giã/ép + pha mật ong; lát mỏng pha trà |
| **Lá khô đặc trưng trà** | vối, dứa, ổi, sen | Vò + thả ấm nước sôi → trà; KHÔNG vắt |
| **Lá tươi giòn** | rau má, mồng tơi, cải xoong | Vò + xay sinh tố / xào tỏi |
| **Hạt** | kê, đậu xanh, đậu đen, mè | Đổ nồi nấu cháo / chè / rang |
| **Bột** | sắn dây, gấc bột | Khuấy với nước lạnh / nóng |
| **Quả nhiều xơ** | đu đủ xanh, mít non | Bổ + nạo + nấu canh / gỏi |
| **Hải sản** | cá thu, cá hồi, tôm | Thái khúc + kho / nướng / canh |
| **Củ ngọt** | khoai lang, khoai môn | Luộc / nướng nguyên củ; KHÔNG ép nước |

### Vanish + re-describe drift (for dim 4) — CRITICAL for video prompts

When a video prompt has the character **vanish** (submerge / burst / fade)
then **reappear**, Veo loses visual continuity at the vanish point. Any
character description AFTER the vanish becomes a new generation seed →
drift. Reference image / start frame's influence drops drastically
post-vanish.

**Vanish patterns** in current skill templates:
- "bùng vọt rời khỏi [bụi / luống / giàn]" — char hidden then bursts (Act 1)
- "dive vào [nồi / ly / bồn]" — char submerges (Act 3)
- "biến mất trong khói / lộn ngược" — partial vanish

**3 fix strategies:**

1. **Minimal re-description post-vanish:** describe ACTION only, NOT BODY:
   - ❌ `"ngoi lên mặt canh cười sảng khoái với 2 cánh tay CƠ BẮP giơ lên flex"`
   - ✅ `"ngoi lên đứng vững giữa nồi, 2 tay giơ lên flex"`
   - ❌ `"đáp xuống đứng hiên ngang, mặt mày bực bội đầy năng lượng cơ bắp..."`
   - ✅ `"đáp xuống đứng hiên ngang, miệng quát to '<dialogue>'"`

2. **Avoid vanish entirely:** continuous action — no submerge:
   - Thay "dive vào nồi" → "đứng cạnh nồi múc canh ra ly"
   - Thay "bùng vọt từ luống" → "bước ra từ phía sau bụi cây" (visible throughout)

3. **Hybrid (recommended):** keep Act 1 burst (visual stunt opener, drift
   forgivable, opens video high-energy) but remove vanish in Acts 2-3-4.
   Act 3 = continuous action (stir / pour / flex over pot), no submerge.

### Subject-form drift watch list (for dim 4)

When character là form ít phổ biến của một cây/quả, Veo dễ drift sang
form phổ biến hơn khi extend (đặc biệt clip dive vào liquid/món ăn —
Veo "nhớ" công thức món có nguyên liệu phổ biến). Negative prompt bắt buộc.

| Form character (dùng) | Form drift target | Negative prompt phải có |
|---|---|---|
| **Lá ổi** | Quả ổi tròn | "KHÔNG có quả ổi tròn, chỉ có lá ổi" |
| **Vỏ dưa hấu (cùi trắng)** | Ruột đỏ | "KHÔNG có ruột dưa hấu đỏ, chỉ có cùi vỏ trắng" |
| **Hạt mít** | Múi mít vàng | "KHÔNG có múi mít vàng, chỉ có hạt mít nâu" |
| **Đu đủ xanh** | Đu đủ chín cam | "KHÔNG có đu đủ chín cam, chỉ có đu đủ xanh chưa chín" |
| **Lá vối / lá tía tô / lá sen** | Cây nguyên / quả | "Chỉ có lá, KHÔNG có cây nguyên hay quả" |
| **Hạt sen** | Bông sen / lá sen | "KHÔNG có bông sen, chỉ có hạt sen" |
| **Cùi dừa** | Quả dừa nguyên | "KHÔNG có quả dừa nguyên, chỉ có cùi trắng" |

Apply trong MỌI act (không chỉ act 1) — extend là điểm drift mạnh nhất.

### Dish color reality (for dim 7)

Veo có xu hướng "tô màu" món ăn theo nguyên liệu chính → render sai. Phải
specify rõ TÁCH BẠCH "broth color" vs "ingredient color":

| Dish | Real color (specify in prompt) | Wrong (Veo default) |
|---|---|---|
| Canh rau xanh (mồng tơi, rau dền, cải xoong) | Nước canh **TRONG VẮT hơi vàng nhạt**, rau xanh nổi trên mặt | "Canh xanh" → broth bị nhuộm xanh ❌ |
| Canh cà chua / canh chua | Nước canh **đỏ cam nhạt** (do cà chua tan), không đỏ đậm | "Canh đỏ" → đỏ máu ❌ |
| Trà lá / trà khô | Nước **vàng nâu đến nâu đậm** trong vắt | "Trà xanh" → xanh lá ❌ (chỉ trà tươi xay là xanh) |
| Nước ép rau xanh | Nước **xanh đặc đục** (là pulp, không trong) | "Nước trong vắt xanh" ❌ |
| Nồi cháo | **Trắng đục có hạt nổi**, hành xanh thái nhỏ rắc lên | "Cháo vàng" ❌ |
| Sinh tố trái cây | Đặc, màu theo trái cây, có **bọt nhỏ trên mặt** | Lỏng như nước ❌ |

### Veo-unknown specific names → use generic alternative (2026-04-30)

Veo's training is heavy on Western / international ingredients but
weak on Vietnam-specific items. When prompt names a specific VN item
Veo doesn't know, it renders a generic substitute that often looks
wrong (different fish, different bone, different vegetable) → fails
"thoại không match render" check.

**Rule:** prefer Veo-known generic terms in cooking shots; reserve VN-
specific names for the dialogue (where audio carries the meaning, not
visuals).

| Veo-unknown VN-specific | Substitute in visual prompt | Keep specific in dialogue? |
|---|---|---|
| **cá lóc** (snakehead) | `xương heo` (canh hầm xương) or `cá thịt trắng` | Drop — say `cá` or `xương` generic |
| **cá rô đồng** | `cá thịt trắng` | Drop |
| **gà ác** (silkie) | `gà thường` | Drop or rephrase |
| **rau má** in salad | (use as juice instead — Veo renders xay better than salad) | Keep when food form unambiguous |
| **bưởi da xanh** | `bưởi tím nhạt` generic | Drop variety, keep `bưởi` |
| **chanh không hạt** | just `chanh` | Drop variety |

When in doubt, **simpler beats specific**: cần tây v3 dropped `cá lóc`
→ `xương heo` and the canh render came out clean. Trade-off: lose
"chuẩn miền Nam" authenticity in visuals — but the audio dialogue can
still mention regional specifics if they matter for the script.

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

### Stage 4d — Fire video — pick mode (extend / ingredients / per-scene)

**Three modes** as of 2026-04-30:

| Mode | Flag | Trade-offs |
|---|---|---|
| **Extend** (classic) | `--frame char.png` | ✅ Motion smooth, audio liền mạch. ❌ Character drift cumulative across scenes. |
| **Ingredients** | `--ingredients char.png[,ref2,ref3]` | ✅ Character locked (re-references image per scene). ❌ Jump cuts (mitigated by 200ms crossfade default). |
| **Per-scene frames** (`scripts/render-by-scene.py`) | gen frame per scene with char as Imagen reference, then `--frame frame-N.png` per clip | ✅ Strongest character lock + per-scene staging control (each frame composes the act explicitly). ❌ Costs 4 extra image credits/video; jump cuts (use crossfade). |

**Rule of thumb (2026-04-30):**
- **Default to Per-scene frames** for hero subjects where staging matters (Act 2 ấm trà, Act 3 nồi canh) — atisô v2/v3 + lá ổi v3/v4 confirmed best lock.
- **Ingredients** is the cheaper fallback when staging is simple (1 setting all acts) and budget tight.
- **Extend** only for heavy motion-continuity sequences (chase, choreographed) where seam smoothness > character lock.
- Subjects that drift hard (lá ổi → quả ổi, rau dền → human, etc.) → never use Extend.

**Mutual exclusion:** Veo UI lets you pick Frames OR Ingredients sub-mode, not both. CLI enforces same: `--frame` and `--ingredients` are mutually exclusive.

**Frame reuse for dialogue-only iterations:** when iterating ONLY on speech speed / dialogue length (not visuals), reuse prior version's frames — saves 4 image credits per re-render. Atisô v3 (2026-04-30) reused v2's per-scene frames + only changed prompts (22w + rapid-fire cue) → confirmed faster speech without new image budget. Pattern: copy `tmp/picker-jobs/job_subject_vN/scenes/scene-*-frame.png` into the new job dir, then run only the video gen step of `render-by-scene.py`.

**Start frame = action-in-progress, NOT a posed flex (CRITICAL — 2026-04-30):**
Scene 2/3 start frames must bake the natural cooking action directly,
not a "standing + flex bắp tay" pose. When a frame has flex pose, Veo
keeps the flex 1-2s into the clip before transitioning to the action
prompt → character looks "gồng / không tự nhiên" the entire opening
beat (cần tây v2 issue confirmed by user 2026-04-30: re-gen scene 2/3
prompts dropping flex from VIDEO prompt didn't help because the FRAME
itself was the source). Fix at the frame level.

Frame prompt rules per scene:
- **Scene 1:** standing rant pose with one hand pointing at camera —
  flex/no-flex doesn't matter much (rant is the focus). Keep current.
- **Scene 2:** action-in-progress — character mid-juicing / mid-slicing /
  mid-pouring. E.g. `"một tay cầm thân cần tây đẩy vào miệng máy ép, tay
  kia hứng ly thuỷ tinh dưới vòi nhận nước ép vừa chảy ra"`. NEVER
  `"flex bắp tay double biceps cố định"`.
- **Scene 3:** action-in-progress — character mid-stirring / mid-serving.
  E.g. `"hai tay cầm vá gỗ múc canh đang khuấy nhẹ trong nồi, hơi nước
  bốc lên"`. NEVER `"một tay cầm vá tay kia flex bắp tay"`.
- **Scene 4:** seated relaxed close — fine to keep static, no flex
  needed (it's the chill outro pose).

Negation in prompts ("không flex bắp tay") is NOT reliable — Veo often
ignores or partially applies negative cues. The fix is positive: bake
the desired action into the frame so flex never starts.

### Fire video

Read the FINAL `video_prompts` from state (user may have edited them
inline). **Use 4 prompts** — Act 1/2/3 + Act 4 contextual outro
(see Per-arc templates below). Fire ONE of:

```bash
# Ingredients mode (recommended default, locks character):
flow-video-cli generate "<act1>" "<act2>" "<act3>" "<act4>" \
  --ingredients /Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs/<job>/char-N.png \
  --output /Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs/<job>/final.mp4 \
  --json

# Extend mode (classic, smooth motion but drifts):
flow-video-cli generate "<act1>" "<act2>" "<act3>" "<act4>" \
  --frame /Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs/<job>/char-N.png \
  --output /Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs/<job>/final.mp4 \
  --json
```

Use `run_in_background: true`. ~13-17 min for 4 clips. Check wakeup at
600s, then every 240s if still running.

When render done, **finalize the video** (delogo Veo watermark only —
no static outro concat, since Act 4 IS the outro) BEFORE marking
state=done:

```bash
ffmpeg -y \
  -i /Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs/<job>/final.mp4 \
  -vf "delogo=x=1770:y=3670:w=320:h=110:show=0" \
  -c:v libx264 -c:a aac -preset fast -crf 20 \
  /Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs/<job>/final-branded.mp4
```

Then auto-compress for FB upload (Playwright CDP setInputFiles caps
at 50 MB):

```bash
ffmpeg -y \
  -i /Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs/<job>/final-branded.mp4 \
  -c:v libx264 -preset slow -crf 26 \
  -c:a aac -b:a 128k \
  /Users/cuongnguyen/projects/flow-daemon/tmp/picker-jobs/<job>/final-branded-fb.mp4
```

**Why no static outro concat anymore:** Old approach concatenated
`assets/outro.mp4` (chuối bodybuilder) at the end of every video.
Created a jarring brand cut — character mid-Act-3 dialogue → smash
cut to chuối ad. Replaced 2026-04-26 with **Act 4 contextual outro**
(see template below): the SAME character closes the video naturally
with a relaxed wave + follow CTA. 4 clips × 8s = 32s total.

Box coords `x=1770 y=3670 w=320 h=110` calibrated for 2160×3840
(4K 9:16) — valid for all flow-video-cli outputs (default resolution).

Finalization ~30s CPU.

Then update state + point video_url at the branded file:
```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -d '{
    "job":"<job>",
    "patch": {
      "state":"done",
      "video_url":"/picker-jobs/<id>/final-branded.mp4"
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

After rerender completes, **re-finalize** (same ffmpeg delogo + outro
concat command as stage 4d) so `final-branded.mp4` reflects the new
render. Server does NOT auto-archive the branded version — if user
re-revises, the archive step handles only raw `final.mp4`.

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
**quotes target 22-24 words per act** to fully use the audio budget.

- **TARGET range:** 22-24 Vietnamese words per act. Hard cap: 24.
- **MINIMUM:** 18 words per act. Below 18 = Veo has dead air → reads
  the dialogue at slow pace to fill 8s, feels sluggish (atisô v2 issue
  2026-04-30: 9-12 word dialogues sounded slow even with "nhanh gọn"
  hint). Veo's TTS expands to fill silence — pack content in.
- **Count the quoted words literally** during self-critique. If a draft
  has under 18 words, ADD content (extra fact, verb, callback) until ≥22.
- **If draft has 40+ words**, cut ruthlessly — drop 1-2 facts.
- **Speed hint in every prompt:** strongly recommend the rapid-fire
  cue (default below) — `nhanh gọn dứt khoát` alone is NOT strong
  enough; Veo defaults to slow conversational pace.
- **Default speed cue (use everywhere except Act 4 chill outro):**
  `"giọng nói rất nhanh tuôn ra liên tục không có khoảng nghỉ, tốc độ TikTok creator rapid-fire pace"`
  → Place near the end of prompt before background.
- **Structure preference:** short declarative sentences > run-on clauses.
  2 short quotes better than 1 long one.
- **Avoid rote filler phrases** — `"thôi bỏ qua"`, `"thực sự là"` —
  eats budget without content.
- **Tone shift only at Act 4** (outro) → `"giọng nói nhẹ nhàng tự nhiên"`
  signals video closing.
- Prior drafts that violated this rule (chuối v1, bơ v1) had 40-80 words
  per act — Veo dropped the middle clauses silently. Drafts under 18
  words (atisô v2) → felt sluggish despite "nhanh gọn" hint.
- **Empirical validation (atisô v3, 2026-04-30):** rebuilding atisô
  v2 with the SAME frames but 22-word dialogues + rapid-fire cue
  produced noticeably faster TikTok-pace speech. User confirmed
  "nhanh hơn rồi" → posted to FB. Rule confirmed working in
  production; treat as default for all new videos.

### Visual mechanism rules (CRITICAL — learned from chuối/gừng compare)

**Every act needs a visible mechanism.** Act 3 is the common failure mode:
it drifts to "smile + product showcase" static frame, losing retention at
the CTA moment. Each of the 3 acts must have ONE concrete physical action
visible:

- Act 1: pointing / gesturing / confrontation pose
- Act 2: product-use action (self-consume, flex, demo) — see two schools below
- Act 3: demo action (ngâm, đắp, pha, rót, bắn, bốc hơi) — NOT just smile

Observed: gừng Act 3 (ngâm chân chậu nước gừng + hơi nước bốc lên + nước
bắn) outperformed chuối Act 3 (static smile + nải chuối trên mâm). Motion
in final act holds attention through CTA.

**Two Act 2 "schools" (pick per subject):**

| School | Shows | Memorable via | Best for |
|---|---|---|---|
| **Product-use** | HOW to consume (uống ừng ực, tràn mép, đắp, chà) | Visceral detail | Gừng, chanh, nghệ, tỏi (có cách dùng cụ thể) |
| **Metaphor** | VIBE of benefit (nâng tạ = khoẻ, flex cơ bắp) | Comedic surprise | Chuối, bơ (benefit abstract: tim khoẻ, ngủ ngon) |

**Visceral detail > hoa mỹ adjective.** When writing action in prompt,
prefer concrete outcome verbs over abstract ones:

- ✅ "nước tràn ra khỏi mép ly chảy xuống cằm"
- ❌ "uống ngon miệng thưởng thức"
- ✅ "hơi nước bốc lên ấm áp, nước bắn tung toé"
- ❌ "khung cảnh thư giãn dễ chịu"
- ✅ "mồ hôi lấp lánh trên bắp tay"
- ❌ "dáng vẻ khoẻ mạnh đầy sức sống"

Concrete physics (flow, spill, splash, steam, drip, shine on sweat) gives
Veo specific things to render. Abstract mood words give it nothing.

**Unexpected prop in familiar setting** — comedic hook pattern: tạ trong
bếp quê, cối giã trong phòng gym, máy xay trong sân đình. Creates
juxtaposition humor + visual surprise + differentiation vs other food
videos using identical props.

### Action & physics library (pick-and-mix cheat sheet)

Compiled from bơ / chuối / gừng / dưa hấu successes. Purpose: avoid
repeating the same pose/action across back-to-back videos. Pick 1 from
each relevant table per video.

#### Physics garnishes (reusable across any act)

| Effect | Vietnamese prompt cue | Best for |
|---|---|---|
| **Splash** | `nước bắn tung toé lên không trung thành những giọt lấp lánh` | Cắt / đập / ném vào nước |
| **Drip** | `giọt nước chảy xuống cằm chảy xuống thân ngực cơ bắp` | Visceral eat/drink |
| **Steam** | `hơi nước bốc lên ấm áp` | Nóng, trà, súp, ngâm |
| **Overflow** | `tràn ra khỏi mép ly chảy xuống cằm` | Uống mạnh |
| **Sizzle** | `xèo xèo khói lẹp bẹp` | Áp chảo, đổ dầu nóng |
| **Sweat shine** | `mồ hôi lấp lánh trên bắp tay` | Flex / gym / heat |
| **Burst** | `nổ tung ra bụi [hạt/phấn]` | Đập / bẻ / mở mạnh |
| **Crack** | `vỏ nứt lộ ra bên trong` | Reveal moment |
| **Particle fall** | `các lát / cánh hoa / vụn rơi xuống mâm tre` | Cắt / xả / đập |
| **Shine travel** | `ánh sáng lướt qua bề mặt bóng ướt` | Glossy hero shot |

#### Act 1 (gắt / chê / confrontation) — pose variants

- **Tay chỉ thẳng camera** (baseline — mặc định an toàn)
- **Nắm đấm đập bàn** + đồ vật xung quanh rung lên
- **Bẻ gãy / đập vỡ đối thủ**: thanh protein bar, chai nước ngọt, bao bì snack
- **Ngón cái chỉ vào ngực** "tao đây" — Vietnamese swagger
- **Hai tay chống hông dạng chân** — intimidation stance
- **Giật lấy sản phẩm đối thủ ném xuống đất** — theatrical dismissal
- **Lean forward low-angle** — hero cam hướng lên, góc thấp kịch tính
- **Vung tay quát có trail nước** (comedic nếu subject mọng nước)

#### Act 2 — PRODUCT-USE school (visceral, khi subject có cách dùng cụ thể)

⚠️ **NEVER mix mouth action with dialogue in same clip.** Veo prioritizes
lip-sync and drops eating/drinking motion — observed on dưa hấu + xoài
where "cắn + nước tràn" was intended but never rendered (only dialogue
+ juice residue on chin showed). Use HAND-based actions if Act 2 has
dialogue. Save mouth actions for silent Act 3 ambient or outro clips.

**Self-process (hands only — SAFE with dialogue):**
- Vắt nước ra ly (chanh, cam, bưởi)
- Bổ nửa reveal inside (dưa hấu, bơ, trứng, sầu riêng)
- Peel vỏ (chuối, cam, tỏi, khoai)
- Bẻ đôi (củ, lá, thanh snack)

**Self-apply (beauty / skincare):**
- Chà sát lên da (chanh, dưa leo, bã cà phê)
- Đắp lên mặt (honey mask, nghệ, sữa chua)
- Thoa nước lên cánh tay (nước gừng, tinh dầu)

**Pour / serve:**
- Rót nước ép vào ly có đá + bắn giọt
- Đổ hạt ra chảo nóng + xèo xèo
- Khuấy trong nồi đất + hơi bốc + muỗng gỗ

#### Act 2 — METAPHOR school (abstract power, khi benefit trừu tượng)

**Weightlifting:**
- Nâng tạ dumbbell (đã dùng chuối) — gym vibe
- Deadlift barbell một tay — superhuman
- Push-up một tay + flex còn lại
- Squat với tạ ngang vai

**Combat:**
- Tung cú đấm bay đối thủ (villain takedown)
- Chém bằng kiếm / dao tre
- Đá bay chai nước ngọt qua frame
- Ném shuriken (hạt / miếng bay theo hướng)

**Flex variants:**
- Double biceps flex classic
- Back flex (lat spread)
- Chest pump + pound ngực
- "Most muscular" pose nghiến răng

**Destruction of competitor:**
- Bẻ gãy thanh protein bar trong tay, vụn rơi
- Đập vỡ chai nước ngọt lên đùi, bọt bắn
- Xé bao bì snack ném xuống đất

#### Act 3 — demo + CTA (MUST have motion — never static smile-only)

**Traditional Vietnamese prep:**
- Giã trong cối đá — bụi bay, tiếng "thịch thịch"
- Pha trà rót từ ấm cao — trà chảy thành dòng vàng
- Ngâm chân chậu nước (đã dùng gừng) — hơi bốc
- Khuấy trong nồi đất — hơi + muỗng gỗ
- Cắt trên thớt gỗ (đã dùng dưa hấu) — splash
- Xào chảo + nêm gia vị — nhúm muối / hành rơi vào

**Giving gesture:**
- Rót vào ly có người đưa tay nhận (partial hand only — safety)
- Đặt lên mâm tre + đẩy về camera
- Vỗ nhẹ vai character khác (ensemble shot)

**Transformation / reveal:**
- Bổ / cắt lộ ra inside cinematic
- Peel vỏ drop xuống slow-mo
- Slice thin → layers floating mid-air

**Ambient motion close:**
- Khăn vải bay nhẹ trong gió
- Hơi nước từ ly trà vươn lên frame
- Lửa bếp củi flicker + ánh sáng nhảy

#### Subject → action quick mapping

| Subject type | Best Act 2 | Best Act 3 |
|---|---|---|
| **Trái cây mọng nước** (dưa hấu, cam, bưởi, xoài) | Cắn + overflow splash | Cắt + nước bắn |
| **Củ / rễ** (gừng, tỏi, nghệ, riềng) | Giã / ép / xay + khói | Pha trà / ngâm chân |
| **Lá** (rau ngót, tía tô, trà, lá neem) | Cho vào nồi + khuấy | Rót trà + hơi bốc |
| **Hạt** (đậu, lạc, hạt sen, mè) | Đổ vào chảo + xào | Nêm vào bát đã nấu |
| **Thức uống** (mật ong, sữa, nước dừa) | Rót chậm / kéo tơ | Chấm bánh + drip |
| **Lá dày / nguyên quả** (bơ, chuối) | Bóc vỏ + reveal | Slice layer floating |
| **Gia vị** (tiêu, muối, ớt) | Rắc xuống chảo / món | Gõ nhẹ lọ + drift xuống |
| **Villain** (cholesterol, đường, gốc tự do) | Combat + destruction | Transformation (tan chảy / vỡ) |

#### Variety rule (chống nhàm chán giữa videos)

- Track the last 3 videos' Act 1 pose / Act 2 action / Act 3 demo
- For next video, pick an action NOT used in last 3 (if subject allows)
- If subject forces a repeat (trái mọng nước → luôn là splash), vary
  the garnish (overflow → burst → spray → drip trail)

### Per-arc templates

#### `arc-gat-khoe-thathu` — Complaint → Pride → Forgiveness

### Act 1 — VISUAL HOOK FIRST RULE (CRITICAL for TikTok retention)

**The first 1-2 seconds determine 80% of retention.** Don't open Act 1
with a static character monologuing. Open with a VISUAL STUNT —
something that stops the scroll — then deliver dialogue in seconds 2-7.

**3-beat structure for 8s clip:**

| Time | Beat | Description |
|---|---|---|
| 0-1.5s | **VISUAL STUNT** | Action moment that grabs attention before viewer hears anything |
| 1.5-7s | **DIALOGUE** | Character delivers the hook line |
| 7-8s | **CLOSE** | Pose-and-hold or transitional action into Act 2 |

**Visual stunt library** (pick 1 per video — rotate, never repeat
back-to-back):

| Stunt | Description | Best for |
|---|---|---|
| **Burst entry** | Character bùng vọt lên từ thớt/đĩa với khói/bụi tung toé | Củ rễ (gừng, tỏi, nghệ) |
| **Splash dive** | Nhảy lên từ ly nước/chậu, nước văng tung toé | Mọng nước (dưa hấu, cam) |
| **Pattern interrupt extreme close-up** | Mắt to xoe nhìn thẳng camera (raksha kiểu mắt anime), zoom out reveal character | Mọi subject |
| **Drop-in slam** | Character rơi xuống từ trên cao đập mạnh xuống thớt, nồi rung | Củ cứng (khoai lang, củ sắn) |
| **Self-cut reveal** | Character bổ nửa mình ra, lộ ruột | Bổ nửa subjects (đu đủ, dưa hấu) |
| **Explosion peel** | Vỏ tróc bùng ra như fireworks → character muscular lộ | Có lớp vỏ (cam, hành tây, tỏi) |
| **Mid-action freeze** | Character mid-flex frozen 0.5s rồi continue | Hero pose subjects |
| **POV camera punch** | Camera tăng tốc lao về phía character, dừng đúng lúc nói | Pain-point hooks |

**Speed/intensity hint for Act 1** (intensify from default
"nhanh gọn dứt khoát"):
- For shock hooks: `giọng nói gấp gáp đầy năng lượng quát to`
- For whisper hooks: `giọng thì thầm khàn khàn bí ẩn`
- For viral trending: `giọng hào hứng tăng dần`

**Template (visual stunt + dialogue):**
```
[VISUAL STUNT 0-1.5s] — vd: "Burst entry: [SUBJECT] cơ bắp bùng vọt lên từ thớt với bụi tung toé, lửa rim light bùng dramatic, mid-air pose mạnh mẽ"

→ Sau đó dialogue + setting:

[CHARACTER_FULL_DESC], [VISUAL_STUNT_DESC], mặt mày bực bội đang gắt '[HOOK_OPENER], [3 FACTS]', tay chỉ thẳng camera quyết liệt, [SETTING_TEXT], ánh sáng warm rim light dramatic, [TREATMENT_TAGS], chi tiết cao, không hoạt hình phẳng
```

**Old Act 1 template (legacy — for reference, prefer visual-first):**
```
[CHARACTER_FULL_DESC], mặt mày bực bội đang gắt '[CONFRONTATIONAL_HOOK], tao là [SUBJECT] đây, tao có [FACT_1], [FACT_2], [FACT_3], mà bọn mày toàn đi ăn [IMPORTED_ALT_1] hay [IMPORTED_ALT_2] đắt tiền, quên tao', tay chỉ thẳng vào camera, miệng mở to quát tháo, [SETTING_TEXT], [TREATMENT_SOFT_TAGS], tông màu trung tính không chói
```

### 3-second rule (full video)

Every 3 seconds across the whole video should have a NEW visual surprise
to maintain attention. With 4 acts × 8s = 32s total, that's ~10 visual
moments minimum:
- Act 1: stunt entry, dialogue gesture, close pose
- Act 2: hand mechanism reveal, product transformation, flex
- Act 3: dive/demo action, splash, settle pose
- Act 4: chill into pose, smile, wave goodbye

Avoid static talking-head shots beyond 3s. Always be doing something.

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

**Act 4 (contextual outro — OPTIONAL, see "3-scene vs 4-scene"
below):** relaxed close with follow CTA. Same character, NEW POSE:
ngồi tựa thoải mái cạnh sản phẩm/món ăn hoàn thiện. Speed hint changes
to `giọng nói nhẹ nhàng tự nhiên` (tone shift signals "end of
video"). Lighting `warm ấm áp dịu` not the dramatic rim light.

Template:
```
[CHARACTER_FULL_DESC], ngồi tựa thoải mái cạnh [FINISHED_PRODUCT/MÓN_ĂN] đang bốc hơi nhẹ, mỉm cười hài lòng nhìn thẳng camera, một tay vẫy chào nhẹ nhàng thân thiện, ánh sáng warm ấm áp chiều vàng dịu, miệng nói '[CTA_DIALOGUE]', giọng nói nhẹ nhàng tự nhiên, [SETTING_TEXT] mờ bokeh, phong cách 3D render photorealistic muscular food character commercial, chi tiết cao, không hoạt hình phẳng
```

### 3-scene vs 4-scene structure (CRITICAL — 2026-04-30)

**Default: 3 scenes (~24s).** Drop Act 4. Merge a brief follow CTA into
the END of Act 3's dialogue. User feedback (cần tây v3): "không cần
scene 4 nữa để thoại nhanh hơn". Tighter pacing, 1 fewer Veo credit.

3-scene Act 3 dialogue pattern: action benefits + brief CTA at end.
Example (cần tây): `'tối 1 bát canh cần tây hầm xương, sáng 1 ly nước
ép xanh, huyết áp ổn hết đau, nhớ follow kênh nha'` (23 words). Keep
22-24 word target. Speed cue stays rapid-fire.

**Use 4 scenes ONLY when:**
- Act 3 dialogue would need to be >24 words to include both benefits +
  CTA (i.e. complex subject with many use instructions).
- Subject has a strong "settling" moment that benefits from a chill
  outro shot (heritage / nostalgia subjects).
- Video pacing feels rushed without a closer.

**CTA dialogue rotation (MUST rotate across batch — don't reuse same
line for back-to-back videos):**

For 3-scene (brief, append to Act 3):
- `nhớ follow kênh nha` (~4 words)
- `follow để xem tiếp nha` (~5 words)
- `nhớ follow Xóm Khoẻ Mạnh nha` (~6 words)
- `follow tao để khoẻ mỗi ngày` (~6 words)

For 4-scene (Act 4 chill, 8-12 words, MUST include "follow"):
- `follow Xóm Khoẻ Mạnh nha, mai tao kể tiếp` (~9 words)
- `nhớ follow để xem tao mỗi ngày, sống khoẻ nha` (~10 words)
- `tạm biệt nha, follow kênh để khoẻ đẹp mỗi ngày` (~10 words)
- `follow nhé, hẹn mày video mới mai, sống vui khoẻ` (~10 words)

**CTA rotation discipline:** track which CTA was used per recently-
posted video. If 3 most recent posts used CTA-1, the next must be
CTA-2/3/4 — never repeat 3× in a row. User feedback (cần tây review):
"câu CTA bị lặp lại giữa các video, có cách nào đổi mới được ko?"

**Why Act 4 was originally added (2026-04-26)**: chuối static outro
felt jarring. Same-character Act 4 fixed jarring transition. With
3-scene structure (CTA in Act 3), the same continuity is preserved
because there's no smash cut at all — just one dialogue ending with
the follow line.

Hook style library for Act 1 (pick 1 per video, rotate across batch so
back-to-back videos don't repeat style). Pattern user feedback on
dưa hấu: **don't overuse "chê đồ ngoại"** — some imports serve real
purposes, always-bashing reads as formulaic. Max ~1-in-10 videos
should attack competitors directly. Prefer hooks that stand on their
own merits:

| # | Style | Template opener | When to use |
|---|---|---|---|
| 1 | **Nostalgia pride** | `ê mày có nhớ hồi bé bà cho tao ăn không, giờ mày quên tao rồi à` | Heritage subjects (lá tía tô, nghệ, quế) |
| 2 | **Contrarian challenge** | `mày cứ bảo tao quê mùa rẻ tiền, nhìn cho kỹ đây` | Underrated subjects (đậu đen, rau má) |
| 3 | **Pain-point diagnose** | `ê mày đang bị X/Y/Z đúng không, có biết tại sao không` | Symptom-specific (sắn dây → nhậu, nghệ → dạ dày) |
| 4 | **Stats shock** | `1 miếng tao bằng 3 ly [X] đấy biết không` | Nutrient-dense (tỏi allicin, đậu đen protein) |
| 5 | **Curiosity tease** | `đố mày biết cái gì vừa [A] vừa [B] vừa [C]` | Multi-benefit subjects (hạt sen, xoài) |
| 6 | **Bi hài underdog** | `buồn quá cả tháng không ai hỏi đến tao` | Less-hyped foods (rau má, sắn dây) |
| 7 | **Coach authority** | `nghe tao nói rõ nha, mỗi ngày phải 1 [X]` | Imperative — tập (rau má → da) |
| 8 | **Family secret** | `bí mật của bà nội tao để lại 3 đời khoẻ đẹp là đây` | Traditional recipes (nghệ mật ong, tía tô) |
| 9 | **Viral trending** | `cả tiktok đang sốt về tao mà mày chưa biết à` | Trendy angles (seed oil alternatives) |
| 10 | **Regional pride** | `từ Hà Giang đến Cà Mau, ai ở quê mà không biết tao` | Vietnamese-ubiquitous (đậu đen, chanh) |
| 11 | **Insider whisper** | `nghe tao thì thầm này, uống 1 tuần là khác hoàn toàn` | Intimate benefits (skincare, sleep) |
| 12 | **Wake-up slap** | `dậy đi mày! bao năm bỏ bê cơ thể, giờ tao đây` | Energy / metabolism subjects |
| 13 | **Legacy 100 năm** | `ông bà cố của mày đã dùng tao cả trăm năm trước khi có thuốc tây` | Medicinal foods (tía tô, nghệ, sắn dây) |
| 14 | **Socratic chain** | `mày có biết sao dân Nhật sống thọ không? vì họ ăn tao` | International authority flex |
| 15 | **Seasonal tie-in** | `trời nóng điên rồi, không ăn tao thì định sao` | Weather-tied (rau má → summer, quế → winter) |
| 16 | **Formal intro** | `xin tự giới thiệu, tao là X đây, nghề tay trái là siêu thực phẩm` | Comedic formality |
| ⚠️ | **Chê đồ ngoại** (legacy — use sparingly) | `bọn mày toàn ăn [IMPORTED_Y], quên tao à` | Max 1-in-10 — don't lean on this |

**Rotation rule:** track last 3 videos' hook style. Don't pick same
style within 3-video window. If subject fits multiple styles, pick one
that's been longest-unused in the catalog.

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

The preview server (`scripts/dev-preview-server.js`) serves multiple static
roots:

```js
app.use('/picker-jobs', express.static('tmp/picker-jobs'));   // job artifacts
app.use('/chars',       express.static('tmp/chars'));         // char gallery
app.use('/dev-preview', express.static('tmp/dev-preview'));   // ad-hoc previews
```

Plus `chars-gallery.html` for browsable thumbnail grid (see Chars Gallery
section above). Verify all routes before first fire.

## Auto-batch mode (multiple videos, no human review)

Triggered when user asks for batch production: "làm 10 video về X/Y/Z…"
or "tự làm 10 loại quả theo format gừng". Skips all interactive review
stages — skill commits to one creative direction per video.

### Shortcuts vs interactive flow

| Stage | Interactive | Auto-batch |
|---|---|---|
| Grid pick | User picks 5 axes on picker | Skill writes grid to state.json directly (use Viral Food Hero preset) |
| Char prompts review | User reviews/edits 4 prompts | Skip — write 1 prompt for target angle only |
| Char gen | 4 images parallel | **1 image only** — the angle planned as video seed. Saves ~3 credits/video |
| Char pick | User picks 1 of 4 | Skip — set `char_index=0` directly (only char-1 exists) |
| Prompts review | User reviews/edits 3 acts | Skip — skill's self-critique catches obvious issues |
| Video render | User approves → fire | Auto-fire after prompts written |
| Finalize | Automatic | Automatic (same delogo + outro concat) |

### Grid direct-write

`/api/picker-submit-grid` rejects non-init states and `/api/picker-update`
has an allow-list that excludes `grid`. So in auto-batch the skill
writes state.json directly:

```python
import json
path = f"tmp/picker-jobs/{job}/state.json"
with open(path) as f: s = json.load(f)
s["grid"] = {
    "setting": "setting-quay-bep-go",        # or setting-bep-que
    "treatment": "treatment-bodybuilder-3d",
    "protagonist": "protagonist-food-hero",
    "arc": "arc-gat-khoe-thathu",
    "sound": "dialogue"
}
with open(path, "w") as f: json.dump(s, f, indent=2, ensure_ascii=False)
```

### Single char gen (the angle that will actually be used)

Write ONE char prompt matching the video's target start-frame angle.
For gừng-format (wide ensemble), use Variant 4 template. Skip
`character_prompts_review` stage entirely — go `grid_done` →
`char_gen` → `char_picked` (with `char_index=0` since only char-1.png
exists).

### Action rotation across batch

To avoid visual monotony across the batch, track which Act 2 + Act 3
actions have been used and rotate through the action library. Example
rotation for 10 food videos:

| # | Subject | Act 2 action | Act 3 mechanism |
|---|---|---|---|
| 1 | Xoài | Cắn dở + chấm muối tôm + nước vàng tràn | Pha sinh tố máy xay + rót ly |
| 2 | Tỏi | Bẻ tép + peel lớp vỏ mỏng rơi xuống | Giã cối đá + bụi bay |
| 3 | Nghệ | Khuấy bột nghệ + mật ong vàng xoáy | Rót nước nghệ mật ong vào ly |
| 4 | Chanh | Vắt nước vào ly có đá | Chà chanh lên da + ánh sáng lướt |
| 5 | Tía tô | Vò lá + nhựa xanh lộ ra | Thả lá vào nồi nước sôi + bốc hơi |
| 6 | Hạt sen | Đổ nắm sen vào chén cháo + rắc | Khuấy chè + hạt sen nổi |
| 7 | Rau má | Vò lá vào máy xay | Rót nước xanh vào ly + bắn giọt |
| 8 | Đậu đen | Đổ đậu vào chảo rang + tiếng xèo | Khuấy chè đậu đen + hơi bốc |
| 9 | Sắn dây | Pha bột với nước + sủi bọt | Rót bột sắn vào ly có đá + trong suốt |
| 10 | Quế | Gõ thanh quế vào ly trà + thơm | Rắc quế bột lên trà + xoáy lên |

If a subject doesn't fit bodybuilder-3D morphology (e.g., tiny seeds),
render as "a handful / đống / nắm" where the group has muscle arms,
not individual tiny unit.

### Batch driver loop

Pseudocode for the orchestrator side:

```python
for subject in subjects_list:
    job_id = picker_init(subject)
    write_grid_direct(job_id, PRESET_GRID)
    char_prompt = render_char_prompt_v4_template(subject)
    fire_char_gen_single(job_id, char_prompt)  # wait for char-1.png
    act1, act2, act3 = render_video_prompts(subject, action_rotation)
    update_state(job_id, video_prompts=[act1,act2,act3], state="video_gen")
    fire_video_render(job_id)  # blocks ~11min
    finalize_delogo_outro(job_id)
    update_state(job_id, state="done", video_url=f"/picker-jobs/{job_id}/final-branded.mp4")
    # Gallery endpoint auto-picks up new final-branded.mp4 — no manual step
```

### Cost + time per batch of 10

- Credits: ~30-40 (1 char × 10 + 3 Veo clips × 10 = 40 max)
- Time: ~4 hours sequential (daemon single-worker)
- User interaction: 1 approval of subject list, then 0 until done

### When batch fails

- **Content filter reject**: soften aggressive language, retry same act
- **Veo selector timeout**: kill daemon + clear profile lock, retry
- **Subject unsuitable**: if char gen returns malformed shape (e.g.,
  tiny seed not muscular), update char prompt to "a pile of X with
  muscle arms holding fists up" and re-gen. Skip if still bad after
  2 tries — move to next subject.
- **Stop on 2 consecutive failures**: don't burn credits on broken pipeline

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
