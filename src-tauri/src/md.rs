//! Markdown 的两条路：
//!
//! - **富文本（默认）**：`to_html` 把 Markdown 转成 HTML，再复用 `html` 模块的切章与渲染，
//!   标题层级、粗斜体、行内代码、列表、引用、表格都保留。
//! - **纯文本（兜底）**：`to_text` 去标记后交给 TXT 链路。只在富文本路径不可用时使用，
//!   或者给「导出纯文本」这类场景留着。
//!
//! 走哪条由前端决定：打开 .md 时调用 `open_md_book`（富文本）。

use crate::error::Result;
use crate::text::{self, Chapter, TextBook};
use crate::util;
use pulldown_cmark::{html as cmark, Options, Parser};
use std::path::Path;

/// Markdown → HTML。只开阅读需要的扩展，不引脚注编号这类会打断排版的语法。
pub fn to_html(src: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);

    let parser = Parser::new_ext(src, options);
    let mut out = String::with_capacity(src.len() * 2);
    cmark::push_html(&mut out, parser);
    out
}

/// 富文本入口：读文件 → 解码 → 转 HTML。
///
/// **整篇作为一章**，不按 h1/h2 切开。Markdown 是笔记，读法是「一路往下滚」：
/// 分章会让滚动在章末停住（要再滚一下才进下一章），长表格与代码块也会被拆成两段。
/// 目录由前端从渲染后的 `<h1>/<h2>` 现场提取，不依赖后端切章。
pub fn open_html(path: &Path) -> Result<TextBook> {
    let (html, encoding) = read_as_html(path)?;
    Ok(TextBook {
        encoding,
        total_bytes: html.len(),
        chapters: vec![Chapter {
            title: first_h1(&html).unwrap_or_default(),
            start: 0,
            end: html.len(),
        }],
    })
}

/// 第一个 `<h1>` 的纯文本，用作整篇的标题（拿不到就留空，前端显示文件名）。
fn first_h1(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<h1")?;
    let open_end = lower[start..].find('>')? + start + 1;
    let close = lower[open_end..].find("</h1>")? + open_end;
    let text = crate::mobi::html_to_text(&html[open_end..close])
        .trim()
        .to_string();
    (!text.is_empty()).then_some(text)
}

/// 取某一章的 HTML 片段。转换是纯函数且很快，按需重算即可，不必落缓存。
pub fn chapter_html(path: &Path, start: usize, end: usize) -> Result<String> {
    let (html, _) = read_as_html(path)?;
    Ok(crate::html::slice_html(&html, start, end))
}

fn read_as_html(path: &Path) -> Result<(String, String)> {
    let bytes = std::fs::read(path)?;
    let (src, encoding) = util::decode_text(&bytes);
    Ok((to_html(&src), encoding.to_string()))
}

pub struct MdBook {
    pub encoding: String,
    pub text: String,
    pub chapters: Vec<Chapter>,
}

/// 读文件并按编码探测解码，再转成纯文本。
pub fn load(path: &Path) -> Result<MdBook> {
    let bytes = std::fs::read(path)?;
    let (src, encoding) = util::decode_text(&bytes);

    let (text, headings) = to_text(&src);

    // 没有 `#` 标题时退回按「第X章」或固定字节切分，避免整本变成一章
    let chapters = if headings.is_empty() {
        text::split_chapters(&text)
    } else {
        headings
            .iter()
            .enumerate()
            .map(|(i, (title, start))| Chapter {
                title: title.clone(),
                // 首个标题之前的内容（前言、元信息）并入首章
                start: if i == 0 { 0 } else { *start },
                end: headings
                    .get(i + 1)
                    .map(|h| h.1)
                    .unwrap_or(text.len()),
            })
            .collect()
    };

    Ok(MdBook {
        encoding: encoding.to_string(),
        text,
        chapters,
    })
}

/// 把 Markdown 转成纯文本。
///
/// 返回正文与 `(标题, 标题所在字节偏移)`。偏移用于切章，
/// 与前端按字节取区间的约定一致。
pub fn to_text(src: &str) -> (String, Vec<(String, usize)>) {
    let mut out = String::with_capacity(src.len());
    let mut headings: Vec<(String, usize)> = Vec::new();
    let mut in_fence = false;

    for raw in src.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim_start();

        // 代码块：围栏行丢掉，内部原样保留（缩进与符号都是内容）
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            out.push_str(line);
            out.push('\n');
            continue;
        }

        if let Some((level, title)) = parse_heading(trimmed) {
            let title = inline(&title);
            if title.is_empty() {
                continue;
            }
            // 1–3 级作为章节；4–6 级只留文字参与排版
            if level <= 3 {
                headings.push((title.clone(), out.len()));
            }
            if !out.is_empty() && !out.ends_with("\n\n") {
                out.push('\n');
            }
            out.push_str(&title);
            out.push('\n');
            out.push('\n');
            continue;
        }

        if is_rule(trimmed) {
            if !out.ends_with("\n\n") {
                out.push('\n');
            }
            continue;
        }

        // 表格分隔行（|---|:--:|）没有阅读价值
        if is_table_separator(trimmed) {
            continue;
        }

        // 引用块：去掉 > 前缀后按普通段落处理
        let mut body = trimmed;
        while let Some(rest) = body.strip_prefix('>') {
            body = rest.trim_start();
        }

        if let Some(rest) = strip_list_marker(body) {
            // 保留缩进层级（按 2 空格一级估算），嵌套列表不至于全平铺
            let indent = line.len() - trimmed.len();
            let level = (indent / 2).min(3);
            for _ in 0..level {
                out.push_str("  ");
            }
            out.push_str("· ");
            out.push_str(&inline(rest));
            out.push('\n');
            continue;
        }

        if body.is_empty() {
            // 连续空行只留一个，否则标题后会出现两三行空白
            if !out.is_empty() && !out.ends_with("\n\n") {
                out.push('\n');
            }
            continue;
        }

        out.push_str(&inline(body));
        out.push('\n');
    }

    (out, headings)
}

/// `## 标题` → (2, "标题")
fn parse_heading(line: &str) -> Option<(usize, String)> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = line[hashes..].trim_start();
    // 必须有空格分隔，否则 `#标签` 这类不算标题
    if rest.len() == line[hashes..].len() && !rest.is_empty() {
        return None;
    }
    Some((hashes, rest.trim_end_matches('#').trim_end().to_string()))
}

/// `---` / `***` / `___` 组成的水平线
fn is_rule(line: &str) -> bool {
    let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    compact.len() >= 3
        && (compact.chars().all(|c| c == '-')
            || compact.chars().all(|c| c == '*')
            || compact.chars().all(|c| c == '_'))
}

fn is_table_separator(line: &str) -> bool {
    if !line.contains('-') {
        return false;
    }
    line.chars()
        .all(|c| matches!(c, '-' | ':' | '|' | ' ' | '\t'))
}

/// 去掉列表标记 `- ` `* ` `+ ` `1. `
fn strip_list_marker(line: &str) -> Option<&str> {
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(marker) {
            return Some(rest.trim_start());
        }
    }

    // 有序列表：数字 + . 或 ) + 空格
    let digits: String = line.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 3 {
        return None;
    }
    let rest = &line[digits.len()..];
    for sep in [". ", ") "] {
        if let Some(tail) = rest.strip_prefix(sep) {
            return Some(tail.trim_start());
        }
    }
    None
}

/// 行内标记清理：图片丢弃、链接留文字、强调符号去掉、内联 HTML 去掉。
fn inline(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        match c {
            // 行内代码：内容原样保留，不再处理内部的强调符号
            '`' => {
                if let Some(j) = (i + 1..chars.len()).find(|&j| chars[j] == '`') {
                    out.extend(&chars[i + 1..j]);
                    i = j + 1;
                } else {
                    i += 1;
                }
            }
            // 图片：阅读器里显示不了，连 alt 一起丢掉，避免正文里出现孤立方括号
            '!' if i + 1 < chars.len() && chars[i + 1] == '[' => {
                i = skip_link(&chars, i + 1);
            }
            '[' => {
                if let Some((label, end)) = take_link(&chars, i) {
                    out.push_str(&label);
                    i = end;
                } else {
                    out.push('[');
                    i += 1;
                }
            }
            '*' | '~' => i += 1,
            // 下划线只在两侧不成词时当强调处理，避免误伤 snake_case
            '_' => {
                let prev_word = i > 0 && chars[i - 1].is_alphanumeric();
                let next_word = i + 1 < chars.len() && chars[i + 1].is_alphanumeric();
                if prev_word && next_word {
                    out.push('_');
                }
                i += 1;
            }
            '<' if looks_like_tag(&chars, i) => {
                i = (i + 1..chars.len())
                    .find(|&j| chars[j] == '>')
                    .map(|j| j + 1)
                    .unwrap_or(i + 1);
            }
            '\\' if i + 1 < chars.len() => {
                out.push(chars[i + 1]);
                i += 2;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }

    out.trim_end().to_string()
}

/// `[文字](链接)` → (文字, 结束位置)。标题形式的链接 `[a](b "t")` 也吃得住。
fn take_link(chars: &[char], start: usize) -> Option<(String, usize)> {
    let close = (start + 1..chars.len()).find(|&j| chars[j] == ']')?;
    if close + 1 >= chars.len() || chars[close + 1] != '(' {
        return None;
    }
    let end = (close + 2..chars.len()).find(|&j| chars[j] == ')')?;
    let label: String = chars[start + 1..close].iter().collect();
    Some((inline(&label), end + 1))
}

/// 跳过 `![...](...)`，返回结束位置
fn skip_link(chars: &[char], start: usize) -> usize {
    take_link(chars, start).map(|(_, end)| end).unwrap_or(start + 1)
}

/// `<p>` `<br/>` `<!--` 这类才当标签；`a < b` 里的 `<` 保留
fn looks_like_tag(chars: &[char], i: usize) -> bool {
    matches!(
        chars.get(i + 1),
        Some(c) if c.is_ascii_alphabetic() || *c == '/' || *c == '!'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_inline_markup() {
        let (text, _) = to_text("这是 **粗体**、*斜体* 与 `code` 混排。");
        assert_eq!(text.trim(), "这是 粗体、斜体 与 code 混排。");
    }

    #[test]
    fn keeps_link_label_and_drops_image() {
        let (text, _) = to_text("见[官方文档](https://example.com/a)与 ![截图](x.png) 两处。");
        assert_eq!(text.trim(), "见官方文档与  两处。");
    }

    #[test]
    fn keeps_snake_case_and_math_lt() {
        let (text, _) = to_text("变量 user_id 与 3 < 5 都应原样保留。");
        assert_eq!(text.trim(), "变量 user_id 与 3 < 5 都应原样保留。");
    }

    #[test]
    fn code_fence_content_is_verbatim() {
        let src = "段落\n\n```rust\nlet a = *b;\n```\n\n段尾\n";
        let (text, _) = to_text(src);
        assert!(text.contains("let a = *b;"), "代码内容不能被当作强调处理");
        assert!(!text.contains("```"));
    }

    #[test]
    fn headings_become_chapters() {
        let src = "# 第一章 山门\n\n内容一\n\n## 小节\n\n内容二\n\n# 第二章 夜行\n\n内容三\n";
        let (text, heads) = to_text(src);
        assert_eq!(heads.len(), 3, "1–3 级标题都作为章节");
        assert_eq!(heads[0].0, "第一章 山门");
        assert_eq!(heads[1].0, "小节");

        // 偏移必须落在正文里，且能切出对应的片段
        for (title, start) in &heads {
            assert!(text[*start..].starts_with(title.as_str()));
        }
    }

    #[test]
    fn list_and_quote_markers_removed() {
        let src = "- 条目一\n- 条目二\n\n> 引用的话\n\n1. 有序项\n";
        let (text, _) = to_text(src);
        assert!(text.contains("· 条目一"));
        assert!(text.contains("引用的话"));
        assert!(text.contains("· 有序项"));
        assert!(!text.contains("> 引用"));
    }

    /// 开发期辅助：`CENRO_MD_SAMPLE=<md> CENRO_MD_OUT=<html> cargo test --lib dump_md -- --ignored`
    #[test]
    #[ignore = "开发期辅助：需要 CENRO_MD_SAMPLE 与 CENRO_MD_OUT"]
    fn dump_md() {
        let (Ok(src), Ok(out)) = (
            std::env::var("CENRO_MD_SAMPLE"),
            std::env::var("CENRO_MD_OUT"),
        ) else {
            return;
        };
        let html = open_html(Path::new(&src)).unwrap();
        let body = chapter_html(Path::new(&src), 0, html.total_bytes).unwrap();
        std::fs::write(&out, body).unwrap();
        println!("wrote {out} chapters={}", html.chapters.len());
    }

    #[test]
    fn renders_inline_and_block_markup_to_html() {
        let src = "# 第一章 山门\n\n这是 **粗体**、*斜体* 与 `code`。\n\n- 一\n- 二\n\n> 引用\n";
        let html = to_html(src);
        assert!(html.contains("<h1>第一章 山门</h1>"), "{html}");
        assert!(html.contains("<strong>粗体</strong>"), "{html}");
        assert!(html.contains("<em>斜体</em>"), "{html}");
        assert!(html.contains("<code>code</code>"), "{html}");
        assert!(html.contains("<li>一</li>"), "{html}");
        assert!(html.contains("<blockquote>"), "{html}");
    }

    /// 代码块里的 `*` 与 `_` 不能被当成强调。
    #[test]
    fn code_fence_stays_literal_in_html() {
        let html = to_html("```\nlet a = *b;\n```\n");
        assert!(html.contains("let a = *b;"), "{html}");
        assert!(!html.contains("<em>"), "{html}");
    }

    /// Markdown 不分章：整篇一个区间，标题取第一个 h1。
    ///
    /// 分章会让滚动在章末停一下（v0.10.0 就是这样），读者看到的是「第一篇」「第一篇第二节」
    /// 两块独立内容，而不是一篇连贯的笔记。
    #[test]
    fn markdown_book_is_a_single_document() {
        let dir = std::env::temp_dir().join("reader-md-html");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("b.md");
        std::fs::write(&file, "# 一\n正文一\n\n## 小节\n正文二\n").unwrap();

        let book = open_html(&file).unwrap();
        assert_eq!(book.chapters.len(), 1);
        assert_eq!(book.chapters[0].title, "一");
        assert_eq!(book.chapters[0].start, 0);
        assert_eq!(book.chapters[0].end, book.total_bytes);

        let all = chapter_html(&file, 0, book.total_bytes).unwrap();
        assert!(all.contains("<h1>一</h1>"), "{all}");
        assert!(all.contains("正文二"), "{all}");
    }

    #[test]
    fn chapters_split_by_headings_with_lead_in() {
        let dir = std::env::temp_dir().join("reader-md-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.md");
        std::fs::write(
            &file,
            "# 一\n正文一\n\n# 二\n正文二\n",
        )
        .unwrap();

        let book = load(&file).unwrap();
        assert_eq!(book.chapters.len(), 2);
        assert_eq!(book.chapters[0].start, 0);
        // 标题行的 `#` 已被去掉，正文里只剩标题文字
        assert!(book.text[book.chapters[1].start..].starts_with("二"));
    }
}
