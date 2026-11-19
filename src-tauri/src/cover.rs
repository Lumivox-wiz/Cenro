use crate::error::Result;
use crate::models::{BookFormat, CoverState};
use crate::util;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

/// 缩略图目标尺寸。规范 §9：统一生成 320px 宽缓存，书架不直接加载原图。
/// 卡片最小宽 160px、封面 2:3，320×480 正好覆盖 2 倍屏。
const THUMB_W: u32 = 320;
const THUMB_H: u32 = 480;
/// 单个封面条目上限，防止把整本扫描图当封面读进内存。
const MAX_ENTRY_BYTES: u64 = 24 * 1024 * 1024;

pub struct CoverOutcome {
    pub path: Option<String>,
    pub state: CoverState,
}

/// 按格式分治：
/// - TXT / PDF 在 P1 不产出真实封面（PDF 首页渲染需要 PDF 引擎，P1 未引入）
/// - EPUB 走 zip 内启发式找封面图
/// - CBZ 取自然排序首图
/// - 图片文件夹取自然排序首图
pub fn generate(
    book_id: &str,
    format: BookFormat,
    source: &Path,
    cache_dir: &Path,
) -> CoverOutcome {
    match format {
        BookFormat::Txt | BookFormat::Pdf => CoverOutcome {
            path: None,
            state: CoverState::Placeholder,
        },
        _ => match build(book_id, format, source, cache_dir) {
            Ok(Some(p)) => CoverOutcome {
                path: Some(p),
                state: CoverState::Ready,
            },
            Ok(None) => CoverOutcome {
                path: None,
                state: CoverState::Placeholder,
            },
            Err(_) => CoverOutcome {
                path: None,
                state: CoverState::Failed,
            },
        },
    }
}

fn build(
    book_id: &str,
    format: BookFormat,
    source: &Path,
    cache_dir: &Path,
) -> Result<Option<String>> {
    let out: PathBuf = cache_dir.join(format!("{book_id}.jpg"));
    if out.exists() {
        return Ok(Some(out.to_string_lossy().into_owned()));
    }

    let bytes = match format {
        BookFormat::Cbz | BookFormat::Zip => read_zip_image(source, false)?,
        // CBT / CB7 / CBR 走同一套页面解压逻辑，取第一页当封面
        BookFormat::Cbt | BookFormat::Cb7 | BookFormat::Cbr => {
            crate::comic::first_image_bytes(source, format, cache_dir, book_id).unwrap_or(None)
        }
        BookFormat::Epub => read_zip_image(source, true)?,
        BookFormat::Folder => read_folder_image(source)?,
        // FB2 / DOCX 内嵌图片；MOBI 家族用首图，纯文字书退回占位
        BookFormat::Fb2 => crate::fb2::cover_bytes(source)?,
        BookFormat::Docx => crate::docx::cover_bytes(source)?,
        BookFormat::Mobi | BookFormat::Azw3 => {
            crate::mobi::first_image_bytes(source).unwrap_or(None)
        }
        _ => None,
    };

    let Some(bytes) = bytes else {
        return Ok(None);
    };

    let img = image::load_from_memory(&bytes)?;
    let thumb = img.thumbnail(THUMB_W, THUMB_H);
    thumb
        .to_rgb8()
        .save_with_format(&out, image::ImageFormat::Jpeg)?;

    Ok(Some(out.to_string_lossy().into_owned()))
}

/// 从 zip 容器里取一张图。
/// `prefer_cover_name = true`（EPUB）时优先匹配文件名含 cover 的条目。
fn read_zip_image(path: &Path, prefer_cover_name: bool) -> Result<Option<Vec<u8>>> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;

    let mut candidates: Vec<(usize, String)> = Vec::new();
    for i in 0..archive.len() {
        let entry = match archive.by_index_raw(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.is_dir() {
            continue;
        }
        // zip 9 的 name() 返回 Result：文件名可能不是合法 UTF-8
        let name = match entry.name() {
            Ok(n) => n.to_string(),
            Err(_) => continue,
        };
        if name.contains("__MACOSX") {
            continue;
        }
        if !util::is_image_path(Path::new(&name)) {
            continue;
        }
        candidates.push((i, name));
    }

    if candidates.is_empty() {
        return Ok(None);
    }

    if prefer_cover_name {
        if let Some(pos) = candidates
            .iter()
            .position(|(_, n)| n.to_lowercase().contains("cover"))
        {
            let target = candidates.remove(pos);
            candidates.insert(0, target);
        }
    }

    candidates.sort_by(|a, b| util::natural_cmp(&a.1, &b.1));

    for (idx, _) in candidates {
        let mut entry = match archive.by_index(idx) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.size() > MAX_ENTRY_BYTES {
            continue;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        if entry.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
            return Ok(Some(buf));
        }
    }

    Ok(None)
}

fn read_folder_image(dir: &Path) -> Result<Option<Vec<u8>>> {
    let mut images: Vec<PathBuf> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.is_file() && util::is_image_path(&path) {
            images.push(path);
        }
    }
    if images.is_empty() {
        return Ok(None);
    }
    images.sort_by(|a, b| {
        util::natural_cmp(
            &a.file_name().unwrap_or_default().to_string_lossy(),
            &b.file_name().unwrap_or_default().to_string_lossy(),
        )
    });

    let first = &images[0];
    if std::fs::metadata(first).map(|m| m.len()).unwrap_or(0) > MAX_ENTRY_BYTES {
        return Ok(None);
    }
    Ok(Some(std::fs::read(first)?))
}
