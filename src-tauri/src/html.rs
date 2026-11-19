//! 单文件 HTML 的富文本阅读。
//!
//! 与 TXT 那条纯文本链路不同：这里保留 HTML 结构，按标题标签切章，
//! 章节内容交给前端清理后直接渲染，粗体、标题层级、链接、列表都不再丢。
//!
//! 切章位置用「原始文件里的字节偏移」表示，进度模型沿用 `Progress::Text`
//! 的 offset/chapter/total，不必新增一套。

use crate::error::Result;
use crate::text::{Chapter, TextBook};
use std::path::Path;

/// 认作章节边界的标题级别。h4 以下多是段落小标题，切太碎反而难读。
const HEADING_LEVELS: [u8; 2] = [b'1', b'2'];

pub fn open(path: &Path) -> Result<TextBook> {
    let raw = std::fs::read(path)?;
    let (html, encoding) = crate::util::decode_text(&raw);
    Ok(book_from_html(&html, encoding))
}

/// 已经拿到 HTML 字符串时的建书逻辑（Markdown 转出来的 HTML 也走这里）。
pub fn book_from_html(html: &str, encoding: &str) -> TextBook {
    let chapters = chapters_from_html(html);
    TextBook {
        encoding: encoding.to_string(),
        total_bytes: html.len(),
        chapters,
    }
}

/// 切章：没有 h1/h2 时整篇一章，章名取 `<title>`。
pub fn chapters_from_html(html: &str) -> Vec<Chapter> {
    let mut chapters = split_by_headings(html);
    if chapters.is_empty() {
        chapters.push(Chapter {
            title: doc_title(html).unwrap_or_default(),
            start: 0,
            end: html.len(),
        });
    }
    chapters
}

/// 取某一章的原始 HTML 片段，前端负责清理与渲染。
pub fn chapter(path: &Path, start: usize, end: usize) -> Result<String> {
    let raw = std::fs::read(path)?;
    let (html, _) = crate::util::decode_text(&raw);
    Ok(slice_html(&html, start, end))
}

/// 按字节区间取片段，两端都对齐到 UTF-8 字符边界。
pub fn slice_html(html: &str, start: usize, end: usize) -> String {
    let len = html.len();
    let mut s = start.min(len);
    while s > 0 && !html.is_char_boundary(s) {
        s -= 1;
    }
    let mut e = end.min(len).max(s);
    while e < len && !html.is_char_boundary(e) {
        e += 1;
    }
    html[s..e].to_string()
}

/// 扫 h1/h2 找章节起点；首个标题之前若有正文，单独成「前言」一章。
fn split_by_headings(html: &str) -> Vec<Chapter> {
    let bytes = html.as_bytes();
    let mut hits: Vec<(usize, String)> = Vec::new();
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let level = heading_level(&bytes[i..]);

        let Some(level) = level else {
            i += 1;
            continue;
        };

        let Some(gt) = bytes[i..].iter().position(|b| *b == b'>') else {
            break;
        };
        let text_start = i + gt + 1;
        // 找对应的闭合标签
        // level 是 u8（b'1'），直接插值会拼成 "</h49"，必须转成字符
        let close = format!("</h{}", level as char);
        let Some(close_pos) = find_ci(&html[text_start..], &close) else {
            i = text_start;
            continue;
        };
        let inner = &html[text_start..text_start + close_pos];
        let title = crate::mobi::html_to_text(inner).trim().to_string();
        hits.push((i, title));
        i = text_start + close_pos + close.len();
    }

    if hits.is_empty() {
        return Vec::new();
    }

    let mut chapters: Vec<Chapter> = Vec::new();

    // 首章之前的内容：剥完标签还有字才算「前言」
    if hits[0].0 > 0 {
        let preamble = &html[..hits[0].0];
        if !crate::mobi::html_to_text(preamble).trim().is_empty() {
            chapters.push(Chapter {
                title: "前言".to_string(),
                start: 0,
                end: hits[0].0,
            });
        }
    }

    for (idx, (start, title)) in hits.iter().enumerate() {
        let end = hits.get(idx + 1).map(|(s, _)| *s).unwrap_or(html.len());
        chapters.push(Chapter {
            title: title.clone(),
            start: *start,
            end,
        });
    }

    chapters
}

/// `<h1` / `<h2` 开头时返回级别字符。
fn heading_level(tail: &[u8]) -> Option<u8> {
    if tail.len() < 3 || tail[0] != b'<' {
        return None;
    }
    if tail[1] != b'h' && tail[1] != b'H' {
        return None;
    }
    if !HEADING_LEVELS.contains(&tail[2]) {
        return None;
    }
    // 后面必须是属性分隔或直接闭合，避免匹配到 <hr>、<html> 之类
    match tail.get(3).copied() {
        Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n') => Some(tail[2]),
        _ => None,
    }
}

/// `<title>` 的文本，用作无标题文档的章名。
fn doc_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open_end = lower[start..].find('>')? + start + 1;
    let close = lower[open_end..].find("</title>")? + open_end;
    let text = crate::mobi::html_to_text(&html[open_end..close])
        .trim()
        .to_string();
    (!text.is_empty()).then_some(text)
}

/// 大小写不敏感的 ASCII 查找，返回字节下标。
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| {
        h[i..i + n.len()]
            .iter()
            .zip(n)
            .all(|(a, b)| a.to_ascii_lowercase() == b.to_ascii_lowercase())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(name: &str, html: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("reader-html");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, html).unwrap();
        path
    }

    const SAMPLE: &str = r##"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>测试文章</title>
<style>body{color:#333}</style><script>console.log("不应出现")</script></head>
<body>
<h1>第一章 山雨</h1>
<p>这是 <strong>HTML</strong> 正文，含有 &amp; 实体与 <a href="#">链接</a>。</p>
<p>第二段：3 &lt; 5 的转义应当还原成小于号。</p>
<h1>第二章 归途</h1>
<p>结尾段落。</p>
</body></html>"##;

    #[test]
    fn find_ci_is_case_insensitive() {
        assert_eq!(find_ci("abc</h1>def", "</h1"), Some(3));
        assert_eq!(find_ci("abc</H1>def", "</h1"), Some(3));
        assert_eq!(find_ci("abc", "</h1"), None);
    }

    #[test]
    fn splits_chapters_by_headings() {
        let path = write("split.html", SAMPLE);
        let meta = open(&path).unwrap();
        assert_eq!(meta.chapters.len(), 2);
        assert_eq!(meta.chapters[0].title, "第一章 山雨");
        assert_eq!(meta.chapters[1].title, "第二章 归途");

        let first = chapter(&path, meta.chapters[0].start, meta.chapters[0].end).unwrap();
        assert!(first.contains("<strong>HTML</strong>"), "必须保留原始标签");
        assert!(first.contains("&amp;"));
        let second = chapter(&path, meta.chapters[1].start, meta.chapters[1].end).unwrap();
        assert!(second.contains("第二章 归途"));
        assert!(!second.contains("第一章"));
    }

    #[test]
    fn falls_back_to_single_chapter() {
        let path = write("plain.html", "<html><head><title>无标题文档</title></head><body><p>一段话。</p></body></html>");
        let meta = open(&path).unwrap();
        assert_eq!(meta.chapters.len(), 1);
        assert_eq!(meta.chapters[0].title, "无标题文档");
        assert_eq!(meta.chapters[0].start, 0);
    }

    #[test]
    fn preamble_becomes_its_own_chapter() {
        let path = write(
            "pre.html",
            "<html><body><p>封面上的说明。</p><h1>正文开始</h1><p>内容。</p></body></html>",
        );
        let meta = open(&path).unwrap();
        assert_eq!(meta.chapters.len(), 2);
        assert_eq!(meta.chapters[0].title, "前言");
        assert_eq!(meta.chapters[1].title, "正文开始");
    }

    #[test]
    fn ignores_non_heading_tags() {
        assert!(heading_level(b"<hr>").is_none());
        assert!(heading_level(b"<html>").is_none());
        assert!(heading_level(b"<h3>").is_none());
        assert_eq!(heading_level(b"<h1 class=\"x\">"), Some(b'1'));
        assert_eq!(heading_level(b"<H2>"), Some(b'2'));
    }
}
