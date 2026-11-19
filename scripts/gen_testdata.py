"""生成用于验证扫描链路的测试书库（不进版本库）。"""

import os
import shutil
import struct
import zipfile
import zlib

ROOT = r"F:\Project\Reader\.testdata\library"


def png_bytes(w, h, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def pdf_text(value: str) -> str:
    """ASCII 直接用字面量，其余走 UTF-16BE（PDF 中文标题的正确写法）。"""
    if all(ord(c) < 128 for c in value):
        return f"({value})"
    hexed = "FEFF" + "".join(f"{ord(c):04X}" for c in value)
    return f"<{hexed}>"


def make_pdf(path, pages=3, chapters=None):
    """最小可用 PDF：每页一个矩形 + 一行文字。chapters 给定时写入书签树。"""
    objects = {}
    font_id = 3 + pages * 2

    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(pages))
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[2] = f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>".encode()

    for i in range(pages):
        page_id = 3 + i * 2
        content_id = page_id + 1
        objects[page_id] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Contents {content_id} 0 R /Resources << /Font << /F1 {font_id} 0 R >> >> >>"
        ).encode()
        stream = (
            f"BT /F1 24 Tf 72 720 Td (Reader Test Page {i + 1}) Tj ET\n"
            f"0.2 0.4 0.8 rg 72 {600 - i * 20} 400 120 re f"
        ).encode()
        objects[content_id] = (
            f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream"
        )

    objects[font_id] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"

    if chapters:
        root_id = font_id + 1
        item_ids = [root_id + 1 + i for i in range(len(chapters))]
        objects[root_id] = (
            f"<< /Type /Outlines /First {item_ids[0]} 0 R "
            f"/Last {item_ids[-1]} 0 R /Count {len(item_ids)} >>"
        ).encode()
        for idx, (title, page_index) in enumerate(chapters):
            parts = [
                f"/Title {pdf_text(title)}",
                f"/Parent {root_id} 0 R",
                f"/Dest [{3 + page_index * 2} 0 R /Fit]",
            ]
            if idx > 0:
                parts.append(f"/Prev {item_ids[idx - 1]} 0 R")
            if idx < len(item_ids) - 1:
                parts.append(f"/Next {item_ids[idx + 1]} 0 R")
            objects[item_ids[idx]] = ("<< " + " ".join(parts) + " >>").encode()

        objects[1] = (
            f"<< /Type /Catalog /Pages 2 0 R /Outlines {root_id} 0 R >>"
        ).encode()

    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for obj_id in sorted(objects):
        offsets[obj_id] = len(out)
        out += f"{obj_id} 0 obj\n".encode() + objects[obj_id] + b"\nendobj\n"

    xref_pos = len(out)
    count = max(objects) + 1
    out += f"xref\n0 {count}\n".encode()
    out += b"0000000000 65535 f \n"
    for obj_id in range(1, count):
        off = offsets.get(obj_id, 0)
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()

    with open(path, "wb") as f:
        f.write(out)


def make_epub(path, title="测试电子书"):
    container = (
        '<?xml version="1.0"?>\n'
        '<container version="1.0" '
        'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        "  <rootfiles>\n"
        '    <rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml"/>\n'
        "  </rootfiles>\n"
        "</container>"
    )
    opf = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">\n'
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        f"    <dc:title>{title}</dc:title>\n"
        "    <dc:creator>测试作者</dc:creator>\n"
        "    <dc:language>zh</dc:language>\n"
        "  </metadata>\n"
        "  <manifest>\n"
        '    <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>\n'
        '    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>\n'
        "  </manifest>\n"
        "  <spine>\n"
        '    <itemref idref="c1"/>\n'
        "  </spine>\n"
        "</package>"
    )
    chapter = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title>'
        "<style>body{font-family:serif;line-height:1.8;margin:2em}</style></head>\n"
        '<body><h1>第一章</h1><p>这是用于验证 EPUB 解析的段落。</p>'
        '<p><img src="cover.png" alt="章节插图" width="240"/></p>'
        "</body></html>"
    )

    with zipfile.ZipFile(path, "w") as z:
        # mimetype 必须不压缩且作为第一个条目
        z.writestr(
            zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED
        )
        z.writestr("META-INF/container.xml", container, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/chapter1.xhtml", chapter, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/cover.png", png_bytes(300, 450, (120, 40, 160)))


def make_mobi(path, title="测试 MOBI", author="食鹿客"):
    """最小可用的 MOBI：PalmDOC 头 + MOBI 头 + EXTH，正文不压缩。

    结构对齐 tauri 端 mobi.rs 的解析顺序：
    记录 0 = 16 字节 PalmDOC 头 + 232 字节 MOBI 头 + EXTH + 完整书名。
    """
    import struct

    body = (
        "<html><body>"
        "<h1>第一章 归宗</h1>"
        "<p>薛冷仙重生归来，睁眼时正躺在合欢宗后山的乱石堆里。</p>"
        "<p>她试着运转经脉，丹田空空如也，连一丝灵力都聚不起来。</p>"
        "<br/>"
        "<h1>第二章 四徒</h1>"
        "<p>大弟子沈扶摇站在门外，神色恭敬，眼底却藏着打量。</p>"
        "<p>二弟子谢花朝抱臂靠在廊柱上，笑意不达眼底。</p>"
        "<mbp:pagebreak/>"
        "<h1>第三章 天魔</h1>"
        "<p>渡劫期的心魔并未散去，它只是换了一种方式留了下来。</p>"
        "</body></html>"
    ).encode("utf-8")

    # ---- EXTH：只有一条作者记录（type 100）----
    author_bytes = author.encode("utf-8")
    exth_rec = struct.pack(">II", 100, 8 + len(author_bytes)) + author_bytes
    exth = b"EXTH" + struct.pack(">II", 12 + len(exth_rec), 1) + exth_rec

    # ---- MOBI 头 ----
    mobi = bytearray(232)
    mobi[0:4] = b"MOBI"
    struct.pack_into(">I", mobi, 4, 232)          # 头长度
    struct.pack_into(">I", mobi, 8, 2)            # 类型：book
    struct.pack_into(">I", mobi, 12, 65001)       # 文本编码 UTF-8
    struct.pack_into(">I", mobi, 16, 1)           # 唯一 ID
    struct.pack_into(">I", mobi, 20, 6)           # 文件版本

    name_bytes = title.encode("utf-8")
    name_offset = 16 + 232 + len(exth)
    struct.pack_into(">I", mobi, 0x54, name_offset)   # 完整书名偏移
    struct.pack_into(">I", mobi, 0x58, len(name_bytes))
    struct.pack_into(">I", mobi, 0x70, 0x40)      # 存在 EXTH
    # 额外数据标志在「记录 0」的 0xF2 处，不在 MOBI 头内，稍后统一写入

    record_0 = bytearray(16)
    struct.pack_into(">H", record_0, 0, 1)             # 不压缩
    struct.pack_into(">I", record_0, 4, len(body))     # 正文字节数
    struct.pack_into(">H", record_0, 8, 1)             # 1 条正文记录
    struct.pack_into(">H", record_0, 10, 4096)
    struct.pack_into(">H", record_0, 12, 0)            # 未加密
    record_0 += mobi + exth + name_bytes
    # 记录 0 绝对偏移 0xF2：额外数据标志 = 0
    record_0 += bytes(0xF6 - len(record_0)) if len(record_0) < 0xF6 else b""
    struct.pack_into(">I", record_0, 0xF2, 0)

    # ---- PDB 头 ----
    header = bytearray(78)
    header[0:4] = b"TEST"
    header[60:64] = b"BOOK"
    header[64:68] = b"MOBI"
    struct.pack_into(">H", header, 76, 2)

    data_start = 78 + 2 * 8
    offsets = [data_start, data_start + len(record_0)]

    out = bytearray(header)
    for i, off in enumerate(offsets):
        out += struct.pack(">I", off) + bytes([0, 0, 0, i])
    out += record_0 + body

    with open(path, "wb") as f:
        f.write(out)



def make_markdown(path):
    """带标题、列表、链接、代码块的 Markdown，用于验证转纯文本与切章。"""
    content = """# 第一章 起风

这是用于验证 **Markdown** 解析的段落，里面有 *斜体*、`行内代码` 与
[链接](https://example.com/a)。

- 列表项一
- 列表项二
  - 嵌套项

> 引用的一段话。

```rust
// 代码块里的 * 与 _ 不应被当作强调
let user_id = 42;
```

## 第一节 小节

小节正文，`snake_case` 必须原样保留。

---

# 第二章 夜行

结尾段落。
"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def make_html(path):
    """单文件 HTML：验证去标签、实体解码与段落换行。"""
    content = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>测试文章</title>
<style>body { color: #333 }</style>
<script>console.log("不应出现");</script>
</head>
<body>
<h1>第一章 山雨</h1>
<p>这是 <strong>HTML</strong> 正文，含有 &amp; 实体与 <a href="#">链接</a>。</p>
<p>第二段：3 &lt; 5 的转义应当还原成小于号。</p>
<h1>第二章 归途</h1>
<p>结尾段落。</p>
</body></html>
"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def make_zip(path, pages=3):
    """内含多张图片的 zip，按 CBZ 同样方式阅读。"""
    import zipfile

    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
        for i in range(1, pages + 1):
            z.writestr(f"{i}.png", png_bytes(320, 460, (40 + i * 40, 90, 160)))





def main():
    if os.path.exists(ROOT):
        shutil.rmtree(ROOT)
    os.makedirs(ROOT)

    # 1. 中文 TXT，GBK 编码，验证编码探测
    body = "第一章 起风了\n\n" + "风从窗缝里挤进来，带着初秋的凉。\n" * 40
    body += "\n第二章 夜行\n\n" + "街灯一盏接一盏亮起。\n" * 40
    with open(os.path.join(ROOT, "小说.txt"), "wb") as f:
        f.write(body.encode("gbk"))

    # 2. CBZ，条目名故意乱序，验证自然排序 1,2,10
    with zipfile.ZipFile(os.path.join(ROOT, "漫画.cbz"), "w", zipfile.ZIP_DEFLATED) as z:
        for idx, color in [(1, (200, 60, 60)), (10, (60, 60, 200)), (2, (60, 200, 60))]:
            z.writestr(f"page{idx}.png", png_bytes(400, 600, color))

    # 3. 图片文件夹
    folder = os.path.join(ROOT, "图集")
    os.makedirs(folder)
    for i in range(1, 5):
        with open(os.path.join(folder, f"{i}.png"), "wb") as f:
            f.write(png_bytes(600, 800, (30 * i, 80, 160)))

    # 3.5 MOBI
    make_mobi(os.path.join(ROOT, "合欢宗.mobi"))

    # 4. PDF（含一份带书签树的，用于验证 outline 目录）
    make_pdf(os.path.join(ROOT, "文档.pdf"), pages=3)
    make_pdf(
        os.path.join(ROOT, "带目录.pdf"),
        pages=5,
        chapters=[
            ("第一章 总则", 0),
            ("第二章 实施", 2),
            ("第三章 附则", 4),
        ],
    )

    # 5. EPUB
    make_epub(os.path.join(ROOT, "电子书.epub"))

    # 5.1 Markdown / HTML / ZIP
    make_markdown(os.path.join(ROOT, "笔记.md"))
    make_html(os.path.join(ROOT, "文章.html"))
    make_zip(os.path.join(ROOT, "压缩漫画.zip"), pages=3)

    # 6. 干扰项：只有两张图的目录不应入库
    small = os.path.join(ROOT, "只有两张")
    os.makedirs(small)
    for i in range(2):
        with open(os.path.join(small, f"{i}.png"), "wb") as f:
            f.write(png_bytes(100, 150, (10, 10, 10)))

    print("生成完成:", ROOT)
    for name in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, name)
        size = os.path.getsize(p) if os.path.isfile(p) else sum(
            os.path.getsize(os.path.join(p, f)) for f in os.listdir(p)
        )
        print(f"  {name:<20} {size:>9} bytes")


if __name__ == "__main__":
    main()
