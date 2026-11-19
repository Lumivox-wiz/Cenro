use crate::error::{AppError, Result};
use crate::text::TextBook;
use crate::text;
use base64::Engine;
use std::path::Path;

/// .mht / .mhtml：把网页连同资源打成一个 MIME 包（IE「另存为单个文件」的产物）。
/// 只取第一个 text/html 部分，转纯文本阅读——图片等资源与文字阅读无关。
pub fn load(path: &Path) -> Result<(TextBook, String)> {
    let raw = std::fs::read(path)?;
    let html = extract_html(&raw)?;
    let text = crate::mobi::html_to_text(&html);
    let meta = TextBook {
        encoding: "utf-8".into(),
        total_bytes: text.len(),
        chapters: text::split_chapters(&text),
    };
    Ok((meta, text))
}

fn extract_html(raw: &[u8]) -> Result<String> {
    // 头部是 ASCII，正文可能是任意字节：按行的 Latin-1 视图切，保留原文偏移
    let head_end = find(raw, b"\r\n\r\n")
        .map(|i| i + 4)
        .or_else(|| find(raw, b"\n\n").map(|i| i + 2))
        .ok_or_else(|| AppError::Other("MHTML 缺少头部".into()))?;

    let head = String::from_utf8_lossy(&raw[..head_end]);
    let body = &raw[head_end..];

    let boundary = header_value(&head, "boundary")
        .map(|b| b.trim_matches('"').to_string())
        .ok_or_else(|| AppError::Other("MHTML 缺少分段边界".into()))?;

    let delim = format!("--{boundary}");
    let bytes = body;
    let mut pos = 0usize;

    while let Some(idx) = find(&bytes[pos..], delim.as_bytes()) {
        let start = pos + idx + delim.len();
        // 段结束标记是 "--boundary--"
        if bytes.get(start..start + 2) == Some(b"--") {
            break;
        }
        // 跳过边界后的换行
        let mut part_start = start;
        while matches!(bytes.get(part_start), Some(b'\r') | Some(b'\n')) {
            part_start += 1;
        }
        let next = find(&bytes[part_start..], delim.as_bytes())
            .map(|i| part_start + i)
            .unwrap_or(bytes.len());
        let part = &bytes[part_start..next];

        if let Some(html) = part_html(part) {
            return Ok(html);
        }
        pos = next;
    }

    Err(AppError::Other("MHTML 里没有网页内容".into()))
}

/// 一个 MIME 段：头部 + 空行 + 正文。命中 text/html 就解码返回。
fn part_html(part: &[u8]) -> Option<String> {
    let split = find(part, b"\r\n\r\n")
        .map(|i| (i, i + 4))
        .or_else(|| find(part, b"\n\n").map(|i| (i, i + 2)))?;
    let head = String::from_utf8_lossy(&part[..split.0]).to_ascii_lowercase();
    let payload = &part[split.1..];

    let ctype = head
        .lines()
        .find(|l| l.starts_with("content-type:"))
        .unwrap_or("");
    if !ctype.contains("text/html") {
        return None;
    }

    let encoding = head
        .lines()
        .find(|l| l.starts_with("content-transfer-encoding:"))
        .unwrap_or("")
        .to_string();

    let bytes = if encoding.contains("base64") {
        let compact: String = String::from_utf8_lossy(payload)
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        base64::engine::general_purpose::STANDARD
            .decode(compact)
            .unwrap_or_default()
    } else if encoding.contains("quoted-printable") {
        decode_qp(payload)
    } else {
        payload.to_vec()
    };

    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// quoted-printable：`=XX` 是字节，`=\r\n` 是软换行（直接删掉）。
fn decode_qp(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] != b'=' {
            out.push(input[i]);
            i += 1;
            continue;
        }
        match input.get(i + 1) {
            Some(b'\r') | Some(b'\n') => {
                i += 1;
                while matches!(input.get(i), Some(b'\r') | Some(b'\n')) {
                    i += 1;
                }
            }
            Some(&hi) => {
                let lo = input.get(i + 2).copied().unwrap_or(b'0');
                let hex = [hi, lo];
                match u8::from_str_radix(&String::from_utf8_lossy(&hex), 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(b'=');
                        i += 1;
                    }
                }
            }
            None => {
                out.push(b'=');
                i += 1;
            }
        }
    }
    out
}

fn header_value(head: &str, key: &str) -> Option<String> {
    for line in head.lines() {
        let lower = line.to_ascii_lowercase();
        if !lower.contains(key) {
            continue;
        }
        if let Some(idx) = lower.find(&format!("{key}=")) {
            let value = &line[idx + key.len() + 1..];
            return Some(value.trim_end_matches([';', ' ', '\r']).to_string());
        }
    }
    None
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_html_part_and_strips_tags() {
        let mht = concat!(
            "MIME-Version: 1.0\r\n",
            "Content-Type: multipart/related; boundary=\"----=_NextPart_01\"\r\n",
            "\r\n",
            "------=_NextPart_01\r\n",
            "Content-Type: image/png\r\n",
            "Content-Transfer-Encoding: base64\r\n",
            "\r\n",
            "iVBORw0KGgo=\r\n",
            "------=_NextPart_01\r\n",
            "Content-Type: text/html; charset=\"utf-8\"\r\n",
            "Content-Transfer-Encoding: quoted-printable\r\n",
            "\r\n",
            "<html><body><p>=E7=AC=AC=E4=B8=80=E7=AB=A0</p></body></html>\r\n",
            "------=_NextPart_01--\r\n",
        );
        let dir = std::env::temp_dir().join("reader-mhtml");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("page.mhtml");
        std::fs::write(&path, mht).unwrap();

        let (_, text) = load(&path).unwrap();
        assert!(text.contains("第一章"), "got: {text:?}");
    }
}
