use crate::error::{AppError, Result};
use roxmltree::Document;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

const DC_NS: &str = "http://purl.org/dc/elements/1.1/";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpubChapter {
    /// zip 内的完整路径，已经是规范化后的形式
    pub href: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpubMeta {
    pub title: String,
    pub author: Option<String>,
    pub chapters: Vec<EpubChapter>,
}

fn read_text(archive: &mut ZipArchive<File>, name: &str) -> Result<String> {
    let mut entry = archive.by_name(name)?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf)?;
    let (text, _) = crate::util::decode_text(&buf);
    Ok(text)
}

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_string(),
        None => String::new(),
    }
}

fn strip_fragment(href: &str) -> &str {
    match href.find('#') {
        Some(i) => &href[..i],
        None => href,
    }
}

/// 把相对 href 拼到基准目录上，并消掉 ./ 与 ../
fn join_path(base_dir: &str, href: &str) -> String {
    let mut parts: Vec<&str> = base_dir.split('/').filter(|s| !s.is_empty()).collect();
    for segment in href.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

pub fn open(path: &Path) -> Result<EpubMeta> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;

    // 1. container.xml → 找到 OPF 路径
    let container = read_text(&mut archive, "META-INF/container.xml")?;
    let container_doc =
        Document::parse(&container).map_err(|e| AppError::Parse(format!("container.xml: {e}")))?;
    let rootfile = container_doc
        .descendants()
        .find(|n| n.has_tag_name("rootfile"))
        .and_then(|n| n.attribute("full-path"))
        .ok_or_else(|| AppError::Parse("container.xml 里没有 rootfile".into()))?
        .to_string();

    // 2. 解析 OPF
    let opf_text = read_text(&mut archive, &rootfile)?;
    let opf = Document::parse(&opf_text).map_err(|e| AppError::Parse(format!("OPF: {e}")))?;
    let opf_dir = parent_dir(&rootfile);

    let mut title = String::new();
    let mut author: Option<String> = None;
    for node in opf.descendants() {
        if node.has_tag_name((DC_NS, "title")) && title.is_empty() {
            title = node.text().unwrap_or("").trim().to_string();
        } else if node.has_tag_name((DC_NS, "creator")) && author.is_none() {
            author = node
                .text()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
        }
    }

    // manifest: id → (zip 路径, media-type)
    let mut manifest: HashMap<String, (String, String)> = HashMap::new();
    let mut nav_href: Option<String> = None;

    for item in opf.descendants().filter(|n| n.has_tag_name("item")) {
        let (Some(id), Some(href)) = (item.attribute("id"), item.attribute("href")) else {
            continue;
        };
        let media_type = item.attribute("media-type").unwrap_or("").to_string();
        let zip_path = join_path(&opf_dir, strip_fragment(href));

        if item
            .attribute("properties")
            .map(|p| p.split_whitespace().any(|t| t == "nav"))
            .unwrap_or(false)
        {
            nav_href = Some(zip_path.clone());
        }

        manifest.insert(id.to_string(), (zip_path, media_type));
    }

    // spine: 阅读顺序
    let mut spine: Vec<String> = Vec::new();
    for itemref in opf.descendants().filter(|n| n.has_tag_name("itemref")) {
        let Some(idref) = itemref.attribute("idref") else {
            continue;
        };
        let Some((zip_path, media_type)) = manifest.get(idref) else {
            continue;
        };
        if media_type.contains("xhtml") || media_type.contains("html") {
            spine.push(zip_path.clone());
        }
    }

    if spine.is_empty() {
        return Err(AppError::Parse("EPUB 的 spine 为空".into()));
    }

    // 3. nav 文档取章节标题
    let mut titles: HashMap<String, String> = HashMap::new();
    if let Some(nav) = nav_href {
        if let Ok(nav_text) = read_text(&mut archive, &nav) {
            if let Ok(nav_doc) = Document::parse(&nav_text) {
                let nav_dir = parent_dir(&nav);
                for a in nav_doc.descendants().filter(|n| n.has_tag_name("a")) {
                    let (Some(href), Some(label)) = (a.attribute("href"), a.text()) else {
                        continue;
                    };
                    let label = label.trim();
                    if label.is_empty() {
                        continue;
                    }
                    let key = join_path(&nav_dir, strip_fragment(href));
                    titles.entry(key).or_insert_with(|| label.to_string());
                }
            }
        }
    }

    let chapters = spine
        .into_iter()
        .enumerate()
        .map(|(i, href)| {
            let fallback = format!("第 {} 节", i + 1);
            let title = titles.get(&href).cloned().unwrap_or(fallback);
            EpubChapter { href, title }
        })
        .collect::<Vec<_>>();

    if title.is_empty() {
        title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未命名")
            .to_string();
    }

    Ok(EpubMeta {
        title,
        author,
        chapters,
    })
}

/// 把 zip 内的资源（图片、字体等）按需解压到缓存并返回路径。
/// 章节正文里的 <img src> 由前端重写到这个路径。
pub fn resource(
    path: &Path,
    href: &str,
    cache_root: &Path,
    book_id: &str,
) -> Result<std::path::PathBuf> {
    if href.contains("..") {
        return Err(AppError::Other("非法资源路径".into()));
    }

    let safe_name = href.replace(['/', '\\'], "__");
    let dir = cache_root.join(book_id);
    std::fs::create_dir_all(&dir)?;
    let out = dir.join(&safe_name);
    if out.is_file() {
        return Ok(out);
    }

    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;

    // 部分 EPUB 的 href 做过 URL 编码，先按原名探测，再解 %20 重试
    let name = if archive.by_name(href).is_ok() {
        href.to_string()
    } else {
        href.replace("%20", " ")
    };
    let mut entry = archive.by_name(&name)?;

    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf)?;
    std::fs::write(&out, &buf)?;
    Ok(out)
}

/// 读取单个章节的原始 XHTML。清理交给前端（需要按 DOM 语义移除脚本与事件属性）。
pub fn chapter(path: &Path, href: &str) -> Result<String> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    read_text(&mut archive, href)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn build_epub(path: &Path) {
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();

        zip.start_file("mimetype", opts).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();

        zip.start_file("META-INF/container.xml", opts).unwrap();
        zip.write_all(
            r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#.as_bytes(),
        )
        .unwrap();

        zip.start_file("OEBPS/content.opf", opts).unwrap();
        zip.write_all(
            r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试书名</dc:title><dc:creator>作者甲</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>"#.as_bytes(),
        )
        .unwrap();

        zip.start_file("OEBPS/nav.xhtml", opts).unwrap();
        zip.write_all(
            r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>
  <li><a href="text/c1.xhtml">第一章 起</a></li>
  <li><a href="text/c2.xhtml#top">第二章 承</a></li>
</ol></nav></body></html>"#.as_bytes(),
        )
        .unwrap();

        for name in ["OEBPS/text/c1.xhtml", "OEBPS/text/c2.xhtml"] {
            zip.start_file(name, opts).unwrap();
            zip.write_all(b"<html><body><p>content</p></body></html>")
                .unwrap();
        }

        zip.finish().unwrap();
    }

    #[test]
    fn parses_spine_and_nav_titles() {
        let dir = std::env::temp_dir().join("reader-epub-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.epub");
        build_epub(&path);

        let meta = open(&path).unwrap();
        assert_eq!(meta.title, "测试书名");
        assert_eq!(meta.author.as_deref(), Some("作者甲"));
        assert_eq!(meta.chapters.len(), 2);
        assert_eq!(meta.chapters[0].href, "OEBPS/text/c1.xhtml");
        assert_eq!(meta.chapters[0].title, "第一章 起");
        // 带 fragment 的 href 应能匹配到标题
        assert_eq!(meta.chapters[1].title, "第二章 承");

        let html = chapter(&path, &meta.chapters[0].href).unwrap();
        assert!(html.contains("<p>content</p>"));
    }

    #[test]
    fn join_path_normalizes() {
        assert_eq!(join_path("OEBPS", "text/a.xhtml"), "OEBPS/text/a.xhtml");
        assert_eq!(join_path("OEBPS", "../a.xhtml"), "a.xhtml");
        assert_eq!(join_path("", "a.xhtml"), "a.xhtml");
    }
}
