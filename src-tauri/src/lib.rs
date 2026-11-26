mod annotations_export;
mod backup;
mod cache;
mod commands;
mod comic;
mod cover;
mod docx;
mod epub;
mod fb2;
mod html;
mod license;
mod logging;
mod manual;
mod md;
mod mhtml;
mod monet;
mod mobi;
mod mobi_huff;
mod ofd;
mod privacy;
mod xlsx;
mod db;
mod error;
mod models;
mod ocr;
mod rtf;
mod search;
mod startup;
mod scanner;
mod text;
mod util;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// 单个缓存目录的容量上限。超过后按最近使用时间裁剪到 80%。
const CACHE_LIMIT_BYTES: u64 = 1500 * 1024 * 1024;

/// 最近一次打开的 TXT 全文缓存。避免每次翻页都重读并重新解码整本书。
pub struct CachedText {
    pub book_id: String,
    pub text: String,
}

/// 全局状态：单个 SQLite 连接 + 封面缓存目录 + 文本缓存。
/// 阅读器是单窗口应用，单连接加互斥足够；将来多窗口再换连接池。
pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub cover_dir: PathBuf,
    pub text_cache: Mutex<Option<CachedText>>,
    /// CBZ 按需解压的落盘目录
    pub comic_cache: PathBuf,
    /// EPUB 内图片等资源按需解压的落盘目录
    pub epub_cache: PathBuf,
    /// 应用数据目录：备份配置（backup.json）与本地备份都放这里
    pub data_dir: PathBuf,
    /// 本地备份包目录。移动端没有「另存为」对话框，产物固定落在这里
    pub backup_dir: PathBuf,
    /// 双击打开的书：前端挂载后取一次并清空
    pub startup_book: Mutex<Option<String>>,
    /// 隐私书架：解锁态只存内存，进程结束即上锁
    pub privacy: Mutex<privacy::Session>,
    /// 扫描件 OCR：模型内嵌，引擎首次用到时才初始化
    pub ocr: ocr::Ocr,
    /// privacy.json 的内存副本。`unlocked()` 会被每次翻页调用，
    /// 在那里读一遍文件太亏，所以启动时读一次、写的时候同步更新。
    pub privacy_config: Mutex<privacy::PrivacyConfig>,
}

impl AppState {
    /// 当前隐私配置（内存副本，已与磁盘一致）。
    pub fn privacy_settings(&self) -> privacy::PrivacyConfig {
        self.privacy_config
            .lock()
            .map(|c| c.clone())
            .unwrap_or_default()
    }

    /// 落盘并同步内存副本。
    pub fn set_privacy_config(&self, config: privacy::PrivacyConfig) -> crate::error::Result<()> {
        privacy::save(&self.data_dir, &config)?;
        if let Ok(mut cached) = self.privacy_config.lock() {
            *cached = config;
        }
        Ok(())
    }

    /// 会话是否处于解锁态。隐私书的所有读写命令都要先过这一关。
    ///
    /// **没启用 PIN 时一律算「解锁」**：没有可挡的东西，硬拦反而制造死局——
    /// 用户忘了 PIN 删掉 privacy.json 之后，书还标着 private，界面上必须有路把它们移出来。
    pub fn unlocked(&self) -> bool {
        let (enabled, lock_after) = self
            .privacy_config
            .lock()
            .map(|c| (c.enabled, c.lock_after_minutes))
            .unwrap_or((false, 0));
        if !enabled {
            return true;
        }
        self.privacy
            .lock()
            .map(|s| s.is_unlocked(lock_after))
            .unwrap_or(false)
    }
}

/// 更名前的应用数据目录。identifier 从 `com.lumviox.reader` 改成 `com.lumviox.cenro` 后，
/// Tauri 的 `app_data_dir()` 会指向新目录；这里把旧库与封面复制过来一次，
/// 老用户不必重新导入。书籍文件本身没挪动，记录里的绝对路径仍然有效。
#[cfg(desktop)]
/// 数据目录迁移。返回一句「发生了什么」，由调用方在日志起来之后再写。
///
/// 两段历史都在这儿：
/// 1. 包名拼写修正 `com.lumviox.cenro` → `com.lumivox.cenro`（整目录搬过去）；
/// 2. 更早的一次更名 `com.lumviox.reader` → 岑序（只带上 db 与封面）。
#[cfg(desktop)]
fn migrate_legacy_data_dir(data_dir: &std::path::Path) -> Option<String> {
    // 新目录里已经有库，就什么都不做——迁移只跑一次
    if data_dir.join("cenro.db").exists() {
        return None;
    }
    let parent = data_dir.parent()?;

    /*
     * 整目录搬家优先用 rename：同一个盘上是瞬时操作，
     * 284 MB 的副本（里面的书是导入时复制进来的）复制一遍要好几十秒。
     * 跨盘或权限不足时退回递归复制，并明确告诉用户「原目录还留着」。
     */
    let typo = parent.join("com.lumviox.cenro");
    if typo.is_dir() {
        if std::fs::rename(&typo, data_dir).is_ok() {
            return Some(format!("数据目录已从 {} 迁移（整目录搬移）", typo.display()));
        }
        if copy_dir_all(&typo, data_dir).is_ok() {
            return Some(format!(
                "数据目录已从 {} 复制过来（原目录保留，确认无误后可手动删除）",
                typo.display()
            ));
        }
        return Some("数据目录迁移失败：请手动把旧目录的内容拷到新目录".into());
    }

    // 更早的一次更名：那时叫 Reader，库文件名也不同，只带 db 与封面就够
    let legacy = parent.join("com.lumviox.reader");
    let legacy_db = legacy.join("reader.db");
    if !legacy_db.exists() {
        return None;
    }
    let _ = std::fs::copy(&legacy_db, data_dir.join("cenro.db"));
    copy_flat_dir(&legacy.join("covers"), &data_dir.join("covers"));
    Some("已从 Reader 时期的数据库迁移书籍与封面".into())
}

/// 递归复制目录。只在 rename 失败时用得上。
#[cfg(desktop)]
fn copy_dir_all(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// 只复制一层文件：封面缓存是 `{book_id}.jpg` 的平铺结构，不需要递归。
#[cfg(desktop)]
fn copy_flat_dir(from: &std::path::Path, to: &std::path::Path) {
    if !from.is_dir() {
        return;
    }
    let _ = std::fs::create_dir_all(to);
    let Ok(entries) = std::fs::read_dir(from) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.path().is_file() {
            let _ = std::fs::copy(entry.path(), to.join(entry.file_name()));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    /*
     * 单实例必须第一个注册：它要在窗口创建之前决定「我是主实例，还是把参数转交出去」。
     * 排在别的 plugin 后面，第二个实例会先把窗口建出来，再被判定为重复——用户会看到闪一下的黑窗。
     */
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            startup::handle_external_open(app, argv);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 移动端导入：把 File 字节写进应用私有目录
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;

            /*
             * 迁移必须排在建目录之前：
             * Windows 上 `rename` 到一个已经存在的目录会失败，
             * 而 create_dir_all 又会把目标目录先建出来。
             * 只影响桌面端——移动端的数据在包名沙箱里，包名变了就是另一份。
             */
            #[cfg(desktop)]
            let migrated = migrate_legacy_data_dir(&data_dir);
            #[cfg(mobile)]
            let migrated: Option<String> = None;

            std::fs::create_dir_all(&data_dir)?;

            // 日志要最先起来：后面任何一步失败都该留下痕迹
            logging::init(&data_dir);
            if let Some(message) = migrated {
                logging::info("migrate", message);
            }

            let conn = db::open(&data_dir.join("cenro.db"))?;
            db::init(&conn)?;

            /*
             * 目录改名之后，库里存的绝对路径还指着旧目录（`inbox/` 里的副本、
             * 随包说明、封面缩略图），表现是书架整片「文件已丢失」。
             * 这里把前缀换掉，一次 UPDATE，平时一条都不会命中。
             */
            if let Some(parent) = data_dir.parent() {
                let old_dir = parent.join("com.lumviox.cenro");
                let fixed = db::rewrite_path_prefix(
                    &conn,
                    &old_dir.to_string_lossy(),
                    &data_dir.to_string_lossy(),
                )?;
                if fixed > 0 {
                    logging::info("migrate", format!("已修正 {fixed} 条记录的路径"));
                }
            }

            // 随包下发的使用说明：首次启动放进书架，之后每次启动只更新内容
            if let Err(e) = manual::ensure(app.handle(), &conn, &data_dir) {
                logging::warn("manual", format!("使用说明没有装进书架：{e}"));
            }

            let cover_dir = data_dir.join("covers");
            std::fs::create_dir_all(&cover_dir)?;

            let comic_cache = data_dir.join("comic_cache");
            std::fs::create_dir_all(&comic_cache)?;

            let epub_cache = data_dir.join("epub_cache");
            std::fs::create_dir_all(&epub_cache)?;

            /*
             * 安卓「用其他应用打开」的收件目录。
             * 这里主动建出来并记一条日志：Kotlin 侧写的是 `filesDir/incoming`，
             * 而 Rust 侧算的是 `app_data_dir/incoming`——两者应该是同一个目录，
             * 但万一不是，日志里的路径就是唯一的线索（用户点了文件没反应时先看这条）。
             */
            #[cfg(target_os = "android")]
            {
                let incoming = data_dir.join("incoming");
                if let Err(e) = std::fs::create_dir_all(&incoming) {
                    logging::warn("open-with", format!("建收件目录失败：{e}"));
                }
                // 把每条候选的存在与否都记下来：万一还是「点了没书」，
                // 这一行就能直接看出是写错位置，还是写对了但没扫
                for dir in startup::incoming_dirs(&data_dir) {
                    let count = std::fs::read_dir(&dir)
                        .map(|it| it.flatten().count())
                        .unwrap_or(0);
                    logging::info(
                        "open-with",
                        format!("收件目录 {} 存在={} 文件={count}", dir.display(), dir.exists()),
                    );
                }
            }

            let privacy_config = privacy::load(&data_dir);

            let backup_dir = data_dir.join("backups");
            std::fs::create_dir_all(&backup_dir)?;

            app.manage(AppState {
                db: Mutex::new(conn),
                cover_dir,
                text_cache: Mutex::new(None),
                comic_cache,
                epub_cache,
                data_dir,
                backup_dir,
                startup_book: Mutex::new(None),
                ocr: ocr::Ocr::new(),
                privacy: Mutex::new(privacy::Session::default()),
                privacy_config: Mutex::new(privacy_config),
            });

            // 双击打开：argv 里带了一个书文件就先收进书库，前端挂载后会取走这本书的 id
            if let Some(path) = startup::book_arg() {
                let state = app.state::<AppState>();
                match state.db.lock() {
                    Ok(conn) => match startup::absorb(&state, &conn, &path) {
                        Ok(Some(book)) => {
                            logging::info("open-with", format!("已收下《{}》", book.title))
                        }
                        Ok(None) => {}
                        Err(e) => logging::failure("open-with", "收下外部文件失败", &e),
                    },
                    Err(_) => logging::warn("open-with", "数据库忙，跳过外部文件"),
                }
            }

            // 启动后台裁剪缓存：先清孤儿，再按最近使用把总量压到上限的 80%
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let state = handle.state::<AppState>();
                let live = match state.db.lock() {
                    Ok(conn) => db::all_book_ids(&conn).unwrap_or_default(),
                    Err(_) => return,
                };
                cache::prune_in(&state.comic_cache, &live, CACHE_LIMIT_BYTES);
                cache::prune_in(&state.epub_cache, &live, CACHE_LIMIT_BYTES);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_roots,
            commands::add_root,
            commands::remove_root,
            commands::scan_library,
            commands::list_books,
            commands::get_book,
            commands::save_progress,
            commands::library_stats,
            commands::monet_palette,
            commands::open_text_book,
            commands::read_text_range,
            commands::book_kind,
            commands::update_book_meta,
            commands::remove_book,
            commands::relocate_book,
            commands::list_comic_pages,
            commands::comic_page_path,
            commands::open_html_book,
            commands::read_html_chapter,
            commands::open_md_book,
            commands::read_md_chapter,
            commands::open_ofd,
            commands::ofd_page_svg,
            commands::open_docx_book,
            commands::read_docx_chapter,
            commands::open_xlsx_book,
            commands::read_xlsx_chapter,
            commands::open_epub,
            commands::read_epub_chapter,
            commands::read_epub_resource,
            commands::cache_report,
            commands::rebuild_covers,
            commands::clear_cache,
            commands::backup_config,
            commands::save_backup_config,
            commands::backup_scope,
            commands::backup_export,
            commands::backup_list_local,
            commands::backup_delete_local,
            commands::backup_restore,
            commands::webdav_test,
            commands::webdav_upload,
            commands::webdav_list,
            commands::webdav_delete,
            commands::webdav_restore,
            commands::privacy_status,
            commands::privacy_enable,
            commands::privacy_unlock,
            commands::privacy_set_lock_after,
            commands::privacy_lock,
            commands::privacy_disable,
            commands::privacy_list,
            commands::privacy_move,
            commands::privacy_release,
            commands::privacy_move_many,
            commands::list_annotations,
            commands::add_annotation,
            commands::update_annotation_label,
            commands::delete_annotation,
            commands::export_books,
            commands::list_tags,
            commands::list_tag_assignments,
            commands::set_book_tags,
            commands::delete_tag,
            commands::search_book,
            commands::ocr_info,
            commands::ocr_status,
            commands::ocr_begin,
            commands::ocr_page,
            commands::ocr_finish,
            commands::ocr_search,
            commands::ocr_clear,
            commands::ocr_blocks,
            commands::export_annotations,
            commands::import_annotations,
            commands::log_frontend,
            commands::read_log,
            commands::log_path,
            license::license_texts,
            commands::take_startup_book,
            commands::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Reader");
}

#[cfg(all(test, desktop))]
mod migrate_tests {
    use super::*;

    fn sandbox(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("cenro-migrate-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn moves_the_whole_typo_directory() {
        let root = sandbox("rename");
        let old = root.join("com.lumviox.cenro");
        std::fs::create_dir_all(old.join("books")).unwrap();
        std::fs::write(old.join("cenro.db"), b"db").unwrap();
        std::fs::write(old.join("books/a.txt"), b"book").unwrap();

        let target = root.join("com.lumivox.cenro");
        let message = migrate_legacy_data_dir(&target);

        assert!(message.is_some(), "迁移应当留下说明");
        assert!(target.join("cenro.db").is_file());
        // 书在 books/ 里，不是封面那种平铺结构：整目录搬家才带得过来
        assert!(target.join("books/a.txt").is_file());
        assert!(!old.exists(), "整目录搬走后旧目录不该还在");
    }

    #[test]
    fn does_nothing_when_new_dir_already_has_a_library() {
        let root = sandbox("exists");
        let target = root.join("com.lumivox.cenro");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("cenro.db"), b"new").unwrap();
        let old = root.join("com.lumviox.cenro");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("cenro.db"), b"old").unwrap();

        assert!(migrate_legacy_data_dir(&target).is_none());
        // 新库不被旧库覆盖
        assert_eq!(std::fs::read(target.join("cenro.db")).unwrap(), b"new");
        assert!(old.exists());
    }

    #[test]
    fn no_legacy_dir_means_no_message() {
        let root = sandbox("none");
        assert!(migrate_legacy_data_dir(&root.join("com.lumivox.cenro")).is_none());
    }
}
