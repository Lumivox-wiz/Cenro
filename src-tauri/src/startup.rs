//! 双击打开：把启动参数里的书收进书库，并告诉前端去打开它。
//!
//! 为什么选择**复制进书库**而不是只记路径：双击打开的文件多半在「下载」「微信接收」
//! 这类目录里，用户清理下载目录是常事。只记路径的结果是书架里留一排「文件已丢失」。
//! 复制一份进 `<data>/inbox/`，之后书就在应用自己手里。
//!
//! 两条入口共用 `absorb`：
//! - **冷启动**：argv 里带文件 → 收下 → 前端挂载时 `take_pending` 取一次；
//! - **热启动**（应用已开着）：单实例插件把参数转进来 → 收下 → `emit` 事件，
//!   前端收到后直接进阅读页。

use crate::db;
use crate::error::Result;
use crate::models::Book;
use crate::scanner;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
// 单实例只在桌面端存在；移动端由系统保证「一个应用一个实例」
#[cfg(desktop)]
use tauri::{AppHandle, Emitter, Manager};

/// 前端启动后取一次「要打开哪本书」。取完即清，避免每次热重载都重开。
pub fn take_pending(state: &crate::AppState) -> Option<String> {
    state
        .startup_book
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
}

/// 从一串参数里挑出第一个像书的路径。
///
/// Windows 双击会把路径作为第一个参数传进来；单实例插件转交的 argv
/// 第 0 个是 exe 自己，所以要靠「文件存在 + 扩展名认识」来筛，
/// 不能只取 `args[0]`——`--some-flag` 这类参数也得能跳过。
pub fn book_from<I: IntoIterator<Item = String>>(args: I) -> Option<PathBuf> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(PathBuf::from)
        .find(|p| p.is_file() && scanner::classify(p).is_some())
}

pub fn book_arg() -> Option<PathBuf> {
    book_from(std::env::args().skip(1))
}

/// 第二个实例带着文件启动时，由单实例插件回调调用。
///
/// 顺序有讲究：先唤窗口再收文件。收文件要读盘、抽封面，慢的能到几百毫秒，
/// 用户双击后盯着一个没反应的任务栏图标会以为没启动。
#[cfg(desktop)]
pub fn handle_external_open(app: &AppHandle, args: Vec<String>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }

    let Some(path) = book_from(args) else {
        // 没有文件参数也要唤窗口：双击图标再点一次，总得有个反应
        crate::logging::warn("open-with", "参数里没有可识别的书籍文件");
        return;
    };

    let state = app.state::<crate::AppState>();
    let id = match state.db.lock() {
        Ok(conn) => match absorb(&state, &conn, &path) {
            Ok(Some(book)) => Some(book.id),
            Ok(None) => None,
            Err(e) => {
                crate::logging::failure("open-with", "收下外部文件失败", &e);
                None
            }
        },
        Err(_) => {
            crate::logging::warn("open-with", "数据库忙，跳过外部文件");
            None
        }
    };

    // absorb 顺手写了 startup_book（冷启动用的槽），这里要抹掉：
    // 前端已经在运行，再走一次「挂载时取」会导致同一本书被重开一遍。
    if let Ok(mut slot) = state.startup_book.lock() {
        *slot = None;
    }

    if let Some(id) = id {
        crate::logging::info("open-with", "已转交给运行中的实例");
        let _ = app.emit("open-book", id);
    }
}

pub fn absorb(state: &crate::AppState, conn: &Connection, source: &Path) -> Result<Option<Book>> {
    let Some((book_type, format)) = scanner::classify(source) else {
        return Ok(None);
    };

    let inbox = state.data_dir.join("inbox");
    std::fs::create_dir_all(&inbox)?;
    let target = unique_path(&inbox, source);

    std::fs::copy(source, &target)?;
    crate::logging::info("open-with", format!("收到外部文件：{}", source.display()));

    scanner::ingest(conn, &state.cover_dir, &target, book_type, format)?;

    // ingest 用的是「路径 → 记录」，按路径回查最稳（同名文件会被去重成 (1)）
    let id = db::list_books(conn, None, None)?
        .into_iter()
        .find(|b| b.path == target.to_string_lossy())
        .map(|b| b.id);

    if let Some(id) = id {
        if let Ok(mut slot) = state.startup_book.lock() {
            *slot = Some(id.clone());
        }
        return db::get_book(conn, &id);
    }
    Ok(None)
}

/// Android：「用其他应用打开」收到的文件由 Kotlin 复制进约定目录，这里把它扫出来入库。
///
/// **为什么不用 JNI 主动拉**：`ndk_context::android_context()` 在未初始化时是 `expect`，
/// 直接 panic；而 `jni` 的调用失败（比如方法找错类）会在 Java 侧留下 pending 异常，
/// 主线程带着它返回 Java 层就是一次崩溃。这两条都是「看起来能用、换台机器就炸」的类型，
/// 而目录协议只需要两边认同一个路径，失败最多是「没扫到」，不会把应用带走。
///
/// 「收件目录」的候选列表。
///
/// 第一条是正解（Kotlin 现在写这里），后三条是历史版本写错的位置——
/// 留着只为让已经升级的用户不必手动搬家。抽成函数是为了启动日志和扫描用同一份列表，
/// 否则两边一旦不同步，又会出现「日志说 A、实际扫 B」。
#[cfg(target_os = "android")]
pub fn incoming_dirs(data_dir: &std::path::Path) -> Vec<PathBuf> {
    let mut dirs = vec![data_dir.join("incoming")];
    dirs.push(data_dir.join("files/incoming")); // 0.20.3 写的
    dirs.push(data_dir.join("cache/incoming"));
    if let Some(name) = data_dir.file_name() {
        dirs.push(data_dir.join(name).join("incoming")); // 0.20.4 多套了一层包名
    }
    dirs
}

/// 与 Kotlin 的约定：
/// - 目录 `app_data_dir/incoming`。实测 Tauri 在 Android 上**不给它追加包名**，
///   就是 `getDataDir()` 本身（`/data/user/0/<包名>`），不是 filesDir——前两版都栽在这一点上；
/// - **先写 `名字.part`，写完再 rename**，所以这里跳过 `.part` 就永远不会读到半截文件。
#[cfg(target_os = "android")]
pub fn take_incoming(state: &crate::AppState, conn: &Connection) -> Option<Book> {
    let candidates = incoming_dirs(&state.data_dir);

    for dir in candidates {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) == Some("part") {
                continue;
            }
            if scanner::classify(&path).is_none() {
                // 不认识的格式：删掉，否则用户每点一次就在这留一个垃圾
                let _ = std::fs::remove_file(&path);
                continue;
            }

            let result = absorb(state, conn, &path);
            // 无论成败都清掉源文件：失败重试也不会变成功（格式/权限问题），留着只会堆积
            let _ = std::fs::remove_file(&path);

            match result {
                Ok(Some(book)) => return Some(book),
                Ok(None) => {}
                Err(e) => crate::logging::failure("open-with", "收下外部文件失败", &e),
            }
        }
    }
    None
}

/// 目标文件重名时加序号：`书.epub` → `书(1).epub`
pub(crate) fn unique_path(dir: &Path, source: &Path) -> PathBuf {
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "book".into());
    let candidate = dir.join(&name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(&name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "book".into());
    let ext = Path::new(&name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for i in 1..1000 {
        let next = dir.join(format!("{stem}({i}){ext}"));
        if !next.exists() {
            return next;
        }
    }
    candidate
}
