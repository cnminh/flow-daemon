#!/usr/bin/env node
// One-time batch-gen reference library for make-viral-health-video-vi skill.
//
// Produces ~26 PNGs in tmp/skill-refs/, covering 4 axes of the framework:
//   - Setting (8):      where scene happens
//   - Treatment (10):   cinematic style
//   - Protagonist (4):  who is the character (food/organ/condition/villain)
//   - Arc (4):          dominant emotional beat of each narrative arc
//
// Writes tmp/skill-refs/manifest.json so the picker UI can discover + label
// them without hardcoding paths. Each entry has: id, category, label, image,
// tailscale_url.
//
// Run once. Costs ~26 Flow image credits. Idempotent — skips files that
// already exist unless --force.
//
// Usage:
//   node scripts/gen-skill-refs.js           # gen missing only
//   node scripts/gen-skill-refs.js --force   # regen everything

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const FORCE = process.argv.includes('--force');

// Output under tmp/dev-preview/ so the existing dev-preview-server.js
// (which serves tmp/dev-preview/) exposes these at
// https://mac-mini.tailf56d7b.ts.net:47399/skill-refs/<file>.png
const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'dev-preview', 'skill-refs');
fs.mkdirSync(OUT_DIR, { recursive: true });

const TAILSCALE_BASE = 'https://mac-mini.tailf56d7b.ts.net:47399';

// ─────────────────────────────────────────────────────────────────────────
// Ref definitions — id, label (VN, short for picker), prompt.
// Subjects:
//   - Setting refs: use quả chanh (lemon) as universal subject
//   - Treatment refs: use chanh in implied context per treatment
//   - Protagonist refs: vary subject to match archetype
//   - Arc refs: use personified chanh bổ đôi (beat 3 moment usually)
// ─────────────────────────────────────────────────────────────────────────

const REFS = [
  // ── Setting (8) ─────────────────────────────────────────────────────
  {
    id: 'setting-cho-que',
    category: 'setting',
    label: 'Chợ quê',
    prompt: `Cận cảnh khay chanh tươi vàng xanh nằm trên mẹt tre trong sạp chợ quê Việt Nam, vài quả chanh đổ ra, bảng giá viết tay 'CHANH TƯƠI 40K/KG' trên bìa cáctông đặt trên lá chuối, chữ Quốc Ngữ tiếng Việt có dấu không dùng tiếng Anh, background chợ quê buổi sớm với nhiều sạp trái cây, thùng xốp, rổ tre, người bán đội nón lá ở phía sau mờ bokeh, ánh sáng tự nhiên sớm dưới mái bạt xanh, phong cách street photography tài liệu chân thực, chi tiết cao, không hoạt hình`,
  },
  {
    id: 'setting-bep-que',
    category: 'setting',
    label: 'Bếp quê',
    prompt: `Cận cảnh vài quả chanh tươi vàng xanh đặt trong rổ tre trên nền bếp quê truyền thống Việt Nam, bếp củi nồi đất đất nung phía sau, mái lá dừa tre nứa, tường đất nâu, chậu sành, dụng cụ gốm sứ, ánh sáng chiều ấm xuyên qua khe cửa gỗ, phong cách documentary chân thực, chi tiết cao, tông nâu ấm, không hoạt hình`,
  },
  {
    id: 'setting-quay-bep-go',
    category: 'setting',
    label: 'Quầy bếp gỗ',
    prompt: `Cận cảnh vài quả chanh tươi vàng xanh trên thớt gỗ sồi cùng con dao thép, background quầy bếp gỗ hiện đại với kệ gia vị, thìa đồng, khăn vải lanh, ánh sáng tự nhiên dịu qua cửa sổ lớn, tông màu trung tính sáng, phong cách food photography tài liệu chân thực, chi tiết cao, không hoạt hình`,
  },
  {
    id: 'setting-bep-voi-nuoc',
    category: 'setting',
    label: 'Bếp vòi nước inox',
    prompt: `Cận cảnh vài quả chanh tươi vàng xanh nằm trong bát đá cạnh vòi nước inox sáng bóng, giọt nước đang chảy xuống, bàn đá granite đen, background bếp hiện đại với gạch ốp tường trắng, ánh sáng tự nhiên dịu qua cửa sổ, phong cách food photography tài liệu chân thực, chi tiết cao, không hoạt hình`,
  },
  {
    id: 'setting-vuon-cay',
    category: 'setting',
    label: 'Vườn cây',
    prompt: `Cận cảnh cành cây chanh nặng trĩu quả chanh tươi vàng xanh còn dính giọt sương, lá xanh non bóng, background là vườn cây ăn quả vùng quê Việt Nam với nhiều cây xanh, đất đỏ bazan, ánh sáng nắng sớm xuyên qua tán lá, phong cách nature documentary chân thực, chi tiết cao, tông xanh vàng dịu, không hoạt hình`,
  },
  {
    id: 'setting-ban-an-gia-dinh',
    category: 'setting',
    label: 'Bàn ăn gia đình',
    prompt: `Cận cảnh bát chanh tươi vàng xanh đặt trên bàn ăn gỗ gia đình Việt Nam, khăn vải trang trí hoa văn cổ truyền bên cạnh, vài đũa tre, bát sứ hoa văn xanh, background là phòng ăn ấm cúng với đèn chùm gỗ, ánh sáng ấm chiều vàng, phong cách home photography tài liệu chân thực, chi tiết cao, không hoạt hình`,
  },
  {
    id: 'setting-co-quan-co-the',
    category: 'setting',
    label: 'Nội tạng cơ thể',
    prompt: `Quả chanh tươi vàng xanh lơ lửng bên trong khoang bụng cơ thể người, xung quanh là lá gan 3D màu nâu đỏ texture mịn nhẹ có chiều sâu, quả thận, dạ dày, ruột, các mạch máu đỏ thẫm bám quanh bề mặt bóng nhẹ, ánh sáng nội soi y tế mềm ấm, phong cách Pixar-style 3D medical illustration semi-realistic, textures chi tiết nhưng hình thái hơi simplified friendly, vẫn giữ chút hoạt hình nhẹ nhàng không gây ghê, không quá photorealistic, không quá phẳng infographic, kiểu modern health app visualization, chi tiết cao`,
  },
  {
    id: 'setting-dam-lay-mekong',
    category: 'setting',
    label: 'Miền Tây sông nước',
    prompt: `Cận cảnh vài quả chanh tươi vàng xanh đặt trong lòng thuyền gỗ nổi trên mặt nước đồng bằng sông Cửu Long, lá dừa nước xanh bao quanh, bèo tây nổi trên mặt nước, background là cảnh miền Tây với hàng dừa xa xa, ánh sáng hoàng hôn vàng cam, phong cách nature documentary chân thực, chi tiết cao, không hoạt hình`,
  },

  // ── Treatment (10) ──────────────────────────────────────────────────
  {
    id: 'treatment-documentary-realism',
    category: 'treatment',
    label: 'Documentary realism',
    prompt: `Cận cảnh quả chanh tươi vàng xanh bổ đôi lộ thịt vàng mọng cùng hạt trắng, đặt trên thớt gỗ sần, ánh sáng tự nhiên dịu, phong cách street photography food documentary chân thực, chi tiết cao, tông màu trung tính, không hoạt hình`,
  },
  {
    id: 'treatment-monologue-closeup',
    category: 'treatment',
    label: 'Chân dung cận cảnh',
    prompt: `Cận cảnh chính diện quả chanh tươi vàng xanh bổ đôi có vẽ mặt biểu cảm bực bội trên phần thịt, đang nhìn thẳng camera, background bếp mờ bokeh đơn giản, ánh sáng portrait soft key light, phong cách portrait photography chân thực, chi tiết cao, không hoạt hình`,
  },
  {
    id: 'treatment-kdrama-romance',
    category: 'treatment',
    label: 'K-drama lãng mạn',
    prompt: `Cận cảnh quả chanh tươi vàng xanh đặt trên bàn gỗ cạnh cửa sổ, ánh sáng hoàng hôn vàng cam xuyên qua tán cây mờ ảo, một giọt nước mắt long lanh trên vỏ chanh, soft focus, bokeh ánh sáng rực rỡ, phong cách K-drama cinematography romance, tông ấm pastel nostalgic, chi tiết cao, không hoạt hình`,
  },
  {
    id: 'treatment-anime-battle',
    category: 'treatment',
    label: 'Anime cooking battle',
    prompt: `Quả chanh tươi vàng xanh trong tư thế bật nảy mạnh mẽ trên không trung, xung quanh là speed lines trắng tỏa ra, sparkle và lens flare vàng rực rỡ bùng nổ, background bếp mờ dynamic, phong cách anime cooking battle shounen với dramatic zoom, saturated colors, chi tiết cao, cinematic framing`,
  },
  {
    id: 'treatment-noir-film',
    category: 'treatment',
    label: 'Noir đen trắng',
    prompt: `Cận cảnh quả chanh tươi bổ đôi trên thớt gỗ ẩn trong bóng tối sâu, một tia sáng blinds cắt ngang tạo shadow stripe trên quả chanh, khói thuốc lá mờ phía sau, background mờ trong bóng đen, đen trắng high contrast, phong cách film noir detective movie 1950s, chi tiết cao, grain film vintage`,
  },
  {
    id: 'treatment-horror-villain',
    category: 'treatment',
    label: 'Horror / phản diện',
    prompt: `Cận cảnh quả chanh tươi xanh lấm tấm mốc xanh đen trên bề mặt, đặt trên bề mặt đen bóng dưới ánh sáng đỏ sâu low-key, sương mù nhẹ bay lơ lửng, góc máy Dutch angle hơi nghiêng, background đen đặc, phong cách horror thriller cinematography, tông đỏ tối ám, chi tiết cao, không hoạt hình`,
  },
  {
    id: 'treatment-tiktok-native',
    category: 'treatment',
    label: 'TikTok native',
    prompt: `Cận cảnh quả chanh tươi vàng xanh bổ đôi ở giữa khung hình dọc 9:16, đủ chỗ cho text trên dưới, có caption tiếng Việt chạy dưới 'CHANH BỔ TIM NHƯ THẾ NÀO?' và emoji sparkle quanh, chữ Quốc Ngữ tiếng Việt có dấu không dùng tiếng Anh, UI giao diện TikTok giả lập bên phải với like button và speaker icon, ánh sáng flash phone camera bright saturated, phong cách native TikTok mobile video aesthetic, chi tiết cao`,
  },
  {
    id: 'treatment-macro-asmr',
    category: 'treatment',
    label: 'Macro ASMR',
    prompt: `Cực cận cảnh macro quả chanh tươi bổ đôi, một giọt nước chanh đang rơi xuống mặt thớt trong slow motion, textures thịt chanh mọng nước chi tiết cực cao, hạt chanh trắng lộ rõ, sóng dầu chanh tỏa ra, ánh sáng raking side light làm nổi texture, phong cách macro food porn ASMR commercial, chi tiết siêu cao, DoF cực nông`,
  },
  {
    id: 'treatment-medical-animation',
    category: 'treatment',
    label: 'Medical animation',
    prompt: `Mô hình quả chanh 3D nhẵn bóng bán trong suốt rendered style scientific illustration, bên cạnh là các mũi tên trỏ và label tiếng Việt 'Vitamin C', 'Chất chống oxy hoá', chữ Quốc Ngữ tiếng Việt có dấu không dùng tiếng Anh, background trắng sạch gradient xanh nhạt, ánh sáng studio đều, phong cách medical animation pharma commercial 3D render, chi tiết cao, minimal aesthetic`,
  },
  {
    id: 'treatment-cinematic-hero',
    category: 'treatment',
    label: 'Cinematic anh hùng',
    prompt: `Cận cảnh quả chanh tươi vàng xanh đặt đứng trên bệ đá, góc máy low angle nhìn lên, ánh sáng rim light backlight mạnh tỏa hào quang quanh quả chanh, tia sáng lens flare vàng ấm, khói mờ bay dưới chân, background mờ tối, phong cách epic cinematic hero shot blockbuster movie, chi tiết cao, dramatic mood`,
  },

  // ── Protagonist (4) ─────────────────────────────────────────────────
  {
    id: 'protagonist-food-hero',
    category: 'protagonist',
    label: 'Thực phẩm anh hùng',
    prompt: `Quả cam tươi đang đứng hào hùng với khăn choàng đỏ bay như siêu nhân, pose tay chỉ thẳng, ánh sáng backlight tạo hào quang xung quanh, background chân trời hoàng hôn với tia sáng rực rỡ, phong cách superhero comic cinematic chân thực, chi tiết cao`,
  },
  {
    id: 'protagonist-organ-patient',
    category: 'protagonist',
    label: 'Nội tạng được cứu',
    prompt: `Mô hình lá gan 3D bán trong suốt đang có vẻ mệt mỏi xanh xao, đường nét chi tiết mạch máu, một quả chanh sáng rực đang được đưa đến gần lá gan phát ánh sáng vàng chữa lành, background gradient đen sinh học, phong cách medical illustration 3D realistic, chi tiết cao, tông màu dần từ xanh xám sang vàng hồi phục`,
  },
  {
    id: 'protagonist-condition-ghost',
    category: 'protagonist',
    label: 'Tình trạng như bóng ma',
    prompt: `Một đám mây đen ma quái hình dạng quỷ đang vờn quanh đầu một bóng người lờ mờ, đại diện cho sự căng thẳng stress, xung quanh có tia sét nhỏ, background ngôi nhà tối với đèn bàn, phong cách horror illustration Vietnamese folk style, chi tiết cao, tông đen tím lạnh`,
  },
  {
    id: 'protagonist-villain-takedown',
    category: 'protagonist',
    label: 'Kẻ xấu bị tiêu diệt',
    prompt: `Một cục mỡ cholesterol màu vàng nhờn hình quái vật có mắt đỏ đang co rúm sợ hãi, một quả tỏi hùng dũng đang giơ kiếm ánh sáng chém xuống, background bên trong mạch máu đỏ với ánh sáng neon trắng, phong cách battle animation medical comic, chi tiết cao, dramatic lighting`,
  },

  // ── Arc (4) ─────────────────────────────────────────────────────────
  {
    id: 'arc-gat-khoe-thathu',
    category: 'arc',
    label: 'Gắt → khoe → tha thứ',
    prompt: `Cận cảnh quả chanh tươi bổ đôi có vẽ mặt cười hiền hậu tha thứ, hai mép vỏ vén lên dang rộng như vòng tay chào đón, background bếp quê ấm cúng với ánh sáng vàng mềm, phong cách character portrait cinematic, chi tiết cao, tông màu ấm áp welcoming`,
  },
  {
    id: 'arc-yeu-sieu-swagger',
    category: 'arc',
    label: 'Yếu → siêu năng lực → swagger',
    prompt: `Quả chanh tươi bổ đôi có vẽ mặt ngạo nghễ tự tin, pose đứng thẳng hiên ngang, một chiếc khăn choàng bay nhẹ, ánh sáng rim light tạo hào quang xung quanh, nhiều tia sparkle vàng bùng nổ, background bếp mờ bokeh hào nhoáng, phong cách cinematic transformation reveal, chi tiết cao, saturated colors triumphant`,
  },
  {
    id: 'arc-bian-reveal',
    category: 'arc',
    label: 'Bí ẩn → tiết lộ → celebrate',
    prompt: `Quả chanh tươi bổ đôi hé lộ dần từ trong bóng tối sâu, một tia sáng từ trên chiếu xuống chỉ một phần, phần còn lại vẫn ẩn trong shadow, khói mờ bao quanh, background đen sâu, phong cách cinematic mystery reveal, chi tiết cao, dramatic chiaroscuro lighting, tông vàng trên nền đen`,
  },
  {
    id: 'arc-before-after-after',
    category: 'arc',
    label: 'Trước → sau → sau nữa',
    prompt: `Split-screen diptych: bên trái quả chanh héo úa màu nâu trên bàn bụi bặm với caption 'NGÀY 1', bên phải quả chanh tươi mọng vàng xanh rực rỡ trên thớt sạch với caption 'NGÀY 30', chữ Quốc Ngữ tiếng Việt có dấu không dùng tiếng Anh, giữa là mũi tên chuyển động vàng, phong cách before-after commercial infographic chân thực, chi tiết cao, split composition`,
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Gen one image via flow-cli. Returns Promise<path>.
// ─────────────────────────────────────────────────────────────────────────
function genOne(ref) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(OUT_DIR, `${ref.id}.png`);
    if (!FORCE && fs.existsSync(outPath)) {
      console.log(`  ✓ ${ref.id} already exists — skipping (use --force to regen)`);
      return resolve(outPath);
    }
    console.log(`  → ${ref.id} [${ref.category}]`);
    const child = execFile(
      'flow-cli',
      ['generate', ref.prompt, '--output', outPath, '--quiet'],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          console.error(`  ✗ ${ref.id} FAILED: ${err.message}`);
          if (stderr) console.error(`    stderr: ${stderr.slice(0, 300)}`);
          return reject(err);
        }
        console.log(`    ✓ saved ${path.basename(outPath)}`);
        resolve(outPath);
      }
    );
    child.on('error', reject);
  });
}

async function main() {
  console.log(`[gen-refs] ${REFS.length} refs total, output → ${OUT_DIR}`);
  console.log(`[gen-refs] ${FORCE ? 'FORCE regen all' : 'skipping existing (use --force to regen)'}`);

  const results = { ok: 0, skipped: 0, failed: 0 };
  const manifest = { generated_at: new Date().toISOString(), refs: [] };

  for (const ref of REFS) {
    try {
      const outPath = await genOne(ref);
      const filename = path.basename(outPath);
      manifest.refs.push({
        id: ref.id,
        category: ref.category,
        label: ref.label,
        image: filename,
        tailscale_url: `${TAILSCALE_BASE}/skill-refs/${filename}`,
        prompt: ref.prompt,
      });
      if (fs.existsSync(outPath) && !FORCE) results.skipped += 1;
      else results.ok += 1;
    } catch (e) {
      results.failed += 1;
      manifest.refs.push({ id: ref.id, category: ref.category, label: ref.label, error: e.message });
    }
  }

  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n[gen-refs] manifest written → ${manifestPath}`);
  console.log(`[gen-refs] results: ${results.ok} gen'd, ${results.skipped} skipped, ${results.failed} failed`);
}

main().catch((e) => {
  console.error(`[gen-refs] fatal: ${e.message}`);
  process.exit(1);
});
