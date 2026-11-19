//! 标注导出。
//!
//! 目标只有一个：导出的东西**不带应用也能读**。所以 Markdown 用标准列表与引用，
//! CSV 用逗号 + 双引号转义（Excel 直接能开），不搞自定义结构。
//!
//! 位置一律写成「人能看懂的相对位置」，原始偏移只在 CSV 里保留一列——
//! 给人看的是「第 3 章 · 42%」，给程序看的才是 `offset=18234`。

use crate::error::{AppError, Result};
use crate::models::{Anchor, Annotation, AnnotationKind, Progress};
use chrono::TimeZone;
use serde::{Deserialize, Serialize};

/// 位置的人话描述。与前端 `ReaderExtras` 里那份保持一致：
/// 用户看到的列表和导出的文件不应该有两种说法。
fn describe(locator: &Progress) -> String {
    match locator {
        Progress::Text { offset, total, .. } => {
            if *total > 0 {
                format!("约 {}%", (*offset as f64 / *total as f64 * 100.0).round() as i64)
            } else {
                format!("字节偏移 {offset}")
            }
        }
        Progress::Paged { page, total, .. } => {
            if *total > 0 {
                format!("第 {} 页 · 共 {total} 页", page + 1)
            } else {
                format!("第 {} 页", page + 1)
            }
        }
        Progress::Epub {
            href, progression, ..
        } => format!("{href} · 章内 {}%", (progression * 100.0).round() as i64),
    }
}

fn kind_label(kind: AnnotationKind) -> &'static str {
    match kind {
        AnnotationKind::Bookmark => "书签",
        AnnotationKind::Highlight => "高亮",
        AnnotationKind::Note => "笔记",
    }
}

fn stamp(ts: i64) -> String {
    chrono::Local
        .timestamp_opt(ts, 0)
        .single()
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

pub fn to_markdown(title: &str, author: Option<&str>, items: &[Annotation]) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {} · 标注\n\n", title.trim()));
    if let Some(author) = author.filter(|a| !a.trim().is_empty()) {
        out.push_str(&format!("- 作者：{}\n", author.trim()));
    }
    out.push_str(&format!(
        "- 导出时间：{}\n- 条目：{} 条\n\n",
        stamp(chrono::Local::now().timestamp()),
        items.len()
    ));

    if items.is_empty() {
        out.push_str("> 这本书还没有标注。\n");
        return out;
    }

    for item in items {
        out.push_str(&format!("## {} · {}\n\n", kind_label(item.kind), describe(&item.locator)));
        /*
         * 引用块固定表示「书里原话」，普通段落表示「我写的」。
         * 书签没有原文，备注就是我的话；高亮与笔记的原文一律进引用块，
         * 这样导出后不用看图例也知道哪句是抄的。
         */
        match item.kind {
            AnnotationKind::Bookmark => {
                if let Some(label) = item.label.as_deref().filter(|l| !l.trim().is_empty()) {
                    out.push_str(&format!("> {}\n\n", label.trim()));
                }
            }
            AnnotationKind::Highlight | AnnotationKind::Note => {
                if let Some(excerpt) = item.excerpt.as_deref().filter(|e| !e.trim().is_empty()) {
                    out.push_str(&format!("> {}\n\n", excerpt.trim()));
                }
                if let Some(label) = item.label.as_deref().filter(|l| !l.trim().is_empty()) {
                    out.push_str(&format!("{}\n\n", label.trim()));
                }
            }
        }
        out.push_str(&format!(
            "<sub>{}</sub>\n\n",
            stamp(item.created_at)
        ));
    }
    out
}

/// RFC 4180：含逗号、引号、换行的字段用双引号包起来，内部引号翻倍。
fn cell(value: &str) -> String {
    let needs_quote = value.contains(',') || value.contains('"') || value.contains('\n');
    if needs_quote {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

pub fn to_csv(items: &[Annotation]) -> String {
    let mut out =
        String::from("kind,position,label,excerpt,created_at,offset,page,progression,anchor_start,anchor_len\n");
    for item in items {
        let (offset, page, progression) = match item.locator {
            Progress::Text { offset, .. } => (offset.to_string(), String::new(), String::new()),
            Progress::Paged { page, .. } => (String::new(), page.to_string(), String::new()),
            Progress::Epub { progression, .. } => {
                (String::new(), String::new(), format!("{progression:.4}"))
            }
        };
        // 锚点只有高亮 / 笔记才有；书签留空，单元格里不写 0 以免被误读成「第一个字」
        let (anchor_start, anchor_len) = match item.anchor {
            Some(a) => (a.start.to_string(), a.len.to_string()),
            None => (String::new(), String::new()),
        };
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{}\n",
            cell(kind_label(item.kind)),
            cell(&describe(&item.locator)),
            cell(item.label.as_deref().unwrap_or("")),
            cell(item.excerpt.as_deref().unwrap_or("")),
            cell(&stamp(item.created_at)),
            offset,
            page,
            progression,
            anchor_start,
            anchor_len
        ));
    }
    out
}

/* ---------------- JSON：可回导的完整格式 ---------------- */

/**
 * Markdown 与 CSV 是给人看的：位置写成「约 42%」、原文与备注分开列，
 * 但那不是一份能重新读回来的数据——四舍五入过的百分比、没有锚点，
 * 导回去只会得到一堆错位的书签。
 *
 * 所以回导单开一种格式：JSON 里存的是**库里的原值**（locator 结构、anchor 区间、
 * 原始时间戳），导入时按原样写回。文件头带 `format` 与 `version`，
 * 认不出来的文件直接拒，不去猜。
 */
const FORMAT_TAG: &str = "cenro.annotations";
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportFile {
    pub format: String,
    pub version: u32,
    pub book: ExportBook,
    pub exported_at: i64,
    pub annotations: Vec<ExportItem>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportBook {
    pub title: String,
    pub author: Option<String>,
    /// 书籍格式（epub / pdf / txt …），仅作说明，导入时不参与校验
    pub format: String,
}

/// 一条可回导的标注。字段顺序与 `Annotation` 一致，但**不带 id 与 book_id**：
/// 那是本机库里的身份，换一台机器就该重新生成。
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportItem {
    pub kind: AnnotationKind,
    pub locator: Progress,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub excerpt: Option<String>,
    #[serde(default)]
    pub anchor: Option<Anchor>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

pub fn to_json(book: &crate::models::Book, items: &[Annotation]) -> Result<String> {
    let file = ExportFile {
        format: FORMAT_TAG.to_string(),
        version: FORMAT_VERSION,
        book: ExportBook {
            title: book.title.clone(),
            author: book.author.clone(),
            format: book.format.as_str().to_string(),
        },
        exported_at: chrono::Local::now().timestamp(),
        annotations: items
            .iter()
            .map(|item| ExportItem {
                kind: item.kind,
                locator: item.locator.clone(),
                label: item.label.clone(),
                excerpt: item.excerpt.clone(),
                anchor: item.anchor,
                created_at: item.created_at,
                updated_at: item.updated_at,
            })
            .collect(),
    };
    // 带缩进：这份文件常被用户打开看一眼，压成一行就没法读了
    Ok(serde_json::to_string_pretty(&file)?)
}

/// 解析回导文件。只认自己的格式与版本，别的文件一律报「不是岑序的标注文件」。
pub fn parse_json(raw: &str) -> Result<ExportFile> {
    let file: ExportFile = serde_json::from_str(raw)
        .map_err(|_| AppError::Other("这不是岑序导出的标注文件（JSON 结构不符）".into()))?;
    if file.format != FORMAT_TAG {
        return Err(AppError::Other("这不是岑序导出的标注文件".into()));
    }
    if file.version > FORMAT_VERSION {
        return Err(AppError::Other(format!(
            "标注文件版本 {} 比当前应用新，请先升级岑序",
            file.version
        )));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(label: &str) -> Annotation {
        Annotation {
            id: "a1".into(),
            book_id: "b1".into(),
            kind: AnnotationKind::Bookmark,
            locator: Progress::Text {
                offset: 420,
                chapter: 2,
                total: 1000,
            },
            label: Some(label.into()),
            excerpt: None,
            anchor: None,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
        }
    }

    /// 高亮：有原文、有锚点、可能带一句笔记
    fn highlight() -> Annotation {
        Annotation {
            id: "a2".into(),
            book_id: "b1".into(),
            kind: AnnotationKind::Highlight,
            locator: Progress::Text {
                offset: 420,
                chapter: 2,
                total: 1000,
            },
            label: Some("这句要记".into()),
            excerpt: Some("被划线的原文".into()),
            anchor: Some(crate::models::Anchor { start: 12, len: 7 }),
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
        }
    }

    #[test]
    fn markdown_has_title_entries_and_quotes() {
        let md = to_markdown("测试书", Some("某人"), &[item("一句话备注")]);
        assert!(md.starts_with("# 测试书 · 标注"), "{md}");
        assert!(md.contains("- 作者：某人"), "{md}");
        // 位置换算成百分比，而不是裸露字节偏移
        assert!(md.contains("约 42%"), "{md}");
        assert!(md.contains("> 一句话备注"), "{md}");
    }

    #[test]
    fn empty_book_says_so() {
        let md = to_markdown("空书", None, &[]);
        assert!(md.contains("还没有标注"), "{md}");
    }

    #[test]
    fn csv_escapes_commas_and_quotes() {
        let line = cell("他说,\"好\"");
        assert_eq!(line, "\"他说,\"\"好\"\"\"");
        let csv = to_csv(&[item("含,逗号")]);
        assert!(csv.starts_with("kind,position"), "{csv}");
        assert!(csv.contains("\"含,逗号\""), "{csv}");
        // 文本定位要带上原始偏移，供程序再定位
        assert!(csv.contains(",420,"), "{csv}");
    }

    fn sample_book() -> crate::models::Book {
        crate::models::Book {
            id: "b1".into(),
            book_type: crate::models::BookType::Novel,
            format: crate::models::BookFormat::Epub,
            path: "/tmp/b1.epub".into(),
            size: 1,
            mtime: 0,
            title: "测试书".into(),
            author: Some("某人".into()),
            cover_path: None,
            cover_state: crate::models::CoverState::Pending,
            meta_locked: false,
            status: crate::models::BookStatus::Ok,
            private: false,
            missing: false,
            progress: None,
            metadata: None,
            added_at: 1,
            last_read_at: None,
        }
    }

    #[test]
    fn json_roundtrip_keeps_locator_anchor_and_time() {
        let json = to_json(&sample_book(), &[highlight()]).unwrap();
        assert!(json.contains("cenro.annotations"), "{json}");
        let parsed = parse_json(&json).unwrap();
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.book.title, "测试书");
        assert_eq!(parsed.annotations.len(), 1);

        let item = &parsed.annotations[0];
        assert_eq!(item.kind, AnnotationKind::Highlight);
        assert_eq!(item.anchor, Some(crate::models::Anchor { start: 12, len: 7 }));
        assert_eq!(item.excerpt.as_deref(), Some("被划线的原文"));
        assert_eq!(item.created_at, 1_700_000_000);
        // 位置要能原样还原：回导靠的是它，不是「约 42%」
        match item.locator {
            Progress::Text { offset, chapter, total } => {
                assert_eq!((offset, chapter, total), (420, 2, 1000));
            }
            _ => panic!("定位类型没还原"),
        }
    }

    #[test]
    fn json_rejects_foreign_or_future_files() {
        assert!(parse_json("{\"hello\":1}").is_err());
        assert!(parse_json("不是 JSON").is_err());
        let future = r#"{"format":"cenro.annotations","version":99,"book":{"title":"x","author":null,"format":"txt"},"exported_at":0,"annotations":[]}"#;
        let err = parse_json(future).unwrap_err().to_string();
        assert!(err.contains("升级"), "{err}");
    }

    #[test]
    fn highlight_exports_quote_then_note_with_anchor() {
        let md = to_markdown("测试书", None, &[highlight()]);
        // 原文进引用块，自己的话走正文：一眼能分清哪句是书、哪句是我写的
        assert!(md.contains("> 被划线的原文"), "{md}");
        assert!(md.contains("\n这句要记\n"), "{md}");
        assert!(!md.contains("原文：被划线的原文"), "{md}");

        let csv = to_csv(&[highlight()]);
        assert!(csv.contains(",12,7"), "{csv}");
        // 书签没有锚点，两列留空而不是写 0
        let bookmark_line = to_csv(&[item("备注")]);
        assert!(bookmark_line.trim_end().ends_with(','), "{bookmark_line}");
    }
}
