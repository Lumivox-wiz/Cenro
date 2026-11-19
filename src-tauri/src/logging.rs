//! 运行日志。
//!
//! 目标只有一个：**出问题时能查到发生了什么**。所以这里不引第三方日志框架，
//! 就一个追加写的文本文件 + 轮转，规则简单到看代码就能确定行为：
//!
//! - 位置：`<app_data>/logs/cenro.log`（移动端也一样，在应用私有目录里）
//! - 轮转：单文件超过 2 MB 就滚成 `.1`，最多留 3 个历史文件
//! - 每行：`2026-11-16 14:20:31.123  INFO  scan  扫描完成：...
//!
//! 写日志本身绝不能把程序弄崩：所有错误都吞掉并放弃这一次写入。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// 单文件上限，超过就轮转
const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// 保留的历史文件数（.1 / .2 / .3）
const KEEP_FILES: usize = 3;

struct Logger {
    path: PathBuf,
    dir: PathBuf,
}

static LOGGER: OnceLock<Mutex<Logger>> = OnceLock::new();

pub fn init(data_dir: &Path) {
    let dir = data_dir.join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("cenro.log");

    // 上次没写完整（进程被杀）会留下过长文件，启动时先收拾一次
    rotate_if_needed(&path, &dir);

    let _ = LOGGER.set(Mutex::new(Logger {
        path: path.clone(),
        dir,
    }));

    install_panic_hook();
    start_watchdog();

    info(
        "app",
        format!(
            "===== 启动 v{} · {} {} · 数据目录 {} =====",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            data_dir.display()
        ),
    );
}

/// 前端有没有活过。用来判断「窗口出来了但里面全黑」这种连日志都没得看的情况。
static FRONT_ALIVE: AtomicBool = AtomicBool::new(false);

/// 前端每发来一条日志就等于报了一次平安。
pub fn mark_front_alive() {
    FRONT_ALIVE.store(true, Ordering::Relaxed);
}

/// 看门狗：启动若干秒后仍未收到前端的任何消息，就把最可能的原因写进日志。
///
/// 黑屏是最难查的一类故障——Rust 侧一切正常（窗口建好了、日志也写了），
/// 问题全在 WebView2 里，而那时前端一行代码都还没执行。
fn start_watchdog() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(8));
        if FRONT_ALIVE.load(Ordering::Relaxed) {
            return;
        }
        error(
            "app",
            "启动 8 秒后仍未收到前端任何消息：窗口可能是全黑的。\n             常见原因与处置：\n             1) WebView2 运行时缺失或过旧 → 安装 Microsoft Edge WebView2 Runtime；\n             2) 老旧显卡/驱动下 WebView2 用 GPU 合成会整窗黑屏 → 设环境变量 \
             WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu 后再启动（仓库里带了一个「兼容模式启动.bat」）；\n             3) 远程桌面 / 虚拟机里缺少硬件加速 → 同上。",
        );
    });
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 先落日志再交给原处理器（桌面端它会往 stderr 打一份）
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "未知位置".to_string());
        error("panic", format!("{info} @ {location}"));
        previous(info);
    }));
}

fn rotate_if_needed(path: &Path, dir: &Path) {
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.len() < MAX_BYTES {
        return;
    }

    // cenro.log → cenro.log.1 → .2 → .3（最老的丢掉）
    for i in (1..KEEP_FILES).rev() {
        let from = dir.join(format!("cenro.log.{i}"));
        let to = dir.join(format!("cenro.log.{}", i + 1));
        let _ = fs::rename(from, to);
    }
    let _ = fs::rename(path, dir.join("cenro.log.1"));
}

fn stamp() -> String {
    // chrono 已在依赖里（备份文件名要用本地时间），这里复用同一套格式化
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string()
}

fn write_line(level: &str, target: &str, message: &str) {
    let Some(lock) = LOGGER.get() else {
        return;
    };
    let Ok(logger) = lock.lock() else {
        return;
    };

    rotate_if_needed(&logger.path, &logger.dir);

    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&logger.path)
    else {
        return;
    };

    let _ = writeln!(file, "{}  {:<5}  {}  {}", stamp(), level, target, flatten(message));
}

/// 一条消息里带换行会破掉「一行一条」，统一折成 " ⏎ "。
fn flatten(message: &str) -> String {
    message.replace(['\r', '\n'], " ⏎ ")
}

pub fn info(target: &str, message: impl AsRef<str>) {
    write_line("INFO", target, message.as_ref());
}

pub fn warn(target: &str, message: impl AsRef<str>) {
    write_line("WARN", target, message.as_ref());
}

pub fn error(target: &str, message: impl AsRef<str>) {
    write_line("ERROR", target, message.as_ref());
}

/// 记录一次失败。命令层到处都能用，省得每处都拼格式串。
pub fn failure(target: &str, context: &str, err: &impl std::fmt::Display) {
    error(target, format!("{context}：{err}"));
}

pub fn path() -> Option<PathBuf> {
    LOGGER.get().and_then(|l| l.lock().ok().map(|g| g.path.clone()))
}

pub fn dir() -> Option<PathBuf> {
    LOGGER.get().and_then(|l| l.lock().ok().map(|g| g.dir.clone()))
}

/// 读日志尾部（最多 `max_lines` 行）。给「设置 → 关于 → 查看日志」用。
pub fn tail(max_lines: usize) -> String {
    let Some(p) = path() else {
        return String::new();
    };
    let Ok(text) = fs::read_to_string(&p) else {
        return String::new();
    };
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("cenro-log-{name}"));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn stamp_has_full_date_and_millis() {
        let s = stamp();
        assert_eq!(s.len(), 23, "{s}"); // YYYY-MM-DD HH:MM:SS.mmm
        assert!(s.starts_with("20"), "{s}");
    }

    #[test]
    fn flatten_keeps_one_line_per_entry() {
        assert_eq!(flatten("第一行\n第二行"), "第一行 ⏎ 第二行");
        assert_eq!(flatten("a\r\nb"), "a ⏎  ⏎ b");
        assert!(!flatten("x\ny").contains('\n'));
    }

    #[test]
    fn rotation_moves_file_aside() {
        let dir = temp_dir("rotate");
        let path = dir.join("cenro.log");
        fs::write(&path, vec![b'x'; (MAX_BYTES + 1) as usize]).unwrap();

        rotate_if_needed(&path, &dir);
        assert!(!path.exists(), "超过上限应被滚走");
        assert!(dir.join("cenro.log.1").exists());

        // 再超一次：旧 .1 变 .2，不会互相覆盖
        fs::write(&path, vec![b'y'; (MAX_BYTES + 1) as usize]).unwrap();
        rotate_if_needed(&path, &dir);
        assert!(dir.join("cenro.log.1").exists());
        assert!(dir.join("cenro.log.2").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
