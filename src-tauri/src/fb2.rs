use crate::error::{AppError, Result};
use crate::text::TextBook;
use crate::text::{self, Chapter};
use base64::Engine;
use std::path::Path;

/// FictionBook 2：单文件 XML，正文在 `<body>`，章节是嵌套的 `<section>`。
/// 只取排版需要的东西（标题、段落、空行），样式与脚注链按纯文本降级处理。
pub fn load(path: &Path) -> Result<(TextBook, String)> {
    let raw = std::fs::read(path)?;
    let xml = String::from_utf8_lossy(&raw);

    let doc = roxmltree::Document::parse(&xml)
        .map_err(|e| AppError::Other(format!("FB2 解析失败：{e}")))?;
    let root = doc.root_element();
    let body = root
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "body")
        .ok_or_else(|| AppError::Other("FB2 缺少正文".into()))?;

    let mut text = String::new();
    let mut chapters: Vec<Chapter> = Vec::new();

    for section in body.children().filter(|n| n.is_element()) {
        let start = text.len();
        let title = section_title(&section).unwrap_or_else(|| {
            if chapters.is_empty() {
                "全文".to_string()
            } else {
                format!("第 {} 节", chapters.len() + 1)
            }
        });

        push_section(&section, &mut text, true);
        let end = text.len();

        if text[start..end].trim().is_empty() {
            // 纯图片页之类的空节不单独成章，长度倒回原处
            text.truncate(start);
            continue;
        }

        chapters.push(Chapter { title, start, end });
    }

    if chapters.is_empty() {
        let mut plain = String::new();
        push_section(&body, &mut plain, false);
        let chapters = text::split_chapters(&plain);
        return Ok((
            TextBook {
                encoding: "utf-8".into(),
                total_bytes: plain.len(),
                chapters,
            },
            plain,
        ));
    }

    // 相邻章节之间补一个空行，避免标题与上一章末段粘连
    Ok((
        TextBook {
            encoding: "utf-8".into(),
            total_bytes: text.len(),
            chapters,
        },
        text,
    ))
}

/// 节标题：`<title>` 里可能有多段 `<p>`，拼成一行。
fn section_title(node: &roxmltree::Node) -> Option<String> {
    let title = node
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "title")?;
    let mut text = String::new();
    for p in title.children().filter(|n| n.is_element()) {
        let line = p.text().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(line);
    }
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// 递归展开一个节。`skip_own_title` 用于顶层：标题已经作为章节名取走，
/// 正文里不再重复一遍。
fn push_section(node: &roxmltree::Node, out: &mut String, skip_own_title: bool) {
    for child in node.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "title" if skip_own_title => {}
            "title" => {
                if let Some(t) = section_title(node) {
                    out.push_str(&t);
                    out.push('\n');
                }
            }
            "section" => push_section(&child, out, false),
            "p" | "subtitle" | "v" | "text-author" => {
                let line = collect_text(&child);
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                out.push_str(line);
                out.push('\n');
            }
            "empty-line" => out.push('\n'),
            _ => {}
        }
    }

    // 段落之间用空行分隔：纯文本阅读器靠它认段落
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push('\n');
    }
}

/// 拼接节点自身的文本（`<p>` 里可能夹 `<strong>` / `<emphasis>` 等行内标签）。
fn collect_text(node: &roxmltree::Node) -> String {
    let mut out = String::new();
    for d in node.descendants() {
        if let Some(t) = d.text() {
            out.push_str(t);
        }
    }
    out
}

/// 内嵌封面：`<coverpage><image l:href="#cover.jpg"/>` →
/// 对应 `<binary id="cover.jpg">` 的 base64。
pub fn cover_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    let raw = std::fs::read(path)?;
    let xml = String::from_utf8_lossy(&raw);
    let doc = roxmltree::Document::parse(&xml)
        .map_err(|e| AppError::Other(format!("FB2 解析失败：{e}")))?;
    let root = doc.root_element();

    // 先找 coverpage 引用的 id；没有 coverpage 时退回第一个图片 binary
    let mut wanted: Option<String> = None;
    for node in root.descendants().filter(|n| n.is_element()) {
        if node.tag_name().name() != "image" {
            continue;
        }
        let href = node
            .attribute("href")
            .or_else(|| node.attribute(("http://www.w3.org/1999/xlink", "href")))
            .unwrap_or("");
        if let Some(id) = href.strip_prefix('#') {
            wanted = Some(id.to_string());
            break;
        }
    }

    let engine = base64::engine::general_purpose::STANDARD;
    for bin in root.children().filter(|n| n.is_element()) {
        if bin.tag_name().name() != "binary" {
            continue;
        }
        let id = bin.attribute("id").unwrap_or("");
        if let Some(w) = &wanted {
            if id != w {
                continue;
            }
        }
        let data: String = bin
            .text()
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        if let Ok(bytes) = engine.decode(data) {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

/// 书名与作者：`<description><title-info>` 里。扫描阶段拿不到，首次打开时回写库。
pub fn title_author(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(raw) = std::fs::read(path) else {
        return (None, None);
    };
    let xml = String::from_utf8_lossy(&raw);
    let Ok(doc) = roxmltree::Document::parse(&xml) else {
        return (None, None);
    };
    let root = doc.root_element();

    let title = root
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "book-title")
        .and_then(|n| n.text())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());

    let author = root
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "author")
        .map(|node| {
            let mut parts: Vec<String> = Vec::new();
            for field in ["first-name", "middle-name", "last-name", "nickname"] {
                if let Some(v) = node
                    .children()
                    .find(|n| n.is_element() && n.tag_name().name() == field)
                    .and_then(|n| n.text())
                    .map(|t| t.trim())
                    .filter(|t| !t.is_empty())
                {
                    parts.push(v.to_string());
                }
            }
            // 中文书常见「姓 名」顺序，西文常见「名 姓」；FB2 没有字段能区分，
            // 按「名 姓」拼接即可，扫一眼能认人就行
            parts.join(" ")
        })
        .filter(|s| !s.is_empty());

    (title, author)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fb2(body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("reader-fb2");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.fb2");
        let xml = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
 <body>{body}</body>
</FictionBook>"#
        );
        std::fs::write(&path, xml).unwrap();
        path
    }

    #[test]
    fn splits_sections_into_chapters() {
        let path = write_fb2(
            r#"<section><title><p>第一章 起</p></title><p>正文一。</p>
               <section><title>小节</title><p>嵌套正文。</p></section></section>
               <section><title><p>第二章 承</p></title><p>正文二。</p></section>"#,
        );
        let (meta, text) = load(&path).unwrap();
        assert_eq!(meta.chapters.len(), 2);
        assert_eq!(meta.chapters[0].title, "第一章 起");
        assert_eq!(meta.chapters[1].title, "第二章 承");
        assert!(text[meta.chapters[0].start..meta.chapters[0].end].contains("嵌套正文"));
        assert!(text[meta.chapters[1].start..meta.chapters[1].end].contains("正文二"));
        // 章节标题在正文里不重复出现
        let first = &text[meta.chapters[0].start..meta.chapters[0].end];
        assert_eq!(first.matches("第一章 起").count(), 0);
    }

    #[test]
    fn decodes_embedded_cover() {
        let dir = std::env::temp_dir().join("reader-fb2-cover");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cover.fb2");
        let jpeg = [0xFFu8, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F'];
        let b64 = base64::engine::general_purpose::STANDARD.encode(jpeg);
        let xml = format!(
            r##"<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
 <description><title-info><coverpage><image l:href="#cover.jpg"/></coverpage></title-info></description>
 <body><section><p>文字</p></section></body>
 <binary id="cover.jpg" content-type="image/jpeg">{b64}</binary>
</FictionBook>"##
        );
        std::fs::write(&path, xml).unwrap();
        assert_eq!(cover_bytes(&path).unwrap().unwrap(), jpeg);
    }
}
