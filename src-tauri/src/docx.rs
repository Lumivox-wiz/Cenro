use crate::error::{AppError, Result};
use crate::text::TextBook;
use crate::text::{self, Chapter};
use base64::prelude::*;
use roxmltree::Node;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

/// Word → HTML：保留对齐、字号、粗斜体、列表缩进、表格与内嵌图片。
///
/// 之前只抽文字，封面页的居中、标题字号、图片全丢，读起来像 txt。
/// 这里把段落级（对齐 / 缩进）与字符级（粗体 / 斜体 / 下划线 / 字号 / 颜色）样式
/// 落到内联 style，图片按 `word/media` 原样转 data URL，前端复用 HTML 阅读器。
pub fn to_html(path: &Path) -> Result<String> {
    let xml = read_part(path, "word/document.xml")?;
    let doc = roxmltree::Document::parse(&xml)
        .map_err(|e| AppError::Other(format!("DOCX 解析失败：{e}")))?;
    let media = read_media(path)?;

    // pre-wrap：Word 里用空格排的封面（「作者姓名：___ 黄昊」）靠它才不会塌成一格
    let mut out = String::with_capacity(xml.len() / 2);
    out.push_str(r#"<div class="docx-body">"#);
    if let Some(body) = doc.descendants().find(|n| is_w(n, "body")) {
        render_blocks(&mut out, body, &media);
    }
    out.push_str("</div>");
    Ok(out)
}

type Media = HashMap<String, (String, String)>; // rId → (mime, base64)

fn render_blocks(out: &mut String, parent: Node, media: &Media) {
    for child in parent.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "p" => render_paragraph(out, child, media),
            "tbl" => render_table(out, child, media),
            // 内容控件（目录、封面占位）里面还是段落，继续往下走
            "sdt" | "sdtContent" => render_blocks(out, child, media),
            _ => {}
        }
    }
}

fn render_paragraph(out: &mut String, p: Node, media: &Media) {
    let ppr = p.children().find(|n| is_w(n, "pPr"));
    let style_id = ppr
        .and_then(|pr| pr.children().find(|n| is_w(n, "pStyle")))
        .and_then(|s| s.attribute("val"))
        .unwrap_or("");

    let mut css = String::new();
    if let Some(jc) = ppr
        .and_then(|pr| pr.children().find(|n| is_w(n, "jc")))
        .and_then(|n| n.attribute("val"))
    {
        let align = match jc {
            "center" => "center",
            "right" | "end" => "right",
            "both" | "distribute" => "justify",
            _ => "",
        };
        if !align.is_empty() {
            css.push_str(&format!("text-align:{align};"));
        }
    }
    // 首行缩进：twips → px（1pt = 20twips，1px = 0.75pt）
    if let Some(ind) = ppr
        .and_then(|pr| pr.children().find(|n| is_w(n, "ind")))
        .and_then(|n| n.attribute("firstLine"))
        .and_then(|v| v.parse::<f32>().ok())
    {
        css.push_str(&format!("text-indent:{}px;", (ind / 20.0 * 1.333).round()));
    }

    let level = heading_level(style_id);
    let tag = match level {
        1 => "h1",
        2 => "h2",
        3 => "h3",
        _ => "p",
    };

    let body = render_inline(p, media);
    if body.trim().is_empty() {
        return;
    }

    if css.is_empty() {
        out.push_str(&format!("<{tag}>{body}</{tag}>"));
    } else {
        out.push_str(&format!(r#"<{tag} style="{css}">{body}</{tag}>"#));
    }
}

/// Word 内置标题样式 id 是 Heading1 / 标题 1；也认 Title。
fn heading_level(style_id: &str) -> u8 {
    let lower = style_id.to_ascii_lowercase();
    if lower == "title" || style_id == "标题" {
        return 1;
    }
    if let Some(rest) = lower.strip_prefix("heading") {
        return match rest.trim() {
            "1" => 1,
            "2" => 2,
            "3" => 3,
            _ => 0,
        };
    }
    0
}

fn render_inline(node: Node, media: &Media) -> String {
    let mut out = String::new();
    for child in node.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "r" => out.push_str(&render_run(child, media)),
            // 超链接、域、修订里的文字都要读出来
            "hyperlink" | "fldSimple" | "ins" | "smartTag" => {
                out.push_str(&render_inline(child, media))
            }
            _ => {}
        }
    }
    out
}

fn render_run(run: Node, media: &Media) -> String {
    let mut html = String::new();
    let props = run.children().find(|n| is_w(n, "rPr"));
    let bold = props
        .map(|pr| pr.children().any(|n| is_w(&n, "b")))
        .unwrap_or(false);
    let italic = props
        .map(|pr| pr.children().any(|n| is_w(&n, "i")))
        .unwrap_or(false);
    let underline = props
        .map(|pr| pr.children().any(|n| is_w(&n, "u")))
        .unwrap_or(false);
    let size_pt = props
        .and_then(|pr| pr.children().find(|n| is_w(n, "sz")))
        .and_then(|n| n.attribute("val"))
        .and_then(|v| v.parse::<f32>().ok())
        .map(|half| half / 2.0);
    let color = props
        .and_then(|pr| pr.children().find(|n| is_w(n, "color")))
        .and_then(|n| n.attribute("val"))
        .filter(|v| *v != "auto" && v.len() == 6)
        .map(|v| format!("#{v}"));

    for child in run.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "t" => {
                if let Some(t) = child.text() {
                    html.push_str(&escape(t));
                }
            }
            "tab" => html.push_str("&emsp;"),
            "br" | "cr" => html.push_str("<br/>"),
            /*
             * 图片常被包在 `mc:AlternateContent` 里（Word 为兼容性加的包装），
             * 直接子节点是 mc:Choice 而不是 drawing，所以要一起认。
             */
            "drawing" | "pict" | "AlternateContent" => {
                if let Some(img) = inline_image(child, media) {
                    html.push_str(&img);
                }
            }
            _ => {}
        }
    }

    if html.is_empty() {
        return html;
    }

    let mut css = String::new();
    if let Some(pt) = size_pt {
        // Word 的磅值直接落到 px，网页与纸张的观感接近
        css.push_str(&format!("font-size:{}px;", (pt * 1.333).round()));
    }
    if let Some(c) = color {
        css.push_str(&format!("color:{c};"));
    }

    if !css.is_empty() {
        html = format!(r#"<span style="{css}">{html}</span>"#);
    }
    if bold {
        html = format!("<strong>{html}</strong>");
    }
    if italic {
        html = format!("<em>{html}</em>");
    }
    if underline {
        html = format!("<u>{html}</u>");
    }
    html
}

/// 内嵌图片：`a:blip r:embed="rIdN"` + `wp:extent` 的 EMU 尺寸
fn inline_image(node: Node, media: &Media) -> Option<String> {
    /*
     * `r:embed` 是带命名空间的属性，`attribute("embed")` 按限定名查不到，
     * 而前缀在不同工具里可能不是 r，所以按本地名扫一遍。
     */
    let rid = node
        .descendants()
        .find(|n| n.tag_name().name() == "blip")
        .and_then(|n| attr_local(n, "embed"))
        .or_else(|| {
            node.descendants()
                .find(|n| n.tag_name().name() == "imagedata")
                .and_then(|n| attr_local(n, "id"))
        })?;
    let (mime, data) = media.get(rid)?;

    let (mut w, mut h) = (0f32, 0f32);
    if let Some(extent) = node.descendants().find(|n| n.tag_name().name() == "extent") {
        let cx = extent.attribute("cx").and_then(|v| v.parse::<f32>().ok());
        let cy = extent.attribute("cy").and_then(|v| v.parse::<f32>().ok());
        if let (Some(cx), Some(cy)) = (cx, cy) {
            // EMU → px
            w = cx / 9525.0;
            h = cy / 9525.0;
        }
    }
    let _ = h;

    let style = if w > 0.0 {
        format!(r#" style="width:{}px""#, (w.round() as i32).min(1000))
    } else {
        String::new()
    };
    Some(format!(
        r#"<img src="data:{mime};base64,{data}"{style} alt=""/>"#
    ))
}

fn render_table(out: &mut String, table: Node, media: &Media) {
    out.push_str("<table>");
    for row in table
        .children()
        .filter(|n| is_w(n, "tr"))
    {
        out.push_str("<tr>");
        for cell in row.children().filter(|n| is_w(n, "tc")) {
            let span = cell
                .children()
                .find(|n| is_w(n, "tcPr"))
                .and_then(|pr| pr.children().find(|n| is_w(n, "gridSpan")))
                .and_then(|n| n.attribute("val"))
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(1);
            let attr = if span > 1 {
                format!(r#" colspan="{span}""#)
            } else {
                String::new()
            };
            out.push_str(&format!("<td{attr}>"));
            let mut first = true;
            for p in cell.children().filter(|n| is_w(n, "p")) {
                if !first {
                    out.push_str("<br/>");
                }
                first = false;
                out.push_str(&render_inline(p, media));
            }
            out.push_str("</td>");
        }
        out.push_str("</tr>");
    }
    out.push_str("</table>");
}

/// 读取 `word/_rels/document.xml.rels` 并把所有 media 转成 data URL 备用。
fn read_media(path: &Path) -> Result<Media> {
    let mut out: Media = HashMap::new();
    let rels = read_part(path, "word/_rels/document.xml.rels").unwrap_or_default();
    if rels.is_empty() {
        return Ok(out);
    }
    let Ok(doc) = roxmltree::Document::parse(&rels) else {
        return Ok(out);
    };

    let targets: Vec<(String, String)> = doc
        .descendants()
        .filter(|n| n.tag_name().name() == "Relationship")
        .filter_map(|n| {
            let id = n.attribute("Id")?.to_string();
            let target = n.attribute("Target")?.trim_start_matches('/').to_string();
            Some((id, format!("word/{target}")))
        })
        .collect();

    let file = std::fs::File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    for (id, name) in targets {
        let Ok(mut entry) = archive.by_name(&name) else {
            continue;
        };
        let mime = mime_of(&name);
        let Some(mime) = mime else { continue };
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_err() {
            continue;
        }
        out.insert(id, (mime.to_string(), BASE64_STANDARD.encode(&buf)));
    }
    Ok(out)
}

fn mime_of(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// 按本地名取属性值（忽略命名空间前缀）。
fn attr_local<'a>(node: Node<'a, 'a>, name: &str) -> Option<&'a str> {
    node.attributes()
        .find(|a| a.name() == name)
        .map(|a| a.value())
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Word 文档：正文在 `word/document.xml`，段落为 `<w:p>`，样式名在 `<w:pStyle w:val>`。
/// 只取文字与段落结构——表格按单元格顺序展开成行，图片与批注忽略。
pub fn load(path: &Path) -> Result<(TextBook, String)> {
    let xml = read_part(path, "word/document.xml")?;
    let doc = roxmltree::Document::parse(&xml)
        .map_err(|e| AppError::Other(format!("DOCX 解析失败：{e}")))?;

    let mut text = String::new();
    let mut chapters: Vec<Chapter> = Vec::new();
    let mut chapter_title: Option<String> = None;
    let mut chapter_start = 0usize;

    for p in doc.descendants().filter(|n| is_w(n, "p")) {
        let body = paragraph_text(&p);
        let heading = paragraph_is_heading(&p);

        if heading && !body.trim().is_empty() {
            // 上一个标题到这里的正文收尾
            let end = text.len();
            if let Some(title) = chapter_title.take() {
                if end > chapter_start && !text[chapter_start..end].trim().is_empty() {
                    chapters.push(Chapter {
                        title,
                        start: chapter_start,
                        end,
                    });
                }
            }
            text.push('\n');
            chapter_title = Some(body.trim().to_string());
            chapter_start = text.len();
            text.push_str(body.trim());
            text.push('\n');
            continue;
        }

        if body.trim().is_empty() {
            continue;
        }
        text.push_str(&body);
        text.push('\n');
    }

    let end = text.len();
    if let Some(title) = chapter_title.take() {
        if end > chapter_start && !text[chapter_start..end].trim().is_empty() {
            chapters.push(Chapter {
                title,
                start: chapter_start,
                end,
            });
        }
    }

    // 没有标题样式时退回按行扫描「第X章」，再不行按固定字节切
    if chapters.is_empty() {
        let chapters = text::split_chapters(&text);
        return Ok((
            TextBook {
                encoding: "utf-8".into(),
                total_bytes: text.len(),
                chapters,
            },
            text,
        ));
    }

    // 首个标题之前的内容（封面页、目录页）并入第一章，避免阅读时丢失
    if chapters[0].start > 0 {
        chapters[0].start = 0;
    }

    Ok((
        TextBook {
            encoding: "utf-8".into(),
            total_bytes: text.len(),
            chapters,
        },
        text,
    ))
}

fn read_part(path: &Path, name: &str) -> Result<String> {
    let file = std::fs::File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    let mut entry = archive
        .by_name(name)
        .map_err(|_| AppError::Other("文件不是有效的 DOCX".into()))?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn is_w(node: &roxmltree::Node, name: &str) -> bool {
    node.is_element() && node.tag_name().name() == name
}

/// 段落文字：`<w:t>` 是文字，`<w:tab/>` 与 `<w:br/>` 是排版符。
/// 中文 Word 常把一句话拆成多个 run，直接顺序拼接即可。
fn paragraph_text(p: &roxmltree::Node) -> String {
    let mut out = String::new();
    for node in p.descendants() {
        if !node.is_element() {
            continue;
        }
        match node.tag_name().name() {
            "t" => {
                if let Some(t) = node.text() {
                    out.push_str(t);
                }
            }
            "tab" => out.push('\t'),
            "br" => out.push('\n'),
            _ => {}
        }
    }
    out
}

/// 标题判定：样式 id 以 Heading / 标题 开头。Word 内置样式的 id 就是 `Heading1`，
/// 中文版界面显示为「标题 1」但底层 id 仍是 Heading1，两种都认。
fn paragraph_is_heading(p: &roxmltree::Node) -> bool {
    let style = p
        .children()
        .find(|n| is_w(n, "pPr"))
        .and_then(|pr| pr.children().find(|n| is_w(n, "pStyle")))
        .and_then(|s| s.attribute("val"))
        .unwrap_or("");
    let lower = style.to_ascii_lowercase();
    lower.starts_with("heading") || style.starts_with("标题")
}

/// 封面：`word/media/` 下的第一张图。
pub fn cover_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    let file = std::fs::File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(i) else {
            continue;
        };
        let Ok(raw_name) = entry.name() else {
            continue;
        };
        let name = raw_name.to_string();
        if !name.starts_with("word/media/") {
            continue;
        }
        if !crate::util::is_image_path(Path::new(&name)) {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        return Ok(Some(buf));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 开发期辅助：把 to_html 的结果写到文件，方便用浏览器核对排版。
    /// `CENRO_DOCX_SAMPLE=<docx> CENRO_DOCX_OUT=<html> cargo test --lib dump_html -- --ignored`
    #[test]
    #[ignore = "开发期辅助：需要 CENRO_DOCX_SAMPLE 与 CENRO_DOCX_OUT"]
    fn dump_html() {
        let (Ok(src), Ok(out)) = (
            std::env::var("CENRO_DOCX_SAMPLE"),
            std::env::var("CENRO_DOCX_OUT"),
        ) else {
            return;
        };
        let html = to_html(Path::new(&src)).unwrap();
        println!("imgs={} len={}", html.matches("<img").count(), html.len());
        std::fs::write(&out, html).unwrap();
        println!("wrote {out}");
    }

    #[test]
    fn extracts_paragraphs_and_headings() {
        let dir = std::env::temp_dir().join("reader-docx");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.docx");

        let doc = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 起</w:t></w:r></w:p>
  <w:p><w:r><w:t>正文一</w:t></w:r><w:r><w:t>，续写。</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>第二节</w:t></w:r></w:p>
  <w:p><w:r><w:t>正文二</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>换行后</w:t></w:r></w:p>
</w:body></w:document>"#;

        {
            let file = std::fs::File::create(&path).unwrap();
            let mut zw = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("word/document.xml", opts).unwrap();
            zw.write_all(doc.as_bytes()).unwrap();
            zw.finish().unwrap();
        }

        let (meta, text) = load(&path).unwrap();
        assert_eq!(meta.chapters.len(), 2);
        assert_eq!(meta.chapters[0].title, "第一章 起");
        assert_eq!(meta.chapters[1].title, "第二节");
        assert!(text.contains("正文一，续写。"));
        assert!(text.contains("换行后"));
    }
}
