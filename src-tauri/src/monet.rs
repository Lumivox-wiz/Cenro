//! 莫奈取色：从一张背景图里取出一个可用的主色相。
//!
//! 这一层只负责「取相」——返回色相与饱和/明度；具体派生（强调色、选中底、光晕）
//! 交给前端 `src/lib/monet.ts`。原因是同一份取色结果要同时服务亮色与暗色两套主题，
//! 而对比度校验必须按当前纸面颜色重算：一张偏深的蓝在暗色下能当强调色，
//! 到亮色下就掉到 3:1 以下，同一组 RGB 不可能两边都合格。
//!
//! 为什么不用前端的 canvas：WebView 里 `<img>` 走的是 asset 协议（不同 origin），
//! 画到 canvas 上会被 taint，`getImageData` 直接抛 SecurityError。
//! 后端已有 `image` crate，顺手把降采样也做了，省掉把整张大图塞进 JS 内存。

use crate::error::{AppError, Result};
use serde::Serialize;

/// 缩略后的采样边长。72 ≈ 5000 像素，足够让色相直方图稳定；
/// 再大不会改变分布，只是徒增解码后的拷贝。
const SAMPLE: u32 = 72;

/// 色相桶数。36 桶 = 每桶 10°，刚好是「分得清偏红还是偏橙」的粒度。
const BUCKETS: usize = 36;

#[derive(Serialize)]
pub struct MonetSwatch {
    /// 色相 0~360；coverage 为 0 时无意义
    pub hue: f32,
    /// 饱和度 0~1（有效像素的加权平均）
    pub saturation: f32,
    /// 明度 0~1（同上）
    pub lightness: f32,
    /// 整图平均明度。前端据此判断「这张图会不会让文字读不清」
    pub mean_lightness: f32,
    /// 有效像素占比 0~1。低于 0.02 基本是灰阶图，没有可用色调
    pub coverage: f32,
}

pub fn extract(path: &str) -> Result<MonetSwatch> {
    let img = image::open(path)
        .map_err(|e| AppError::Other(format!("背景图读取失败：{e}")))?
        .thumbnail(SAMPLE, SAMPLE)
        .to_rgba8();

    let mut weight = [0f64; BUCKETS];
    // 每个桶累加「单位圆向量」而不是角度，最后用 atan2 求环形平均。
    // 直接平均角度会把 350° 与 10° 算成 180°——红色被算成青色。
    let mut sin_sum = [0f64; BUCKETS];
    let mut cos_sum = [0f64; BUCKETS];
    let mut sat_sum = [0f64; BUCKETS];
    let mut light_sum = [0f64; BUCKETS];

    let mut total = 0u32;
    let mut used = 0u32;
    let mut light_total = 0f64;

    for px in img.pixels() {
        let [r, g, b, a] = px.0;
        if a < 128 {
            continue;
        }
        total += 1;
        let (h, s, l) = rgb_to_hsl(r, g, b);
        light_total += l as f64;

        // 灰、近黑、近白都不承载「色调」。让它们参与统计只会把主色拉向灰，
        // 最后得到一个谁也不像的中间色。
        if s < 0.10 || l < 0.08 || l > 0.94 {
            continue;
        }
        // 中明度权重最高：极暗的深蓝与极亮的米白都容易把色相带偏，
        // 而真正定义「这张图是什么颜色」的是中间调。
        let w = s as f64 * (1.0 - ((l as f64) - 0.5).abs() * 1.4).max(0.0);
        if w <= 0.0 {
            continue;
        }

        let idx = ((h / 360.0 * BUCKETS as f32) as usize).min(BUCKETS - 1);
        let rad = (h as f64).to_radians();
        weight[idx] += w;
        sin_sum[idx] += rad.sin() * w;
        cos_sum[idx] += rad.cos() * w;
        sat_sum[idx] += s as f64 * w;
        light_sum[idx] += l as f64 * w;
        used += 1;
    }

    let mean_lightness = if total > 0 {
        (light_total / total as f64) as f32
    } else {
        0.0
    };

    if used == 0 {
        return Ok(MonetSwatch {
            hue: 0.0,
            saturation: 0.0,
            lightness: 0.0,
            mean_lightness,
            coverage: 0.0,
        });
    }

    // 峰值桶连同左右各一桶一起算：主色正好落在桶边界时，
    // 只看单桶会让同一个色相在两张相近的图上跳到隔壁桶。
    let peak = (0..BUCKETS)
        .max_by(|a, b| weight[*a].total_cmp(&weight[*b]))
        .unwrap_or(0);

    let (mut w_sum, mut si, mut co, mut s_sum, mut l_sum) = (0f64, 0f64, 0f64, 0f64, 0f64);
    for off in [-1i32, 0, 1] {
        let i = (peak as i32 + off).rem_euclid(BUCKETS as i32) as usize;
        w_sum += weight[i];
        si += sin_sum[i];
        co += cos_sum[i];
        s_sum += sat_sum[i];
        l_sum += light_sum[i];
    }

    if w_sum <= 0.0 {
        return Ok(MonetSwatch {
            hue: 0.0,
            saturation: 0.0,
            lightness: 0.0,
            mean_lightness,
            coverage: 0.0,
        });
    }

    let mut hue = si.atan2(co).to_degrees();
    if hue < 0.0 {
        hue += 360.0;
    }

    Ok(MonetSwatch {
        hue: hue as f32,
        saturation: (s_sum / w_sum) as f32,
        lightness: (l_sum / w_sum) as f32,
        mean_lightness,
        coverage: used as f32 / total as f32,
    })
}

fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let r = r as f32 / 255.0;
    let g = g as f32 / 255.0;
    let b = b as f32 / 255.0;

    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;

    if (max - min).abs() < f32::EPSILON {
        return (0.0, 0.0, l);
    }

    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        ((g - b) / d + if g < b { 6.0 } else { 0.0 }) * 60.0
    } else if max == g {
        ((b - r) / d + 2.0) * 60.0
    } else {
        ((r - g) / d + 4.0) * 60.0
    };

    (h, s, l)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hsl_known_values() {
        // 纯红 / 纯绿 / 纯蓝 / 灰
        assert!((rgb_to_hsl(255, 0, 0).0 - 0.0).abs() < 0.01);
        assert!((rgb_to_hsl(0, 255, 0).0 - 120.0).abs() < 0.01);
        assert!((rgb_to_hsl(0, 0, 255).0 - 240.0).abs() < 0.01);
        let (_, s, _) = rgb_to_hsl(128, 128, 128);
        assert!(s < 0.01, "灰色饱和度应为 0");
    }

    #[test]
    fn grey_image_has_no_palette() {
        // 构造一张纯灰图，走一遍 extract 的内核逻辑：应当一个有效像素都没有
        let mut used = 0;
        for l in [0.2f32, 0.4, 0.6, 0.8] {
            let v = (l * 255.0) as u8;
            let (_, s, _) = rgb_to_hsl(v, v, v);
            if s >= 0.10 {
                used += 1;
            }
        }
        assert_eq!(used, 0);
    }

    /// 端到端：写一张纯蓝图，验证色相、覆盖率与"没有色调"两条分支。
    /// 用临时文件而不是项目内资源，测试才能在任何机器上独立跑。
    #[test]
    fn extract_solid_and_grey_images() {
        let dir = std::env::temp_dir();

        let blue_path = dir.join("cenro_monet_blue.png");
        let mut blue = image::RgbaImage::new(48, 48);
        for px in blue.pixels_mut() {
            // rgb(40,90,200) → 色相约 221°
            *px = image::Rgba([40, 90, 200, 255]);
        }
        blue.save(&blue_path).expect("写测试图");

        let sw = extract(blue_path.to_str().unwrap()).expect("取色");
        assert!(
            (sw.hue - 221.0).abs() < 10.0,
            "纯蓝的色相应接近 221，实际 {}",
            sw.hue
        );
        assert!(sw.coverage > 0.95, "纯色图的有效像素应接近全部");
        assert!(sw.saturation > 0.5 && sw.saturation < 0.8);

        let grey_path = dir.join("cenro_monet_grey.png");
        let mut grey = image::RgbaImage::new(48, 48);
        for px in grey.pixels_mut() {
            *px = image::Rgba([128, 128, 128, 255]);
        }
        grey.save(&grey_path).expect("写测试图");

        let sw = extract(grey_path.to_str().unwrap()).expect("取色");
        assert_eq!(sw.coverage, 0.0, "灰阶图没有可用色相");
        assert_eq!(sw.saturation, 0.0);

        let _ = std::fs::remove_file(&blue_path);
        let _ = std::fs::remove_file(&grey_path);
    }
}
