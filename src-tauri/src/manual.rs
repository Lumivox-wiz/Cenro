//! 随安装包下发的「使用说明」。
//!
//! 目标：新用户第一次打开就有一本能读的书，讲清楚怎么导入、书签怎么用、隐私怎么开。
//!
//! 两个约束：
//! 1. **内容随版本更新**：每次启动都用包内的版本覆盖数据目录里的副本，
//!    改说明不用让用户重装、也不会出现「老说明 + 新功能」对不上的情况；
//! 2. **用户删了就不再塞回来**：插入成功后落一个标记文件，之后只更新内容不重建记录。
//!    否则用户每删一次、下次启动又冒出来，像甩不掉的广告。

use crate::db;
use crate::error::Result;
use crate::models::{Book, BookFormat, BookStatus, BookType, CoverState};
use rusqlite::Connection;
use std::path::Path;
use tauri::AppHandle;

const FILE_NAME: &str = "岑序使用说明.md";
/// 直接把内容编进二进制。
///
/// 打包资源在 Android 上是 APK 内的条目，`std::fs::read` 拿不到；
/// 而这份说明只有十来 KB，内嵌进去最省事，也免了「资源没打进包」这类事故。
const CONTENT: &str = include_str!("../resources/岑序使用说明.md");
const TITLE: &str = "岑序使用说明";
/// 固定 id：即使记录被删过，也能靠它判断「这本书曾经装过」
const BOOK_ID: &str = "cenro-manual";

pub fn ensure(_app: &AppHandle, conn: &Connection, data_dir: &Path) -> Result<()> {
    let dir = data_dir.join("manual");
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(FILE_NAME);
    std::fs::write(&target, CONTENT.as_bytes())?;

    let marker = dir.join(".installed");
    if marker.exists() {
        return Ok(());
    }

    let meta = std::fs::metadata(&target)?;
    let book = Book {
        id: BOOK_ID.to_string(),
        book_type: BookType::Doc,
        format: BookFormat::Markdown,
        path: target.to_string_lossy().into_owned(),
        size: meta.len() as i64,
        mtime: mtime_of(&meta),
        title: TITLE.to_string(),
        author: None,
        cover_path: None,
        cover_state: CoverState::Pending,
        meta_locked: true,
        status: BookStatus::Ok,
        private: false,
        missing: false,
        progress: None,
        metadata: None,
        added_at: db::now_ts(),
        last_read_at: None,
    };
    db::upsert_book(conn, &book)?;
    let _ = std::fs::write(&marker, b"1");
    crate::logging::info("manual", "使用说明已加入书架");
    Ok(())
}

fn mtime_of(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
