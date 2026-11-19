use crate::error::Result;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 目录递归总字节数
pub fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => total += dir_size(&path),
            Ok(meta) => total += meta.len(),
            Err(_) => {}
        }
    }
    total
}

/// 目录内最新的文件修改时间，作为「最近使用」的近似
fn newest_mtime(dir: &Path) -> SystemTime {
    let mut newest = SystemTime::UNIX_EPOCH;
    let Ok(entries) = fs::read_dir(dir) else {
        return newest;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => {
                let inner = newest_mtime(&path);
                if inner > newest {
                    newest = inner;
                }
            }
            Ok(meta) => {
                if let Ok(t) = meta.modified() {
                    if t > newest {
                        newest = t;
                    }
                }
            }
            Err(_) => {}
        }
    }
    newest
}

/// 清空目录内容但保留目录本身
pub fn clear_dir(dir: &Path) -> Result<u64> {
    let size = dir_size(dir);
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(0);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        } else {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(size)
}

/// 按两步裁剪：
/// 1. 删掉书籍已不在库中的孤儿缓存目录
/// 2. 总量超过上限时，按「最近修改时间」从旧到新删，直到降到上限的 80%
/// 返回释放的字节数。
pub fn prune_in(root: &Path, live_ids: &HashSet<String>, limit_bytes: u64) -> u64 {
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };

    let mut items: Vec<(PathBuf, String, u64, SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        items.push((path.clone(), name.to_string(), dir_size(&path), newest_mtime(&path)));
    }

    let mut freed = 0u64;

    // 1. 孤儿
    items.retain(|(path, id, size, _)| {
        if live_ids.contains(id) {
            return true;
        }
        let _ = fs::remove_dir_all(path);
        freed += size;
        false
    });

    // 2. 超限
    let mut total: u64 = items.iter().map(|i| i.2).sum();
    if total > limit_bytes {
        items.sort_by_key(|i| i.3);
        let target = limit_bytes.saturating_mul(8) / 10;
        for (path, _id, size, _) in &items {
            if total <= target {
                break;
            }
            let _ = fs::remove_dir_all(path);
            total = total.saturating_sub(*size);
            freed += size;
        }
    }

    freed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prunes_orphans_and_respects_limit() {
        let root = std::env::temp_dir().join("reader-cache-prune");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("keep")).unwrap();
        fs::create_dir_all(root.join("gone")).unwrap();
        fs::write(root.join("keep/a.bin"), vec![0u8; 1024]).unwrap();
        fs::write(root.join("gone/b.bin"), vec![0u8; 2048]).unwrap();

        let live: HashSet<String> = ["keep".to_string()].into_iter().collect();
        let freed = prune_in(&root, &live, u64::MAX);

        assert_eq!(freed, 2048);
        assert!(root.join("keep").is_dir());
        assert!(!root.join("gone").exists());
    }

    #[test]
    fn clear_dir_keeps_directory() {
        let root = std::env::temp_dir().join("reader-cache-clear");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("x")).unwrap();
        fs::write(root.join("x/y.bin"), vec![0u8; 512]).unwrap();

        let freed = clear_dir(&root).unwrap();
        assert!(freed >= 512);
        assert!(root.is_dir());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }
}
