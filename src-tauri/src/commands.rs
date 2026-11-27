use crate::cover;
use crate::db;
use crate::monet;
use crate::error::{AppError, Result};
use crate::models::{
    Anchor, Annotation, AnnotationKind, Book, BookStatus, LibraryRoot, Progress, ScanReport,
    SearchHit, TagCount,
};
use crate::scanner;
use crate::AppState;
use rusqlite::OptionalExtension;
use tauri::{AppHandle, Manager, State};

fn lock_conn<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::Other("数据库连接不可用".into()))
}

#[tauri::command]
pub fn list_roots(state: State<'_, AppState>) -> Result<Vec<LibraryRoot>> {
    let conn = lock_conn(&state)?;
    db::list_roots(&conn)
}

#[tauri::command]
pub fn add_root(state: State<'_, AppState>, path: String) -> Result<LibraryRoot> {
    let conn = lock_conn(&state)?;
    db::add_root(&conn, &path)
}

#[tauri::command]
pub fn remove_root(state: State<'_, AppState>, id: i64) -> Result<()> {
    let conn = lock_conn(&state)?;
    db::remove_root(&conn, id)
}

/// 莫奈取色：读一张背景图，返回主色相与饱和/明度。
///
/// 只取相不配色——派生色要按当前主题（亮/暗）各自算对比度，
/// 那是前端的事，见 `src/lib/monet.ts`。
///
/// 必须走阻塞线程池：一张 4K 图解码要两三百毫秒，同步命令会直接卡住 UI 线程，
/// 用户看到的是「勾了取色，界面僵一下」。
#[tauri::command]
pub async fn monet_palette(path: String) -> Result<monet::MonetSwatch> {
    tauri::async_runtime::spawn_blocking(move || monet::extract(&path))
        .await
        .map_err(|e| AppError::Other(format!("取色任务异常：{e}")))?
}

/// 扫描是重 IO 任务，放阻塞线程池，避免冻结 UI。
#[tauri::command]
pub async fn scan_library(app: AppHandle) -> Result<ScanReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::Other("数据库连接不可用".into()))?;
        let report = scanner::scan(&conn, &state.cover_dir)?;
        crate::logging::info(
            "scan",
            format!(
                "扫描完成：共 {} · 新增 {} · 更新 {} · 跳过 {} · 失败 {}",
                report.scanned, report.added, report.updated, report.skipped, report.failed
            ),
        );
        for f in report.failures.iter().take(20) {
            crate::logging::warn("scan", format!("{} → {}", f.path, f.message));
        }
        Ok::<_, AppError>(report)
    })
    .await
    .map_err(|e| {
        crate::logging::error("scan", format!("扫描任务崩溃：{e}"));
        AppError::Other(format!("扫描任务失败: {e}"))
    })?
}

#[tauri::command]
pub fn list_books(
    state: State<'_, AppState>,
    query: Option<String>,
    kind: Option<String>,
) -> Result<Vec<Book>> {
    let conn = lock_conn(&state)?;
    db::list_books(&conn, query.as_deref(), kind.as_deref())
}

#[tauri::command]
pub fn get_book(state: State<'_, AppState>, id: String) -> Result<Option<Book>> {
    // 锁定时按 id 直查也要返回「没有这本书」，不能返回 Some
    match visible_book(&state, &id) {
        Ok(book) => Ok(Some(book)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn save_progress(state: State<'_, AppState>, id: String, progress: Progress) -> Result<()> {
    visible_book(&state, &id)?;
    let conn = lock_conn(&state)?;
    db::save_progress(&conn, &id, &progress)
}

#[tauri::command]
pub fn library_stats(state: State<'_, AppState>) -> Result<i64> {
    let conn = lock_conn(&state)?;
    // 只报公开书架：把隐私书也算进去，「30 本」对上「27 本」就成了存在性侧信道
    db::count_visible(&conn)
}

// ---------------- TXT 阅读 ----------------

use crate::md;
use crate::mobi;
use crate::text::{self, TextBook};
use std::path::{Path, PathBuf};

/// 取一本书，并挡掉「锁定时按 id 直取隐私书」。
///
/// 关键是**返回和「查无此书」完全一样的错误**：如果这里回 403 / 「无权访问」，
/// 就等于告诉对方「这个 id 存在，只是不给你看」。id 是路径哈希，能算出来，
/// 所以这条守卫不是可选装饰。
fn visible_book(state: &State<'_, AppState>, id: &str) -> Result<Book> {
    let conn = lock_conn(state)?;
    let book = db::get_book(&conn, id)?
        .ok_or_else(|| AppError::Other("书籍不存在，请重新扫描书库".into()))?;
    if book.private && !state.unlocked() {
        return Err(AppError::Other("书籍不存在，请重新扫描书库".into()));
    }
    Ok(book)
}

fn book_path(state: &State<'_, AppState>, id: &str) -> Result<String> {
    Ok(visible_book(state, id)?.path)
}

/// 打开纯文字书（TXT / MOBI）：解码全文、切章，并把全文放进缓存。
#[tauri::command]
pub fn open_text_book(state: State<'_, AppState>, id: String) -> Result<TextBook> {
    let path = book_path(&state, &id)?;
    let (meta, full) = load_plain_text(&state, &id, Path::new(&path))?;
    let mut cache = state
        .text_cache
        .lock()
        .map_err(|_| AppError::Other("文本缓存不可用".into()))?;
    *cache = Some(crate::CachedText {
        book_id: id,
        text: full,
    });
    Ok(meta)
}

/// 按字节区间取正文。区间会被夹到字符边界，前端传任意值都不会 panic。
#[tauri::command]
pub fn read_text_range(
    state: State<'_, AppState>,
    id: String,
    start: usize,
    end: usize,
) -> Result<String> {
    let cached = {
        let cache = state
            .text_cache
            .lock()
            .map_err(|_| AppError::Other("文本缓存不可用".into()))?;
        cache.as_ref().map(|c| c.book_id == id).unwrap_or(false)
    };

    // 缓存未命中（例如应用重启后直接进入阅读页）时补加载
    if !cached {
        let path = book_path(&state, &id)?;
        let (_, full) = load_plain_text(&state, &id, Path::new(&path))?;
        let mut cache = state
            .text_cache
            .lock()
            .map_err(|_| AppError::Other("文本缓存不可用".into()))?;
        *cache = Some(crate::CachedText {
            book_id: id.clone(),
            text: full,
        });
    }

    let cache = state
        .text_cache
        .lock()
        .map_err(|_| AppError::Other("文本缓存不可用".into()))?;
    let cached = cache
        .as_ref()
        .ok_or_else(|| AppError::Other("文本缓存为空".into()))?;

    let (s, e) = clamp_range(&cached.text, start, end);
    Ok(cached.text[s..e].to_string())
}

/// 按书籍格式选择解码器：TXT 走编码探测，MOBI 走 PDB/PalmDOC 解析。
/// 两者都产出「编码名 + 全文」，下游切章、区间读取、进度模型完全共用。
fn load_plain_text(
    state: &State<'_, AppState>,
    id: &str,
    path: &Path,
) -> Result<(TextBook, String)> {
    let format = {
        let conn = lock_conn(state)?;
        db::get_book(&conn, id)?
            .ok_or_else(|| AppError::Other("书籍不存在，请重新扫描书库".into()))?
            .format
    };

    if format == BookFormat::Markdown {
        let book = md::load(path)?;
        let meta = TextBook {
            encoding: book.encoding,
            total_bytes: book.text.len(),
            chapters: book.chapters,
        };
        return Ok((meta, book.text));
    }

    if format == BookFormat::Html {
        let bytes = std::fs::read(path)?;
        let (html, encoding) = crate::util::decode_text(&bytes);
        // 单文件 HTML 没有目录结构，按标题或固定字节兜底切章
        let text = mobi::html_to_text(&html);
        let meta = TextBook {
            encoding: encoding.to_string(),
            total_bytes: text.len(),
            chapters: text::split_chapters(&text),
        };
        return Ok((meta, text));
    }

    if format == BookFormat::Fb2 {
        let (meta, text) = crate::fb2::load(path)?;
        // FB2 自带书名与作者，与 MOBI 一样在首次打开时回写
        let (title, author) = crate::fb2::title_author(path);
        if title.is_some() || author.is_some() {
            if let Ok(conn) = lock_conn(state) {
                let _ = db::update_title_author(&conn, id, title.as_deref(), author.as_deref());
            }
        }
        return Ok((meta, text));
    }

    if format == BookFormat::Docx {
        return crate::docx::load(path);
    }

    if format == BookFormat::Rtf {
        return crate::rtf::load(path);
    }

    if format == BookFormat::Mhtml {
        return crate::mhtml::load(path);
    }

    if format.is_mobi_family() {
        let book = mobi::load(path)?;
        // MOBI 自带书名与作者，扫描阶段拿不到，这里回写进库
        if book.title.is_some() || book.author.is_some() {
            if let Ok(conn) = lock_conn(state) {
                let _ = db::update_title_author(
                    &conn,
                    id,
                    book.title.as_deref(),
                    book.author.as_deref(),
                );
            }
        }

        let meta = TextBook {
            encoding: book.encoding.to_string(),
            total_bytes: book.text.len(),
            chapters: text::split_chapters(&book.text),
        };
        return Ok((meta, book.text));
    }

    text::load(path)
}

fn clamp_range(text: &str, start: usize, end: usize) -> (usize, usize) {
    let len = text.len();
    let mut s = start.min(len);
    while s > 0 && !text.is_char_boundary(s) {
        s -= 1;
    }
    let mut e = end.min(len).max(s);
    while e < len && !text.is_char_boundary(e) {
        e += 1;
    }
    (s, e)
}

/// 返回书籍实际应该用哪种阅读器打开。
///
/// 扫描阶段的分类只是尽力而为：MOBI 既可能是文字书也可能是图片型漫画，
/// 而分类规则会随版本变化（新增漫画支持时就变了），老记录不会自动更新。
/// 打开前再判一次，顺手把数据库里的类型改对，书架下次就显示正确。
#[tauri::command]
pub fn book_kind(state: State<'_, AppState>, id: String) -> Result<String> {
    let book = visible_book(&state, &id)?;
    let conn = lock_conn(&state)?;

    if !book.format.is_mobi_family() {
        return Ok(book.book_type.as_str().to_string());
    }

    let probe = mobi::probe(Path::new(&book.path))?;
    let kind = if probe.image_count >= 3 {
        BookType::Comic
    } else {
        BookType::Novel
    };

    if kind != book.book_type {
        db::update_book_type(&conn, &id, kind)?;
    }
    Ok(kind.as_str().to_string())
}

// ---------------- 漫画 ----------------

use crate::comic;
use crate::models::{BookFormat, BookType};

fn comic_source(state: &State<'_, AppState>, id: &str) -> Result<(String, BookFormat)> {
    let book = visible_book(state, id)?;
    Ok((book.path, book.format))
}

/// 列出全部页面名（自然序）。前端据此做进度与预加载。
#[tauri::command]
pub fn list_comic_pages(state: State<'_, AppState>, id: String) -> Result<Vec<String>> {
    let (path, format) = comic_source(&state, &id)?;
    if format.is_mobi_family() {
        return mobi::list_images(Path::new(&path));
    }
    comic::list_pages(Path::new(&path), format, &state.comic_cache, &id)
}

/// 取某页可用的本地路径。CBZ / CBT 首次访问会解压到缓存，CB7 整包解压。
#[tauri::command]
pub fn comic_page_path(
    state: State<'_, AppState>,
    id: String,
    index: usize,
    name: String,
) -> Result<String> {
    let (path, format) = comic_source(&state, &id)?;

    // 图片型 MOBI / AZW3：按图片序号从记录里切出来落盘
    if format.is_mobi_family() {
        let resolved = mobi::extract_image(Path::new(&path), index, &state.comic_cache, &id)?;
        return Ok(resolved.to_string_lossy().into_owned());
    }

    let resolved = comic::page_path(
        Path::new(&path),
        format,
        index,
        &name,
        &state.comic_cache,
        &id,
    )?;
    Ok(resolved.to_string_lossy().into_owned())
}

// ---------------- 单文件 HTML（富文本） ----------------

/// 打开 HTML：按标题切章，返回章节区间。内容仍是原始 HTML，由前端清理后渲染。
#[tauri::command]
pub fn open_html_book(state: State<'_, AppState>, id: String) -> Result<TextBook> {
    let path = book_path(&state, &id)?;
    crate::html::open(Path::new(&path))
}

/// 取某一章的 HTML 片段。
#[tauri::command]
pub fn read_html_chapter(
    state: State<'_, AppState>,
    id: String,
    start: usize,
    end: usize,
) -> Result<String> {
    let path = book_path(&state, &id)?;
    crate::html::chapter(Path::new(&path), start, end)
}

// ---------------- Markdown（富文本） ----------------

/// 打开 Markdown：转成 HTML 后按标题切章，前端复用 HTML 的渲染与清理。
#[tauri::command]
pub fn open_md_book(state: State<'_, AppState>, id: String) -> Result<TextBook> {
    let path = book_path(&state, &id)?;
    crate::md::open_html(Path::new(&path))
}

/// 取某一章的 HTML 片段。
#[tauri::command]
pub fn read_md_chapter(
    state: State<'_, AppState>,
    id: String,
    start: usize,
    end: usize,
) -> Result<String> {
    let path = book_path(&state, &id)?;
    crate::md::chapter_html(Path::new(&path), start, end)
}

// ---------------- DOCX / XLSX（富文本） ----------------

/// Word：转 HTML 后按标题切章（无标题则整篇一章）。
#[tauri::command]
pub fn open_docx_book(state: State<'_, AppState>, id: String) -> Result<TextBook> {
    let path = book_path(&state, &id)?;
    let html = crate::docx::to_html(Path::new(&path))?;
    Ok(crate::html::book_from_html(&html, "utf-8"))
}

#[tauri::command]
pub fn read_docx_chapter(
    state: State<'_, AppState>,
    id: String,
    start: usize,
    end: usize,
) -> Result<String> {
    let path = book_path(&state, &id)?;
    let html = crate::docx::to_html(Path::new(&path))?;
    Ok(crate::html::slice_html(&html, start, end))
}

/// Excel：每张工作表一章，表格原样保留。
#[tauri::command]
pub fn open_xlsx_book(state: State<'_, AppState>, id: String) -> Result<TextBook> {
    let path = book_path(&state, &id)?;
    let html = crate::xlsx::to_html(Path::new(&path))?;
    Ok(crate::html::book_from_html(&html, "utf-8"))
}

#[tauri::command]
pub fn read_xlsx_chapter(
    state: State<'_, AppState>,
    id: String,
    start: usize,
    end: usize,
) -> Result<String> {
    let path = book_path(&state, &id)?;
    let html = crate::xlsx::to_html(Path::new(&path))?;
    Ok(crate::html::slice_html(&html, start, end))
}

// ---------------- OFD ----------------

/// 打开 OFD：只返回页数与首页尺寸，正文按需取。
#[tauri::command]
pub fn open_ofd(state: State<'_, AppState>, id: String) -> Result<crate::ofd::OfdMeta> {
    let path = book_path(&state, &id)?;
    crate::ofd::open(Path::new(&path))
}

/// 取某一页的 SVG。索引从 0 开始。
#[tauri::command]
pub fn ofd_page_svg(state: State<'_, AppState>, id: String, index: usize) -> Result<String> {
    let path = book_path(&state, &id)?;
    crate::ofd::page_svg(Path::new(&path), index)
}

// ---------------- EPUB ----------------

use crate::epub::{self, EpubMeta};

#[tauri::command]
pub fn open_epub(state: State<'_, AppState>, id: String) -> Result<EpubMeta> {
    let path = book_path(&state, &id)?;
    epub::open(Path::new(&path))
}

/// 取单章原始 XHTML，脚本与事件属性的清理在前端做（需要 DOM 语义）。
#[tauri::command]
pub fn read_epub_chapter(state: State<'_, AppState>, id: String, href: String) -> Result<String> {
    let path = book_path(&state, &id)?;
    epub::chapter(Path::new(&path), &href)
}

/// 章节内图片/字体等资源，按需解压到 epub_cache 并返回本地路径。
#[tauri::command]
pub fn read_epub_resource(
    state: State<'_, AppState>,
    id: String,
    href: String,
) -> Result<String> {
    let path = book_path(&state, &id)?;
    let resolved = epub::resource(Path::new(&path), &href, &state.epub_cache, &id)?;
    Ok(resolved.to_string_lossy().into_owned())
}

// ---------------- 编辑书籍信息 ----------------

/// 手动修改书名与作者。
///
/// 置位 meta_locked，之后扫描不会再用「从文件名推导的标题」覆盖它
/// —— 否则用户改一次名，下次文件变动（甚至只是重新扫描）就被改回去。
#[tauri::command]
pub fn update_book_meta(
    state: State<'_, AppState>,
    id: String,
    title: String,
    author: String,
) -> Result<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Other("书名不能为空".into()));
    }

    let author = author.trim();
    let author = if author.is_empty() { None } else { Some(author) };

    visible_book(&state, &id)?;
    let conn = lock_conn(&state)?;
    db::set_meta(&conn, &id, title, author)
}

// ---------------- 移除 / 删除 ----------------

#[derive(serde::Serialize)]
pub struct RemoveReport {
    /// 文件是否已移入回收站
    pub file_trashed: bool,
    /// 文件已移走但记录没删掉，记录被置为「待恢复」（UX §10.2）
    pub pending: bool,
    /// 移除时顺带删掉了**应用自己复制进来的副本**（不是用户的原文件）。
    /// 前端据此不给「撤销」——文件都没了，恢复出来只会是一条「已丢失」的记录。
    pub removed_copy: bool,
}

/// 从书架移除一本书。
///
/// - `delete_file = false`：只删记录、书库根与缓存。
///   用户自己的文件（扫描目录里的）保持不动，可撤销；
///   但**应用复制进来的副本**（`<data>/inbox`、`<data>/books`）会被一并清掉——
///   那是我们为了「双击就能读」造出来的文件，留着只会白占空间，而且再导入一次又是新的一份。
/// - `delete_file = true`：先把文件移入系统回收站，成功后才删记录
///
/// 顺序是有意的：文件移动失败时数据库保持原样，不会出现「记录没了文件还在」。
/// 反过来「文件已移走但删记录失败」概率极低，此时如实报错，并说明文件在回收站里。
#[tauri::command]
pub fn remove_book(
    state: State<'_, AppState>,
    id: String,
    delete_file: bool,
) -> Result<RemoveReport> {
    let book = visible_book(&state, &id)?;
    let path = Path::new(&book.path);
    let mut removed_copy = false;

    if delete_file {
        if !path.exists() {
            return Err(AppError::Other("文件已不在原位置".into()));
        }
        delete_local_file(path)?;
    } else if managed_copy(&state.data_dir, path) && path.exists() {
        /*
         * 副本不进回收站：它不是用户的文件，用户也不会去回收站找它。
         * 删失败也不阻断移除——记录先干净，比留个删不掉的副本重要。
         */
        match std::fs::remove_file(path) {
            Ok(()) => {
                removed_copy = true;
                crate::logging::info("book", "移除时已清理库内副本");
            }
            Err(e) => crate::logging::warn("book", format!("清理副本失败：{e}")),
        }
    }

    let deleted = {
        let conn = lock_conn(&state)?;
        db::delete_book(&conn, &id)
    };

    if let Err(e) = deleted {
        // 删除事务只完成了前半段：文件进了回收站，记录没删掉。
        // 这里不假装能撤销（trash crate 没有跨平台恢复接口），直接置为
        // 「待恢复」，把决定权交回用户：重新定位，或移除记录（UX §10.2）。
        if delete_file {
            if let Ok(conn) = state.db.lock() {
                let _ = db::set_status(&conn, &id, BookStatus::Pending);
            }
            return Ok(RemoveReport {
                file_trashed: true,
                pending: true,
                removed_copy: false,
            });
        }
        return Err(e);
    }

    // 缓存清理失败不影响正确性，后台静默处理
    let _ = std::fs::remove_dir_all(state.comic_cache.join(&id));
    let _ = std::fs::remove_dir_all(state.epub_cache.join(&id));
    let _ = std::fs::remove_file(state.cover_dir.join(format!("{id}.jpg")));

    Ok(RemoveReport {
        file_trashed: delete_file,
        pending: false,
        removed_copy,
    })
}

/// 这本书的文件是不是**应用自己复制进来的副本**。
///
/// 判别就是看它在不在数据目录下面：`inbox/`（桌面双击打开）、
/// `books/`（移动端导入）都在里面，而扫描目录里的书是用户的原文件，在别处。
///
/// `manual/` 要排除：随包说明的文件被删掉后，下次启动会重新写一份内容
/// 却不会重建记录，反而在磁盘上留个孤儿。
fn managed_copy(data_dir: &Path, path: &Path) -> bool {
    path.starts_with(data_dir) && !path.starts_with(data_dir.join("manual"))
}

/// 「重新定位」一本书：把记录指到用户新选的文件。
///
/// 两种场景共用一条路径：文件被外部移走后找回（`missing`），以及删除事务
/// 中断后的待恢复记录（`status = pending`）。都只修路径，阅读进度与
/// 加入时间原样保留 —— 用户要的是「找到它」，不是「重新入库」。
#[tauri::command]
pub fn relocate_book(state: State<'_, AppState>, id: String, path: String) -> Result<Book> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(AppError::Other("这个文件不存在或无法访问".into()));
    }

    let (book_type, format) = scanner::classify(&target)
        .ok_or_else(|| AppError::Other("这个格式不在支持范围内".into()))?;

    let meta = std::fs::metadata(&target)?;
    let size = meta.len() as i64;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let book = visible_book(&state, &id)?;
    let conn = lock_conn(&state)?;

    // 新路径已被另一条记录占用：硬指过去会撞 UNIQUE 约束，
    // 与其抛数据库错误，不如给一句能看懂的话。
    if let Some((other_id, _, _)) = db::existing_stamp(&conn, &path)? {
        if other_id != id {
            return Err(AppError::Other("这个文件已经在书架里了".into()));
        }
    }

    // 书名锁定过就尊重用户，否则跟着新文件名走——重新定位时选的
    // 往往正是改名后的那个文件，沿用旧名会让人以为没生效。
    let title = if book.meta_locked {
        None
    } else {
        Some(scanner::derive_title(&target, format))
    };

    db::relocate(
        &conn,
        &id,
        &path,
        size,
        mtime,
        title.as_deref(),
        book_type,
        format,
    )?;

    db::get_book(&conn, &id)?
        .ok_or_else(|| AppError::Other("重新定位后记录消失，请重新扫描书库".into()))
}

/// 删除本地文件。
///
/// 桌面走系统回收站，可手动恢复；移动端没有回收站概念，直接删除
/// （前端确认框的文案会随平台变化，不会假装能恢复）。
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn delete_local_file(path: &Path) -> Result<()> {
    trash::delete(path).map_err(|e| AppError::Other(format!("无法移入回收站：{e}")))
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn delete_local_file(path: &Path) -> Result<()> {
    let result = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|e| AppError::Other(format!("删除失败：{e}")))
}

// ---------------- 封面重建 ----------------

#[derive(serde::Serialize)]
pub struct CoverReport {
    /// 真实产出了封面的书数
    pub rebuilt: usize,
    /// 无法读取源文件的书数
    pub failed: usize,
    /// 本来就没有封面的书数（TXT / PDF / 纯文字 MOBI）
    pub placeholder: usize,
}

/// 重新提取全部封面缩略图。
///
/// 为什么需要独立命令：封面只在扫描的「新增 / 文件已变化」分支里生成，
/// 清空 covers 目录后再扫描会走 `Ingest::Skipped` 提前返回，封面永远补不回来。
/// 这里直接遍历书籍重算，并回写 cover_path / cover_state。
#[tauri::command]
pub fn rebuild_covers(state: State<'_, AppState>) -> Result<CoverReport> {
    let conn = lock_conn(&state)?;
    rebuild_all(&conn, &state.cover_dir)
}

/// 重建核心逻辑（与 Tauri 无关，便于单测）。
pub fn rebuild_all(conn: &rusqlite::Connection, cover_dir: &Path) -> Result<CoverReport> {
    use crate::models::CoverState;

    let books = db::list_books(conn, None, None)?;

    let mut report = CoverReport {
        rebuilt: 0,
        failed: 0,
        placeholder: 0,
    };

    for mut book in books {
        // 先删旧文件，否则 cover::build 的「已存在就直接返回」会命中空壳
        let stale = cover_dir.join(format!("{}.jpg", book.id));
        let _ = std::fs::remove_file(stale);

        let outcome = cover::generate(&book.id, book.format, Path::new(&book.path), cover_dir);

        match outcome.state {
            CoverState::Ready => report.rebuilt += 1,
            CoverState::Failed => report.failed += 1,
            _ => report.placeholder += 1,
        }

        book.cover_path = outcome.path;
        book.cover_state = outcome.state;

        db::upsert_book(conn, &book)?;
    }

    Ok(report)
}

// ---------------- 缓存 ----------------

use crate::cache;

#[derive(serde::Serialize)]
pub struct CacheReport {
    pub comic: u64,
    pub epub: u64,
    pub covers: u64,
}

#[tauri::command]
pub fn cache_report(state: State<'_, AppState>) -> Result<CacheReport> {
    Ok(CacheReport {
        comic: cache::dir_size(&state.comic_cache),
        epub: cache::dir_size(&state.epub_cache),
        covers: cache::dir_size(&state.cover_dir),
    })
}

/// kind: comic | epub | covers | all（all 不含封面，封面重建有成本）
#[tauri::command]
pub fn clear_cache(state: State<'_, AppState>, kind: String) -> Result<u64> {
    let mut freed = 0u64;
    match kind.as_str() {
        "comic" => freed += cache::clear_dir(&state.comic_cache)?,
        "epub" => freed += cache::clear_dir(&state.epub_cache)?,
        "covers" => freed += cache::clear_dir(&state.cover_dir)?,
        _ => {
            freed += cache::clear_dir(&state.comic_cache)?;
            freed += cache::clear_dir(&state.epub_cache)?;
        }
    }
    Ok(freed)
}

// ---------------- 备份 / 恢复 ----------------

use crate::backup::{
    self, BackupConfig, BackupScope, ExportReport, LocalBackup, RemoteBackup, RestoreReport,
    WebdavConfig,
};

/// 版本号写进备份包的 manifest，方便排查「这个包是哪版生成的」
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[tauri::command]
pub fn backup_config(state: State<'_, AppState>) -> Result<BackupConfig> {
    Ok(backup::load_config(&state.data_dir))
}

#[tauri::command]
pub fn save_backup_config(state: State<'_, AppState>, config: BackupConfig) -> Result<()> {
    backup::save_config(&state.data_dir, &config)
}

/// 生成备份包。`target` 为空时落到应用数据目录下的 backups/（移动端没有另存为对话框）。
///
/// 备份是重 IO（整库快照 + 压缩），放阻塞线程池，别让设置页卡住。
#[tauri::command]
pub async fn backup_export(
    app: AppHandle,
    target: Option<String>,
    include_covers: bool,
    include_private: bool,
) -> Result<ExportReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = match target.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
            Some(t) => std::path::PathBuf::from(t),
            None => state.backup_dir.join(backup::backup_file_name()),
        };

        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::Other("数据库连接不可用".into()))?;
        let report = backup::export(
            &conn,
            &state.cover_dir,
            &path,
            include_covers,
            include_private,
            APP_VERSION,
        )
        .map_err(|e| {
            crate::logging::failure("backup", "导出失败", &e);
            e
        })?;
        drop(conn);
        crate::logging::info(
            "backup",
            format!(
                "导出完成：{} 本 · 封面 {} · 含隐私 {} · {} KB",
                report.books,
                if include_covers { "是" } else { "否" },
                if include_private { "是" } else { "否" },
                report.bytes / 1024
            ),
        );

        // 记一笔「上次本地备份」。写失败只影响摘要文案，不影响备份本身。
        let mut config = backup::load_config(&state.data_dir);
        config.last_local_at = Some(report.created_at);
        config.include_covers = include_covers;
        let _ = backup::save_config(&state.data_dir, &config);

        Ok(report)
    })
    .await
    .map_err(|e| AppError::Other(format!("备份任务失败: {e}")))?
}

/// 备份前先问一次范围：有隐私书时前端要弹「是否一并备份」。
#[tauri::command]
pub fn backup_scope(state: State<'_, AppState>) -> Result<BackupScope> {
    let conn = lock_conn(&state)?;
    backup::scope(&conn)
}

#[tauri::command]
pub fn backup_list_local(state: State<'_, AppState>) -> Result<Vec<LocalBackup>> {
    Ok(backup::list_local(&state.backup_dir))
}

/// 删除应用自己产出的备份包。
///
/// 路径来自前端，所以必须先落回备份目录里再删——这条命令不能变成
/// 「凭一个字符串删任意文件」的后门。
#[tauri::command]
pub fn backup_delete_local(state: State<'_, AppState>, path: String) -> Result<()> {
    let target = Path::new(&path)
        .canonicalize()
        .map_err(|_| AppError::Other("备份包不存在".into()))?;
    let dir = state
        .backup_dir
        .canonicalize()
        .unwrap_or_else(|_| state.backup_dir.clone());

    if !target.starts_with(&dir) {
        return Err(AppError::Other("只能删除应用备份目录里的文件".into()));
    }
    std::fs::remove_file(&target)?;
    Ok(())
}

/// 用备份覆盖当前书库。书籍文件本身不动，只还原书架记录、进度与封面。
#[tauri::command]
pub async fn backup_restore(app: AppHandle, path: String) -> Result<RestoreReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut conn = state
            .db
            .lock()
            .map_err(|_| AppError::Other("数据库连接不可用".into()))?;
        let report = backup::restore(&mut conn, &state.cover_dir, std::path::Path::new(&path))
            .map_err(|e| {
                crate::logging::failure("backup", "恢复失败", &e);
                e
            })?;
        drop(conn);
        crate::logging::info(
            "backup",
            format!("恢复完成：{} 本 · 封面 {}", report.books, report.covers),
        );

        // 书可能是另一台机器上的，缓存的全文 / 图片路径都可能失效
        if let Ok(mut cache) = state.text_cache.lock() {
            *cache = None;
        }
        Ok(report)
    })
    .await
    .map_err(|e| AppError::Other(format!("恢复任务失败: {e}")))?
}

#[tauri::command]
pub async fn webdav_test(config: WebdavConfig) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || backup::webdav_test(&config))
        .await
        .map_err(|e| AppError::Other(format!("测试连接失败: {e}")))?
}

#[tauri::command]
pub async fn webdav_upload(
    app: AppHandle,
    config: WebdavConfig,
    include_covers: bool,
    include_private: bool,
) -> Result<ExportReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::Other("数据库连接不可用".into()))?;
        let report = backup::webdav_upload(
            &conn,
            &state.cover_dir,
            &config,
            include_covers,
            include_private,
            APP_VERSION,
        )?;
        drop(conn);

        // 顺手把地址与账号存下来：下次打开设置不用重填
        let mut saved = backup::load_config(&state.data_dir);
        saved.webdav = config;
        saved.include_covers = include_covers;
        saved.last_webdav_at = Some(report.created_at);
        let _ = backup::save_config(&state.data_dir, &saved);

        Ok(report)
    })
    .await
    .map_err(|e| AppError::Other(format!("上传任务失败: {e}")))?
}

#[tauri::command]
pub async fn webdav_list(config: WebdavConfig) -> Result<Vec<RemoteBackup>> {
    tauri::async_runtime::spawn_blocking(move || backup::webdav_list(&config))
        .await
        .map_err(|e| AppError::Other(format!("读取远端列表失败: {e}")))?
}

#[tauri::command]
pub async fn webdav_delete(config: WebdavConfig, name: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || backup::webdav_delete(&config, &name))
        .await
        .map_err(|e| AppError::Other(format!("删除失败: {e}")))?
}

#[tauri::command]
pub async fn webdav_restore(
    app: AppHandle,
    config: WebdavConfig,
    name: String,
) -> Result<RestoreReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut conn = state
            .db
            .lock()
            .map_err(|_| AppError::Other("数据库连接不可用".into()))?;
        let report = backup::webdav_restore(&mut conn, &state.cover_dir, &config, &name)?;
        drop(conn);

        if let Ok(mut cache) = state.text_cache.lock() {
            *cache = None;
        }
        Ok(report)
    })
    .await
    .map_err(|e| AppError::Other(format!("恢复任务失败: {e}")))?
}

// ---------------- 运行日志 ----------------

/// 前端把错误转进同一份日志。
///
/// 前端能看到的错误（IPC 失败、渲染异常）后端是不知道的，
/// 两边写同一个文件，排查时按时间排一遍就够了。
#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    // 收到任何一条就等于「前端活着」，看门狗据此判断要不要报黑屏
    crate::logging::mark_front_alive();
    match level.as_str() {
        "error" => crate::logging::error("frontend", message),
        "warn" => crate::logging::warn("frontend", message),
        _ => crate::logging::info("frontend", message),
    }
}

/// 读日志尾部，供「设置 → 关于 → 查看日志」显示。
#[tauri::command]
pub fn read_log(max_lines: Option<usize>) -> String {
    crate::logging::tail(max_lines.unwrap_or(500).clamp(50, 5000))
}

/// 日志文件路径（找不到日志功能没起来时返回空）。
#[tauri::command]
pub fn log_path() -> Option<String> {
    crate::logging::path().map(|p| p.to_string_lossy().to_string())
}

// ---------------- 标注：书签 / 笔记 ----------------

/// 取一本书的标注。`kind` 省略时返回全部（书签 + 笔记）。
#[tauri::command]
pub fn list_annotations(
    state: State<'_, AppState>,
    id: String,
    kind: Option<String>,
) -> Result<Vec<Annotation>> {
    visible_book(&state, &id)?;
    let conn = lock_conn(&state)?;
    let kind = kind.as_deref().map(AnnotationKind::parse);
    db::list_annotations(&conn, &id, kind)
}

/// 新增一条标注（书签 / 高亮 / 笔记）。
///
/// 三者共用一张表、同一个入口，区别只在 `kind` 与字段用法：
/// - 书签：`locator` 即可，`label` 是备注；
/// - 高亮：`locator` 定章、`anchor` 定章内区间、`excerpt` 存原文；
/// - 笔记：在高亮的基础上再把正文放进 `label`。
///
/// `locator` 与「保存进度」同一个坐标，所以「跳到标注」和「跳到搜索结果」
/// 可以是同一段前端代码。
#[tauri::command]
pub fn add_annotation(
    state: State<'_, AppState>,
    id: String,
    kind: String,
    locator: Progress,
    label: Option<String>,
    excerpt: Option<String>,
    anchor: Option<Anchor>,
) -> Result<Annotation> {
    visible_book(&state, &id)?;
    let now = db::now_ts();
    let kind = AnnotationKind::parse(&kind);
    // 书签是「一个点」，带上区间没有意义，反而会让列表里的描述错位
    let anchor = match kind {
        AnnotationKind::Bookmark => None,
        _ => anchor,
    };
    let item = Annotation {
        id: crate::util::new_id(),
        book_id: id,
        kind,
        locator,
        label: label.filter(|s| !s.trim().is_empty()),
        excerpt: excerpt.filter(|s| !s.trim().is_empty()),
        anchor,
        created_at: now,
        updated_at: now,
    };
    let conn = lock_conn(&state)?;
    db::insert_annotation(&conn, &item)?;
    crate::logging::info(
        "annotation",
        format!("新增 {}（…{}）", item.kind.as_str(), item.id),
    );
    Ok(item)
}

/// 改书签备注（空字符串表示清空）。
#[tauri::command]
pub fn update_annotation_label(
    state: State<'_, AppState>,
    annotation_id: String,
    label: Option<String>,
) -> Result<()> {
    let book_id = annotation_book_id(&state, &annotation_id)?;
    visible_book(&state, &book_id)?;
    let conn = lock_conn(&state)?;
    let label = label.filter(|s| !s.trim().is_empty());
    db::update_annotation_label(&conn, &annotation_id, label.as_deref())
}

#[tauri::command]
pub fn delete_annotation(state: State<'_, AppState>, annotation_id: String) -> Result<()> {
    let book_id = annotation_book_id(&state, &annotation_id)?;
    visible_book(&state, &book_id)?;
    let conn = lock_conn(&state)?;
    db::delete_annotation(&conn, &annotation_id)?;
    crate::logging::info("annotation", format!("删除标注（…{annotation_id}）"));
    Ok(())
}

/// 标注属于哪本书。改 / 删之前要先拿它过一遍隐私守卫：
/// 否则锁定时仍能凭 id 删掉隐私书的书签，等于绕过可见性。
fn annotation_book_id(state: &State<'_, AppState>, annotation_id: &str) -> Result<String> {
    let conn = lock_conn(state)?;
    conn.query_row(
        "SELECT book_id FROM annotations WHERE id = ?1",
        rusqlite::params![annotation_id],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .ok_or_else(|| AppError::Other("标注不存在".into()))
}

/// 导出标注（书签 / 以后的高亮与笔记）到文本文件。
///
/// 由后端写文件而不是前端：`plugin-fs` 的写入受 scope 限制，
/// 用户在保存对话框里选的任意路径未必在白名单内；后端 `fs::write` 不受这一层限制。
/// 移动端由前端决定是否提供「保存」（安卓没有系统保存对话框，走「复制」）。
#[tauri::command]
pub fn export_annotations(
    state: State<'_, AppState>,
    id: String,
    path: String,
    format: String,
) -> Result<usize> {
    let book = visible_book(&state, &id)?;
    let items = {
        let conn = lock_conn(&state)?;
        db::list_annotations(&conn, &id, None)?
    };
    let body = match format.as_str() {
        // JSON 是唯一「能回导」的格式：Markdown / CSV 给人看，位置是四舍五入后的说法
        "json" => crate::annotations_export::to_json(&book, &items)?,
        "csv" => crate::annotations_export::to_csv(&items),
        _ => crate::annotations_export::to_markdown(&book.title, book.author.as_deref(), &items),
    };
    std::fs::write(&path, body.as_bytes())?;
    crate::logging::info(
        "annotation",
        format!("导出 {} 条到 {path}", items.len()),
    );
    Ok(items.len())
}

/// 回导结果。给用户的是一句「导入 12 条，跳过 3 条」，
/// 而不是一个整体成功——「跳过」才是重复导入时最该看见的数字。
#[derive(Debug, serde::Serialize)]
pub struct ImportReport {
    pub imported: usize,
    pub skipped: usize,
    pub total: usize,
    /// 文件里记的书名。与当前书不一致时前端可以提醒一句，但不阻止导入
    pub source_title: String,
}

/// 从 JSON 文件回导标注。
///
/// 去重规则：同一本书里，**类型 + 位置 + 锚点 + 备注 + 原文**全同视为同一条。
/// 只比其中几项都不够：同一页可能真的有两条不同备注的书签，
/// 而同一份文件导入两次必须一条都不增加。
#[tauri::command]
pub fn import_annotations(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<ImportReport> {
    visible_book(&state, &id)?;
    // 标注文件本来只有几十 KB。读到几百 MB 的文件只可能是选错了，
    // 与其把内存吃满再报 JSON 错，不如提前说清楚。
    let size = std::fs::metadata(&path)?.len();
    if size > 20 * 1024 * 1024 {
        return Err(AppError::Other(format!(
            "这个文件有 {} MB，不像是标注文件",
            size / 1024 / 1024
        )));
    }
    let raw = std::fs::read_to_string(&path)?;
    let file = crate::annotations_export::parse_json(&raw)?;

    let conn = lock_conn(&state)?;
    let (imported, skipped) = import_into(&conn, &id, &file)?;
    let total = file.annotations.len();
    crate::logging::info(
        "annotation",
        format!("回导标注：导入 {imported} 条，跳过 {skipped} 条（来自 {path}）"),
    );
    Ok(ImportReport {
        imported,
        skipped,
        total,
        source_title: file.book.title,
    })
}

/// 真正的写入循环。抽出来是为了能脱离 Tauri 的 `State` 做单测：
/// 「导入两次不会翻倍」这条规则只有真跑一遍才验证得了。
fn import_into(
    conn: &rusqlite::Connection,
    book_id: &str,
    file: &crate::annotations_export::ExportFile,
) -> Result<(usize, usize)> {
    let existing = db::list_annotations(conn, book_id, None)?;
    let mut seen: std::collections::HashSet<String> = existing.iter().map(dedupe_key).collect();

    let now = db::now_ts();
    let mut imported = 0usize;
    let mut skipped = 0usize;

    for item in &file.annotations {
        // 书签没有锚点，别把文件里的脏数据带进来
        let anchor = match item.kind {
            AnnotationKind::Bookmark => None,
            _ => item.anchor.clone(),
        };
        let candidate = Annotation {
            id: crate::util::new_id(),
            book_id: book_id.to_string(),
            kind: item.kind,
            locator: item.locator.clone(),
            label: item.label.clone().filter(|s| !s.trim().is_empty()),
            excerpt: item.excerpt.clone().filter(|s| !s.trim().is_empty()),
            anchor,
            created_at: if item.created_at > 0 { item.created_at } else { now },
            updated_at: if item.updated_at > 0 { item.updated_at } else { now },
        };
        let key = dedupe_key(&candidate);
        if seen.contains(&key) {
            skipped += 1;
            continue;
        }
        db::insert_annotation(conn, &candidate)?;
        seen.insert(key);
        imported += 1;
    }
    Ok((imported, skipped))
}

/// 去重键：把参与比较的字段拼成一个字符串。序列化好的 JSON 就是最稳的规范形式。
fn dedupe_key(item: &Annotation) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        item.kind.as_str(),
        serde_json::to_string(&item.locator).unwrap_or_default(),
        serde_json::to_string(&item.anchor).unwrap_or_default(),
        item.label.as_deref().unwrap_or(""),
        item.excerpt.as_deref().unwrap_or(""),
    )
}

// ---------------- 批量导出 ----------------

/// 批量导出的结果。
///
/// 三个失败口分开报：文件不在本地、复制失败、无权导出（隐私书）。
/// 合成一个「失败 N 本」用户没法判断该去修哪一块。
#[derive(Debug, serde::Serialize)]
pub struct ExportBooksReport {
    /// 实际复制了几本
    pub copied: usize,
    /// 其中因重名改了文件名的有几本
    pub renamed: usize,
    /// 文件不在本地（已被移走 / 删除）的书名
    pub missing: Vec<String>,
    /// 复制失败的书名
    pub failed: Vec<String>,
    /// 因隐私书架未解锁而跳过的数量
    pub blocked: usize,
    pub total: usize,
}

/// 把选中的书**复制**一份到目标目录。原文件不动——这是「导出」，不是「导出并删除」。
#[tauri::command]
pub fn export_books(
    state: State<'_, AppState>,
    ids: Vec<String>,
    dir: String,
) -> Result<ExportBooksReport> {
    let target = std::path::Path::new(&dir);
    if !target.is_dir() {
        return Err(AppError::Other("目标目录不存在".into()));
    }

    let conn = lock_conn(&state)?;
    let report = export_into(&conn, &ids, target)?;
    crate::logging::info(
        "export",
        format!(
            "批量导出到 {dir}：成功 {} / 重名改名 {} / 缺失 {} / 失败 {}",
            report.copied,
            report.renamed,
            report.missing.len(),
            report.failed.len()
        ),
    );
    Ok(report)
}

/// 复制循环。抽出来是为了脱离 Tauri `State` 做单测——
/// 「文件不在本地要单独报」「同名要改名而不是覆盖」这两条都得真跑文件系统。
fn export_into(
    conn: &rusqlite::Connection,
    ids: &[String],
    target: &std::path::Path,
) -> Result<ExportBooksReport> {
    let mut report = ExportBooksReport {
        copied: 0,
        renamed: 0,
        missing: Vec::new(),
        failed: Vec::new(),
        blocked: 0,
        total: ids.len(),
    };

    for id in ids {
        // 隐私守卫：公开书架上的批量导出不该成为绕过「隐私书不可见」的出口
        let book = match db::get_book(conn, id)? {
            Some(book) if !book.private => book,
            _ => {
                report.blocked += 1;
                continue;
            }
        };

        let source = std::path::Path::new(&book.path);
        if !source.is_file() {
            report.missing.push(book.title.clone());
            continue;
        }

        let dest = crate::startup::unique_path(target, source);
        let renamed = dest.file_name() != source.file_name();
        match std::fs::copy(source, &dest) {
            Ok(_) => {
                report.copied += 1;
                if renamed {
                    report.renamed += 1;
                }
            }
            Err(_) => report.failed.push(book.title.clone()),
        }
    }

    Ok(report)
}

// ---------------- 标签 ----------------

/// 侧栏用的标签清单（带可见书里的使用次数）。
#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> Result<Vec<TagCount>> {
    let conn = lock_conn(&state)?;
    db::list_tags(&conn)
}

/// 每本书挂了哪些标签。一次取全量，前端建 Map——逐本查会打出几百次 IPC。
#[tauri::command]
pub fn list_tag_assignments(state: State<'_, AppState>) -> Result<Vec<(String, String)>> {
    let conn = lock_conn(&state)?;
    db::list_tag_assignments(&conn)
}

/// 覆盖一本书的标签。全量替换：调用方知道的永远是「这张卡现在有哪些标签」。
#[tauri::command]
pub fn set_book_tags(
    state: State<'_, AppState>,
    id: String,
    tags: Vec<String>,
) -> Result<Vec<String>> {
    visible_book(&state, &id)?;
    let conn = lock_conn(&state)?;
    let saved = db::set_book_tags(&conn, &id, &tags)?;
    crate::logging::info("tag", format!("更新标签（{} 个）", saved.len()));
    Ok(saved)
}

/// 删掉一个标签，连带所有书的关联。
#[tauri::command]
pub fn delete_tag(state: State<'_, AppState>, name: String) -> Result<()> {
    let conn = lock_conn(&state)?;
    db::delete_tag(&conn, &name)?;
    crate::logging::info("tag", format!("删除标签「{name}」"));
    Ok(())
}

// ---------------- 书内搜索 ----------------

/// 书内全文搜索。
///
/// 只覆盖「有纯文本」的格式：TXT / MOBI / FB2 / RTF / MHTML 扫解码后的正文，
/// HTML / MD / DOCX / XLSX 扫 HTML 本身（剥标签时保持字节偏移，见 `search.rs`）。
/// PDF 与漫画没有文字层，不在这条链路上（EPUB 走单独的逐章分支）。
#[tauri::command]
pub fn search_book(
    state: State<'_, AppState>,
    id: String,
    query: String,
) -> Result<Vec<SearchHit>> {
    let book = visible_book(&state, &id)?;
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let path = Path::new(&book.path);

    // HTML 族：阅读器拿到的就是这串 HTML，章节偏移也基于它
    if matches!(
        book.format,
        BookFormat::Html | BookFormat::Markdown | BookFormat::Docx | BookFormat::Xlsx
    ) {
        let html = match book.format {
            BookFormat::Html => {
                let bytes = std::fs::read(path)?;
                crate::util::decode_text(&bytes).0
            }
            // 与 md::open_html 同一条路径：解码 → 转 HTML，偏移才能对上章节
            BookFormat::Markdown => {
                let bytes = std::fs::read(path)?;
                let (src, _) = crate::util::decode_text(&bytes);
                crate::md::to_html(&src)
            }
            BookFormat::Docx => crate::docx::to_html(path)?,
            _ => crate::xlsx::to_html(path)?,
        };
        let meta = crate::html::book_from_html(&html, "utf-8");
        let plain = crate::search::strip_tags_keep_offsets(&html);
        return Ok(crate::search::search_text(
            &plain,
            &query,
            &meta.chapters,
            meta.total_bytes as u64,
            SEARCH_LIMIT,
        ));
    }

    if matches!(
        book.format,
        BookFormat::Txt
            | BookFormat::Fb2
            | BookFormat::Rtf
            | BookFormat::Mhtml
            | BookFormat::Mobi
            | BookFormat::Azw3
    ) {
        let (meta, full) = load_plain_text(&state, &id, path)?;
        return Ok(crate::search::search_text(
            &full,
            &query,
            &meta.chapters,
            meta.total_bytes as u64,
            SEARCH_LIMIT,
        ));
    }

    if book.format == BookFormat::Epub {
        let meta = crate::epub::open(path)?;
        let mut hits: Vec<SearchHit> = Vec::new();
        // 逐章扫：命中够了就停，避免整本书全解压
        for (index, chapter) in meta.chapters.iter().enumerate() {
            if hits.len() >= SEARCH_LIMIT {
                break;
            }
            let Ok(html) = crate::epub::chapter(path, &chapter.href) else {
                // 单章解不出来不影响其余章节
                continue;
            };
            let more = crate::search::search_epub_chapter(
                &html,
                &query,
                &chapter.href,
                &chapter.title,
                index,
                SEARCH_LIMIT - hits.len(),
            );
            hits.extend(more);
        }
        crate::logging::info("search", format!("EPUB 命中 {} 条", hits.len()));
        return Ok(hits);
    }

    crate::logging::warn(
        "search",
        format!("{} 暂不支持书内搜索", book.format.as_str()),
    );
    Err(AppError::Other(
        "这个格式暂不支持书内搜索（PDF 与漫画没有文字层，需要 OCR 或另一套索引）".into(),
    ))
}

const SEARCH_LIMIT: usize = 200;

// ---------------- 隐私书架 ----------------

use crate::privacy::{self, PrivacyConfig};

#[derive(serde::Serialize)]
pub struct PrivacyStatus {
    pub enabled: bool,
    pub unlocked: bool,
    pub lock_after_minutes: i64,
    /// 只在解锁态下给出真实数量：锁定时连「有几本」都不该泄露
    pub private_books: i64,
}

#[tauri::command]
pub fn privacy_status(state: State<'_, AppState>) -> Result<PrivacyStatus> {
    let config = state.privacy_settings();
    let unlocked = state.unlocked();
    let private_books = if unlocked {
        let conn = lock_conn(&state)?;
        db::count_private(&conn)?
    } else {
        0
    };
    Ok(PrivacyStatus {
        enabled: config.enabled,
        unlocked,
        lock_after_minutes: config.lock_after_minutes,
        private_books,
    })
}

/// 启用隐私书架：设 PIN。已经启用时要求先关掉（避免悄悄换 PIN）。
#[tauri::command]
pub fn privacy_enable(
    state: State<'_, AppState>,
    pin: String,
    lock_after_minutes: i64,
) -> Result<()> {
    let pin = privacy::normalize_pin(&pin)?;
    let mut config = state.privacy_settings();
    if config.enabled {
        return Err(AppError::Other("隐私书架已启用，先关闭才能换 PIN".into()));
    }

    config.enabled = true;
    config.pin_hash = privacy::hash_pin(&pin)?;
    config.lock_after_minutes = lock_after_minutes.clamp(0, 240);
    state.set_privacy_config(config)?;
    crate::logging::info("privacy", "隐私书架已启用");

    // 刚设完就是解锁态：用户下一步通常就是往里放书
    if let Ok(mut session) = state.privacy.lock() {
        session.unlock();
    }
    Ok(())
}

#[tauri::command]
pub fn privacy_unlock(state: State<'_, AppState>, pin: String) -> Result<()> {
    let config = state.privacy_settings();
    if !config.enabled {
        return Err(AppError::Other("还没有启用隐私书架".into()));
    }

    {
        let session = state
            .privacy
            .lock()
            .map_err(|_| AppError::Other("会话不可用".into()))?;
        let wait = session.retry_after();
        if wait > std::time::Duration::ZERO {
            return Err(AppError::Other(format!(
                "尝试次数过多，{} 秒后再试",
                wait.as_secs().max(1)
            )));
        }
    }

    let pin = pin.trim();
    if privacy::verify_pin(pin, &config.pin_hash) {
        if let Ok(mut session) = state.privacy.lock() {
            session.unlock();
        }
        return Ok(());
    }

    let remaining = {
        let mut session = state
            .privacy
            .lock()
            .map_err(|_| AppError::Other("会话不可用".into()))?;
        session.record_failure();
        session.failures()
    };
    // 不告诉对方「还差几位」，只说还有几次机会——本地应用没有锁死，但也不该白送信息
    // 只记「第几次失败」，PIN 本身绝不进日志
    crate::logging::warn("privacy", format!("解锁失败（连续第 {remaining} 次）"));
    let left = (8i64 - remaining as i64).max(0);
    Err(AppError::Other(if left > 0 {
        format!("PIN 不正确，还可以试 {left} 次")
    } else {
        "PIN 不正确".to_string()
    }))
}

/// 改自动上锁时长。不需要 PIN：它不改变「谁能看到」，只改变「多久之后要再输一次」。
#[tauri::command]
pub fn privacy_set_lock_after(state: State<'_, AppState>, minutes: i64) -> Result<()> {
    let mut config = state.privacy_settings();
    if !config.enabled {
        return Err(AppError::Other("还没有启用隐私书架".into()));
    }
    config.lock_after_minutes = minutes.clamp(0, 240);
    state.set_privacy_config(config)
}

#[tauri::command]
pub fn privacy_lock(state: State<'_, AppState>) -> Result<()> {
    if let Ok(mut session) = state.privacy.lock() {
        session.lock();
        session.reset_failures();
    }
    Ok(())
}

/// 关闭隐私书架。**书架里还有书就拒绝**：
/// 一键关闭把书全放回公开书架，是最容易让人后悔的操作。
#[tauri::command]
pub fn privacy_disable(state: State<'_, AppState>, pin: String) -> Result<()> {
    let config = state.privacy_settings();
    if !config.enabled {
        return Ok(());
    }
    if !privacy::verify_pin(pin.trim(), &config.pin_hash) {
        return Err(AppError::Other("PIN 不正确".into()));
    }

    {
        let conn = lock_conn(&state)?;
        let left = db::count_private(&conn)?;
        if left > 0 {
            return Err(AppError::Other(format!(
                "隐私书架里还有 {left} 本，先把它们移出再关闭"
            )));
        }
    }

    let cleared = PrivacyConfig::default();
    state.set_privacy_config(cleared)?;
    crate::logging::info("privacy", "隐私书架已关闭");
    if let Ok(mut session) = state.privacy.lock() {
        session.lock();
        session.reset_failures();
    }
    Ok(())
}

/// 隐私书架列表。锁定时直接拒绝——这里没有「返回空列表」这一说，
/// 空列表和「没有隐私书」在语义上没法区分，反而更让人困惑。
#[tauri::command]
pub fn privacy_list(state: State<'_, AppState>, query: Option<String>) -> Result<Vec<Book>> {
    if !state.unlocked() {
        return Err(AppError::Other("隐私书架已锁定".into()));
    }
    let conn = lock_conn(&state)?;
    db::list_private(&conn, query.as_deref())
}

/// 书架的封面目录。隐私书要挪到 private_covers/，不再和公开书混在一起。
fn private_cover_dir(state: &State<'_, AppState>) -> PathBuf {
    state.data_dir.join("private_covers")
}

/// 把封面在两个目录之间搬一次。搬失败返回 None，调用方把状态退回 pending。
fn move_cover(state: &State<'_, AppState>, id: &str, to_private: bool) -> Option<PathBuf> {
    let public = state.cover_dir.join(format!("{id}.jpg"));
    let hidden_dir = private_cover_dir(state);
    let hidden = hidden_dir.join(format!("{id}.jpg"));

    let (from, to) = if to_private {
        (public, hidden)
    } else {
        (hidden, public)
    };
    if !from.is_file() {
        return None;
    }

    if let Some(parent) = to.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::rename(&from, &to) {
        Ok(()) => Some(to),
        Err(_) => {
            // 跨设备 / 被占用时 rename 会失败，退回复制
            if std::fs::copy(&from, &to).is_ok() {
                let _ = std::fs::remove_file(&from);
                Some(to)
            } else {
                None
            }
        }
    }
}

fn set_privacy(state: &State<'_, AppState>, id: String, private: bool) -> Result<()> {
    if !state.unlocked() {
        return Err(AppError::Other("隐私书架已锁定".into()));
    }
    let book = visible_book(state, &id)?;

    {
        let conn = lock_conn(state)?;
        db::set_private(&conn, &id, private)?;
    }

    // 封面跟着走：留在公开目录里等于把「一眼能看到的内容」摊在明处
    let existing_state = book.cover_state;
    let path = move_cover(state, &id, private);
    let conn = lock_conn(state)?;
    match path {
        Some(p) => db::set_cover(&conn, &id, Some(&p.to_string_lossy()), existing_state)?,
        None => {
            // 本来就没有封面（TXT / PDF）就别硬造一个错误状态
            let keep = if book.cover_path.is_some() {
                crate::models::CoverState::Pending
            } else {
                existing_state
            };
            db::set_cover(&conn, &id, None, keep)?;
        }
    }
    Ok(())
}

/// 把书移进隐私书架。
#[tauri::command]
pub fn privacy_move(state: State<'_, AppState>, id: String) -> Result<()> {
    set_privacy(&state, id, true)
}

/// 批量移入 / 移出隐私书架。
///
/// 逐本走 `set_privacy`：封面搬移、封面状态回填这些副作用只在那一处实现，
/// 批量入口再复制一份迟早会漏。单本失败不中断整批，返回真正成功的本数。
#[tauri::command]
pub fn privacy_move_many(
    state: State<'_, AppState>,
    ids: Vec<String>,
    private: bool,
) -> Result<usize> {
    if !state.unlocked() {
        return Err(AppError::Other("隐私书架已锁定".into()));
    }
    let total = ids.len();
    let mut moved = 0;
    for id in ids {
        match set_privacy(&state, id, private) {
            Ok(()) => moved += 1,
            Err(e) => crate::logging::warn("privacy", format!("批量{}失败：{e}", if private { "移入" } else { "移出" })),
        }
    }
    crate::logging::info(
        "privacy",
        format!(
            "批量{}：{moved}/{total} 本",
            if private { "移入隐私" } else { "移出隐私" }
        ),
    );
    Ok(moved)
}

/// 移出隐私书架（回到公开书架）。
#[tauri::command]
pub fn privacy_release(state: State<'_, AppState>, id: String) -> Result<()> {
    set_privacy(&state, id, false)
}

/// 双击打开时，前端挂载后取一次「该打开哪本书」，取完即清。
#[tauri::command]
pub fn take_startup_book(state: State<'_, AppState>) -> Option<String> {
    // 冷启动：argv 里带的文件在 setup 阶段已经收下，这里直接取 id
    if let Some(id) = crate::startup::take_pending(&state) {
        return Some(id);
    }

    /*
     * Android：「用其他应用打开」没有 argv。Kotlin 主 Activity 把文件复制到 cache 后
     * 排进队列，前端每次回到前台都会来问一次——所以热启动（应用已在后台）
     * 同样走这条，不需要额外的原生回调。
     */
    #[cfg(target_os = "android")]
    {
        let state = state.inner();
        let conn = state.db.lock().ok()?;
        if let Some(book) = crate::startup::take_incoming(state, &conn) {
            // absorb 顺手写了冷启动槽；这里直接返回 id，别再让挂载逻辑重开一次
            if let Ok(mut slot) = state.startup_book.lock() {
                *slot = None;
            }
            return Some(book.id);
        }
    }

    None
}

// ---------------- 应用生命周期 ----------------

/// 退出应用。Android 上用于「返回键走到栈底」时主动结束 Activity，
/// 否则我们自己接管了 back-button 事件后，系统不会再自动退出。
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod managed_copy_tests {
    use super::managed_copy;
    use std::path::Path;

    #[test]
    fn copies_inside_data_dir_are_managed() {
        let data = Path::new("/data/user/0/app");
        assert!(managed_copy(data, Path::new("/data/user/0/app/inbox/a.epub")));
        assert!(managed_copy(data, Path::new("/data/user/0/app/books/b.pdf")));
    }

    /// 用户自己的文件绝不能删：扫描目录里的书、以及名字只差一个字的别的目录
    #[test]
    fn user_files_outside_are_untouched() {
        let data = Path::new("/data/user/0/app");
        assert!(!managed_copy(
            data,
            Path::new("/storage/emulated/0/Download/a.epub")
        ));
        // 前缀是路径组件比较，不是字符串比较：app2 不算 app 里面
        assert!(!managed_copy(data, Path::new("/data/user/0/app2/inbox/a.epub")));
    }

    /// 随包说明排除在外：删了文件下次启动还会写回内容，只在磁盘上留孤儿
    #[test]
    fn bundled_manual_is_excluded() {
        let data = Path::new("/data/user/0/app");
        assert!(!managed_copy(data, Path::new("/data/user/0/app/manual/x.md")));
    }
}

#[cfg(test)]
mod export_books_tests {
    use super::*;
    use crate::models::{BookStatus, CoverState};

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cenro-export-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed(conn: &rusqlite::Connection, root: &std::path::Path, id: &str, private: bool) -> String {
        let path = root.join(format!("{id}.txt"));
        std::fs::write(&path, b"hello").unwrap();
        let book = Book {
            id: id.into(),
            book_type: BookType::Novel,
            format: BookFormat::Txt,
            path: path.to_string_lossy().into_owned(),
            size: 5,
            mtime: 0,
            title: id.into(),
            author: None,
            cover_path: None,
            cover_state: CoverState::Pending,
            meta_locked: false,
            status: BookStatus::Ok,
            private: false,
            missing: false,
            progress: None,
            metadata: None,
            added_at: 1,
            last_read_at: None,
        };
        conn.execute(
            r#"INSERT INTO books (id, type, format, path, size, mtime, title, added_at, private)
               VALUES (?1,'novel','txt',?2,5,0,?3,1,?4)"#,
            rusqlite::params![id, book.path, id, if private { 1 } else { 0 }],
        )
        .unwrap();
        id.to_string()
    }

    fn db_with(root: &std::path::Path, ids: &[(&str, bool)]) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        for (id, private) in ids {
            seed(&conn, root, id, *private);
        }
        conn
    }

    #[test]
    fn copies_files_and_skips_private() {
        let root = temp_dir("copy");
        let out = temp_dir("copy-out");
        let conn = db_with(&root, &[("a", false), ("b", false), ("p", true)]);

        let ids = vec!["a".to_string(), "b".to_string(), "p".to_string()];
        let report = export_into(&conn, &ids, &out).unwrap();
        assert_eq!(report.copied, 2);
        assert_eq!(report.blocked, 1);
        assert_eq!(report.total, 3);
        assert!(out.join("a.txt").is_file() && out.join("b.txt").is_file());
        assert!(!out.join("p.txt").exists());
        // 原文件不动
        assert!(root.join("a.txt").is_file());
    }

    #[test]
    fn same_name_gets_a_suffix_instead_of_overwriting() {
        let root = temp_dir("dup");
        let out = temp_dir("dup-out");
        let conn = db_with(&root, &[("a", false)]);

        export_into(&conn, &["a".to_string()], &out).unwrap();
        let second = export_into(&conn, &["a".to_string()], &out).unwrap();
        assert_eq!(second.copied, 1);
        assert_eq!(second.renamed, 1);
        assert!(out.join("a(1).txt").is_file());
    }

    #[test]
    fn reports_missing_files_without_aborting() {
        let root = temp_dir("missing");
        let out = temp_dir("missing-out");
        let conn = db_with(&root, &[("a", false), ("b", false)]);
        std::fs::remove_file(root.join("a.txt")).unwrap();

        let report = export_into(&conn, &["a".to_string(), "b".to_string()], &out).unwrap();
        assert_eq!(report.copied, 1);
        assert_eq!(report.missing, vec!["a".to_string()]);
        assert!(out.join("b.txt").is_file());
    }
}

#[cfg(test)]
mod annotation_dedupe_tests {
    use super::*;
    use crate::models::{Anchor, BookStatus, CoverState};

    fn item(label: Option<&str>, start: u32) -> Annotation {
        Annotation {
            id: "x".into(),
            book_id: "b1".into(),
            kind: AnnotationKind::Highlight,
            locator: Progress::Text { offset: 100, chapter: 1, total: 1000 },
            label: label.map(|s| s.to_string()),
            excerpt: Some("原文".into()),
            anchor: Some(Anchor::text(start, 4)),
            created_at: 1,
            updated_at: 1,
        }
    }

    fn seed_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        let book = Book {
            id: "b1".into(),
            book_type: BookType::Novel,
            format: BookFormat::Txt,
            path: "/tmp/b1.txt".into(),
            size: 1,
            mtime: 0,
            title: "测试书".into(),
            author: None,
            cover_path: None,
            cover_state: CoverState::Pending,
            meta_locked: false,
            status: BookStatus::Ok,
            private: false,
            missing: false,
            progress: None,
            metadata: None,
            added_at: 1,
            last_read_at: None,
        };
        db::upsert_book(&conn, &book).unwrap();
        conn
    }

    #[test]
    fn importing_twice_does_not_duplicate() {
        let conn = seed_db();
        let file = crate::annotations_export::ExportFile {
            format: "cenro.annotations".into(),
            version: 1,
            book: crate::annotations_export::ExportBook {
                title: "测试书".into(),
                author: None,
                format: "txt".into(),
            },
            exported_at: 0,
            annotations: vec![
                crate::annotations_export::ExportItem {
                    kind: AnnotationKind::Highlight,
                    locator: Progress::Text { offset: 100, chapter: 1, total: 1000 },
                    label: Some("第一条".into()),
                    excerpt: Some("原文".into()),
                    anchor: Some(Anchor::text(10, 4)),
                    created_at: 1_700_000_000,
                    updated_at: 1_700_000_000,
                },
                crate::annotations_export::ExportItem {
                    kind: AnnotationKind::Bookmark,
                    locator: Progress::Text { offset: 200, chapter: 1, total: 1000 },
                    label: Some("书签".into()),
                    excerpt: None,
                    anchor: None,
                    created_at: 0,
                    updated_at: 0,
                },
            ],
        };

        let (imported, skipped) = import_into(&conn, "b1", &file).unwrap();
        assert_eq!((imported, skipped), (2, 0));
        assert_eq!(db::list_annotations(&conn, "b1", None).unwrap().len(), 2);

        // 第二遍：一条都不该新增
        let (imported, skipped) = import_into(&conn, "b1", &file).unwrap();
        assert_eq!((imported, skipped), (0, 2));
        assert_eq!(db::list_annotations(&conn, "b1", None).unwrap().len(), 2);
    }

    #[test]
    fn same_annotation_gets_same_key() {
        // 重复导入同一份文件时，这条必须被判成「已存在」
        assert_eq!(dedupe_key(&item(Some("备注"), 10)), dedupe_key(&item(Some("备注"), 10)));
    }

    #[test]
    fn notes_and_positions_are_part_of_the_key() {
        assert_ne!(dedupe_key(&item(Some("A"), 10)), dedupe_key(&item(Some("B"), 10)));
        assert_ne!(dedupe_key(&item(Some("A"), 10)), dedupe_key(&item(Some("A"), 20)));
        // 空备注与无备注视作同一件事：导入前会把空串洗成 None，键也必须一致
        assert_eq!(dedupe_key(&item(None, 10)), dedupe_key(&item(Some(""), 10)));
    }
}

// ---------------- 扫描件 OCR ----------------
//
// 图片由前端 pdf.js 渲染后传进来（Rust 侧没有 PDF 引擎），这里只做「认字 + 落库」。
// 逐页调用而不是整本一次：单页失败不会拖垮整本，进度也能按页汇报。

#[derive(serde::Serialize)]
pub struct OcrInfo {
    /// 模型已内嵌进二进制，正常情况恒为 true；留给「将来换成外置模型」用
    ready: bool,
    bytes: u64,
    engine: String,
}

#[tauri::command]
pub fn ocr_info(state: State<'_, AppState>) -> OcrInfo {
    OcrInfo {
        ready: true,
        bytes: state.ocr.models_bytes(),
        engine: crate::ocr::ENGINE_ID.to_string(),
    }
}

#[derive(serde::Serialize)]
pub struct OcrStatus {
    total: i64,
    done: i64,
    status: String,
    /// 已落库的页数（可能大于 done：换模型重跑时会先清）
    pages: i64,
}

fn read_status(conn: &rusqlite::Connection, id: &str) -> Result<OcrStatus> {
    let pages: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ocr_pages WHERE book_id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let job = conn
        .query_row(
            "SELECT total, done, status FROM ocr_jobs WHERE book_id = ?1",
            [id],
            |r| {
                Ok(OcrStatus {
                    total: r.get(0)?,
                    done: r.get(1)?,
                    status: r.get(2)?,
                    pages,
                })
            },
        )
        .optional()?;
    Ok(job.unwrap_or(OcrStatus {
        total: 0,
        done: 0,
        status: "idle".into(),
        pages,
    }))
}

#[tauri::command]
pub fn ocr_status(state: State<'_, AppState>, id: String) -> Result<OcrStatus> {
    visible_book(&state, &id)?;
    let conn = state.db.lock().map_err(|_| AppError::Other("数据库忙".into()))?;
    read_status(&conn, &id)
}

/// 开始建索引：清掉旧结果、记下总页数。
///
/// 换模型重跑也走这里——`ocr_pages` 先清空，避免新旧模型的结果混在一张表里。
#[tauri::command]
pub fn ocr_begin(state: State<'_, AppState>, id: String, total: i64) -> Result<OcrStatus> {
    visible_book(&state, &id)?;
    let conn = state.db.lock().map_err(|_| AppError::Other("数据库忙".into()))?;
    crate::ocr::clear_book(&conn, &id)?;
    conn.execute(
        "INSERT INTO ocr_jobs (book_id, total, done, status, engine, updated_at)
         VALUES (?1, ?2, 0, 'running', ?3, ?4)
         ON CONFLICT(book_id) DO UPDATE SET
           total = excluded.total, done = 0, status = 'running',
           engine = excluded.engine, updated_at = excluded.updated_at",
        rusqlite::params![id, total, crate::ocr::ENGINE_ID, crate::ocr::now_secs()],
    )?;
    read_status(&conn, &id)
}

#[derive(serde::Serialize)]
pub struct OcrPageResult {
    chars: i64,
    done: i64,
}

/// 识别一页并落库。`jpeg` 是 base64（前端 `canvas.toDataURL` 去掉前缀后的部分）。
#[tauri::command]
pub fn ocr_page(
    state: State<'_, AppState>,
    id: String,
    page: i64,
    jpeg: String,
) -> Result<OcrPageResult> {
    use base64::Engine as _;
    visible_book(&state, &id)?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(jpeg.as_bytes())
        .map_err(|e| AppError::Other(format!("图片解码失败：{e}")))?;
    let img = image::load_from_memory(&bytes)?;

    // 识别期间不放数据库锁：一页要几百毫秒，锁着会卡住别处的读写
    let text = state.ocr.recognize(&img)?;

    let conn = state.db.lock().map_err(|_| AppError::Other("数据库忙".into()))?;
    crate::ocr::save_page(&conn, &id, page, &text)?;
    conn.execute(
        "UPDATE ocr_jobs SET done = (SELECT COUNT(*) FROM ocr_pages WHERE book_id = ?1),
                updated_at = ?2 WHERE book_id = ?1",
        rusqlite::params![id, crate::ocr::now_secs()],
    )?;
    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ocr_pages WHERE book_id = ?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    Ok(OcrPageResult {
        chars: text.chars().count() as i64,
        done,
    })
}

#[tauri::command]
pub fn ocr_finish(state: State<'_, AppState>, id: String, status: String) -> Result<OcrStatus> {
    visible_book(&state, &id)?;
    let conn = state.db.lock().map_err(|_| AppError::Other("数据库忙".into()))?;
    conn.execute(
        "UPDATE ocr_jobs SET status = ?2, updated_at = ?3 WHERE book_id = ?1",
        rusqlite::params![id, status, crate::ocr::now_secs()],
    )?;
    read_status(&conn, &id)
}

#[derive(serde::Serialize)]
pub struct OcrHit {
    pub page: i64,
    pub snippet: String,
}

/// 在已建索引的页里找词。大小写与全角按「去空白后包含」粗略匹配即可——
/// 扫描件的文本本来就有零星错字，严格匹配反而让用户搜不到。
#[tauri::command]
pub fn ocr_search(state: State<'_, AppState>, id: String, query: String) -> Result<Vec<OcrHit>> {
    visible_book(&state, &id)?;
    let needle = query.trim().to_string();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let conn = state.db.lock().map_err(|_| AppError::Other("数据库忙".into()))?;
    let mut stmt =
        conn.prepare("SELECT page, text FROM ocr_pages WHERE book_id = ?1 ORDER BY page")?;
    let rows = stmt.query_map([&id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;

    let mut hits = Vec::new();
    for row in rows {
        let (page, text) = row?;
        if let Some(snippet) = crate::ocr::find_in_page(&text, &needle, 24) {
            hits.push(OcrHit { page, snippet });
            if hits.len() >= 100 {
                break;
            }
        }
    }
    Ok(hits)
}

#[derive(serde::Serialize)]
pub struct OcrBlocks {
    width: u32,
    height: u32,
    blocks: Vec<crate::ocr::Block>,
}

/// 识别一张图并返回**带坐标**的文字块（不落库）。
///
/// 给漫画用：气泡要按原位覆盖译文，光有字符串没用。
/// `vertical` 打开时多跑一遍旋转推理，日漫竖排才认得出。
#[tauri::command]
pub fn ocr_blocks(
    state: State<'_, AppState>,
    id: String,
    jpeg: String,
    vertical: bool,
) -> Result<OcrBlocks> {
    use base64::Engine as _;
    visible_book(&state, &id)?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(jpeg.as_bytes())
        .map_err(|e| AppError::Other(format!("图片解码失败：{e}")))?;
    let img = image::load_from_memory(&bytes)?;
    let (width, height) = (img.width(), img.height());
    let blocks = state.ocr.recognize_blocks(&img, vertical)?;
    // 原图尺寸一起回去：前端要按显示尺寸换算百分比，不然框会飘
    Ok(OcrBlocks {
        width,
        height,
        blocks,
    })
}

/// 批量翻译（OpenAI 兼容端点）。CSP 不放行外网，所以必须走后端。
#[tauri::command]
pub fn translate_texts(
    state: State<'_, AppState>,
    texts: Vec<String>,
    config: crate::translate::TranslateConfig,
) -> Result<crate::translate::TranslateOutcome> {
    // 缓存命中就不发请求：翻回上一页、重开一本书是最高频的场景
    let conn = state.db.lock().map_err(|_| AppError::Other("数据库忙".into()))?;
    crate::translate::translate_cached(&conn, &config, &texts)
}

#[tauri::command]
pub fn ocr_clear(state: State<'_, AppState>, id: String) -> Result<()> {
    visible_book(&state, &id)?;
    let conn = state.db.lock().map_err(|_| AppError::Other("数据库忙".into()))?;
    crate::ocr::clear_book(&conn, &id)?;
    Ok(())
}

#[cfg(test)]
mod cover_rebuild_tests {
    use super::*;
    use crate::models::{Book, BookFormat, BookType, CoverState};

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("reader-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_book(id: &str, format: BookFormat, path: &str) -> Book {
        Book {
            id: id.to_string(),
            book_type: if format == BookFormat::Folder {
                BookType::Comic
            } else {
                BookType::Novel
            },
            format,
            path: path.to_string(),
            size: 1,
            mtime: 0,
            title: "测试".into(),
            author: None,
            // 模拟「曾经有封面，但文件被清理掉了」
            cover_path: Some("/nonexistent/old.jpg".into()),
            cover_state: CoverState::Ready,
            meta_locked: false,
            status: crate::models::BookStatus::Ok,
            private: false,
            missing: false,
            progress: None,
            metadata: None,
            added_at: 0,
            last_read_at: None,
        }
    }

    /// 图片文件夹：清空 covers 后重建应当重新产出缩略图并回写路径
    #[test]
    fn rebuild_restores_missing_cover() {
        let root = temp_dir("rebuild-cover");
        let book_dir = root.join("album");
        std::fs::create_dir_all(&book_dir).unwrap();

        // 一张 40x60 的纯色图，足够走完解码 → 缩略 → 写 jpg
        let img = image::RgbImage::from_pixel(40, 60, image::Rgb([120, 60, 200]));
        img.save(book_dir.join("001.png")).unwrap();

        let covers = root.join("covers");
        std::fs::create_dir_all(&covers).unwrap();

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        db::upsert_book(
            &conn,
            &sample_book("abc", BookFormat::Folder, &book_dir.to_string_lossy()),
        )
        .unwrap();

        // 重建前：路径指向的文件不存在
        assert!(!Path::new("/nonexistent/old.jpg").exists());

        let report = rebuild_all(&conn, &covers).unwrap();
        assert_eq!(report.rebuilt, 1, "应当产出一张封面");
        assert_eq!(report.failed, 0);

        let out = covers.join("abc.jpg");
        assert!(out.is_file(), "缩略图应写入 covers 目录");
        assert!(std::fs::metadata(&out).unwrap().len() > 0);

        let book = db::get_book(&conn, "abc").unwrap().unwrap();
        assert_eq!(book.cover_state, CoverState::Ready);
        assert_eq!(
            book.cover_path.as_deref(),
            Some(out.to_string_lossy().as_ref())
        );
    }

    /// 手动编辑书名后应当置位 meta_locked，且作者允许清空
    #[test]
    fn manual_meta_sets_lock_and_clears_author() {
        let root = temp_dir("manual-meta");
        let file = root.join("old-name.txt");
        std::fs::write(&file, b"hello").unwrap();

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        db::upsert_book(
            &conn,
            &sample_book("m1", BookFormat::Txt, &file.to_string_lossy()),
        )
        .unwrap();

        db::set_meta(&conn, "m1", "新书名", Some("作者甲")).unwrap();
        let book = db::get_book(&conn, "m1").unwrap().unwrap();
        assert_eq!(book.title, "新书名");
        assert_eq!(book.author.as_deref(), Some("作者甲"));
        assert!(book.meta_locked, "手动改过就应锁住，避免扫描覆盖");

        // 作者可以清空（传 None 写入 NULL）
        db::set_meta(&conn, "m1", "新书名", None).unwrap();
        let book = db::get_book(&conn, "m1").unwrap().unwrap();
        assert!(book.author.is_none());
    }

    /// TXT 没有可取的首图，重建后应为占位而不是留着失效路径
    #[test]
    fn rebuild_clears_stale_path_for_txt() {
        let root = temp_dir("rebuild-txt");
        let file = root.join("novel.txt");
        std::fs::write(&file, b"hello").unwrap();

        let covers = root.join("covers");
        std::fs::create_dir_all(&covers).unwrap();

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        db::upsert_book(
            &conn,
            &sample_book("txt1", BookFormat::Txt, &file.to_string_lossy()),
        )
        .unwrap();

        let report = rebuild_all(&conn, &covers).unwrap();
        assert_eq!(report.placeholder, 1);
        assert_eq!(report.rebuilt, 0);

        let book = db::get_book(&conn, "txt1").unwrap().unwrap();
        assert_eq!(book.cover_state, CoverState::Placeholder);
        // 关键：不能留着指向已删文件的路径，否则前端仍是裂图
        assert!(book.cover_path.is_none());
    }
}
