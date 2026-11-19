use sha2::{Digest, Sha256};
use std::path::Path;

/// 由绝对路径派生稳定 id。同一路径重复扫描必须得到同一 id。
pub fn stable_id(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// 标注用的新 id：时间戳 + 进程内自增，避免同一毫秒连加两条时撞车。
pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("n{nanos:x}{:x}", SEQ.fetch_add(1, Ordering::Relaxed))
}

#[allow(dead_code)] // 扫描器暂未启用隐藏目录过滤，保留以便后续接入
pub fn is_hidden_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

/// 系统目录与打包残留，扫描时整树跳过。
pub fn is_ignored_dir_name(name: &str) -> bool {
    matches!(
        name,
        "__MACOSX" | ".git" | ".svn" | "node_modules" | "$RECYCLE.BIN" | "System Volume Information"
    )
}

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "jxl", "tif", "tiff",
];

pub fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext))
}

pub fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(is_image_ext)
        .unwrap_or(false)
}

/// 自然排序：1, 2, 10 而非 1, 10, 2。漫画条目顺序依赖它。
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let (mut i, mut j) = (0usize, 0usize);

    while i < a_bytes.len() && j < b_bytes.len() {
        let ca = a_bytes[i];
        let cb = b_bytes[j];

        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let si = i;
            while i < a_bytes.len() && a_bytes[i].is_ascii_digit() {
                i += 1;
            }
            let sj = j;
            while j < b_bytes.len() && b_bytes[j].is_ascii_digit() {
                j += 1;
            }
            let na = &a[si..i];
            let nb = &b[sj..j];
            let na_trim = na.trim_start_matches('0');
            let nb_trim = nb.trim_start_matches('0');
            let na_trim = if na_trim.is_empty() { "0" } else { na_trim };
            let nb_trim = if nb_trim.is_empty() { "0" } else { nb_trim };
            match na_trim.len().cmp(&nb_trim.len()) {
                Ordering::Equal => match na_trim.cmp(nb_trim) {
                    Ordering::Equal => continue,
                    ord => return ord,
                },
                ord => return ord,
            }
        } else {
            let ord = ca.cmp(&cb);
            if ord != Ordering::Equal {
                return ord;
            }
            i += 1;
            j += 1;
        }
    }

    (a_bytes.len() - i).cmp(&(b_bytes.len() - j))
}

/// 探测中文文本编码。返回 (解码后文本, 使用的编码名)。
/// 顺序：BOM → UTF-8 严格校验 → GB18030 兜底。
pub fn decode_text(bytes: &[u8]) -> (String, &'static str) {
    let (cow, encoding, had_errors) = encoding_rs::UTF_8.decode(bytes);
    if !had_errors {
        return (cow.into_owned(), encoding.name());
    }
    let (cow, encoding, _) = encoding_rs::GB18030.decode(bytes);
    (cow.into_owned(), encoding.name())
}
