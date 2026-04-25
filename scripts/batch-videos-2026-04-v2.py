#!/usr/bin/env python3
"""Batch v2: 19 videos — hero (dive-into-dish) + doc (educational) + bà ngoại.
Skips tỏi hero, dưa hấu (done), hạt chia (both)."""
import json, subprocess, os, shutil, time, urllib.request, sys

REPO = "/Users/cuongnguyen/projects/flow-daemon"
CHARS_STYLE = f"{REPO}/tmp/dev-preview/style-test"
CHARS_CONCEPT = f"{REPO}/tmp/dev-preview/concept-test"
JOBS_DIR = f"{REPO}/tmp/picker-jobs"
OUTRO = f"{REPO}/assets/outro.mp4"
PREVIEW_API = "http://127.0.0.1:47399"

GRID = {"setting":"setting-quay-bep-go","treatment":"treatment-bodybuilder-3d","protagonist":"protagonist-food-hero","arc":"arc-gat-khoe-thathu","sound":"dialogue"}
SPEED = ", giọng nói nhanh gọn dứt khoát"

HERO_TAIL = ", background quầy bếp gỗ hiện đại mờ bokeh với thớt gỗ sồi con dao thép gia vị, ánh sáng warm rim light dramatic chiều vàng, phong cách 3D render photorealistic muscular food character commercial, chi tiết cao, không hoạt hình phẳng"
DOC_TAIL = ", background bếp Việt hiện đại với bếp gas tủ lạnh bảng biểu đồ dinh dưỡng treo tường mờ bokeh, ánh sáng warm natural bếp sáng, phong cách 3D render photorealistic nutrition doctor food character commercial, chi tiết cao, không hoạt hình phẳng"
BN_TAIL = ", background bếp quê Việt truyền thống với bếp củi đang cháy nồi đất mái lá mờ bokeh, ánh sáng warm rim light chiều vàng từ cửa sổ, phong cách 3D render photorealistic grandma food character commercial, chi tiết cao, không hoạt hình phẳng"

# Character signatures (kept consistent across 3 acts per video for Veo continuity)
HERO = {
    "khoai-lang": "Củ khoai lang 3D photorealistic tím đậm hình trụ dài cơ bắp muscular, thân củ dày TẠO body, bắp tay bắp chân cơ bắp săn chắc mọc ra 2 bên, vỏ tím đen bóng ướt, ruột vàng cam lộ ở vết cắt",
    "mong-toi": "Một bó lá mồng tơi 3D photorealistic xanh đậm dày bóng cơ bắp muscular, các cụm lá tim dày mọng nước NHƯ bắp tay bắp chân, cuống xanh bóng",
    "dau-xanh": "Một hạt đậu xanh 3D photorealistic xanh non khổng lồ hình bầu dục cơ bắp muscular, 2 bên hạt phình NHƯ bắp tay bắp chân, mắt hạt trắng nổi bên cạnh",
    "nuoc-dua": "Một trái dừa xiêm 3D photorealistic vỏ xanh tươi tròn lớn cơ bắp muscular, phần nắp đã chặt lộ xơ trắng, 2 bên trái dừa phình NHƯ bắp tay bắp chân",
    "du-du": "Nửa quả đu đủ 3D photorealistic vàng cam bổ nửa cơ bắp muscular, thịt 2 bên TẠO bắp tay bắp chân, ruột cam với hạt đen xoắn ốc lộ ở giữa",
    "oi": "Quả ổi 3D photorealistic tròn xanh non cơ bắp muscular, 2 bên quả phình NHƯ bắp tay bắp chân, vỏ sần nhẹ bóng ướt pha ánh hồng",
    "ca-rot": "Củ cà rốt 3D photorealistic cam tươi hình nón dài cơ bắp muscular, thân củ dày TẠO body, bắp tay bắp chân mọc ra 2 bên, lá xanh tươi ở đỉnh như tóc",
    "rau-muong": "Một bó rau muống 3D photorealistic xanh non dày cơ bắp muscular, các cọng lá bó chặt TẠO thân hình, bắp tay bắp chân từ cụm lá",
}

DOC = {
    "khoai-lang": "Củ khoai lang 3D photorealistic tím đậm hình trụ dài nhân cách hoá thành bác sĩ dinh dưỡng, khoác áo blouse trắng tinh có huy hiệu cây thập đỏ nhỏ, ống nghe stethoscope bạc treo cổ, khuôn mặt thân thiện chuyên nghiệp",
    "bi-do": "Quả bí đỏ 3D photorealistic cam lớn tròn nhân cách hoá thành bác sĩ dinh dưỡng, khoác áo blouse trắng tinh có huy hiệu cây thập đỏ nhỏ, ống nghe stethoscope bạc treo cổ, khuôn mặt chuyên nghiệp",
    "mong-toi": "Một bó lá mồng tơi 3D photorealistic xanh đậm bóng nhân cách hoá thành bác sĩ dinh dưỡng, khoác áo blouse trắng tinh, ống nghe stethoscope bạc treo cổ, khuôn mặt chuyên nghiệp",
    "dau-xanh": "Một hạt đậu xanh 3D photorealistic xanh non khổng lồ hình bầu dục nhân cách hoá thành bác sĩ dinh dưỡng, khoác áo blouse trắng tinh, ống nghe stethoscope bạc treo cổ, khuôn mặt chuyên nghiệp",
    "nuoc-dua": "Một trái dừa xiêm 3D photorealistic vỏ xanh tươi tròn lớn đã chặt nắp nhân cách hoá thành bác sĩ dinh dưỡng, khoác áo blouse trắng tinh, ống nghe stethoscope bạc treo cổ, khuôn mặt chuyên nghiệp",
    "du-du": "Nửa quả đu đủ 3D photorealistic vàng cam bổ nửa nhân cách hoá thành bác sĩ dinh dưỡng, khoác áo blouse trắng tinh, ống nghe stethoscope bạc treo cổ, khuôn mặt chuyên nghiệp",
    "oi": "Quả ổi 3D photorealistic tròn xanh non nhân cách hoá thành bác sĩ dinh dưỡng, khoác áo blouse trắng tinh, ống nghe stethoscope bạc treo cổ, khuôn mặt chuyên nghiệp",
    "ca-rot": "Củ cà rốt 3D photorealistic cam tươi hình nón dài nhân cách hoá thành bác sĩ dinh dưỡng, khoác áo blouse trắng tinh, ống nghe stethoscope bạc treo cổ, khuôn mặt chuyên nghiệp",
    "rau-muong": "Một bó rau muống 3D photorealistic xanh non dày nhân cách hoá thành bác sĩ dinh dưỡng, khoác áo blouse trắng tinh, ống nghe stethoscope bạc treo cổ, khuôn mặt chuyên nghiệp",
    "toi": "Củ tỏi 3D photorealistic nguyên củ trắng tinh nhân cách hoá thành bác sĩ dinh dưỡng, khoác áo blouse trắng tinh, ống nghe stethoscope bạc treo cổ, khuôn mặt chuyên nghiệp",
}

BN_BI_DO = "Quả bí đỏ 3D photorealistic cam lớn tròn có cuống xanh trên đỉnh nhân cách hoá thành bà ngoại Việt Nam, khoác áo bà ba nâu đen, búi tóc bạc nhỏ trên đỉnh bí đỏ, khuôn mặt hiền hậu ấm áp"


def a(sig, scene, dialogue, tail):
    return f"{sig}, {scene}, miệng nói '{dialogue}'{SPEED}{tail}"


SCRIPTS = {
    # ===== HERO (dive-into-dish) =====
    "01-khoai-lang-hero": {
        "subject": "khoai lang (fiber, đường huyết) — hero",
        "char": f"{CHARS_STYLE}/khoai-lang-hero.png",
        "acts": [
            a(HERO["khoai-lang"], "mặt mày khẩn trương như vừa thức dậy, vung tay chỉ camera quát cảnh báo", "dậy đi mày, lười vận động thì ăn khoai lang, fiber cho cơ thể đánh thức", HERO_TAIL),
            a(HERO["khoai-lang"], "tay bẻ đôi 1 củ khoai lang đã nướng khác, ruột vàng bốc khói thơm, tay kia flex bắp tay", "fiber ổn đường huyết, vitamin A, no lâu, giảm cân tự nhiên", HERO_TAIL),
            a(HERO["khoai-lang"], "cười tự tin, nhảy bay lên lộn ngược dive vào lò than hồng rực, lửa bùng lên khói bay, ngoi lên đã vàng nâu cháy xém thơm phức", "sáng 1 củ khoai nướng, no khoẻ cả sáng nha", HERO_TAIL),
        ],
    },
    "02-khoai-lang-doc": {
        "subject": "khoai lang — doctor style",
        "char": f"{CHARS_STYLE}/khoai-lang-doc.png",
        "acts": [
            a(DOC["khoai-lang"], "tay cầm clipboard đứng sau bàn khám nhìn thẳng camera như khám bệnh thân thiện", "táo bón à, đường huyết cao à, nghe tôi, ăn khoai lang mỗi sáng là hết", DOC_TAIL),
            a(DOC["khoai-lang"], "dao trên thớt gỗ cắt khoai lang thành 5 khoanh tròn đều đặn, đặt lên dĩa trắng, clipboard bên cạnh ghi fiber 3.8g/100g", "fiber ổn đường huyết, vitamin A, no lâu, giảm cân", DOC_TAIL),
            a(DOC["khoai-lang"], "tay chỉ vào biểu đồ trên tường Fiber mũi tên Tiêu hoá, đặt lên bàn khám 1 dĩa khoai nướng 1 dĩa khoai hấp 1 ly nước ép khoai", "sáng 1 củ khoai nướng hoặc hấp, đơn giản khoẻ nha", DOC_TAIL),
        ],
    },

    # ===== BÍ ĐỎ BÀ NGOẠI + DOC =====
    "03-bi-do-ba-ngoai": {
        "subject": "bí đỏ (beta-caroten, trẻ em) — bà ngoại",
        "char": f"{CHARS_CONCEPT}/b1-bi-do-ba-ngoai.png",
        "acts": [
            a(BN_BI_DO, "tay đưa ra trìu mến nhớ lại, mỉm cười ấm áp nhìn camera", "hồi bé bà nấu cháo bí đỏ cho cháu khoẻ, phải nhớ không", BN_TAIL),
            a(BN_BI_DO, "tay cầm dao lớn đập bổ nửa 1 quả bí đỏ khác trên thớt gỗ, hạt rơi tơi ruột cam đậm lộ ra, tay bà khoẻ khoắn", "beta-caroten cho mắt, đẹp da, tăng đề kháng, bổ trẻ nhỏ", BN_TAIL),
            a(BN_BI_DO, "mỉm cười hiền đang múc cháo bí đỏ vàng ra chén sứ bằng muôi gỗ, xung quanh bàn gỗ có chén chè bí đỏ nước cốt dừa trắng bánh bí đỏ hấp nhỏ vàng hơi bốc", "cháo chè bánh bí đỏ, bé nào cũng khoẻ nha", BN_TAIL),
        ],
    },
    "04-bi-do-doc": {
        "subject": "bí đỏ — doctor style",
        "char": f"{CHARS_STYLE}/bi-do-doc.png",
        "acts": [
            a(DOC["bi-do"], "tay cầm clipboard mỉm cười chuyên nghiệp nhìn camera", "bạn biết không, bí đỏ nhiều beta-caroten nhất họ bầu bí, gấp đôi cà rốt", DOC_TAIL),
            a(DOC["bi-do"], "dao đập bổ nửa quả bí đỏ khác trên thớt, hạt rơi tơi ruột cam đậm lộ, chỉ tay vào ruột cam giải thích", "beta-caroten cho mắt, đẹp da, tăng đề kháng, bổ trẻ nhỏ", DOC_TAIL),
            a(DOC["bi-do"], "đặt trên bàn khám 1 tô cháo bí đỏ 1 tô soup bí đỏ 1 dĩa bánh hấp, chỉ tay vào biểu đồ Beta-caroten mũi tên Mắt trên tường", "tuần 2 bữa bí đỏ, bé và người lớn đều khoẻ", DOC_TAIL),
        ],
    },

    # ===== MỒNG TƠI =====
    "05-mong-toi-hero": {
        "subject": "mồng tơi (mát gan, táo bón) — hero + bath",
        "char": f"{CHARS_STYLE}/mong-toi-hero.png",
        "acts": [
            a(HERO["mong-toi"], "ngồi thoải mái trong bát thuỷ tinh khổng lồ đầy nước mát trong veo có vài lá mồng tơi nhỏ và lá bạc hà nổi lấp lánh trên mặt nước, bọt nước sủi nhẹ quanh thân, mặt mày thư giãn nhưng tinh nghịch, tay khua nước splash nhẹ tung toé", "buồn quá chẳng ai khoe tao trên tiktok, mồng tơi đây, mát gan tiêu táo", HERO_TAIL),
            a(HERO["mong-toi"], "2 tay vò nắm lá mồng tơi, nhớt xanh sệt lộ ra giữa các ngón, tay kia flex bắp tay", "mát gan giải nhiệt, chất nhầy tiêu hoá, đẹp da mùa hè", HERO_TAIL),
            a(HERO["mong-toi"], "cười tươi nhảy bay lên lộn ngược dive vào nồi canh tôm đang sôi trên bếp, canh xanh lá bắn tung toé tôm đỏ nổi lên, ngoi lên cười", "hè nóng 1 bát canh mồng tơi tôm, mát cả ngày", HERO_TAIL),
        ],
    },
    "06-mong-toi-doc": {
        "subject": "mồng tơi — doctor style",
        "char": f"{CHARS_STYLE}/mong-toi-doc.png",
        "acts": [
            a(DOC["mong-toi"], "tay cầm clipboard, mắt nhìn camera thân thiện chuyên nghiệp", "bạn bị nóng trong, táo bón à, nghe tôi, canh mồng tơi mát gan", DOC_TAIL),
            a(DOC["mong-toi"], "dao sắc cắt nhỏ bó mồng tơi trên thớt, các lá xanh bóng rơi tơi, cuốn sách bên cạnh mở trang Chất nhầy tốt tiêu hoá", "mát gan giải nhiệt, chất nhầy tiêu hoá, đẹp da mùa hè", DOC_TAIL),
            a(DOC["mong-toi"], "đặt bát canh mồng tơi tôm lên bàn khám, tay chỉ biểu đồ Chất nhầy mũi tên Tiêu hoá trên tường", "hè 1 bát canh mồng tơi tôm, mát cả ngày nha", DOC_TAIL),
        ],
    },

    # ===== ĐẬU XANH =====
    "07-dau-xanh-hero": {
        "subject": "đậu xanh (chè, giải nhiệt) — hero + bath",
        "char": f"{CHARS_STYLE}/dau-xanh-hero.png",
        "acts": [
            a(HERO["dau-xanh"], "ngồi thoải mái trong bát thuỷ tinh khổng lồ đầy nước mát trong veo có vài hạt đậu xanh và lá bạc hà nhỏ nổi lấp lánh trên mặt nước, bọt nước sủi nhẹ, mặt mày hào hứng tinh nghịch, tay khua nước splash nhẹ", "dạo này tiktok sốt chè đậu xanh nước cốt dừa mà mày chưa biết à", HERO_TAIL),
            a(HERO["dau-xanh"], "2 tay bẻ đôi nắm hạt đậu xanh nhỏ, nhân vàng lộ ra trên tay, tay kia flex bắp tay", "protein cao, giải nhiệt, chống táo bón, đẹp da mùa hè", HERO_TAIL),
            a(HERO["dau-xanh"], "cười tươi nhảy bay lên lộn ngược dive vào nồi chè đậu xanh đang sôi có nước cốt dừa trắng sệt, chè bắn tung toé, ngoi lên vàng óng", "hè 1 chén chè đậu xanh nước dừa, mát rượi nha", HERO_TAIL),
        ],
    },
    "08-dau-xanh-doc": {
        "subject": "đậu xanh — doctor style",
        "char": f"{CHARS_STYLE}/dau-xanh-doc.png",
        "acts": [
            a(DOC["dau-xanh"], "tay cầm clipboard mỉm cười chuyên nghiệp nhìn camera đặt câu hỏi socratic", "sao dân Việt hay chè đậu xanh mùa hè, vì giải nhiệt detox tự nhiên", DOC_TAIL),
            a(DOC["dau-xanh"], "tay đong 1 nắm đậu xanh lên cân điện tử nhỏ, số 50g hiện lên trên màn hình, ghi chú vào clipboard", "protein cao, giải nhiệt, chống táo bón, đẹp da", DOC_TAIL),
            a(DOC["dau-xanh"], "đặt trên bàn khám 1 chén chè đậu xanh nước cốt dừa 1 ly nước đậu xanh, chỉ biểu đồ Đậu xanh mũi tên Giải nhiệt", "hè 1 chén chè đậu xanh, detox nhẹ nhàng", DOC_TAIL),
        ],
    },

    # ===== NƯỚC DỪA =====
    "09-nuoc-dua-hero": {
        "subject": "nước dừa (electrolyte) — hero",
        "char": f"{CHARS_STYLE}/nuoc-dua-hero.png",
        "acts": [
            a(HERO["nuoc-dua"], "mặt mày thách thức đầy tự tin, 1 tay chỉ camera quyết liệt", "mày cứ uống nước tăng lực đắt tiền, tao đây kali tự nhiên, dừa Việt Nam", HERO_TAIL),
            a(HERO["nuoc-dua"], "2 tay vặn phần nắp đã chặt, nước dừa trong chảy thành dòng ra ly thuỷ tinh có đá viên, tay kia flex bắp tay", "kali cao, bù nước, chống chuột rút, mát thân", HERO_TAIL),
            a(HERO["nuoc-dua"], "cười sảng khoái nhảy bay lên lộn ngược dive vào ly thuỷ tinh cao lớn đầy đá viên, nước văng tung toé đá nhảy bật ra, ngoi lên cười", "sau tập 1 trái dừa, tự nhiên hơn nước tăng lực", HERO_TAIL),
        ],
    },
    "10-nuoc-dua-doc": {
        "subject": "nước dừa — doctor style",
        "char": f"{CHARS_STYLE}/nuoc-dua-doc.png",
        "acts": [
            a(DOC["nuoc-dua"], "tay cầm clipboard đứng bàn khám chuyên nghiệp, nhìn camera nói", "nghe tôi nói rõ, tập thể thao xong phải bù điện giải, nước dừa tự nhiên nhất", DOC_TAIL),
            a(DOC["nuoc-dua"], "tay đổ nước dừa vào ly đo lường thuỷ tinh, kiểm tra mức nước chuyên nghiệp, ghi clipboard Kali 250mg", "kali cao, bù nước, chống chuột rút, mát thân", DOC_TAIL),
            a(DOC["nuoc-dua"], "đặt ly nước dừa cùng biểu đồ Electrolyte sau tập trên bàn khám, tay chỉ biểu đồ giải thích", "sau tập 1 trái dừa, bù nước tự nhiên nhất", DOC_TAIL),
        ],
    },

    # ===== ĐU ĐỦ =====
    "11-du-du-hero": {
        "subject": "đu đủ (papain, tiêu hoá) — hero",
        "char": f"{CHARS_STYLE}/du-du-hero.png",
        "acts": [
            a(HERO["du-du"], "mặt mày tự tin ấm áp, tay đưa ra như giảng bài nghiêm túc nhưng thân thiện", "nghe tao dặn, muốn tiêu hoá tốt da đẹp thì sáng ăn đu đủ", HERO_TAIL),
            a(HERO["du-du"], "tay cầm dao tre bổ nửa 1 quả đu đủ khác trên thớt, ruột cam với hạt đen xoắn ốc lộ ra bóng ướt, tay kia flex bắp tay", "papain giúp tiêu hoá, vitamin C, đẹp da, no lâu", HERO_TAIL),
            a(HERO["du-du"], "cười tươi nhảy bay lên lộn ngược dive vào máy xay sinh tố thuỷ tinh có sữa đặc và đá, máy xay quay tít nước sinh tố vàng sệt bắn, rót ra ly thuỷ tinh", "sáng 1 ly sinh tố đu đủ sữa, tiêu hoá khoẻ", HERO_TAIL),
        ],
    },
    "12-du-du-doc": {
        "subject": "đu đủ — doctor style",
        "char": f"{CHARS_STYLE}/du-du-doc.png",
        "acts": [
            a(DOC["du-du"], "tay cầm clipboard nhìn camera như khám bệnh thân thiện chuyên nghiệp", "bạn đau dạ dày ăn không tiêu à, nghe tôi, đu đủ có papain enzyme tiêu hoá", DOC_TAIL),
            a(DOC["du-du"], "dao sắc bổ nửa 1 quả đu đủ khác trên thớt, ruột cam hạt đen xoắn ốc lộ ra, tay chỉ vào ruột giải thích papain", "papain giúp tiêu hoá, vitamin C, đẹp da, no lâu", DOC_TAIL),
            a(DOC["du-du"], "đặt lát đu đủ chín và ly sinh tố đu đủ sữa lên bàn khám, tay chỉ biểu đồ Papain mũi tên Tiêu hoá", "sáng 1 đĩa đu đủ hoặc ly sinh tố, dạ dày khoẻ", DOC_TAIL),
        ],
    },

    # ===== ỔI =====
    "13-oi-hero": {
        "subject": "ổi (vitamin C) — hero",
        "char": f"{CHARS_STYLE}/oi-hero.png",
        "acts": [
            a(HERO["oi"], "mặt mày tinh nghịch tự tin, tay giơ ra thách đố camera", "đố mày biết cái gì nhiều vitamin C gấp 4 cam, ổi Việt đây", HERO_TAIL),
            a(HERO["oi"], "2 tay bẻ đôi 1 quả ổi khác, ruột hồng-trắng với hạt lộ ra, tay kia flex bắp tay", "vitamin C siêu cao, chống oxy hoá, da mịn, đề kháng", HERO_TAIL),
            a(HERO["oi"], "cười tươi nhảy bay lên lộn ngược dive vào ly thuỷ tinh cao lớn đầy nước lọc mát lạnh có đá viên, nước văng tung toé trong suốt, ngoi lên cười", "sáng 1 ly nước ổi ép, da mịn đề kháng tăng nha", HERO_TAIL),
        ],
    },
    "14-oi-doc": {
        "subject": "ổi — doctor style",
        "char": f"{CHARS_STYLE}/oi-doc.png",
        "acts": [
            a(DOC["oi"], "tay cầm clipboard mỉm cười chuyên nghiệp nhìn camera nói", "1 quả ổi nhiều vitamin C gấp 4 quả cam đấy, bạn biết chưa", DOC_TAIL),
            a(DOC["oi"], "dao sắc bổ đôi 1 quả ổi khác trên thớt, ruột hồng-trắng hạt lộ ra, tay chỉ vào ruột giải thích vitamin C", "vitamin C siêu cao, chống oxy hoá, da mịn, đề kháng", DOC_TAIL),
            a(DOC["oi"], "đặt đĩa ổi cắt lát và ly nước ổi ép lên bàn khám, tay chỉ biểu đồ Vitamin C 228mg 100g trên tường", "ngày 1 quả ổi, đề kháng vững da mịn màng", DOC_TAIL),
        ],
    },

    # ===== CÀ RỐT =====
    "15-ca-rot-hero": {
        "subject": "cà rốt (vitamin A, mắt) — hero + bath",
        "char": f"{CHARS_STYLE}/ca-rot-hero.png",
        "acts": [
            a(HERO["ca-rot"], "ngồi thoải mái trong bát thuỷ tinh khổng lồ đầy nước ép cà rốt cam tươi mát có đá viên và vài lát cà rốt nhỏ nổi lấp lánh trên mặt nước, bọt nước cam sủi nhẹ, mặt mày tự tin tinh nghịch, tay khua nước cam splash nhẹ tung toé", "1 củ tao có beta-caroten đủ vitamin A cả ngày, cà rốt Việt đây", HERO_TAIL),
            a(HERO["ca-rot"], "tay cầm 1 củ cà rốt khác bào sợi bằng bàn bào kim loại, sợi cam rơi xuống dĩa trắng đều đặn, tay kia flex bắp tay", "vitamin A cho mắt, beta-caroten đẹp da, fiber tiêu hoá", HERO_TAIL),
            a(HERO["ca-rot"], "cười tươi nhảy bay lên lộn ngược dive vào máy ép nước kim loại lớn, máy kêu ù ù nước cam tươi bắn ra ly thuỷ tinh, ngoi lên cười", "sáng 1 ly nước ép cà rốt, mắt tinh cả ngày", HERO_TAIL),
        ],
    },
    "16-ca-rot-doc": {
        "subject": "cà rốt — doctor style",
        "char": f"{CHARS_STYLE}/ca-rot-doc.png",
        "acts": [
            a(DOC["ca-rot"], "tay cầm clipboard đứng bàn khám, mắt nhìn camera như khám bệnh", "bạn bị mỏi mắt cận thị khô mắt đúng không, cà rốt mỗi ngày là đỡ", DOC_TAIL),
            a(DOC["ca-rot"], "tay cầm 1 củ cà rốt bào sợi bằng bàn bào chuyên nghiệp, sợi cam rơi xuống dĩa nhỏ, tay chỉ biểu đồ mắt trên tường", "vitamin A cho mắt, beta-caroten đẹp da, fiber tiêu hoá", DOC_TAIL),
            a(DOC["ca-rot"], "đặt ly nước ép cà rốt và dĩa salad cà rốt lên bàn khám, tay chỉ biểu đồ Vitamin A mũi tên Mắt sáng", "sáng 1 ly nước ép cà rốt, mắt tinh cả ngày", DOC_TAIL),
        ],
    },

    # ===== RAU MUỐNG =====
    "17-rau-muong-hero": {
        "subject": "rau muống (sắt, bổ máu) — hero",
        "char": f"{CHARS_STYLE}/rau-muong-hero.png",
        "acts": [
            a(HERO["rau-muong"], "mặt mày formal thân thiện, cúi đầu chào nhẹ như giới thiệu bản thân", "xin tự giới thiệu, tao là rau muống, món quốc dân Việt Nam đây", HERO_TAIL),
            a(HERO["rau-muong"], "2 tay vẩy bó rau muống lau giọt nước, nước bắn rơi như mưa nhẹ, tay kia flex bắp tay", "vitamin A, chất sắt bổ máu, chất xơ, giải nhiệt", HERO_TAIL),
            a(HERO["rau-muong"], "cười tươi nhảy bay lên lộn ngược dive vào chảo gang nóng rực đang phi tỏi vàng, lửa bùng sáng khói tỏi xèo xèo, ngoi lên xanh mướt", "bữa cơm thêm rau muống xào tỏi, đủ chất mỗi ngày", HERO_TAIL),
        ],
    },
    "18-rau-muong-doc": {
        "subject": "rau muống — doctor style",
        "char": f"{CHARS_STYLE}/rau-muong-doc.png",
        "acts": [
            a(DOC["rau-muong"], "tay cầm clipboard mỉm cười chuyên nghiệp nhìn camera nói bí mật dinh dưỡng", "bí mật mâm cơm Việt khoẻ cả nhà là đây, rau muống, tuần mấy bữa", DOC_TAIL),
            a(DOC["rau-muong"], "tay rửa bó rau muống dưới vòi nước sạch, nước chảy róc rách trên lá xanh, tay chỉ biểu đồ Sắt bổ máu trên tường", "vitamin A, chất sắt bổ máu, chất xơ, giải nhiệt", DOC_TAIL),
            a(DOC["rau-muong"], "đặt dĩa rau muống xào tỏi và bát canh rau muống lên bàn khám, tay chỉ biểu đồ Rau muống mũi tên Máu khoẻ", "bữa cơm 2 bữa rau muống, đủ chất mỗi ngày", DOC_TAIL),
        ],
    },

    # ===== DƯA HẤU HERO v2 (bath in watermelon juice) =====
    "20-dua-hau-hero-bath": {
        "subject": "dưa hấu (mát thân, bù nước) — hero bath v2",
        "char": f"{CHARS_STYLE}/dua-hau-hero.png",
        "acts": [
            a("Nửa quả dưa hấu 3D photorealistic bổ nửa cơ bắp muscular, vỏ xanh sọc đen, mặt cắt đỏ hồng lộ hạt đen bóng, bắp tay bắp chân từ thịt đỏ, bóng ướt",
              "ngồi thoải mái trong bát thuỷ tinh khổng lồ đầy nước ép dưa hấu đỏ hồng tươi mát có đá viên và vài miếng dưa hấu nhỏ nổi lấp lánh trên mặt nước, bọt nước đỏ sủi nhẹ, mặt mày thư giãn tinh nghịch, tay khua nước đỏ splash nhẹ",
              "ê mày khát nước hoài không, ngày nóng mệt mỏi không, dưa hấu Việt mát lành",
              HERO_TAIL),
            a("Nửa quả dưa hấu 3D photorealistic bổ nửa cơ bắp muscular, vỏ xanh sọc đen, mặt cắt đỏ hồng lộ hạt đen bóng, bắp tay bắp chân từ thịt đỏ, bóng ướt",
              "tự tin dùng 2 tay bóp vắt nửa quả dưa hấu lớn trong tay, nước đỏ hồng chảy thành dòng vào ly thuỷ tinh đá viên, tay kia flex bắp tay mạnh mẽ",
              "92% nước, ít calo, bù khoáng, mát thân tự nhiên",
              HERO_TAIL),
            a("Nửa quả dưa hấu 3D photorealistic bổ nửa cơ bắp muscular, vỏ xanh sọc đen, mặt cắt đỏ hồng lộ hạt đen bóng, bắp tay bắp chân từ thịt đỏ, bóng ướt",
              "nở nụ cười thân thiện cầm dao tre bổ nửa quả dưa hấu khác trên thớt gỗ dứt khoát, nước đỏ bắn tung toé lên không trung thành giọt lấp lánh, các lát dưa xếp lên mâm tre",
              "sáng 1 miếng sau ăn, chiều 1 ly nước ép, mát người nha",
              HERO_TAIL),
        ],
    },

    # ===== TỎI DOC (skip tỏi hero — đã có) =====
    "19-toi-doc": {
        "subject": "tỏi — doctor style",
        "char": f"{CHARS_STYLE}/toi-doc.png",
        "acts": [
            a(DOC["toi"], "tay cầm clipboard đứng bàn khám, mắt nhìn camera như giảng bài nghiêm túc", "cholesterol cao, huyết áp cao, nghe tôi, 1 tép tỏi mỗi sáng là ổn", DOC_TAIL),
            a(DOC["toi"], "tay bóc 1 tép tỏi đặt lên cân điện tử nhỏ, số trọng lượng hiển thị, ghi clipboard Allicin 5mg", "allicin kháng khuẩn, ổn huyết áp, tim khoẻ, miễn dịch tăng", DOC_TAIL),
            a(DOC["toi"], "đặt hũ tỏi ngâm mật ong vàng óng và dĩa tỏi tươi lên bàn khám, tay chỉ biểu đồ Allicin mũi tên Tim trên tường", "sáng 1 tép tỏi sống, tối hũ tỏi mật ong, tim khoẻ", DOC_TAIL),
        ],
    },
}

ORDER = ["02-khoai-lang-doc","03-bi-do-ba-ngoai","04-bi-do-doc","05-mong-toi-hero","06-mong-toi-doc","07-dau-xanh-hero","08-dau-xanh-doc","09-nuoc-dua-hero","10-nuoc-dua-doc","11-du-du-hero","12-du-du-doc","13-oi-hero","14-oi-doc","15-ca-rot-hero","16-ca-rot-doc","17-rau-muong-hero","18-rau-muong-doc","19-toi-doc","20-dua-hau-hero-bath"]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def reset_daemon():
    subprocess.run(["pkill", "-f", "flow-daemon/server.js"], check=False)
    time.sleep(2)
    profile = os.path.expanduser("~/.flow-daemon/profile")
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        try: os.remove(os.path.join(profile, name))
        except FileNotFoundError: pass
    time.sleep(1)
    log("  [daemon reset]")


def post_update(job, patch):
    data = json.dumps({"job": job, "patch": patch}).encode()
    req = urllib.request.Request(f"{PREVIEW_API}/api/picker-update", data=data,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def init_job(subject):
    data = json.dumps({"subject": subject}).encode()
    req = urllib.request.Request(f"{PREVIEW_API}/api/picker-init", data=data,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())["job_id"]


def process(key):
    info = SCRIPTS[key]
    log(f"=== {key}: {info['subject']} ===")
    reset_daemon()
    job_id = init_job(info["subject"])
    jd = f"{JOBS_DIR}/{job_id}"
    log(f"  job_id: {job_id}")

    with open(f"{jd}/state.json") as f: state = json.load(f)
    state["grid"] = GRID
    with open(f"{jd}/state.json","w") as f: json.dump(state, f, indent=2, ensure_ascii=False)

    if not os.path.exists(info["char"]):
        log(f"  FAIL: char missing {info['char']}"); return False
    shutil.copy(info["char"], f"{jd}/char-1.png")

    post_update(job_id, {
        "state": "video_gen",
        "char_index": 0,
        "characters": [{"url": f"/picker-jobs/{job_id}/char-1.png"}],
        "character_prompts": [f"(auto: {os.path.basename(info['char'])})"],
        "video_prompts": info["acts"],
        "video_progress": "Starting render...",
    })

    log(f"  firing render...")
    r = subprocess.run([
        "node", f"{REPO}/bin/flow-video-cli.js",
        "generate", *info["acts"],
        "--frame", f"{jd}/char-1.png",
        "--output", f"{jd}/final.mp4",
        "--json"
    ], capture_output=True, text=True, timeout=1800)

    if r.returncode != 0 or not os.path.exists(f"{jd}/final.mp4") or os.path.getsize(f"{jd}/final.mp4") < 1_000_000:
        log(f"  FAIL render: {r.stderr[-400:]}")
        post_update(job_id, {"state": "error", "error": "render failed"})
        return False

    size_mb = os.path.getsize(f'{jd}/final.mp4')//1024//1024
    log(f"  render OK: {size_mb} MB")

    log(f"  finalizing (delogo + outro)...")
    r = subprocess.run([
        "ffmpeg","-y","-i", f"{jd}/final.mp4","-i", OUTRO,
        "-filter_complex",
        "[0:v]delogo=x=1770:y=3670:w=320:h=110:show=0[v0];[v0][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
        "-map","[v]","-map","[a]",
        "-c:v","libx264","-c:a","aac","-preset","fast","-crf","20",
        f"{jd}/final-branded.mp4"
    ], capture_output=True, text=True)

    if r.returncode != 0 or not os.path.exists(f"{jd}/final-branded.mp4"):
        log(f"  FINALIZE FAIL: {r.stderr[-300:]}")
        post_update(job_id, {"state": "done", "video_url": f"/picker-jobs/{job_id}/final.mp4"})
        return True

    log(f"  finalized: {os.path.getsize(f'{jd}/final-branded.mp4')//1024//1024} MB")

    # Auto-compress for FB Reels upload (Playwright CDP setInputFiles caps at
    # 50 MB). final-branded.mp4 is 4K @ ~16 Mbps = often 50-80 MB. Re-encode
    # at CRF 26 → typically 25-40 MB while keeping decent quality for mobile.
    log(f"  compressing for FB (target <50MB)...")
    r = subprocess.run([
        "ffmpeg","-y","-i", f"{jd}/final-branded.mp4",
        "-c:v","libx264","-preset","slow","-crf","26",
        "-c:a","aac","-b:a","128k",
        f"{jd}/final-branded-fb.mp4"
    ], capture_output=True, text=True)
    if r.returncode == 0 and os.path.exists(f"{jd}/final-branded-fb.mp4"):
        fb_mb = os.path.getsize(f'{jd}/final-branded-fb.mp4')//1024//1024
        log(f"  fb-ready: {fb_mb} MB")
    else:
        log(f"  WARN compress failed (non-blocking): {r.stderr[-200:]}")

    post_update(job_id, {
        "state": "done",
        "video_url": f"/picker-jobs/{job_id}/final-branded.mp4",
        "video_progress": "✓ Done"
    })
    return True


def main():
    log(f"=== BATCH v2 START: {len(ORDER)} videos ===")
    done, failed, consecutive_fail = [], [], 0
    for key in ORDER:
        try: ok = process(key)
        except Exception as e:
            log(f"  EXCEPTION {key}: {e}"); ok = False
        if ok:
            done.append(key); consecutive_fail = 0
        else:
            failed.append(key); consecutive_fail += 1
            if consecutive_fail >= 2:
                log(f"  STOP: {consecutive_fail} consecutive failures"); break
    log(f"=== BATCH v2 END: {len(done)} done, {len(failed)} failed ===")
    log(f"  done: {done}")
    log(f"  failed: {failed}")


if __name__ == "__main__":
    main()
