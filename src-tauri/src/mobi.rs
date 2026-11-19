//! MOBI / PalmDOC 解析。
//!
//! 结构：PDB 头 → 记录偏移表 → 记录 0（PalmDOC 头〔+ MOBI 头 + EXTH〕）
//! → 记录 1..N 是正文分片。分片按 PalmDOC LZ77 解压后拼接，再按 text_length 截断。
//! 正文本身是 HTML 片段，需要转成纯文本才能交给 TXT 阅读器渲染。
//!
//! 支持范围：未加密；压缩方式「不压缩 / PalmDOC / HUFF-CDIC」全部自研解码。
//! HUFF 的字典构造见 `mobi_huff`。带 DRM 的文件明确报错，而不是给出乱码。

use crate::error::{AppError, Result};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 一个 8KB 以上的分片可能被拆成多条记录，PalmDOC 头里的 record size 只作参考。
const PALMDOC_HEADER_LEN: usize = 16;
const MOBI_MAGIC: &[u8; 4] = b"MOBI";
const EXTH_MAGIC: &[u8; 4] = b"EXTH";

pub struct MobiText {
    /// 用于界面展示的编码名，与 TXT 保持同一套说法
    pub encoding: &'static str,
    pub title: Option<String>,
    pub author: Option<String>,
    pub text: String,
}

pub fn load(path: &Path) -> Result<MobiText> {
    load_bytes(&std::fs::read(path)?)
}

fn load_bytes(data: &[u8]) -> Result<MobiText> {
    parse(data)
}

/// 按记录下标取一段字节，切片范围由偏移表决定。
fn record_slice<'a>(data: &'a [u8], offsets: &[usize], index: usize) -> Result<&'a [u8]> {
    let start = *offsets.get(index).ok_or_else(bad)?;
    let end = *offsets.get(index + 1).ok_or_else(bad)?;
    data.get(start..end).ok_or_else(bad)
}

fn bad() -> AppError {
    AppError::Other("文件内容无法识别，可能不是有效的 MOBI 文件".into())
}

fn u16_at(data: &[u8], offset: usize) -> Result<u16> {
    let slice = data.get(offset..offset + 2).ok_or_else(bad)?;
    Ok(u16::from_be_bytes([slice[0], slice[1]]))
}

fn u32_at(data: &[u8], offset: usize) -> Result<u32> {
    let slice = data.get(offset..offset + 4).ok_or_else(bad)?;
    Ok(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn parse(data: &[u8]) -> Result<MobiText> {
    // PDB 头固定 78 字节，最后两字节是记录数
    if data.len() < 78 {
        return Err(bad());
    }
    let record_count = u16_at(data, 76)? as usize;
    if record_count < 2 {
        return Err(bad());
    }

    // 记录偏移表：每条 8 字节（偏移 4 + 属性 1 + 唯一 ID 3）
    let mut offsets = Vec::with_capacity(record_count + 1);
    for i in 0..record_count {
        offsets.push(u32_at(data, 78 + i * 8)? as usize);
    }
    offsets.push(data.len());

    let record_0 = data
        .get(offsets[0]..*offsets.get(1).ok_or_else(bad)?)
        .ok_or_else(bad)?;
    if record_0.len() < PALMDOC_HEADER_LEN {
        return Err(bad());
    }

    let compression = u16_at(record_0, 0)?;
    let text_length = u32_at(record_0, 4)? as usize;
    let text_records = u16_at(record_0, 8)? as usize;
    // 每条记录解压后应有的正文长度（通常 4096）
    let record_size = u16_at(record_0, 10)? as usize;
    let encryption = u16_at(record_0, 12)?;

    if encryption != 0 {
        return Err(AppError::Other(
            "这本书带有 DRM 保护，无法打开".into(),
        ));
    }
    if !matches!(compression, 1 | 2 | 17480) {
        return Err(bad());
    }

    // ---- MOBI 头（纯 PalmDOC 没有这一段）----
    let mut code_page = 0u32;
    let mut title: Option<String> = None;
    let mut author: Option<String> = None;
    let mut huff_decoder: Option<crate::mobi_huff::HuffDecoder> = None;

    let has_mobi = record_0.len() >= PALMDOC_HEADER_LEN + 12
        && record_0[PALMDOC_HEADER_LEN..PALMDOC_HEADER_LEN + 4] == *MOBI_MAGIC;

    if has_mobi {
        let mo = PALMDOC_HEADER_LEN;
        let header_len = u32_at(record_0, mo + 4)? as usize;
        code_page = u32_at(record_0, mo + 12)?;

        // 完整书名：MOBI 头的 0x44/0x48，偏移相对记录 0 起点
        if let (Some(off), Some(len)) = (
            u32_at(record_0, mo + 0x44).ok(),
            u32_at(record_0, mo + 0x48).ok(),
        ) {
            let start = off as usize;
            let end = start.saturating_add(len as usize);
            if let Some(bytes) = record_0.get(start..end) {
                let name = decode(bytes, code_page).0.trim().to_string();
                if !name.is_empty() {
                    title = Some(name);
                }
            }
        }

        // HUFF/CDIC：0x60 是 HUFF 记录下标，0x64 是记录数（含 HUFF 本身）
        if compression == 17480 {
            let huff_index = u32_at(record_0, mo + 0x60)? as usize;
            let huff_count = u32_at(record_0, mo + 0x64)? as usize;
            if huff_count < 2 {
                return Err(AppError::Other("HUFF 字典记录缺失".into()));
            }
            let huff = record_slice(data, &offsets, huff_index)?;
            let mut cdics: Vec<&[u8]> = Vec::with_capacity(huff_count - 1);
            for i in 1..huff_count {
                cdics.push(record_slice(data, &offsets, huff_index + i)?);
            }
            huff_decoder = Some(crate::mobi_huff::HuffDecoder::new(huff, &cdics)?);
        }

        let _ = header_len;

        // EXTH：紧跟 MOBI 头，取作者等元数据
        let exth_off = mo + header_len;
        if record_0.len() >= exth_off + 12
            && record_0[exth_off..exth_off + 4] == *EXTH_MAGIC
        {
            author = read_exth_author(record_0, exth_off, code_page);
        }
    }

    // ---- 正文：逐条解压后拼接 ----
    /*
     * 每条正文记录解压后应当正好是 record_size 字节（只有最后一条可能不足）。
     *
     * 记录尾部还会追加「额外数据」（索引、多字节重叠等），那部分**未经压缩**。
     * 若不按 record_size 截断，这些原始字节会被当成压缩流继续解码，
     * 产出 `vdex=" align="` 这类乱码 —— 本项目踩过的坑。
     * 按长度截断比解析 extra data flags 更可靠：flags 的位含义有多个版本，
     * 而且这条路径完全不依赖对 flags 的解读。
     */
    let mut raw: Vec<u8> = Vec::with_capacity(text_length.max(record_size));
    let mut remaining = text_length;
    let last = text_records.min(record_count - 1);

    for i in 1..=last {
        if remaining == 0 {
            break;
        }
        let start = *offsets.get(i).ok_or_else(bad)?;
        let end = *offsets.get(i + 1).ok_or_else(bad)?;
        let chunk = data.get(start..end).ok_or_else(bad)?;

        let decoded = match compression {
            2 => decompress_palmdoc(chunk),
            17480 => huff_decoder
                .as_mut()
                .ok_or_else(|| AppError::Other("HUFF 解码器缺失".into()))?
                .decompress(chunk)?,
            _ => chunk.to_vec(),
        };

        let take = decoded.len().min(record_size).min(remaining);
        raw.extend_from_slice(&decoded[..take]);
        remaining -= take;
    }

    let (html, encoding) = decode(&raw, code_page);
    let text = html_to_text(&html);
    if text.trim().is_empty() {
        return Err(bad());
    }

    Ok(MobiText {
        encoding,
        title,
        author,
        text,
    })
}

fn decode(bytes: &[u8], code_page: u32) -> (String, &'static str) {
    if code_page == 65001 {
        // 少数文件声明 UTF-8 但有坏字节，用 lossy 兜住而不是整体失败
        return (String::from_utf8_lossy(bytes).into_owned(), "UTF-8");
    }

    // 纯 PalmDOC 没有编码字段（code_page 为 0），先按 UTF-8 严格校验，
    // 失败再退回 Windows-1252 —— 与 TXT 的探测顺序保持一致。
    if code_page == 0 {
        if let Ok(text) = std::str::from_utf8(bytes) {
            return (text.to_string(), "UTF-8");
        }
    }

    let (text, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
    (text.into_owned(), "Windows-1252")
}

fn read_exth_author(record_0: &[u8], exth_off: usize, code_page: u32) -> Option<String> {
    let count = u32_at(record_0, exth_off + 8).ok()? as usize;
    let mut pos = exth_off + 12;
    let mut authors = Vec::new();

    for _ in 0..count.min(1024) {
        let kind = u32_at(record_0, pos).ok()?;
        let len = u32_at(record_0, pos + 4).ok()? as usize;
        if len < 8 {
            break;
        }
        let body = record_0.get(pos + 8..pos + len)?;
        // 100 = 作者，501/517 是「作者排序」「ASIN 作者」之类，忽略
        if kind == 100 {
            let name = decode(body, code_page).0.trim().to_string();
            if !name.is_empty() {
                authors.push(name);
            }
        }
        pos += len;
    }

    if authors.is_empty() {
        None
    } else {
        Some(authors.join("、"))
    }
}

/// PalmDOC LZ77 解压。
fn decompress_palmdoc(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() * 2);
    let mut i = 0usize;

    while i < input.len() {
        let byte = input[i];
        i += 1;

        match byte {
            // 0x00 是字面量 0
            0x00 => out.push(0),
            // 0x01..=0x08：后面紧跟 N 个原样字节
            0x01..=0x08 => {
                let take = (byte as usize).min(input.len() - i);
                out.extend_from_slice(&input[i..i + take]);
                i += take;
            }
            // 0x09..=0x7f：直接输出
            0x09..=0x7f => out.push(byte),
            // 0x80..=0xbf：2 字节表示「距离 + 长度」，做回溯复制
            0x80..=0xbf => {
                if i >= input.len() {
                    break;
                }
                let next = input[i];
                i += 1;
                let pair = ((byte as u16) << 8) | next as u16;
                let distance = ((pair >> 3) & 0x07ff) as usize;
                let length = (pair & 0x0007) as usize + 3;

                if distance == 0 || distance > out.len() {
                    continue;
                }
                // 允许与正在写入的区域重叠，必须逐字节复制
                let mut pos = out.len() - distance;
                for _ in 0..length {
                    let b = out[pos];
                    out.push(b);
                    pos += 1;
                }
            }
            // 0xc0..=0xff：空格 + 单字节
            _ => {
                out.push(b' ');
                out.push(byte ^ 0x80);
            }
        }
    }

    out
}

/// MOBI 正文是 HTML 片段，转成纯文本后交给 TXT 渲染路径。
/// 判断标签名是否完全等于 name（`head` 不能命中 `header`）
fn tag_name_is(tag: &[u8], name: &[u8]) -> bool {
    if tag.len() < name.len() {
        return false;
    }
    if !tag[..name.len()].eq_ignore_ascii_case(name) {
        return false;
    }
    matches!(
        tag.get(name.len()),
        None | Some(b' ') | Some(b'/') | Some(b'\t') | Some(b'\n') | Some(b'\r')
    )
}

pub(crate) fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut i = 0usize;
    let mut skip_until: Option<&[u8]> = None;

    while i < bytes.len() {
        // 跳过 script / style 的内容
        if let Some(tag) = skip_until {
            if let Some(pos) = find_sub(&bytes[i..], tag) {
                i += pos + tag.len();
                skip_until = None;
                continue;
            }
            break;
        }

        if bytes[i] == b'<' {
            let Some(close) = bytes[i..].iter().position(|&b| b == b'>') else {
                break;
            };
            let tag = &bytes[i + 1..i + close];
            let tag_lower: Vec<u8> = tag.iter().map(|b| b.to_ascii_lowercase()).collect();

            if tag_name_is(&tag_lower, b"script") {
                skip_until = Some(b"</script>");
                i += close + 1;
                continue;
            }
            if tag_name_is(&tag_lower, b"style") {
                skip_until = Some(b"</style>");
                i += close + 1;
                continue;
            }
            /*
             * 整篇 HTML 文件的 <head> 里有 <title>，不跳过会把书名当正文第一行。
             * 只有确实存在闭合标签时才跳，畸形片段不会因此丢掉正文。
             */
            if tag_name_is(&tag_lower, b"head") && find_sub(&bytes[i..], b"</head>").is_some() {
                skip_until = Some(b"</head>");
                i += close + 1;
                continue;
            }
            if tag_name_is(&tag_lower, b"title") {
                skip_until = Some(b"</title>");
                i += close + 1;
                continue;
            }
            if starts_with(&tag_lower, b"br") || starts_with(&tag_lower, b"/p") {
                out.push('\n');
            } else if starts_with(&tag_lower, b"mbp:pagebreak") {
                out.push_str("\n\n");
            } else if starts_with(&tag_lower, b"/h") || starts_with(&tag_lower, b"/div") {
                out.push('\n');
            }

            i += close + 1;
            continue;
        }

        if bytes[i] == b'&' {
            if let Some(semi) = bytes[i..].iter().position(|&b| b == b';').filter(|&n| n <= 10) {
                let entity = &html[i + 1..i + semi];
                if let Some(ch) = decode_entity(entity) {
                    out.push(ch);
                    i += semi + 1;
                    continue;
                }
            }
        }

        // 普通字符：按 UTF-8 边界整段拷贝
        let ch_len = utf8_len(bytes[i]);
        let end = (i + ch_len).min(bytes.len());
        out.push_str(&html[i..end]);
        i = end;
    }

    normalize_blank_lines(&out)
}

fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

fn starts_with(haystack: &[u8], prefix: &[u8]) -> bool {
    haystack.len() >= prefix.len() && &haystack[..prefix.len()] == prefix
}

fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn decode_entity(entity: &str) -> Option<char> {
    Some(match entity {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "mdash" => '—',
        "ldquo" => '“',
        "rdquo" => '”',
        _ => {
            let num = entity.strip_prefix('#')?;
            let code = if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                u32::from_str_radix(hex, 16).ok()?
            } else {
                num.parse::<u32>().ok()?
            };
            char::from_u32(code)?
        }
    })
}

/// 压缩连续空行：MOBI 里 `<p>` 与换行混用，容易产出大片空白。
fn normalize_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = 0usize;

    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
            out.push('\n');
        } else {
            blank = 0;
            out.push_str(trimmed);
            out.push('\n');
        }
    }

    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个最小 PDB：2 条记录（头部 + 正文），不压缩、无 MOBI 头。
    fn minimal_pdb(text: &str) -> Vec<u8> {
        let mut header = vec![0u8; 78];
        header[..4].copy_from_slice(b"TEST");
        header[60..64].copy_from_slice(b"BOOK");
        header[64..68].copy_from_slice(b"MOBI");
        header[76..78].copy_from_slice(&2u16.to_be_bytes());

        let mut record_0 = vec![0u8; PALMDOC_HEADER_LEN];
        record_0[0..2].copy_from_slice(&1u16.to_be_bytes()); // 不压缩
        record_0[4..8].copy_from_slice(&(text.len() as u32).to_be_bytes());
        record_0[8..10].copy_from_slice(&1u16.to_be_bytes()); // 1 条正文记录
        record_0[10..12].copy_from_slice(&4096u16.to_be_bytes());

        let body = text.as_bytes();
        let data_start = 78 + 2 * 8;
        let offset_0 = data_start as u32;
        let offset_1 = offset_0 + record_0.len() as u32;

        let mut out = header;
        let mut info = Vec::new();
        info.extend_from_slice(&offset_0.to_be_bytes());
        info.extend_from_slice(&[0, 0, 0, 0]);
        info.extend_from_slice(&offset_1.to_be_bytes());
        info.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&info);
        out.extend_from_slice(&record_0);
        out.extend_from_slice(body);
        out
    }

    /// 真实 HUFF 样本书（libmobi 的 sample-unicode-huffdic.mobi，compression=17480）。
    /// 样本不进仓库，所以默认忽略，手动指定路径运行：
    /// `READER_HUFF_SAMPLE=<path> cargo test --lib decodes_real_huff_book -- --ignored --nocapture`
    #[test]
    #[ignore = "需要真实 HUFF 样本书：设置 READER_HUFF_SAMPLE"]
    fn decodes_real_huff_book() {
        let Ok(path) = std::env::var("READER_HUFF_SAMPLE") else {
            return;
        };
        let book = load(Path::new(&path)).expect("HUFF 兜底应能解出正文");
        let chars = book.text.chars().count();
        assert!(chars > 500, "正文太短：{chars} 字符");
        let broken = book.text.chars().filter(|c| *c == '\u{FFFD}').count();
        assert_eq!(broken, 0, "解出来含替换字符，说明码表没对上");
        println!("title={:?} author={:?} chars={}", book.title, book.author, chars);
        println!("head={}", book.text.chars().take(80).collect::<String>());
    }

    /// HUFF/CDIC 走兜底分支：路由要正确，且失败时是 Err 不是 panic。
    #[test]
    fn routes_huff_compression_to_fallback() {
        let mut data = minimal_pdb("hello");
        // 记录 0 的第一条偏移在 PDB 头之后；把 compression 改成 HUFF/CDIC
        let first = u32::from_be_bytes(data[78..82].try_into().unwrap()) as usize;
        data[first..first + 2].copy_from_slice(&17480u16.to_be_bytes());
        // 这份样本没有 HUFF 字典记录，应当明确报错而不是崩溃
        assert!(load_bytes(&data).is_err());
    }

    #[test]
    fn parses_uncompressed_pdb() {
        let pdb = minimal_pdb("<p>第一段</p><p>第二段</p>");
        let book = parse(&pdb).unwrap();
        assert_eq!(book.text, "第一段\n第二段");
        // 纯 PalmDOC 没有编码字段，正文是合法 UTF-8，应判为 UTF-8
        assert_eq!(book.encoding, "UTF-8");
    }

    #[test]
    fn decompresses_palmdoc_literals_and_pairs() {
        // 0x41 0x42 字面量；0xC1 = 空格 + 'A'
        let out = decompress_palmdoc(&[0x41, 0x42, 0xc1]);
        assert_eq!(out, b"AB A");

        // 0x80 0x08：(0x8008 >> 3) & 0x7ff = 1，长度 = 0 + 3 = 3
        // 已写入 "abc"，回溯 1 字节、复制 3 次（逐字节、允许重叠）→ "abcccc"
        let out = decompress_palmdoc(&[0x61, 0x62, 0x63, 0x80, 0x08]);
        assert_eq!(out, b"abcccc");
    }

    /// 真实 HTML 文件的完整链路（编码探测 + 去标签 + 解实体）。
    /// 同样不进仓库样本，手动跑：`READER_HTML_SAMPLE=<path> cargo test --lib probe_real_html_file -- --ignored`
    #[test]
    #[ignore = "需要真实 HTML 样本：设置 READER_HTML_SAMPLE"]
    fn probe_real_html_file() {
        let Ok(path) = std::env::var("READER_HTML_SAMPLE") else { return };
        // 走真实链路：先按编码探测解码，再去标签
        let bytes = std::fs::read(&path).unwrap();
        let (html, enc) = crate::util::decode_text(&bytes);
        println!("encoding={enc}");
        let text = html_to_text(&html);
        println!("---\n{text}\n---");
        assert!(!text.contains("&amp;"), "实体没还原");
        assert!(!text.contains("&lt;"), "实体没还原");
    }

    #[test]
    fn html_to_text_strips_tags_and_entities() {
        let html = "<html><head><style>p{color:red}</style></head>\
                    <body><h1>标题</h1><p>正文 &amp; 说明</p><br/>下一行\
                    <span>同段</span></body></html>";
        let text = html_to_text(html);
        assert!(text.starts_with("标题"));
        assert!(text.contains("正文 & 说明"));
        assert!(text.contains("同段"));
        assert!(!text.contains("color:red"));
        assert!(!text.contains('<'));
    }

    /// 构造带 MOBI 头 + EXTH 的样本，验证书名与作者解析。
    fn pdb_with_meta(title: &str, author: &str, body: &str) -> Vec<u8> {
        let name = title.as_bytes();
        let author_bytes = author.as_bytes();

        // EXTH：一条作者记录（type 100）
        let mut exth = Vec::new();
        exth.extend_from_slice(EXTH_MAGIC);
        let rec_len = 8 + author_bytes.len();
        exth.extend_from_slice(&((12 + rec_len) as u32).to_be_bytes());
        exth.extend_from_slice(&1u32.to_be_bytes());
        exth.extend_from_slice(&100u32.to_be_bytes());
        exth.extend_from_slice(&(rec_len as u32).to_be_bytes());
        exth.extend_from_slice(author_bytes);

        let mut mobi_header = vec![0u8; 232];
        mobi_header[0..4].copy_from_slice(MOBI_MAGIC);
        mobi_header[4..8].copy_from_slice(&232u32.to_be_bytes());
        mobi_header[8..12].copy_from_slice(&2u32.to_be_bytes());
        mobi_header[12..16].copy_from_slice(&65001u32.to_be_bytes());

        let name_offset = PALMDOC_HEADER_LEN + mobi_header.len() + exth.len();
        mobi_header[0x44..0x48].copy_from_slice(&(name_offset as u32).to_be_bytes());
        mobi_header[0x48..0x4c].copy_from_slice(&(name.len() as u32).to_be_bytes());
        mobi_header[0x70..0x74].copy_from_slice(&0x40u32.to_be_bytes()); // 有 EXTH

        let mut record_0 = vec![0u8; PALMDOC_HEADER_LEN];
        record_0[0..2].copy_from_slice(&1u16.to_be_bytes());
        record_0[4..8].copy_from_slice(&(body.len() as u32).to_be_bytes());
        record_0[8..10].copy_from_slice(&1u16.to_be_bytes());
        record_0[10..12].copy_from_slice(&4096u16.to_be_bytes());
        record_0.extend_from_slice(&mobi_header);
        record_0.extend_from_slice(&exth);
        record_0.extend_from_slice(name);
        // 额外数据标志位于记录 0 的 0xF2
        record_0.resize(record_0.len().max(0xf6), 0);

        let mut header = vec![0u8; 78];
        header[60..64].copy_from_slice(b"BOOK");
        header[64..68].copy_from_slice(b"MOBI");
        header[76..78].copy_from_slice(&2u16.to_be_bytes());

        let data_start = 78 + 2 * 8;
        let offset_1 = data_start + record_0.len();

        let mut out = header;
        out.extend_from_slice(&(data_start as u32).to_be_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(offset_1 as u32).to_be_bytes());
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&record_0);
        out.extend_from_slice(body.as_bytes());
        out
    }

    #[test]
    fn reads_title_and_author_from_header() {
        let pdb = pdb_with_meta("合欢宗", "食鹿客", "<p>正文</p>");
        let book = parse(&pdb).unwrap();
        assert_eq!(book.title.as_deref(), Some("合欢宗"));
        assert_eq!(book.author.as_deref(), Some("食鹿客"));
        assert_eq!(book.encoding, "UTF-8");
        assert_eq!(book.text, "正文");
    }

}

// ---------------- 图片型 MOBI（漫画） ----------------

/// 扫描阶段用的轻量探测：只读记录索引与每条的 8 字节魔数，不载入整本文件。
pub struct Probe {
    /// 图片记录数。扫描阶段据此判断这是漫画还是文字书。
    pub image_count: usize,
}

struct Index {
    /// 各记录起始偏移，末尾追加文件长度
    offsets: Vec<usize>,
}

fn read_index(file: &mut File) -> Result<Index> {
    file.seek(SeekFrom::Start(0))?;

    let mut head = [0u8; 78];
    file.read_exact(&mut head)?;
    let count = u16_at(&head, 76)? as usize;
    if count < 2 {
        return Err(bad());
    }

    let mut table = vec![0u8; count * 8];
    file.read_exact(&mut table)?;

    let mut offsets = Vec::with_capacity(count + 1);
    for i in 0..count {
        offsets.push(u32_at(&table, i * 8)? as usize);
    }
    offsets.push(file.metadata()?.len() as usize);

    Ok(Index { offsets })
}

fn image_ext(magic: &[u8]) -> Option<&'static str> {
    if magic.len() >= 3 && magic[..3] == [0xff, 0xd8, 0xff] {
        return Some("jpg");
    }
    if magic.len() >= 8 && magic[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some("png");
    }
    if magic.len() >= 4 && &magic[..4] == b"GIF8" {
        return Some("gif");
    }
    if magic.len() >= 2 && &magic[..2] == b"BM" {
        return Some("bmp");
    }
    None
}

/// 逐条读魔数，收集图片记录的下标（相对于全部记录）。
fn scan_image_records(file: &mut File, offsets: &[usize]) -> Result<Vec<(usize, usize, &'static str)>> {
    let mut out = Vec::new();
    let mut magic = [0u8; 8];

    for i in 1..offsets.len().saturating_sub(1) {
        let start = offsets[i];
        let end = offsets[i + 1];
        if end <= start {
            continue;
        }
        file.seek(SeekFrom::Start(start as u64))?;
        let read = file.read(&mut magic)?;
        if let Some(ext) = image_ext(&magic[..read]) {
            out.push((start, end, ext));
        }
    }
    Ok(out)
}

/// 判断这是不是一本图片型（漫画）MOBI。
pub fn probe(path: &Path) -> Result<Probe> {
    let mut file = File::open(path)?;
    let index = read_index(&mut file)?;
    let images = scan_image_records(&mut file, &index.offsets)?;

    Ok(Probe {
        image_count: images.len(),
    })
}

/// 列出图片型 MOBI 的页名。命名形如 `00001.jpg`，与漫画的页面契约一致。
pub fn list_images(path: &Path) -> Result<Vec<String>> {
    let mut file = File::open(path)?;
    let index = read_index(&mut file)?;
    let images = scan_image_records(&mut file, &index.offsets)?;

    if images.is_empty() {
        return Err(AppError::Other("这本书里没有图片".into()));
    }

    Ok(images
        .iter()
        .enumerate()
        .map(|(i, (_, _, ext))| format!("{:05}.{ext}", i + 1))
        .collect())
}

/// 把第 index 页图片按需落到缓存目录。图片记录本身不压缩，直接切片写出。
pub fn extract_image(
    path: &Path,
    index: usize,
    cache_root: &Path,
    book_id: &str,
) -> Result<std::path::PathBuf> {
    let mut file = File::open(path)?;
    let table = read_index(&mut file)?;
    let images = scan_image_records(&mut file, &table.offsets)?;

    let Some(&(start, end, ext)) = images.get(index) else {
        return Err(AppError::Other(format!("页面不存在：{index}")));
    };

    let dir = cache_root.join(book_id);
    std::fs::create_dir_all(&dir)?;
    let out = dir.join(format!("{index:05}.{ext}"));
    if out.is_file() {
        return Ok(out);
    }

    let mut buf = vec![0u8; end - start];
    file.seek(SeekFrom::Start(start as u64))?;
    file.read_exact(&mut buf)?;
    std::fs::write(&out, &buf)?;
    Ok(out)
}

/// 取第一张图片的原始字节，供封面缩略图使用。
/// 单张上限 24MB，避免把整本扫描图读进内存。
pub fn first_image_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    const MAX_IMAGE_BYTES: usize = 24 * 1024 * 1024;

    let mut file = File::open(path)?;
    let table = read_index(&mut file)?;
    let images = scan_image_records(&mut file, &table.offsets)?;

    let Some(&(start, end, _)) = images.first() else {
        return Ok(None);
    };
    if end <= start || end - start > MAX_IMAGE_BYTES {
        return Ok(None);
    }

    let mut buf = vec![0u8; end - start];
    file.seek(SeekFrom::Start(start as u64))?;
    file.read_exact(&mut buf)?;
    Ok(Some(buf))
}
