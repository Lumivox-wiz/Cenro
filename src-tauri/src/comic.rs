use crate::error::{AppError, Result};
use crate::models::BookFormat;
use crate::util;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

/// 7z 整包解压完成的标记文件。解压是幂等的：标记在就只列目录，不重复解。
const EXTRACTED_MARKER: &str = ".extracted";

/// 列出漫画页。
/// - 图片文件夹：返回目录内的文件名
/// - CBZ / CBT：返回压缩包内的条目名
/// - CB7：整包解压到缓存后返回相对路径
/// 都按自然序排列（1, 2, 10 而不是 1, 10, 2）。
pub fn list_pages(
    source: &Path,
    format: BookFormat,
    cache_root: &Path,
    book_id: &str,
) -> Result<Vec<String>> {
    let mut names: Vec<String> = match format {
        BookFormat::Cbz | BookFormat::Zip => zip_entries(source)?
            .into_iter()
            .map(|(name, _)| name)
            .filter(|name| is_page_name(name))
            .collect(),
        BookFormat::Cbt => tar_entries(source)?
            .into_iter()
            .map(|e| e.name)
            .filter(|name| is_page_name(name))
            .collect(),
        BookFormat::Cbr => rar_entries(source)?
            .into_iter()
            .map(|(name, _)| name)
            .filter(|name| is_page_name(name))
            .collect(),
        BookFormat::Cb7 => {
            let dir = extract_sevenz(source, cache_root, book_id)?;
            walk_images(&dir)?
        }
        _ => {
            let mut names = Vec::new();
            for entry in std::fs::read_dir(source)? {
                let entry = entry?;
                let path = entry.path();
                if path.is_file() && util::is_image_path(&path) {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        names.push(name.to_string());
                    }
                }
            }
            names
        }
    };

    names.sort_by(|a, b| util::natural_cmp(a, b));
    Ok(names)
}

/// 条目名是否算漫画页：跳过 macOS 垃圾条目、隐藏文件与非图片。
fn is_page_name(name: &str) -> bool {
    if name.contains("__MACOSX") {
        return false;
    }
    let base = name.rsplit('/').next().unwrap_or("");
    if base.starts_with('.') {
        return false;
    }
    util::is_image_path(Path::new(name))
}

/// zip 的条目名与未压缩大小，按条目顺序。
fn zip_entries(path: &Path) -> Result<Vec<(String, u64)>> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    let mut out = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index_raw(i) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        match entry.name() {
            Ok(name) => out.push((name.to_string(), entry.size())),
            Err(_) => continue,
        }
    }
    Ok(out)
}

/// 数压缩包里的图片条目数。用于判断一个 `.zip` 到底是漫画还是普通压缩包。
/// 只读条目名，不解压任何内容。
pub fn zip_image_count(path: &Path) -> Result<usize> {
    let mut count = 0;
    for (name, _) in zip_entries(path)? {
        if is_page_name(&name) {
            count += 1;
        }
    }
    Ok(count)
}

// ---------------- TAR（.cbt） ----------------

struct TarEntry {
    name: String,
    /// 数据起始偏移，按需 seek 读取单页
    offset: u64,
    size: u64,
}

/// TAR 没有集中索引，只能顺序扫头部。每块 512 字节，全 0 块表示结束。
/// 支持 ustar 前缀与 GNU 长文件名（typeflag 'L'）——漫画包目录层数多，常会触发。
fn tar_entries(path: &Path) -> Result<Vec<TarEntry>> {
    let mut file = File::open(path)?;
    let total = file.metadata()?.len();
    let mut pos = 0u64;
    let mut out = Vec::new();
    let mut long_name: Option<String> = None;
    let mut header = [0u8; 512];

    while pos + 512 <= total {
        file.seek(SeekFrom::Start(pos))?;
        file.read_exact(&mut header)?;
        if header.iter().all(|b| *b == 0) {
            break;
        }

        let size = parse_tar_octal(&header[124..136]).unwrap_or(0);
        let typeflag = header[156];
        let data_off = pos + 512;

        if typeflag == b'L' {
            // GNU 长文件名：数据区就是完整的名字
            let mut buf = vec![0u8; size as usize];
            file.seek(SeekFrom::Start(data_off))?;
            let _ = file.read_exact(&mut buf);
            long_name = Some(
                String::from_utf8_lossy(&buf)
                    .trim_end_matches('\0')
                    .to_string(),
            );
        } else if typeflag == b'x' {
            // pax 扩展头：只关心 path= 这一条
            let mut buf = vec![0u8; size as usize];
            file.seek(SeekFrom::Start(data_off))?;
            let _ = file.read_exact(&mut buf);
            let text = String::from_utf8_lossy(&buf);
            for line in text.lines() {
                if let Some(rest) = line.trim_end_matches('\0').strip_prefix("path=") {
                    long_name = Some(rest.split('\0').next().unwrap_or(rest).to_string());
                }
            }
        } else if typeflag == b'0' || typeflag == 0 {
            let name = long_name.take().unwrap_or_else(|| tar_name(&header));
            out.push(TarEntry {
                name,
                offset: data_off,
                size,
            });
        } else {
            // 目录 / 链接 / 其它元数据块：不当作页面
            long_name = None;
        }

        pos = data_off + size.div_ceil(512) * 512;
    }

    Ok(out)
}

fn tar_name(header: &[u8]) -> String {
    let name = cstr(&header[0..100]);
    let prefix = cstr(&header[345..500]);
    if prefix.is_empty() {
        name
    } else {
        format!("{prefix}/{name}")
    }
}

fn cstr(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).to_string()
}

/// TAR 数值字段：八进制 ASCII，可能带前导空格与结尾 NUL。也兼容 GNU base-256。
fn parse_tar_octal(field: &[u8]) -> Option<u64> {
    if field.first().is_some_and(|b| b & 0x80 != 0) {
        let mut value = 0u64;
        for b in &field[1..] {
            value = (value << 8) | *b as u64;
        }
        return Some(value);
    }
    let text = String::from_utf8_lossy(field);
    let trimmed = text.trim_matches(|c: char| c == ' ' || c == '\0');
    if trimmed.is_empty() {
        return None;
    }
    u64::from_str_radix(trimmed, 8).ok()
}

pub fn tar_image_count(path: &Path) -> Result<usize> {
    Ok(tar_entries(path)?
        .into_iter()
        .filter(|e| is_page_name(&e.name))
        .count())
}

// ---------------- RAR（.cbr） ----------------

/// 条目表：RAR 头部自带文件名与解压后大小，列页不解压正文。
/// 分卷包只看第一只卷的头，覆盖绝大多数漫画合集。
fn rar_entries(path: &Path) -> Result<Vec<(String, u64)>> {
    let archive = unrar_rs::RarArchive::open(File::open(path)?)
        .map_err(|e| AppError::Other(format!("RAR 读取失败：{e}")))?;
    let mut out = Vec::new();
    for member in archive.entries() {
        if member.name.ends_with('/') {
            continue;
        }
        out.push((member.name.clone(), member.unpacked_size.unwrap_or(0)));
    }
    Ok(out)
}

pub fn rar_image_count(path: &Path) -> Result<usize> {
    Ok(rar_entries(path)?
        .into_iter()
        .filter(|(name, _)| is_page_name(name))
        .count())
}

// ---------------- 7z（.cb7） ----------------

/// 7z 没有便宜的「只看名字」通道（条目表在压缩块里），
/// 因此首次访问时整包解到缓存目录，之后按目录读取。
fn extract_sevenz(source: &Path, cache_root: &Path, book_id: &str) -> Result<PathBuf> {
    let dir = cache_root.join(book_id);
    let marker = dir.join(EXTRACTED_MARKER);

    if marker.is_file() {
        return Ok(dir);
    }

    // 解压到临时目录再改名：中途失败不会留下「半个包」被误当完整
    let tmp = cache_root.join(format!("{book_id}.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;

    sevenz_rust::decompress_file(source, &tmp)
        .map_err(|e| AppError::Other(format!("7z 解压失败：{e}")))?;

    std::fs::write(tmp.join(EXTRACTED_MARKER), b"1")?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&tmp, &dir)?;
    Ok(dir)
}

/// 7z 的图片条目数：只读条目表，不解压（扫描阶段用）。
pub fn sevenz_image_count(path: &Path) -> Result<usize> {
    let reader = sevenz_rust::SevenZReader::open(path, sevenz_rust::Password::empty())
        .map_err(|e| AppError::Other(format!("7z 读取失败：{e}")))?;
    let count = reader
        .archive()
        .files
        .iter()
        .filter(|entry| !entry.is_directory() && is_page_name(entry.name()))
        .count();
    Ok(count)
}

/// 递归收集图片相对路径（7z 解压后可能有多层目录）。
fn walk_images(dir: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(dir).follow_links(false) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        if !util::is_image_path(entry.path()) {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(dir) {
            let name = rel.to_string_lossy().replace('\\', "/");
            if !name.ends_with(EXTRACTED_MARKER) {
                out.push(name);
            }
        }
    }
    Ok(out)
}

/// 首页图像字节，供封面生成用。CB7 会触发整包解压（有缓存标记，只做一次）。
pub fn first_image_bytes(
    source: &Path,
    format: BookFormat,
    cache_root: &Path,
    book_id: &str,
) -> Result<Option<Vec<u8>>> {
    let pages = list_pages(source, format, cache_root, book_id)?;
    let Some(name) = pages.first() else {
        return Ok(None);
    };
    let path = page_path(source, format, 0, name, cache_root, book_id)?;
    Ok(Some(std::fs::read(path)?))
}

/// 取第 index 页在磁盘上的路径。
/// 文件夹直接复用原文件；压缩包按需解压到缓存目录，命中缓存则不重复解压。
pub fn page_path(
    source: &Path,
    format: BookFormat,
    index: usize,
    name: &str,
    cache_root: &Path,
    book_id: &str,
) -> Result<PathBuf> {
    // 防路径穿越：任何模式都不允许 ..
    if name.contains("..") {
        return Err(AppError::Other("非法页面路径".into()));
    }

    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("img");
    let dir = cache_root.join(book_id);
    let out = dir.join(format!("{index:05}.{ext}"));

    match format {
        BookFormat::Folder => {
            if name.contains('/') || name.contains('\\') {
                return Err(AppError::Other("非法页面文件名".into()));
            }
            let path = source.join(name);
            if path.is_file() {
                return Ok(path);
            }
            Err(AppError::Other(format!("页面不存在：{name}")))
        }
        BookFormat::Cb7 => {
            // 整包已解压，直接返回解压出来的文件
            let path = extract_sevenz(source, cache_root, book_id)?.join(name);
            if path.is_file() {
                Ok(path)
            } else {
                Err(AppError::Other(format!("页面不存在：{name}")))
            }
        }
        BookFormat::Cbr => {
            std::fs::create_dir_all(&dir)?;
            if out.is_file() {
                return Ok(out);
            }
            // RAR 只能顺序解压：按名定位后解出这一条，直接落到缓存文件
            let mut archive = unrar_rs::RarArchive::open(File::open(source)?)
                .map_err(|e| AppError::Other(format!("RAR 读取失败：{e}")))?;
            let mut buf = Vec::new();
            archive
                .by_name(name)
                .map_err(|_| AppError::Other(format!("页面不存在：{name}")))?
                .copy_to(&mut buf)
                .map_err(|e| AppError::Other(format!("RAR 解压失败：{e}")))?;
            std::fs::write(&out, &buf)?;
            Ok(out)
        }
        BookFormat::Cbt => {
            std::fs::create_dir_all(&dir)?;
            if out.is_file() {
                return Ok(out);
            }
            let entry = tar_entries(source)?
                .into_iter()
                .find(|e| e.name == name)
                .ok_or_else(|| AppError::Other(format!("页面不存在：{name}")))?;
            let mut file = File::open(source)?;
            file.seek(SeekFrom::Start(entry.offset))?;
            let mut buf = vec![0u8; entry.size as usize];
            file.read_exact(&mut buf)?;
            let mut writer = File::create(&out)?;
            writer.write_all(&buf)?;
            Ok(out)
        }
        _ => {
            std::fs::create_dir_all(&dir)?;
            if out.is_file() {
                return Ok(out);
            }
            let file = File::open(source)?;
            let mut archive = ZipArchive::new(file)?;
            let mut entry = archive.by_name(name)?;
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buf)?;
            std::fs::write(&out, &buf)?;
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `.zip` 是否算漫画，取决于里面有多少张图 —— 这条决定扫描阶段收不收它。
    #[test]
    fn counts_images_in_zip() {
        use std::io::Write;

        let root = std::env::temp_dir().join("reader-zip-count");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("book.zip");

        {
            let file = File::create(&path).unwrap();
            let mut zw = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();

            // 三张图（含一张子目录里的）+ 一个非图片条目 + 一个 macOS 垃圾条目
            for name in ["001.jpg", "002.png", "sub/003.webp"] {
                zw.start_file(name, opts).unwrap();
                zw.write_all(b"x").unwrap();
            }
            zw.start_file("readme.txt", opts).unwrap();
            zw.write_all(b"not an image").unwrap();
            zw.start_file("__MACOSX/._001.jpg", opts).unwrap();
            zw.write_all(b"x").unwrap();
            zw.finish().unwrap();
        }

        assert_eq!(zip_image_count(&path).unwrap(), 3);
    }

    #[test]
    fn lists_folder_in_natural_order() {
        let root = std::env::temp_dir().join("reader-comic-list");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        for name in ["10.png", "2.png", "1.png"] {
            std::fs::write(root.join(name), b"x").unwrap();
        }
        std::fs::write(root.join("note.txt"), b"x").unwrap();

        let pages = list_pages(&root, BookFormat::Folder, &root, "x").unwrap();
        assert_eq!(pages, vec!["1.png", "2.png", "10.png"]);
    }

    #[test]
    fn rejects_path_traversal() {
        let root = std::env::temp_dir().join("reader-comic-guard");
        std::fs::create_dir_all(&root).unwrap();
        let err = page_path(&root, BookFormat::Folder, 0, "../secret.png", &root, "x");
        assert!(err.is_err());
    }

    /// 手写 ustar 头，验证 CBT 的「数条目 / 列页 / 按需取单页」整条链路。
    fn tar_header(name: &str, size: usize) -> [u8; 512] {
        let mut h = [0u8; 512];
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[100..108].copy_from_slice(b"0000644\0");
        h[108..116].copy_from_slice(b"0000000\0");
        h[116..124].copy_from_slice(b"0000000\0");
        let size_str = format!("{:011o}\0", size);
        h[124..136].copy_from_slice(size_str.as_bytes());
        h[136..148].copy_from_slice(b"00000000000\0");
        h[148..156].copy_from_slice(b"        ");
        h[156] = b'0';
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        let sum: u32 = h.iter().map(|b| *b as u32).sum();
        let sum_str = format!("{:06o}\0 ", sum);
        h[148..156].copy_from_slice(sum_str.as_bytes());
        h
    }

    /// 不是 RAR 的文件要报错而不是 panic：扫描阶段靠 unwrap_or(0) 吞掉。
    #[test]
    fn rejects_non_rar_as_cbr() {
        let dir = std::env::temp_dir().join("reader-cbr-bad");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("not.cbr");
        std::fs::write(&path, b"not a rar archive").unwrap();
        assert!(rar_image_count(&path).is_err());
    }

    #[test]
    fn reads_cbt_entries_and_extracts_page() {        let dir = std::env::temp_dir().join("reader-cbt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.cbt");

        let mut bytes: Vec<u8> = Vec::new();
        for (name, payload) in [("10.png", b"ten".as_slice()), ("2.png", b"two"), ("1.png", b"one")] {
            bytes.extend_from_slice(&tar_header(name, payload.len()));
            bytes.extend_from_slice(payload);
            let pad = (512 - payload.len() % 512) % 512;
            bytes.extend(std::iter::repeat_n(0u8, pad));
        }
        // 两块的结束标记
        bytes.extend(std::iter::repeat_n(0u8, 1024));
        std::fs::write(&path, &bytes).unwrap();

        assert_eq!(tar_image_count(&path).unwrap(), 3);

        let names = list_pages(&path, BookFormat::Cbt, &dir, "id").unwrap();
        assert_eq!(names, vec!["1.png", "2.png", "10.png"]);

        let page = page_path(&path, BookFormat::Cbt, 1, "2.png", &dir, "id").unwrap();
        assert_eq!(std::fs::read(page).unwrap(), b"two");
    }
}
