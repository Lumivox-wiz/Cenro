//! 扫描件的文字索引：用 PP-OCR 识别页面位图，结果按页存进 SQLite。
//!
//! 分工会有一个反直觉的地方——**图片不是这里渲染的**。
//! PDF 的页面只在 pdf.js 里能画（我们没引 pdfium / mupdf），所以前端负责
//! 「渲染成 JPEG」，这个模块只负责「认字 + 落库」。两端都好做：
//! Rust 侧拿到的是压缩过的几百 KB，不必为了一页 OCR 引一个 PDF 引擎。
//!
//! 模型是 PP-OCRv6 tiny（det 1.74 MB + rec 4.28 MB），放在 `resources/ocr/`。
//! 选它而不是 v5 mobile 的原因见 docs/OCR_RESEARCH.md：手机上整本 72 页
//! 约 22 秒、峰值 185 MB，而识别结果与 v5 在正文页上逐字一致。

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use paddleocr_rs_onnx::{OcrEngine, OrderBy};

use crate::error::{AppError, Result};

/// 模型标识：写进数据库，方便日后换模型时判断哪些页需要重建。
pub const ENGINE_ID: &str = "ppocrv6-tiny-ort";

/// 模型直接编进二进制（`include_bytes!`），不走 resources 目录。
///
/// 这样两端只有一条路径：Windows 的资源在 exe 旁边、安卓的在 APK 里，
/// 用运行时路径去读要各写一套（安卓那边是 `resource_dir()` 的特殊解析，
/// 出错时表现为「模型找不到」而不是编译错误）。6 MB 换掉这个不确定性，值。
const DET: &[u8] = include_bytes!("../resources/ocr/det.onnx");
const REC: &[u8] = include_bytes!("../resources/ocr/rec.onnx");
const DICT: &[u8] = include_bytes!("../resources/ocr/dict.txt");

/// 单页最多保留多少字。极端页面（整版广告）能出上万字，
/// 但索引里没必要留那么多——前 6000 字足够覆盖搜索命中。
const MAX_PAGE_CHARS: usize = 6000;

#[derive(Default)]
pub struct Ocr {
    /// 引擎初始化要 ~700 ms（桌面），所以只在第一次真正用到时构建，之后常驻。
    /// 用 `Result` 记住失败原因：初始化挂了不必每次调用都重试一遍。
    engine: Mutex<Option<std::result::Result<OcrEngine, String>>>,
}

impl Ocr {
    pub fn new() -> Self {
        Self::default()
    }

    /// 模型总体积（内嵌，恒可用），给设置页与日志用。
    pub fn models_bytes(&self) -> u64 {
        (DET.len() + REC.len() + DICT.len()) as u64
    }

    /// 识别一张图，返回按视觉顺序拼接的文本（行间用 `\n`）。
    ///
    /// 为什么是 `\n` 而不是空格：搜索时用户输入的是词，不是句子，
    /// 换行能让命中片段更短、更精确；而且 PDF 文字层那边也是按行给的。
    pub fn recognize(&self, image: &image::DynamicImage) -> Result<String> {
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| AppError::Other("OCR 引擎状态异常".into()))?;

        if guard.is_none() {
            *guard = Some(
                OcrEngine::new(DET, REC, DICT)
                    .map_err(|e| format!("初始化失败：{e}")),
            );
        }
        let engine = match guard.as_ref().unwrap() {
            Ok(e) => e,
            Err(msg) => return Err(AppError::Other(format!("OCR 引擎不可用：{msg}"))),
        };

        let blocks = engine
            .recognize_all(image, OrderBy::Horizontal)
            .map_err(|e| AppError::Other(format!("识别失败：{e}")))?;

        let mut out = String::new();
        for b in blocks {
            let text = b.text.trim();
            if text.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(text);
            if out.chars().count() >= MAX_PAGE_CHARS {
                break;
            }
        }
        Ok(out)
    }

}

/// 页文本落库。重复识别同一页时覆盖——换模型重跑就靠这条。
pub fn save_page(
    conn: &rusqlite::Connection,
    book_id: &str,
    page: i64,
    text: &str,
) -> Result<()> {
    let now = now_secs();
    conn.execute(
        "INSERT INTO ocr_pages (book_id, page, text, chars, engine, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(book_id, page) DO UPDATE SET
           text = excluded.text,
           chars = excluded.chars,
           engine = excluded.engine,
           created_at = excluded.created_at",
        rusqlite::params![
            book_id,
            page,
            text,
            text.chars().count() as i64,
            ENGINE_ID,
            now
        ],
    )?;
    Ok(())
}

pub fn clear_book(conn: &rusqlite::Connection, book_id: &str) -> Result<()> {
    conn.execute("DELETE FROM ocr_pages WHERE book_id = ?1", [book_id])?;
    conn.execute("DELETE FROM ocr_jobs WHERE book_id = ?1", [book_id])?;
    Ok(())
}

/// 在识别文本里找词，返回命中处的片段（前后各 `PAD` 个字符）。
///
/// 为什么不能直接 `text.contains(needle)`：OCR 出来的中文经常带空格
/// （实测封面页是「天 津科 技大 学研 究生」），英文又常常没有词间空格
/// （「keyelementsof」）。两种方向都会让「明明页上有这几个字，搜不到」成立，
/// 所以**两边都去掉空白再比**，命中位置再映射回原文取片段。
pub fn find_in_page(text: &str, needle: &str, pad: usize) -> Option<String> {
    let needle: String = needle
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect();
    if needle.is_empty() {
        return None;
    }

    let chars: Vec<char> = text.chars().collect();
    let mut compact = String::with_capacity(text.len());
    // compact 的第 i 个字符 → chars 里的下标；取片段时靠它还原原文
    let mut map: Vec<usize> = Vec::with_capacity(text.len());
    for (i, c) in chars.iter().enumerate() {
        if c.is_whitespace() {
            continue;
        }
        // 小写化可能一对多（İ 之类），只取第一个，保证 compact 与 map 一一对应
        if let Some(lc) = c.to_lowercase().next() {
            compact.push(lc);
            map.push(i);
        }
    }

    let pos = compact.find(&needle)?;
    let hit_at = compact[..pos].chars().count();
    let hit_len = needle.chars().count();
    let start = map.get(hit_at).copied()?.saturating_sub(pad);
    let last = map.get(hit_at + hit_len - 1).copied().unwrap_or(start);
    let end = (last + 1 + pad).min(chars.len());
    Some(
        chars[start..end]
            .iter()
            .collect::<String>()
            .replace('\n', " ")
            .replace(['\r', '\t'], " "),
    )
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真跑一遍模型。样本图不随仓库走，用环境变量指：
    ///   CENRO_OCR_SAMPLE="C:/…/scan.png" cargo test --lib ocr
    #[test]
    fn recognize_sample_page() {
        let Ok(path) = std::env::var("CENRO_OCR_SAMPLE") else {
            return;
        };
        let img = image::open(&path).expect("样本图打不开");
        let ocr = Ocr::new();
        let text = ocr.recognize(&img).expect("识别失败");
        let chars = text.chars().count();
        assert!(chars > 40, "识别结果太少（{chars} 字）：{text}");
        eprintln!("[样本] {chars} 字，前 60 字：{}", text.chars().take(60).collect::<String>());
    }

    #[test]
    fn find_tolerates_spaces_and_case() {
        // OCR 给中文插空格
        assert!(find_in_page("天 津科 技大 学研 究生", "天津科技大学", 4).is_some());
        // 英文没有词间空格
        assert!(find_in_page("materialsasoneofthekeyelementsof", "key elements of", 4).is_some());
        // 大小写
        assert!(find_in_page("Abstract", "abstract", 4).is_some());
        // 原文里没有就是没有
        assert!(find_in_page("第一页", "第二页", 4).is_none());
        // 片段要能从原文还原（带上下文）
        let snip = find_in_page("前文命中后文", "命中", 1).unwrap();
        assert_eq!(snip, "文命中后");
    }

    #[test]
    fn pages_roundtrip() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init(&conn).unwrap();

        save_page(&conn, "b1", 0, "第一页的文字").unwrap();
        save_page(&conn, "b1", 1, "第二页的文字").unwrap();
        // 同一页重跑：覆盖而不是插重复
        save_page(&conn, "b1", 0, "第一页重跑后的文字").unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ocr_pages WHERE book_id='b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "按页应只有两行");

        let text: String = conn
            .query_row(
                "SELECT text FROM ocr_pages WHERE book_id='b1' AND page=0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(text, "第一页重跑后的文字");

        clear_book(&conn, "b1").unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM ocr_pages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }
}
