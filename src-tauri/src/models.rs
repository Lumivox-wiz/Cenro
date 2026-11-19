use serde::{Deserialize, Serialize};

/// 书籍大类，决定前端用哪套阅读器与交互模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookType {
    Novel,
    Comic,
    Pdf,
    /// 版式文档：OFD 这类「像 PDF 但另有渲染器」的公文格式
    Doc,
}

impl BookType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Novel => "novel",
            Self::Comic => "comic",
            Self::Pdf => "pdf",
            Self::Doc => "doc",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "comic" => Self::Comic,
            "pdf" => Self::Pdf,
            "doc" => Self::Doc,
            _ => Self::Novel,
        }
    }
}

/// 具体容器格式，决定 Rust 侧用哪个解析器。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    Txt,
    /// Markdown，转成纯文本阅读。
    ///
    /// 必须显式 rename：`rename_all = "lowercase"` 会把它序列化成 `markdown`，
    /// 而前端 FORMAT_LABEL / 打开前的格式白名单用的都是 `md`，
    /// 结果 .md 书点开只得到「undefined 阅读器还没接入」。
    #[serde(rename = "md")]
    Markdown,
    /// 单文件 HTML，去标签后按纯文本阅读
    Html,
    Epub,
    Mobi,
    /// Kindle AZW3 / AZW：PDB 容器，与 MOBI 共用解析器
    Azw3,
    /// FictionBook 2：XML 单文件，自带章节与内嵌封面
    Fb2,
    /// Word：解压 word/document.xml 取段落文本
    Docx,
    /// 富文本：剥离控制字后按纯文本阅读
    Rtf,
    /// MIME 封装的单文件网页（.mht / .mhtml）
    Mhtml,
    Cbz,
    /// 内含图片的 zip，按 CBZ 同样处理
    Zip,
    /// TAR 打包的图片（.cbt）
    Cbt,
    /// 7z 打包的图片（.cb7）
    Cb7,
    /// RAR 打包的图片（.cbr）
    Cbr,
    /// 中文版式文档（.ofd），转 SVG 逐页渲染
    Ofd,
    /// Excel 工作簿（.xlsx），每张表转 HTML 表格
    Xlsx,
    Folder,
    Pdf,
}

impl BookFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Txt => "txt",
            Self::Markdown => "md",
            Self::Html => "html",
            Self::Epub => "epub",
            Self::Mobi => "mobi",
            Self::Azw3 => "azw3",
            Self::Fb2 => "fb2",
            Self::Docx => "docx",
            Self::Rtf => "rtf",
            Self::Mhtml => "mhtml",
            Self::Cbz => "cbz",
            Self::Zip => "zip",
            Self::Cbt => "cbt",
            Self::Cb7 => "cb7",
            Self::Cbr => "cbr",
            Self::Ofd => "ofd",
            Self::Xlsx => "xlsx",
            Self::Folder => "folder",
            Self::Pdf => "pdf",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "txt" => Self::Txt,
            "md" => Self::Markdown,
            "html" => Self::Html,
            "epub" => Self::Epub,
            "mobi" => Self::Mobi,
            "azw3" => Self::Azw3,
            "fb2" => Self::Fb2,
            "docx" => Self::Docx,
            "rtf" => Self::Rtf,
            "mhtml" => Self::Mhtml,
            "cbz" => Self::Cbz,
            "zip" => Self::Zip,
            "cbt" => Self::Cbt,
            "cb7" => Self::Cb7,
            "cbr" => Self::Cbr,
            "ofd" => Self::Ofd,
            "xlsx" => Self::Xlsx,
            "folder" => Self::Folder,
            "pdf" => Self::Pdf,
            _ => return None,
        })
    }

    /// MOBI 家族：PDB 容器，可能同时含文字与图片，打开前需要再判一次类型
    pub fn is_mobi_family(self) -> bool {
        matches!(self, Self::Mobi | Self::Azw3)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoverState {
    Pending,
    Ready,
    Placeholder,
    Failed,
}

impl CoverState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Placeholder => "placeholder",
            Self::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "ready" => Self::Ready,
            "placeholder" => Self::Placeholder,
            "failed" => Self::Failed,
            _ => Self::Pending,
        }
    }
}

/// 漫画与 PDF 共用的翻页模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpreadMode {
    Single,
    Double,
    Webtoon,
}

impl Default for SpreadMode {
    fn default() -> Self {
        Self::Single
    }
}

/// 阅读进度：按格式分态，统一序列化进 books.progress_json。
/// 不做「统一 char_offset」——EPUB 在字号/页宽变化后字符偏移会失效。
/// 各态都带总长度，UI 才能算百分比（UI_SPEC 5.4 要求进度细条与百分比）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Progress {
    /// TXT：字符偏移 + 章节索引
    Text {
        offset: u64,
        chapter: u32,
        #[serde(default)]
        total: u64,
    },
    /// EPUB：CFI 优先，href + progression 兜底（progression 本身即百分比）
    Epub {
        cfi: Option<String>,
        href: String,
        progression: f32,
    },
    /// 漫画与 PDF：页码 + 总页数 + 缩放 + 翻页模式
    Paged {
        page: u32,
        #[serde(default)]
        total: u32,
        #[serde(default = "default_zoom")]
        zoom: f32,
        #[serde(default)]
        spread: SpreadMode,
    },
}

fn default_zoom() -> f32 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Book {
    pub id: String,
    #[serde(rename = "type")]
    pub book_type: BookType,
    pub format: BookFormat,
    pub path: String,
    pub size: i64,
    pub mtime: i64,
    pub title: String,
    pub author: Option<String>,
    pub cover_path: Option<String>,
    pub cover_state: CoverState,
    /// 用户手动改过书名/作者。置位后扫描不再用文件名推导的标题覆盖
    pub meta_locked: bool,
    /// 落库的记录状态（只有「待恢复」需要持久化）
    pub status: BookStatus,
    /// 属于隐私书架。备份默认排除，扫描不会重置这个标记
    pub private: bool,
    /// 记录里的路径此刻是否不存在。运行时判定，不落库——
    /// 文件可能被用户挪走又挪回来，写进数据库就会留下过期结论。
    pub missing: bool,
    pub progress: Option<Progress>,
    pub metadata: Option<serde_json::Value>,
    pub added_at: i64,
    pub last_read_at: Option<i64>,
}

/// 标注：书签 / 高亮 / 笔记。
///
/// 三者共用一张表，区别只在 `kind` 和位置字段的用法：
/// - 书签：一个位置 + 可选备注
/// - 高亮：一段区间（`anchor`）+ 原文（`excerpt`）
/// - 笔记：一段区间或一个位置 + 正文（`label`）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    pub id: String,
    pub book_id: String,
    pub kind: AnnotationKind,
    /// 位置。沿用 `Progress`：各格式已经有明确的定位语义，
    /// 跳转、续读、书签三处共用同一套坐标，不用再发明一套。
    pub locator: Progress,
    /// 书签备注 / 笔记正文
    pub label: Option<String>,
    /// 位置处的原文片段，列表里做预览，也是高亮区间的文字依据
    pub excerpt: Option<String>,
    /// 章内字符区间。只有高亮与笔记有；书签为 None。
    #[serde(default)]
    pub anchor: Option<Anchor>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 章内字符区间，半开区间 `[start, start + len)`，单位是 UTF-16 码元。
///
/// 为什么和 `locator` 分开存：`locator` 只说「在第几章」（TXT 是章节序号、
/// EPUB 是 href），而「章里第几个字到第几个字」在所有文本格式上是同一件事。
/// 单位取 UTF-16 码元是因为它和 JS 字符串下标、DOM `Range` 偏移完全一致——
/// 前端量出来多少就存多少，画回去也不用换算。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    pub start: u32,
    pub len: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationKind {
    Bookmark,
    Highlight,
    Note,
}

impl AnnotationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bookmark => "bookmark",
            Self::Highlight => "highlight",
            Self::Note => "note",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "highlight" => Self::Highlight,
            "note" => Self::Note,
            _ => Self::Bookmark,
        }
    }
}

/// 标签与它在可见书架里被用到的次数。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagCount {
    pub name: String,
    pub count: i64,
}

/// 书内搜索结果。
///
/// `locator` 的坐标与 `Progress` 完全一致，所以「跳到搜索结果」和
/// 「跳到书签」是同一段前端代码。
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    /// 章节序号（0 基）与章节名
    pub chapter: u32,
    pub chapter_title: String,
    pub locator: Progress,
    /// 命中处前后各若干字符，UI 里直接显示
    pub excerpt: String,
    /// 命中词在 excerpt 里的字符区间，用于高亮关键词
    pub match_start: u32,
    pub match_end: u32,
}

/// 书库记录的状态。
///
/// - `Ok`：正常，文件在原位置；
/// - `Pending`：删除事务中断——文件已移入回收站但记录没删掉。UX §10.2 要求
///   保留记录并标记「待恢复」，右键给「重新定位」「移除记录」两条出口。
///
/// 「文件已丢失」不在这里：那是运行时事实（见 `Book::missing`），不落库。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookStatus {
    Ok,
    Pending,
}

impl BookStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Pending => "pending",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "pending" => Self::Pending,
            _ => Self::Ok,
        }
    }
}

impl Default for BookStatus {
    fn default() -> Self {
        Self::Ok
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryRoot {
    pub id: i64,
    pub path: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScanReport {
    pub scanned: u32,
    pub added: u32,
    pub updated: u32,
    pub skipped: u32,
    pub removed: u32,
    pub failed: u32,
    /// 失败明细。只报数字等于让用户去猜——「失败 3 个」既不知道是哪三个，
    /// 也不知道为什么，最后只能把文件全删了重来。
    pub failures: Vec<ScanFailure>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanFailure {
    pub path: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 线上格式串必须与 `as_str()` 一致：前端白名单与 FORMAT_LABEL 都以它为准。
    #[test]
    fn format_serializes_to_as_str() {
        for format in [
            BookFormat::Txt,
            BookFormat::Markdown,
            BookFormat::Html,
            BookFormat::Epub,
            BookFormat::Mobi,
            BookFormat::Azw3,
            BookFormat::Fb2,
            BookFormat::Docx,
            BookFormat::Rtf,
            BookFormat::Mhtml,
            BookFormat::Cbz,
            BookFormat::Zip,
            BookFormat::Cbt,
            BookFormat::Cb7,
            BookFormat::Cbr,
            BookFormat::Ofd,
            BookFormat::Xlsx,
            BookFormat::Folder,
            BookFormat::Pdf,
        ] {
            let json = serde_json::to_string(&format).unwrap();
            assert_eq!(json, format!("\"{}\"", format.as_str()), "{format:?}");
            assert_eq!(BookFormat::parse(format.as_str()), Some(format));
        }
    }
}
