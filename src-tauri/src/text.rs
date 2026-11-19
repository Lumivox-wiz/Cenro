use crate::error::Result;
use crate::util;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// 无章节标题时的兜底切分粒度（字节）。约 5000 汉字，保证单章分页不吃内存。
const FALLBACK_CHUNK_BYTES: usize = 15_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chapter {
    pub title: String,
    /// 字节偏移，落在字符边界上。前端只当不透明游标使用。
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextBook {
    pub encoding: String,
    pub total_bytes: usize,
    pub chapters: Vec<Chapter>,
}

/// 解码全文并切章。返回 (元信息, 全文)，全文由调用方缓存。
pub fn load(path: &Path) -> Result<(TextBook, String)> {
    let bytes = std::fs::read(path)?;
    let (text, encoding) = util::decode_text(&bytes);
    let chapters = split_chapters(&text);

    let meta = TextBook {
        encoding: encoding.to_string(),
        total_bytes: text.len(),
        chapters,
    };
    Ok((meta, text))
}

/// 按行扫描标题行。识别「第X章/节/回/卷/篇/集」与 Chapter N。
/// 未命中任何标题时按固定字节切分，避免整本变成一章无法分页。
pub fn split_chapters(text: &str) -> Vec<Chapter> {
    let mut chapters: Vec<Chapter> = Vec::new();
    let mut current: Option<(String, usize)> = None;

    let mut line_start = 0usize;
    for (i, ch) in text.char_indices() {
        if ch != '\n' {
            continue;
        }
        let line = &text[line_start..i];
        if is_chapter_heading(line) {
            if let Some((title, start)) = current.take() {
                chapters.push(Chapter {
                    title,
                    start,
                    end: line_start,
                });
            }
            current = Some((line.trim().to_string(), line_start));
        }
        line_start = i + 1;
    }

    // 末行
    if line_start < text.len() {
        let line = &text[line_start..];
        if is_chapter_heading(line) {
            if let Some((title, start)) = current.take() {
                chapters.push(Chapter {
                    title,
                    start,
                    end: line_start,
                });
            }
            current = Some((line.trim().to_string(), line_start));
        }
    }

    if let Some((title, start)) = current {
        chapters.push(Chapter {
            title,
            start,
            end: text.len(),
        });
    }

    if chapters.is_empty() {
        return split_fixed(text);
    }

    // 首个标题前的内容（书名页、简介）并入第一章，避免阅读时丢失
    if chapters[0].start > 0 {
        chapters[0].start = 0;
    }
    chapters
}

fn split_fixed(text: &str) -> Vec<Chapter> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;

    while start < text.len() {
        let mut end = (start + FALLBACK_CHUNK_BYTES).min(text.len());
        while end < text.len() && !text.is_char_boundary(end) {
            end -= 1;
        }
        index += 1;
        out.push(Chapter {
            title: format!("第 {index} 节"),
            start,
            end,
        });
        start = end;
    }

    if out.is_empty() {
        out.push(Chapter {
            title: "全文".to_string(),
            start: 0,
            end: text.len(),
        });
    }
    out
}

fn is_chapter_heading(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    // 过长的行不可能是标题
    if trimmed.chars().count() > 40 {
        return false;
    }

    // 第X章 / 第X节 / 第X回 / 第X卷 / 第X篇 / 第X集
    if trimmed.starts_with('第') {
        let mut seen_digit = false;
        for c in trimmed.chars().skip(1) {
            if is_cjk_numeral(c) {
                seen_digit = true;
                continue;
            }
            if seen_digit && matches!(c, '章' | '节' | '回' | '卷' | '篇' | '集') {
                return true;
            }
            break;
        }
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("chapter ") || lower.starts_with("prologue") || lower.starts_with("epilogue")
    {
        return true;
    }

    false
}

fn is_cjk_numeral(c: char) -> bool {
    matches!(
        c,
        '零' | '〇' | '一' | '二' | '三' | '四' | '五' | '六' | '七' | '八' | '九' | '十' | '百'
            | '千' | '万' | '亿' | '两'
    ) || c.is_ascii_digit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_cjk_chapters() {
        let text = "书名页\n\n第一章 起风了\n正文一\n\n第二章 夜行\n正文二\n";
        let chapters = split_chapters(text);
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].title, "第一章 起风了");
        assert_eq!(chapters[0].start, 0, "书名页并入首章");
        assert_eq!(chapters[1].title, "第二章 夜行");
        assert_eq!(&text[chapters[1].start..chapters[1].end], "第二章 夜行\n正文二\n");
    }

    #[test]
    fn detects_english_chapters() {
        let text = "Chapter 1\nHello\n\nChapter 2\nWorld\n";
        let chapters = split_chapters(text);
        assert_eq!(chapters.len(), 2);
    }

    #[test]
    fn falls_back_to_fixed_chunks() {
        let text = "啊".repeat(20_000);
        let chapters = split_chapters(&text);
        assert!(chapters.len() > 1);
        assert!(chapters.iter().all(|c| c.end > c.start));
    }

    #[test]
    fn rejects_ordinary_lines() {
        assert!(!is_chapter_heading("他说：第一章写得不错，但这里还可以改。"));
        assert!(!is_chapter_heading(""));
        assert!(is_chapter_heading("第十章"));
        assert!(is_chapter_heading("第3章 归来"));
    }
}
