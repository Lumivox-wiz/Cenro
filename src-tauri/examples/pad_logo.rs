//! 给安卓自适应图标做前景：把标志缩到画布中央约 2/3，其余铺白底。
//!
//! 自适应图标的可视区只有中央约 72/108，圆形遮罩会切掉四角。
//! 直接把整张图标当前景，山峰的左右尖角会被裁掉，所以这里先缩再居中。
//!
//! 用法：cargo run --release --example pad_logo -- <源.png> <输出.png> <缩放比例>
fn main() {
    let mut args = std::env::args().skip(1);
    let src = args.next().expect("缺少源图");
    let dst = args.next().expect("缺少输出");
    let scale: f32 = args.next().and_then(|v| v.parse().ok()).unwrap_or(0.66);

    let img = image::open(&src).expect("读图失败").to_rgba8();
    let (w, h) = img.dimensions();
    let side = 1024u32;
    let inner = (side as f32 * scale) as u32;
    let resized = image::imageops::resize(&img, inner, inner, image::imageops::FilterType::Lanczos3);

    let mut canvas = image::RgbaImage::from_pixel(side, side, image::Rgba([255, 255, 255, 255]));
    let offset = (side - inner) / 2;
    image::imageops::overlay(&mut canvas, &resized, offset as i64, offset as i64);
    canvas.save(&dst).expect("写图失败");
    println!("{src} ({w}×{h}) → {dst}，内容缩放 {scale} 居中");
}
