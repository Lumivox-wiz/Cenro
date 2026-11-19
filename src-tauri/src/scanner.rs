use crate::cover;
use crate::db;
use crate::error::Result;
use crate::models::{Book, BookFormat, BookType, CoverState, LibraryRoot, ScanFailure, ScanReport};
use crate::util;
use rusqlite::Connection;
use std::path::Path;
use std::time::{Instant, SystemTime};

/// 图片文件夹判定：只看同层图片，且数量达到阈值。
/// 子目录不参与计数——章节嵌套交给后续版本，P1 只认扁平图集。
const MIN_IMAGES_FOR_FOLDER: usize = 3;

pub(crate) enum Ingest {
    Added,
    Updated,
    Skipped,
}

pub fn scan(conn: &Connection, cover_dir: &Path) -> Result<ScanReport> {
    let roots: Vec<LibraryRoot> = db::list_roots(conn)?;
    let mut report = ScanReport::default();
    let start = Instant::now();

    for root in &roots {
        let root_path = Path::new(&root.path);

        // 根本身就是一个文件（「导入单个文件」的场景）：直接收作一本书
        if root_path.is_file() {
            if let Some((book_type, format)) = classify(root_path) {
                report.scanned += 1;
                match ingest(conn, cover_dir, root_path, book_type, format) {
                    Ok(Ingest::Added) => report.added += 1,
                    Ok(Ingest::Updated) => report.updated += 1,
                    Ok(Ingest::Skipped) => report.skipped += 1,
                    Err(e) => record_failure(&mut report, root_path, e),
                }
            }
            if let Ok(n) = db::remove_missing_under(conn, &root.path) {
                report.removed += n;
            }
            continue;
        }

        if !root_path.is_dir() {
            continue;
        }

        let mut walker = walkdir::WalkDir::new(root_path)
            .follow_links(false)
            .into_iter();

        while let Some(next) = walker.next() {
            let entry = match next {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            if path == root_path {
                continue;
            }

            let name = entry.file_name().to_str().unwrap_or("");

            // 隐藏项与系统目录：整树剪枝
            if name.starts_with('.') || util::is_ignored_dir_name(name) {
                if entry.file_type().is_dir() {
                    walker.skip_current_dir();
                }
                continue;
            }

            if entry.file_type().is_dir() {
                if let Some(count) = count_direct_images(path) {
                    if count >= MIN_IMAGES_FOR_FOLDER {
                        report.scanned += 1;
                        match ingest(conn, cover_dir, path, BookType::Comic, BookFormat::Folder) {
                            Ok(Ingest::Added) => report.added += 1,
                            Ok(Ingest::Updated) => report.updated += 1,
                            Ok(Ingest::Skipped) => report.skipped += 1,
                            Err(e) => record_failure(&mut report, path, e),
                        }
                        walker.skip_current_dir();
                    }
                }
                continue;
            }

            if !entry.file_type().is_file() {
                continue;
            }

            let Some((book_type, format)) = classify(path) else {
                continue;
            };

            report.scanned += 1;
            match ingest(conn, cover_dir, path, book_type, format) {
                Ok(Ingest::Added) => report.added += 1,
                Ok(Ingest::Updated) => report.updated += 1,
                Ok(Ingest::Skipped) => report.skipped += 1,
                Err(e) => record_failure(&mut report, path, e),
            }
        }

        // 磁盘上已删除的条目从书架移除
        if let Ok(n) = db::remove_missing_under(conn, &root.path) {
            report.removed += n;
        }
    }

    report.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(report)
}

pub(crate) fn classify(path: &Path) -> Option<(BookType, BookFormat)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "txt" => (BookType::Novel, BookFormat::Txt),
        // Markdown 与单文件 HTML 都转成纯文本阅读，复用 TXT 的整条链路
        "md" | "markdown" => (BookType::Novel, BookFormat::Markdown),
        "html" | "htm" | "xhtml" => (BookType::Novel, BookFormat::Html),
        "epub" => (BookType::Novel, BookFormat::Epub),
        // FictionBook：XML 单文件，自带章节与内嵌封面
        "fb2" => (BookType::Novel, BookFormat::Fb2),
        // Word / 富文本 / MIME 网页：都降级为纯文本阅读，复用 TXT 的整条链路
        "docx" => (BookType::Doc, BookFormat::Docx),
        "rtf" => (BookType::Doc, BookFormat::Rtf),
        "mhtml" | "mht" => (BookType::Doc, BookFormat::Mhtml),
        // MOBI 既可能是文字书，也可能是图片型漫画（日漫常见）。
        // 只读记录索引与每条的魔数来判断，不载入整本文件。
        // AZW3 / AZW 同为 PDB 容器，判定与读取路径完全一致。
        "mobi" | "prc" | "azw3" | "azw" => {
            let format = if ext.as_str() == "mobi" || ext.as_str() == "prc" {
                BookFormat::Mobi
            } else {
                BookFormat::Azw3
            };
            let comic = crate::mobi::probe(path)
                .map(|p| p.image_count >= 3)
                .unwrap_or(false);
            if comic {
                (BookType::Comic, format)
            } else {
                (BookType::Novel, format)
            }
        }
        "cbz" => (BookType::Comic, BookFormat::Cbz),
        // TAR / 7z 打包的图片：只有图片条目够数才收，避免把普通压缩包塞进书库
        "cbt" => {
            if crate::comic::tar_image_count(path).unwrap_or(0) >= 3 {
                (BookType::Comic, BookFormat::Cbt)
            } else {
                return None;
            }
        }
        "cb7" => {
            if crate::comic::sevenz_image_count(path).unwrap_or(0) >= 3 {
                (BookType::Comic, BookFormat::Cb7)
            } else {
                return None;
            }
        }
        "cbr" => {
            if crate::comic::rar_image_count(path).unwrap_or(0) >= 3 {
                (BookType::Comic, BookFormat::Cbr)
            } else {
                return None;
            }
        }
        // .zip 不一定是漫画：只有里面图片条目 ≥ 3 才收，
        // 否则当普通压缩包忽略，免得书库里塞满代码包
        "zip" => {
            if crate::comic::zip_image_count(path).unwrap_or(0) >= 3 {
                (BookType::Comic, BookFormat::Zip)
            } else {
                return None;
            }
        }
        "pdf" => (BookType::Pdf, BookFormat::Pdf),
        // OFD 是中文版式文档，自带渲染器，归「文档」而不是 PDF
        "ofd" => (BookType::Doc, BookFormat::Ofd),
        // Excel 只有 xlsx（zip 容器）；老的 .xls 是二进制，不在支持范围
        "xlsx" => (BookType::Doc, BookFormat::Xlsx),
        _ => return None,
    })
}

/// 记一条失败：数字与明细一起维护，避免两处对不上。
///
/// 明细只留前 20 条：书库根选错（比如选了整个 D 盘）时可能有上万条失败，
/// 全塞进 JSON 会让 IPC 与前端列表一起卡住，而用户最多也就看前几条。
const MAX_FAILURE_DETAILS: usize = 20;

fn record_failure(report: &mut ScanReport, path: &Path, error: crate::error::AppError) {
    report.failed += 1;
    if report.failures.len() < MAX_FAILURE_DETAILS {
        report.failures.push(ScanFailure {
            path: path.to_string_lossy().to_string(),
            message: error.to_string(),
        });
    }
}

fn count_direct_images(dir: &Path) -> Option<usize> {
    let mut count = 0usize;
    for entry in std::fs::read_dir(dir).ok()? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.is_dir() {
            // 出现子目录说明这更像一个书库根或合集目录，不当作单本漫画
            return None;
        }
        if path.is_file() && util::is_image_path(&path) {
            count += 1;
        }
    }
    Some(count)
}

/// 收下一本书：复制/登记记录、抽封面、写库。
///
/// `pub(crate)`：文件关联（双击打开）也走这条路径，免得「导入」与「双击打开」
/// 两套代码对同一份文件给出不同的标题、封面与状态。
pub(crate) fn ingest(
    conn: &Connection,
    cover_dir: &Path,
    path: &Path,
    book_type: BookType,
    format: BookFormat,
) -> Result<Ingest> {
    let meta = std::fs::metadata(path)?;
    let size = meta.len() as i64;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let path_str = path.to_string_lossy().to_string();
    let id = util::stable_id(path);
    let title = derive_title(path, format);

    // 增量：大小与修改时间都没变时跳过。但**分类可能随版本变化**
    // （例如新增 MOBI 漫画支持后，同一文件会从「小说」变成「漫画」），
    // 因此还要比对类型与格式，不一致就重建。
    if let Some((existing_id, old_size, old_mtime)) = db::existing_stamp(conn, &path_str)? {
        let existing = db::get_book(conn, &existing_id)?;

        /*
         * 隐私书一律跳过：不进封面重建、不重置状态。
         *
         * 这里是最容易被忽略的回归点——扫描器按目录遍历，隐私书的 path 仍在库里，
         * 一旦走到下面的「封面缺失就重建」分支，缩略图会被重新生成到公开的
         * covers/ 目录，标记本身虽然不会被 upsert 覆盖，封面却已经泄露了。
         */
        if existing.as_ref().map(|b| b.private).unwrap_or(false) {
            return Ok(Ingest::Skipped);
        }

        let unchanged = old_size == size && old_mtime == mtime;

        if unchanged {
            let same_kind = existing
                .as_ref()
                .map(|b| b.book_type == book_type && b.format == format)
                .unwrap_or(false);

            /*
             * 封面文件可能已被「清理缓存 / 重建封面」删除，此时记录仍是 Ready，
             * 但磁盘上没有图，书架会一直裂着。这种情况不能算「没变化」，
             * 继续走重建分支把封面补回来（也让「重新扫描」具备自愈能力）。
             */
            let cover_missing = existing
                .as_ref()
                .map(|b| {
                    b.cover_state == CoverState::Ready
                        && !cover_dir.join(format!("{existing_id}.jpg")).exists()
                })
                .unwrap_or(false);

            if same_kind && !cover_missing {
                return Ok(Ingest::Skipped);
            }
        }

        let mut book = match existing {
            Some(b) => b,
            None => new_book(&existing_id, path, book_type, format, size, mtime, title.clone()),
        };
        book.size = size;
        book.mtime = mtime;
        // 用户手动改过书名就不再用文件名推导的标题覆盖
        if !book.meta_locked {
            book.title = title;
        }
        book.book_type = book_type;
        book.format = format;
        // 文件已变化：旧缓存必须失效，否则书架会一直显示上一版封面
        let stale = cover_dir.join(format!("{existing_id}.jpg"));
        let _ = std::fs::remove_file(stale);
        let cov = cover::generate(&existing_id, format, path, cover_dir);
        book.cover_path = cov.path;
        book.cover_state = cov.state;
        db::upsert_book(conn, &book)?;
        return Ok(Ingest::Updated);
    }

    let cov = cover::generate(&id, format, path, cover_dir);
    let mut book = new_book(&id, path, book_type, format, size, mtime, title);
    book.cover_path = cov.path;
    book.cover_state = cov.state;
    db::upsert_book(conn, &book)?;
    Ok(Ingest::Added)
}

fn new_book(
    id: &str,
    path: &Path,
    book_type: BookType,
    format: BookFormat,
    size: i64,
    mtime: i64,
    title: String,
) -> Book {
    Book {
        id: id.to_string(),
        book_type,
        format,
        path: path.to_string_lossy().to_string(),
        size,
        mtime,
        title,
        author: None,
        cover_path: None,
        cover_state: crate::models::CoverState::Pending,
        meta_locked: false,
        status: crate::models::BookStatus::Ok,
        // 扫描永远不碰隐私标记：新书默认公开，已存在的记录靠 upsert 不覆盖这一列
        private: false,
        // 刚扫到的文件必然存在，这里不做 stat
        missing: false,
        progress: None,
        metadata: None,
        added_at: db::now_ts(),
        last_read_at: None,
    }
}

pub(crate) fn derive_title(path: &Path, format: BookFormat) -> String {
    let stem = if format == BookFormat::Folder {
        path.file_name()
    } else {
        path.file_stem()
    };
    stem.and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "未命名".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn temp_root(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("reader-test-{name}"));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// 开发期辅助：拿真实书库跑一遍扫描，打印失败明细。
    /// `CENRO_LIB=<dir> cargo test --lib dump_scan -- --ignored --nocapture`
    #[test]
    #[ignore = "开发期辅助：需要 CENRO_LIB 指向真实书库目录"]
    fn dump_scan() {
        let Ok(dir) = std::env::var("CENRO_LIB") else {
            return;
        };
        // CENRO_DB 指向已有库时会顺带走一遍迁移，用来复现线上状态
        let db_path = match std::env::var("CENRO_DB") {
            Ok(p) => std::path::PathBuf::from(p),
            Err(_) => {
                let p = std::env::temp_dir().join("reader-scan-dump.db");
                let _ = std::fs::remove_file(&p);
                p
            }
        };
        let conn = db::open(&db_path).unwrap();
        db::init(&conn).unwrap();
        db::add_root(&conn, &dir).unwrap();
        let covers = std::env::temp_dir().join("reader-scan-dump-covers");
        let report = scan(&conn, &covers).unwrap();
        println!(
            "scanned={} added={} skipped={} failed={}",
            report.scanned, report.added, report.skipped, report.failed
        );
        for f in &report.failures {
            println!("FAIL {} -> {}", f.path, f.message);
        }
    }

    fn write_png(path: &Path, color: [u8; 3]) {
        let img = image::RgbImage::from_pixel(8, 12, image::Rgb(color));
        img.save_with_format(path, image::ImageFormat::Png).unwrap();
    }

    fn write_cbz(path: &Path) {
        use std::io::Write;
        let file = std::fs::File::create(path).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        for i in [1, 2, 10] {
            zw.start_file(format!("p{i}.png"), opts).unwrap();
            let img = image::RgbImage::from_pixel(8, 12, image::Rgb([10, 10, 200]));
            let mut buf = std::io::Cursor::new(Vec::new());
            img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
            zw.write_all(buf.get_ref()).unwrap();
        }
        zw.finish().unwrap();
    }

    #[test]
    fn natural_order_is_numeric_aware() {
        assert!(util::natural_cmp("p2.png", "p10.png") == std::cmp::Ordering::Less);
        assert!(util::natural_cmp("a", "b") == std::cmp::Ordering::Less);
        assert!(util::natural_cmp("p10", "p10") == std::cmp::Ordering::Equal);
    }

    /// 隐私书重扫必须原地不动：不改标记、不重建封面、不进公开书架。
    ///
    /// 这是文档里点名「最容易被忽略的回归点」。扫描器按目录遍历，
    /// 隐私书的 path 还在库里，一旦走到封面重建分支，缩略图就回到了
    /// 公开的 covers/ 目录——标记没丢，封面已经泄露。
    #[test]
    fn rescan_keeps_private_books_private() {
        let root = temp_root("scan-private");
        write_cbz(&root.join("秘密.cbz"));

        let covers = temp_root("scan-private-covers");
        let conn = Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        db::add_root(&conn, root.to_str().unwrap()).unwrap();
        scan(&conn, &covers).unwrap();

        let book = db::list_books(&conn, None, None).unwrap().remove(0);
        db::set_private(&conn, &book.id, true).unwrap();

        // 模拟隐私书封面已挪走，此时若扫描器不当心就会重建它
        let public_cover = covers.join(format!("{}.jpg", book.id));
        std::fs::remove_file(&public_cover).unwrap();

        let report = scan(&conn, &covers).unwrap();
        assert_eq!(report.skipped, 1, "隐私书应被跳过");
        assert_eq!(report.updated, 0);

        let after = db::get_book(&conn, &book.id).unwrap().unwrap();
        assert!(after.private, "重扫不能把书搬回公开书架");
        assert!(
            !public_cover.exists(),
            "公开封面目录里不能再出现隐私书的缩略图"
        );
        assert!(
            db::list_books(&conn, None, None).unwrap().is_empty(),
            "公开书架列表必须看不到它"
        );
        assert_eq!(db::list_private(&conn, None).unwrap().len(), 1);
    }

    #[test]
    fn scans_txt_cbz_and_image_folder() {
        let root = temp_root("scan");
        std::fs::write(root.join("小说.txt"), "第一章 起风了\n正文……").unwrap();
        write_cbz(&root.join("漫画.cbz"));

        let folder = root.join("图集");
        std::fs::create_dir_all(&folder).unwrap();
        write_png(&folder.join("1.png"), [200, 40, 40]);
        write_png(&folder.join("2.png"), [40, 200, 40]);
        write_png(&folder.join("3.png"), [40, 40, 200]);

        // 干扰项：两图目录不应被当成漫画
        let small = root.join("只有两张");
        std::fs::create_dir_all(&small).unwrap();
        write_png(&small.join("1.png"), [0, 0, 0]);
        write_png(&small.join("2.png"), [0, 0, 0]);

        let covers = temp_root("scan-covers");
        let conn = Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        db::add_root(&conn, root.to_str().unwrap()).unwrap();

        let report = scan(&conn, &covers).unwrap();
        assert_eq!(report.added, 3, "txt + cbz + 图集 = 3");
        assert_eq!(report.failed, 0);

        let books = db::list_books(&conn, None, None).unwrap();
        assert_eq!(books.len(), 3);

        let txt = books.iter().find(|b| b.format == BookFormat::Txt).unwrap();
        assert_eq!(txt.book_type, BookType::Novel);
        assert_eq!(txt.cover_state, crate::models::CoverState::Placeholder);

        let cbz = books.iter().find(|b| b.format == BookFormat::Cbz).unwrap();
        assert_eq!(cbz.book_type, BookType::Comic);
        assert_eq!(cbz.cover_state, crate::models::CoverState::Ready);
        assert!(cbz.cover_path.as_ref().map(|p| Path::new(p).exists()).unwrap_or(false));

        let folder_book = books.iter().find(|b| b.format == BookFormat::Folder).unwrap();
        assert_eq!(folder_book.title, "图集");
        assert_eq!(folder_book.cover_state, crate::models::CoverState::Ready);
    }

    #[test]
    fn second_scan_is_incremental() {
        let root = temp_root("incremental");
        std::fs::write(root.join("a.txt"), "hello").unwrap();
        let covers = temp_root("incremental-covers");

        let conn = Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        db::add_root(&conn, root.to_str().unwrap()).unwrap();

        let first = scan(&conn, &covers).unwrap();
        assert_eq!(first.added, 1);

        let second = scan(&conn, &covers).unwrap();
        assert_eq!(second.added, 0);
        assert_eq!(second.skipped, 1);
    }
}
