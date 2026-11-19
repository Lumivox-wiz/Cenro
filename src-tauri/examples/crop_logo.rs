//! 把设计稿裁掉外框、缩放到 1024²，并套一个圆角遮罩。
//!
//! 设计稿里的「圆角方框 + 内描边」是展示用的外框，不是图标本身。
//! 直接裁内切会留下四角的弧线，所以裁完再套圆角遮罩把角切掉。
//!
//! 用法：cargo run --release --example crop_logo -- <源图> <输出.png> <内缩px> <圆角比例>
fn main() {
    let mut args = std::env::args().skip(1);
    let src = args.next().expect("缺少源图路径");
    let dst = args.next().expect("缺少输出路径");
    let inset: u32 = args.next().and_then(|v| v.parse().ok()).unwrap_or(128);
    // 22% 接近 Windows / Android 的图标圆角观感
    let radius_ratio: f32 = args.next().and_then(|v| v.parse().ok()).unwrap_or(0.22);

    let img = image::open(&src).expect("读图失败");
    let (w, h) = (img.width(), img.height());
    assert!(w > inset * 2 && h > inset * 2, "内缩过大");

    let cropped = img
        .crop_imm(inset, inset, w - inset * 2, h - inset * 2)
        .resize_exact(1024, 1024, image::imageops::FilterType::Lanczos3)
        .to_rgba8();

    let size = 1024f32;
    let radius = size * radius_ratio;
    let mut out = cropped.clone();
    for (x, y, px) in out.enumerate_pixels_mut() {
        // 圆角矩形的覆盖判定：角上到圆心的距离超过半径就透明
        let fx = x as f32 + 0.5;
        let fy = y as f32 + 0.5;
        let cx = fx.clamp(radius, size - radius);
        let cy = fy.clamp(radius, size - radius);
        let dx = fx - cx;
        let dy = fy - cy;
        if dx * dx + dy * dy > radius * radius {
            px[3] = 0;
        }
    }

    out.save(&dst).expect("写图失败");
    println!("{src} ({w}×{h}) → {dst} 1024×1024，内缩 {inset}，圆角 {radius_ratio}");
}
