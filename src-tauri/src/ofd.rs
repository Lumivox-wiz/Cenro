//! OFD（GB/T 33190，中文版式文档）阅读。
//!
//! OFD 本质是一个 zip：`OFD.xml` 指向 `Doc_N/Document.xml`，后者列出每页的
//! `Pages/Page_x/Content.xml`；页面内容由 TextObject / PathObject / ImageObject 组成，
//! 坐标单位是毫米。
//!
//! 这里不引第三方 OFD 引擎（`liteofd` 解包后 84MB，且只能在浏览器里跑），
//! 直接把每页转成 SVG：文字按 `TextCode` 的 x/y 与 `DeltaX` 逐字定位，
//! 线条按 `AbbreviatedData` 转成 SVG path。前端把 SVG 当图片显示，
//! 排版位置来自文件本身，不依赖字体度量，缺字体也不会串行。
//!
//! 覆盖范围：文字（含逐字偏移）、直线/曲线路径、填充与描边。
//! 未做：旋转对象、图像对象（扫描件）、数字签名校验。

use crate::error::{AppError, Result};
use roxmltree::{Document, Node};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

#[derive(Debug, Clone, serde::Serialize)]
pub struct OfdMeta {
    pub title: String,
    pub pages: usize,
    /// 首页宽高（毫米），用于前端占位与宽高比
    pub width: f32,
    pub height: f32,
}

/// 打开：只读目录与首页尺寸，不解析正文。
pub fn open(path: &Path) -> Result<OfdMeta> {
    let mut archive = open_zip(path)?;
    let doc_path = document_path(&mut archive)?;
    let xml = read_entry(&mut archive, &doc_path)?;
    let doc = Document::parse(&xml).map_err(|e| AppError::Other(format!("OFD 文档结构损坏：{e}")))?;

    let pages = page_locs(&doc);
    if pages.is_empty() {
        return Err(AppError::Other("OFD 里没有页面".into()));
    }
    let (w, h) = document_page_size(&doc).unwrap_or((210.0, 297.0));

    Ok(OfdMeta {
        title: doc_title(&doc).unwrap_or_default(),
        pages: pages.len(),
        width: w,
        height: h,
    })
}

/// 渲染某一页为 SVG 字符串。索引从 0 开始。
pub fn page_svg(path: &Path, index: usize) -> Result<String> {
    let mut archive = open_zip(path)?;
    let doc_path = document_path(&mut archive)?;
    let doc_xml = read_entry(&mut archive, &doc_path)?;
    let doc = Document::parse(&doc_xml)
        .map_err(|e| AppError::Other(format!("OFD 文档结构损坏：{e}")))?;
    let doc_dir = parent_dir(&doc_path);
    let pages = page_locs(&doc);
    let loc = pages
        .get(index)
        .ok_or_else(|| AppError::Other(format!("OFD 没有第 {} 页", index + 1)))?;
    let page_path = join_path(&doc_dir, loc);
    let page_xml = read_entry(&mut archive, &page_path)?;
    let page = Document::parse(&page_xml)
        .map_err(|e| AppError::Other(format!("OFD 第 {} 页损坏：{e}", index + 1)))?;

    // 每页可以有自己的 PhysicalBox（横向页很常见），优先用它
    let (w, h) = page_size(&page).or_else(|| document_page_size(&doc)).unwrap_or((210.0, 297.0));

    // 字体 ID → 字体名，取不到就用通用衬线
    let fonts = public_res_fonts(&mut archive, &doc, &doc_dir);

    let mut svg = String::with_capacity(96 * 1024);
    /*
     * 只给 viewBox，不给 width/height。
     *
     * 写成 `width="210mm" height="297mm"` 时，部分 Android WebView 会按本机 DPI 把 mm
     * 解析成固定的 px 高度，而 CSS 又把宽度改成 100%——两者比例对不上，图形就被 letterbox
     * 进一个比例错误的盒子里：页面看起来被压扁、上下留白、顶部内容像被截掉。
     * 没有 width/height 时，`width:100%; height:auto` 会按 viewBox 的比例算高度，任何引擎都一致。
     */
    svg.push_str(&format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" preserveAspectRatio="xMidYMid meet">"#
    ));
    svg.push_str(&format!(
        r##"<rect x="0" y="0" width="{w}" height="{h}" fill="#ffffff"/>"##
    ));

    for node in page.descendants() {
        match node.tag_name().name() {
            "TextObject" => render_text_object(&mut svg, node, &fonts),
            "PathObject" => render_path_object(&mut svg, node),
            _ => {}
        }
    }

    svg.push_str("</svg>");
    Ok(svg)
}

// ---------------- 容器与目录 ----------------

fn open_zip(path: &Path) -> Result<ZipArchive<File>> {
    let file = File::open(path)?;
    ZipArchive::new(file).map_err(|e| AppError::Other(format!("OFD 不是有效的压缩包：{e}")))
}

fn read_entry(archive: &mut ZipArchive<File>, name: &str) -> Result<String> {
    let mut f = archive
        .by_name(name)
        .map_err(|_| AppError::Other(format!("OFD 缺少 {name}")))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(crate::util::decode_text(&buf).0)
}

/// `OFD.xml` 里的 DocRoot，如 `Doc_0/Document.xml`。
fn document_path(archive: &mut ZipArchive<File>) -> Result<String> {
    let xml = read_entry(archive, "OFD.xml")?;
    let doc = Document::parse(&xml)
        .map_err(|e| AppError::Other(format!("OFD 目录损坏：{e}")))?;
    doc.descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "DocRoot")
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Other("OFD 目录里没有 DocRoot".into()))
}

fn parent_dir(path: &str) -> String {
    path.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default()
}

fn join_path(dir: &str, name: &str) -> String {
    let name = name.trim_start_matches("./");
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

fn page_locs(doc: &Document) -> Vec<String> {
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "Page")
        .filter_map(|n| n.attribute("BaseLoc").map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect()
}

fn doc_title(doc: &Document) -> Option<String> {
    doc.descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "Title")
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn document_page_size(doc: &Document) -> Option<(f32, f32)> {
    let node = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "PhysicalBox")?;
    parse_box(node.text()?)
}

fn page_size(page: &Document) -> Option<(f32, f32)> {
    let node = page
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "PhysicalBox")?;
    parse_box(node.text()?)
}

/// `"0 0 210 297"` → 宽高
fn parse_box(text: &str) -> Option<(f32, f32)> {
    let nums: Vec<f32> = text
        .split_whitespace()
        .filter_map(|t| t.parse().ok())
        .collect();
    if nums.len() < 4 {
        return None;
    }
    let (w, h) = (nums[2] - nums[0], nums[3] - nums[1]);
    (w > 0.0 && h > 0.0).then_some((w, h))
}

/// PublicRes 里的字体表：ID → 字体名
fn public_res_fonts(
    archive: &mut ZipArchive<File>,
    doc: &Document,
    doc_dir: &str,
) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Some(res) = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "PublicRes")
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
    else {
        return map;
    };

    let path = join_path(doc_dir, &res);
    let Ok(xml) = read_entry(archive, &path) else {
        return map;
    };
    let Ok(resdoc) = Document::parse(&xml) else {
        return map;
    };
    for font in resdoc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "Font")
    {
        let (Some(id), Some(name)) = (font.attribute("ID"), font.attribute("FontName")) else {
            continue;
        };
        map.insert(id.to_string(), name.to_string());
    }
    map
}

// ---------------- 文字 ----------------

fn render_text_object(
    out: &mut String,
    node: Node,
    fonts: &std::collections::HashMap<String, String>,
) {
    let Some(boundary) = node.attribute("Boundary").and_then(parse_floats4) else {
        return;
    };
    let (bx, by, _, _) = boundary;
    let size: f32 = node
        .attribute("Size")
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(3.5);
    let family = node
        .attribute("Font")
        .and_then(|id| fonts.get(id))
        .map(|name| css_family(name))
        .unwrap_or_else(|| "serif".to_string());
    let fill = child_color(node, "FillColor").unwrap_or_else(|| "#000000".to_string());

    for code in node
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "TextCode")
    {
        let Some(text) = code.text() else { continue };
        if text.trim().is_empty() {
            continue;
        }
        let x: f32 = code
            .attribute("X")
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0.0);
        let y: f32 = code
            .attribute("Y")
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(size);
        let chars: Vec<char> = text.chars().collect();
        let expected = chars.len().saturating_sub(1);
        let deltas = code
            .attribute("DeltaX")
            .map(|raw| pick_deltas(raw, expected))
            .unwrap_or_default();

        let content = escape_xml(&chars.iter().collect::<String>());

        /*
         * 拿不到与字数匹配的偏移表时，整段交给字体自身排版：
         * 位置会与原件差一点点，但绝不会叠字——叠字比字距不齐难看得多。
         */
        if deltas.len() != expected {
            out.push_str(&format!(
                r#"<text x="{}" y="{}" font-size="{}" font-family="{}" fill="{}">{content}</text>"#,
                trim_float(bx + x),
                trim_float(by + y),
                trim_float(size),
                family,
                fill
            ));
            continue;
        }

        // 逐字给 x 坐标：不依赖字体度量，缺字体也不会串位
        let mut xs = String::with_capacity(chars.len() * 8);
        let mut cursor = bx + x;
        for i in 0..chars.len() {
            if i > 0 {
                cursor += deltas[i - 1];
                xs.push(' ');
            }
            xs.push_str(&trim_float(cursor));
        }

        out.push_str(&format!(
            r#"<text x="{xs}" y="{}" font-size="{}" font-family="{}" fill="{}">{content}</text>"#,
            trim_float(by + y),
            trim_float(size),
            family,
            fill
        ));
    }
}

/// `DeltaX` 展开，取长度正好等于 `expected`（字数 − 1）的那一种解释。
///
/// OFD 的 `g` 有两种写法，而且都真实存在：
///
/// - `g <n> <v>`：**数值 v 重复 n 次**（GB/T 33190 的写法，WPS 导出的公文用的就是这个）；
/// - `<v> g <n>`：前一个值再重复 n 次（早期实现常这么理解）。
///
/// 只看字符串分不清 `g 2 5.7572` 里的 5.7572 是「被重复的值」还是「下一个独立增量」，
/// 所以两种都展开，用字数这个外部约束来选：字数对得上的才是对的。
/// 都对不上就返回空表，由调用方退回字体自适应排版（宁可字距不齐，不能叠字）。
fn pick_deltas(raw: &str, expected: usize) -> Vec<f32> {
    let trailing = expand_deltas(raw, false);
    if trailing.len() == expected {
        return trailing;
    }
    let leading = expand_deltas(raw, true);
    if leading.len() == expected {
        return leading;
    }
    Vec::new()
}

/// `value_after` = true 表示按 `g <n> <v>` 读（v 重复 n 次）；
/// false 表示按 `<v> g <n>` 读（前一个值再补 n−1 个）。
fn expand_deltas(raw: &str, value_after: bool) -> Vec<f32> {
    let mut out: Vec<f32> = Vec::new();
    let mut tokens = raw.split_whitespace().peekable();

    while let Some(tok) = tokens.next() {
        if tok != "g" {
            if let Ok(value) = tok.parse::<f32>() {
                out.push(value);
            }
            continue;
        }

        let count: usize = tokens.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        if value_after {
            let value = match tokens.peek().and_then(|t| t.parse::<f32>().ok()) {
                Some(v) => {
                    tokens.next();
                    v
                }
                None => out.last().copied().unwrap_or(0.0),
            };
            for _ in 0..count {
                out.push(value);
            }
        } else {
            /*
             * 重复的是「前一个值」，所以只补 n−1 个。
             * 没有前值时不能补 0：`g 2 5.7572` 会因此变成 [0, 5.7572]，
             * 恰好凑够两个间隔却让前两个字落在同一个 x 上——正是旧版叠字的成因。
             */
            let Some(last) = out.last().copied() else {
                continue;
            };
            for _ in 0..count.saturating_sub(1) {
                out.push(last);
            }
        }
    }
    out
}

fn child_color(node: Node, tag: &str) -> Option<String> {
    let value = node
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == tag)?
        .attribute("Value")?;
    let nums: Vec<f32> = value
        .split_whitespace()
        .filter_map(|t| t.parse().ok())
        .collect();
    if nums.len() < 3 {
        return None;
    }
    let alpha = if nums.len() >= 4 { nums[3] / 255.0 } else { 1.0 };
    Some(format!(
        "rgba({},{},{},{})",
        nums[0].round() as i32,
        nums[1].round() as i32,
        nums[2].round() as i32,
        (alpha * 100.0).round() / 100.0
    ))
}

// ---------------- 路径 ----------------

fn render_path_object(out: &mut String, node: Node) {
    let Some((bx, by, _, _)) = node.attribute("Boundary").and_then(parse_floats4) else {
        return;
    };
    let Some(data) = node
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "AbbreviatedData")
        .and_then(|n| n.text())
    else {
        return;
    };

    let d = path_data(data, bx, by);
    if d.is_empty() {
        return;
    }

    let has_stroke = node.attribute("Stroke") == Some("true");
    let has_fill = node.attribute("Fill") == Some("true");
    let width: f32 = node
        .attribute("LineWidth")
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0.35);
    let stroke = child_color(node, "StrokeColor").unwrap_or_else(|| "#000000".to_string());
    let fill = child_color(node, "FillColor").unwrap_or_else(|| "#000000".to_string());

    out.push_str(&format!(
        r#"<path d="{}" fill="{}" stroke="{}" stroke-width="{}"/>"#,
        d,
        if has_fill { fill.as_str() } else { "none" },
        if has_stroke { stroke.as_str() } else { "none" },
        trim_float(width)
    ));
}

/// `M 0 1 L 10 1` → SVG path（平移到对象的 Boundary 原点）。
fn path_data(raw: &str, ox: f32, oy: f32) -> String {
    let mut d = String::with_capacity(raw.len());
    let mut tokens = raw.split_whitespace().peekable();
    let mut cmd = 'M';

    while let Some(tok) = tokens.next() {
        if let Some(c) = tok.chars().next() {
            if c.is_ascii_alphabetic() {
                cmd = c.to_ascii_uppercase();
                match cmd {
                    'Z' => {
                        d.push_str(" Z");
                        continue;
                    }
                    'M' | 'L' | 'C' | 'Q' => {
                        d.push(' ');
                        d.push(cmd);
                        continue;
                    }
                    // 圆弧等未实现的指令：整段放弃，避免画出错位的线
                    _ => return String::new(),
                }
            }
        }

        let Ok(x) = tok.parse::<f32>() else {
            continue;
        };
        let Some(y) = tokens.next().and_then(|t| t.parse::<f32>().ok()) else {
            continue;
        };
        d.push(' ');
        d.push_str(&trim_float(x + ox));
        d.push(' ');
        d.push_str(&trim_float(y + oy));
    }

    d.trim().to_string()
}

// ---------------- 工具 ----------------

fn parse_floats4(raw: &str) -> Option<(f32, f32, f32, f32)> {
    let nums: Vec<f32> = raw
        .split_whitespace()
        .filter_map(|t| t.parse().ok())
        .collect();
    if nums.len() < 4 {
        return None;
    }
    Some((nums[0], nums[1], nums[2], nums[3]))
}

/// 去掉多余小数位：SVG 里 7.7000003 只会让文件变大。
fn trim_float(v: f32) -> String {
    let rounded = (v * 1000.0).round() / 1000.0;
    let s = format!("{rounded}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// 字体名要嵌进 `font-family="..."`，族名用单引号，避免和外层双引号打架。
fn css_family(name: &str) -> String {
    /*
     * 回退链要同时覆盖 Windows 与 Android：
     * 安卓上没有仿宋 / 黑体 / 宋体，只有 Noto CJK（或无衬线回退），
     * 不给族名的话会落到系统默认无衬线，字宽变化会让整行看起来「偏」。
     */
    let fallback = if name.contains("黑体") || name.contains("雅黑") || name.contains("黑") {
        "'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', \
         'Droid Sans Fallback', sans-serif"
    } else if name.contains("楷") {
        "'KaiTi', 'Kaiti SC', 'Noto Serif CJK SC', serif"
    } else if name.contains("仿宋") || name.contains("FangSong") {
        "'FangSong', 'FangSong_GB2312', 'STFangsong', 'Noto Serif CJK SC', serif"
    } else {
        "'SimSun', 'Songti SC', 'Noto Serif CJK SC', serif"
    };
    format!("'{}', {}", escape_attr(name), fallback)
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attr(s: &str) -> String {
    escape_xml(s).replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_repeat_deltas() {
        // 没有 g 时逐项读
        assert_eq!(expand_deltas("5.6 5.6", false), vec![5.6, 5.6]);
        assert!(expand_deltas("", false).is_empty());
        // `v g n`：前一个值再补 n−1 个
        assert_eq!(expand_deltas("7.7468 7.7892 g 2", false), vec![7.7468, 7.7892, 7.7892]);
        // `g n v`：v 重复 n 次（WPS 导出的公文用的是这种）
        assert_eq!(expand_deltas("g 3 5.8842", true), vec![5.8842, 5.8842, 5.8842]);
        assert_eq!(
            expand_deltas("5.8418 5.8842 g 2 5.8418", true),
            vec![5.8418, 5.8842, 5.8418, 5.8418]
        );
    }

    /// 真实公文里的三种写法，都必须展开成「字数 − 1」个间隔。
    ///
    /// 「第一章」的 `g 2 5.7572` 就是旧版叠字的元凶：
    /// 按「重复前值」读会得到 [0, 5.7572]，第一、二个字落在同一个 x 上。
    #[test]
    fn picks_delta_interpretation_by_char_count() {
        // 第一章（3 字 → 2 个间隔）
        assert_eq!(pick_deltas("g 2 5.7572", 2), vec![5.7572, 5.7572]);
        // 行政事业单位，包括（9 字 → 8 个）
        assert_eq!(
            pick_deltas("g 7 5.7572 5.7996", 8),
            vec![5.7572; 7].into_iter().chain([5.7996]).collect::<Vec<_>>()
        );
        // 资产处置管理办法（8 字 → 7 个），g 在中间
        assert_eq!(
            pick_deltas("g 3 5.8842 5.9267 g 3 5.8842", 7),
            vec![
                5.8842, 5.8842, 5.8842, 5.9267, 5.8842, 5.8842, 5.8842
            ]
        );
        // 对不上就返回空表，让调用方退回字体排版
        assert!(pick_deltas("g 2 5.7572", 9).is_empty());
    }

    #[test]
    fn translates_path_coordinates() {
        assert_eq!(path_data("M 0 1 L 10 1", 5.0, 5.0), "M 5 6 L 15 6");
        // 未支持的弧线整段放弃
        assert_eq!(path_data("M 0 1 A 2 2 0 0 1 4 4", 0.0, 0.0), "");
    }

    #[test]
    fn trims_float_noise() {
        assert_eq!(trim_float(7.7000003), "7.7");
        assert_eq!(trim_float(12.0), "12");
        assert_eq!(trim_float(0.0423), "0.042");
    }

    #[test]
    fn parses_page_box() {
        assert_eq!(parse_box("0 0 210 297"), Some((210.0, 297.0)));
        assert_eq!(parse_box("bad"), None);
    }

    /// 把某一页导出成文件，方便用浏览器核对排版：
    /// `CENRO_OFD_SAMPLE=<ofd> CENRO_OFD_OUT=<svg> cargo test --lib dump_page -- --ignored`
    #[test]
    #[ignore = "开发期辅助：需要 CENRO_OFD_SAMPLE 与 CENRO_OFD_OUT"]
    fn dump_page() {
        let (Ok(src), Ok(out)) = (
            std::env::var("CENRO_OFD_SAMPLE"),
            std::env::var("CENRO_OFD_OUT"),
        ) else {
            return;
        };
        let index: usize = std::env::var("CENRO_OFD_PAGE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let svg = page_svg(Path::new(&src), index).unwrap();
        std::fs::write(&out, svg).unwrap();
        println!("wrote {out}");
    }

    /// 真实样本：`CENRO_OFD_SAMPLE=<path> cargo test --lib ofd -- --ignored --nocapture`
    #[test]
    #[ignore = "需要真实 OFD 样本：设置 CENRO_OFD_SAMPLE"]
    fn renders_real_ofd_page() {
        let Ok(path) = std::env::var("CENRO_OFD_SAMPLE") else {
            return;
        };
        let meta = open(Path::new(&path)).expect("应能打开");
        assert!(meta.pages > 0);
        let svg = page_svg(Path::new(&path), 0).expect("应能渲染首页");
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("<text"), "首页应有文字");
        println!("pages={} size={}x{} svg_len={}", meta.pages, meta.width, meta.height, svg.len());
    }
}
