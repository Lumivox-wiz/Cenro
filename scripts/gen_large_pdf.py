"""生成用于 PDF spike 的大体积扫描版 PDF。

结构贴近真实扫描件：每页一张独立 JPEG（DCTDecode 流），page 的 Contents
只负责把图片铺满画布。这样 pdf.js 的瓶颈会落在解码与 canvas 合成上，
而不是矢量绘制。
"""

from __future__ import annotations

import argparse
import io
import os
import sys

# 用户环境的 PYTHONPATH 里有一个缺少 _imaging 扩展的 PIL 目录，
# 优先级高于 site-packages，会导致 ImportError。这里只剔除该目录。
sys.path = [p for p in sys.path if not p.rstrip("\\/").endswith("pylibs")]

from PIL import Image, ImageDraw  # noqa: E402


def make_page_jpeg(width: int, height: int, quality: int, page_no: int) -> bytes:
    img = Image.new("RGB", (width, height), (249, 247, 242))
    draw = ImageDraw.Draw(img)

    # 标题块
    draw.rectangle([80, 70, width - 80, 130], fill=(40, 40, 40))
    # 正文行
    for row in range(170, height - 90, 26):
        jitter = (page_no * 7 + row) % 40
        draw.line(
            [(80, row), (width - 80 - jitter, row)],
            fill=(70, 68, 64),
            width=3,
        )

    # 纸张纹理与噪点：让每页熵足够高，避免 PDF 被过度压缩
    noise = Image.effect_noise((width, height), 32).convert("L")
    img = Image.blend(img, Image.merge("RGB", (noise, noise, noise)), 0.10)

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality, optimize=False)
    return buf.getvalue()


def build_pdf(pages: list[bytes], width: int, height: int, out_path: str) -> int:
    n = len(pages)
    out = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offsets: dict[int, int] = {}

    def add_object(obj_id: int, body: bytes, stream: bytes | None = None) -> None:
        offsets[obj_id] = len(out)
        out.extend(f"{obj_id} 0 obj\n".encode())
        out.extend(body)
        if stream is not None:
            out.extend(b"\nstream\n")
            out.extend(stream)
            out.extend(b"\nendstream")
        out.extend(b"\nendobj\n")

    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(n))
    add_object(1, b"<< /Type /Catalog /Pages 2 0 R >>")
    add_object(2, f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())

    image_base = 3 + n * 2

    for i, jpeg in enumerate(pages):
        page_id = 3 + i * 2
        content_id = page_id + 1
        img_id = image_base + i

        content = (
            f"q\n{width} 0 0 {height} 0 0 cm\n/Im0 Do\nQ\n".encode()
        )
        add_object(
            page_id,
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] "
                f"/Resources << /XObject << /Im0 {img_id} 0 R >> >> "
                f"/Contents {content_id} 0 R >>"
            ).encode(),
        )
        add_object(
            content_id,
            f"<< /Length {len(content)} >>".encode(),
            content,
        )
        add_object(
            img_id,
            (
                f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} "
                f"/ColorSpace /DeviceRGB /BitsPerComponent 8 "
                f"/Filter /DCTDecode /Length {len(jpeg)} >>"
            ).encode(),
            jpeg,
        )

    xref_pos = len(out)
    count = image_base + n
    out.extend(f"xref\n0 {count}\n".encode())
    out.extend(b"0000000000 65535 f \n")
    for obj_id in range(1, count):
        out.extend(f"{offsets.get(obj_id, 0):010d} 00000 n \n".encode())
    out.extend(
        f"trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    )

    with open(out_path, "wb") as f:
        f.write(out)
    return len(out)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pages", type=int, default=260)
    parser.add_argument("--width", type=int, default=1000)
    parser.add_argument("--height", type=int, default=1400)
    parser.add_argument("--quality", type=int, default=72)
    parser.add_argument(
        "--out",
        default=r"F:\Project\Reader\.testdata\library\扫描件.pdf",
    )
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    print(f"生成 {args.pages} 页 {args.width}x{args.height} JPEG q={args.quality} ...")
    pages = [
        make_page_jpeg(args.width, args.height, args.quality, i)
        for i in range(args.pages)
    ]
    total = build_pdf(pages, args.width, args.height, args.out)
    print(f"完成: {args.out}")
    print(f"大小: {total / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
