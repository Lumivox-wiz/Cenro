//! 书内搜索。
//!
//! 只做「找位置 + 出片段」，不做索引：一本书撑死几 MB，顺序扫一遍的耗时
//! 远小于维护倒排索引的复杂度。真到了几十 MB 再谈索引。
//!
//! 坐标必须和阅读器一致，否则跳转会落到别处：
//! - 纯文本族（txt / mobi / fb2 / rtf / mhtml）：扫解码后的全文；
//! - HTML 族（html / md / docx / xlsx）：扫的是 HTML 字符串本身，先把标签
//!   替换成**等长空格**再搜，这样字节偏移与原文一一对应，摘出来的片段又天然没有标签。
//!
//! 大小写折叠只处理 ASCII：中文没有大小写，而 `to_lowercase()` 对某些字符
//! 会改变字节长度，一旦长度变了，偏移就全错。

use crate::models::{Progress, SearchHit};
use crate::text::Chapter;

const MAX_HITS: usize = 200;
/// 片段前后各取多少字符
const BEFORE: usize = 30;
const AFTER: usize = 60;

/// 把 `<...>` 换成等长空格（含注释、CDATA）。
///
/// 保留换行与原来一样：标签内部的换行被抹成空格，标签之间的文本原样不动。
pub fn strip_tags_keep_offsets(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // 找结束的 '>'，找不到就把剩下的当文本
            let mut j = i + 1;
            let mut closed = false;
            while j < bytes.len() {
                if bytes[j] == b'>' {
                    closed = true;
                    break;
                }
                j += 1;
            }
            if closed {
                for k in i..=j {
                    out.push(if bytes[k] == b'\n' { b'\n' } else { b' ' });
                }
                i = j + 1;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    // 只替换了 ASCII 字节，UTF-8 结构没动
    String::from_utf8(out).unwrap_or_else(|_| html.to_string())
}

/// 逐字符转小写（仅 ASCII），字节长度不变。
fn fold(text: &str) -> Vec<u8> {
    text.as_bytes()
        .iter()
        .map(|b| b.to_ascii_lowercase())
        .collect()
}

/// 找出全部命中位置（字节偏移），不重叠。
fn find_all(hay: &[u8], needle: &[u8], limit: usize) -> Vec<usize> {
    let mut hits = Vec::new();
    if needle.is_empty() || hay.len() < needle.len() {
        return hits;
    }
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        if &hay[i..i + needle.len()] == needle {
            hits.push(i);
            if hits.len() >= limit {
                break;
            }
            i += needle.len();
            continue;
        }
        i += 1;
    }
    hits
}

/// 从 `start` 往前找 `n` 个字符的边界
fn back_chars(text: &str, start: usize, n: usize) -> usize {
    if start == 0 {
        return 0;
    }
    let mut idx = start;
    for _ in 0..n {
        if idx == 0 {
            break;
        }
        idx -= 1;
        while idx > 0 && !text.is_char_boundary(idx) {
            idx -= 1;
        }
    }
    idx
}

/// 从 `start` 往后找 `n` 个字符的边界
fn forward_chars(text: &str, start: usize, n: usize) -> usize {
    let mut idx = start;
    for _ in 0..n {
        if idx >= text.len() {
            break;
        }
        idx += 1;
        while idx < text.len() && !text.is_char_boundary(idx) {
            idx += 1;
        }
    }
    idx
}

fn chapter_of(chapters: &[Chapter], offset: usize) -> usize {
    chapters
        .iter()
        .position(|c| offset >= c.start && offset < c.end)
        .unwrap_or_else(|| chapters.len().saturating_sub(1))
}

/// 在给定的全文里搜。
///
/// `text` 的坐标必须与 `chapters` 一致（HTML 族请先 `strip_tags_keep_offsets`）。
pub fn search_text(
    text: &str,
    query: &str,
    chapters: &[Chapter],
    total: u64,
    limit: usize,
) -> Vec<SearchHit> {
    let needle_owned = query.trim();
    if needle_owned.is_empty() {
        return Vec::new();
    }

    let hay = fold(text);
    let needle = fold(needle_owned);
    let limit = limit.min(MAX_HITS);
    find_all(&hay, &needle, limit)
        .into_iter()
        .map(|pos| {
            let begin = back_chars(text, pos, BEFORE);
            let end = forward_chars(text, pos + needle_owned.len(), AFTER);
            let raw = &text[begin..end];
            // 片段里的换行 / 连续空白压成单个空格：列表里一行显示，多行会撑高
            let mut excerpt = String::with_capacity(raw.len());
            let mut last_space = false;
            for ch in raw.chars() {
                let ch = if ch == '\n' || ch == '\r' || ch == '\t' { ' ' } else { ch };
                if ch == ' ' {
                    if last_space {
                        continue;
                    }
                    last_space = true;
                } else {
                    last_space = false;
                }
                excerpt.push(ch);
            }

            // 命中词在片段里的字符区间（UI 拿来加粗）
            let match_start = text[begin..pos].chars().count() as u32;
            let match_end = match_start + needle_owned.chars().count() as u32;

            let chapter = chapter_of(chapters, pos);
            SearchHit {
                chapter: chapter as u32,
                chapter_title: chapters
                    .get(chapter)
                    .map(|c| c.title.clone())
                    .unwrap_or_default(),
                locator: Progress::Text {
                    offset: pos as u64,
                    chapter: chapter as u32,
                    total,
                },
                excerpt: excerpt.trim().to_string(),
                match_start,
                match_end,
            }
        })
        .collect()
}

/// EPUB 单章搜索。
///
/// 与 `search_text` 的区别只在定位方式：EPUB 的进度是
/// `{ href, progression }`，`progression` 是**章内比例**，不是字节偏移。
/// 这里用「命中处字符数 / 全章字符数」近似——对文字为主的章节误差不到一屏，
/// 换成真实的滚动比例需要先排版，那是渲染阶段才知道的事。
pub fn search_epub_chapter(
    html: &str,
    query: &str,
    href: &str,
    title: &str,
    index: usize,
    limit: usize,
) -> Vec<SearchHit> {
    let text = strip_tags_keep_offsets(html);
    if query.trim().is_empty() || text.is_empty() {
        return Vec::new();
    }

    let total_chars = text.chars().count().max(1);
    let chapters = vec![Chapter {
        title: title.to_string(),
        start: 0,
        end: text.len(),
    }];

    // 复用纯文本搜索，再把 Text 定位换算成章内比例
    search_text(&text, query, &chapters, text.len() as u64, limit)
        .into_iter()
        .map(|hit| {
            let offset = match hit.locator {
                Progress::Text { offset, .. } => offset as usize,
                _ => 0,
            };
            let chars_before = text[..offset.min(text.len())].chars().count();
            SearchHit {
                chapter: index as u32,
                chapter_title: title.to_string(),
                locator: Progress::Epub {
                    cfi: None,
                    href: href.to_string(),
                    progression: chars_before as f32 / total_chars as f32,
                },
                excerpt: hit.excerpt,
                match_start: hit.match_start,
                match_end: hit.match_end,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chapters_of(text: &str) -> Vec<Chapter> {
        vec![Chapter {
            title: "全文".into(),
            start: 0,
            end: text.len(),
        }]
    }

    #[test]
    fn strips_tags_without_moving_offsets() {
        let html = "<p>甲<b>乙</b>丙</p>";
        let plain = strip_tags_keep_offsets(html);
        assert_eq!(plain.len(), html.len(), "长度必须一致，否则偏移全错");
        assert!(plain.contains("甲"), "{plain}");
        assert!(!plain.contains('<'), "{plain}");
        // 「丙」在原文与剥离后的位置相同
        assert_eq!(html.find('丙'), plain.find('丙'));
    }

    #[test]
    fn finds_all_matches_case_insensitively() {
        let text = "Reader 的核心是 reader。READER!";
        let chapters = chapters_of(text);
        let hits = search_text(text, "reader", &chapters, text.len() as u64, 10);
        assert_eq!(hits.len(), 3, "{hits:?}");
        assert!(hits[0].excerpt.to_lowercase().contains("reader"));
    }

    #[test]
    fn excerpt_marks_the_match_position() {
        let text = "前面有一堆铺垫，然后开关在这里，后面还有内容。";
        let chapters = chapters_of(text);
        let hits = search_text(text, "开关", &chapters, text.len() as u64, 5);
        assert_eq!(hits.len(), 1);
        let hit = &hits[0];
        let chars: Vec<char> = hit.excerpt.chars().collect();
        let matched: String = chars[hit.match_start as usize..hit.match_end as usize]
            .iter()
            .collect();
        assert_eq!(matched, "开关", "{}", hit.excerpt);
    }

    #[test]
    fn locator_points_at_the_hit() {
        let text = "第一章\n这里提到目标词\n第二章";
        let chapters = vec![
            Chapter { title: "一".into(), start: 0, end: 20 },
            Chapter { title: "二".into(), start: 20, end: text.len() },
        ];
        let hits = search_text(text, "目标词", &chapters, text.len() as u64, 5);
        assert_eq!(hits.len(), 1);
        match &hits[0].locator {
            Progress::Text { offset, .. } => {
                assert_eq!(*offset as usize, text.find("目标词").unwrap());
            }
            _ => panic!("应返回 Text 定位"),
        }
    }

    #[test]
    fn ignores_empty_query_and_overlap() {
        let text = "aaaa";
        let chapters = chapters_of(text);
        assert!(search_text(text, "  ", &chapters, 4, 5).is_empty());
        // 不重叠：4 个 a 搜 "aa" 得 2 条
        assert_eq!(search_text(text, "aa", &chapters, 4, 5).len(), 2);
    }

    /// 与真实切章器联调：偏移必须落在「该章节内部的正确位置」。
    #[test]
    fn offsets_agree_with_real_chapter_split() {
        let text = "第一章 开端\n正文甲。\n第二章 转折\n正文乙，这里有关键词。\n";
        let chapters = crate::text::split_chapters(text);
        assert!(chapters.len() >= 2, "切章失败：{chapters:?}");

        let hits = search_text(text, "关键词", &chapters, text.len() as u64, 10);
        assert_eq!(hits.len(), 1);
        let hit = &hits[0];
        let offset = match hit.locator {
            Progress::Text { offset, .. } => offset as usize,
            _ => panic!("应返回 Text 定位"),
        };
        assert_eq!(offset, text.find("关键词").unwrap());
        // 命中的章节区间要真的包含这个偏移
        let chapter = &chapters[hit.chapter as usize];
        assert!(offset >= chapter.start && offset < chapter.end, "{chapter:?} vs {offset}");
    }

    #[test]
    fn epub_hit_carries_href_and_progression() {
        let html = r#"<p>开头一段。</p><p>这里出现目标词，后面继续。</p>"#;
        let hits = search_epub_chapter(html, "目标词", "OEBPS/ch2.xhtml", "第二章", 3, 10);
        assert_eq!(hits.len(), 1);
        let hit = &hits[0];
        assert_eq!(hit.chapter, 3);
        assert_eq!(hit.chapter_title, "第二章");
        match &hit.locator {
            Progress::Epub { href, progression, .. } => {
                assert_eq!(href, "OEBPS/ch2.xhtml");
                assert!(*progression > 0.0 && *progression < 1.0, "{progression}");
            }
            other => panic!("应返回 Epub 定位：{other:?}"),
        }
        // 片段里不该出现标签
        assert!(!hit.excerpt.contains('<'), "{}", hit.excerpt);
    }

    #[test]
    fn respects_limit() {
        let text = "词".repeat(50);
        let chapters = chapters_of(&text);
        assert_eq!(search_text(&text, "词", &chapters, text.len() as u64, 5).len(), 5);
    }
}
