use crate::error::Result;
use crate::text::TextBook;
use crate::text;
use std::path::Path;

/// 富文本：不是标记语言，只能按 RTF 词法剥控制字。
/// 目标是「读得懂」——段落、换行、制表与中文编码保住，字体表/颜色表/图片组整组丢弃。
pub fn load(path: &Path) -> Result<(TextBook, String)> {
    let raw = std::fs::read(path)?;
    let (text, encoding) = strip(&raw);
    let meta = TextBook {
        encoding: encoding_name(encoding).to_string(),
        total_bytes: text.len(),
        chapters: text::split_chapters(&text),
    };
    Ok((meta, text))
}

/// 码页：RTF 用 \ansicpgN 声明；中文文档基本是 936。
#[derive(Clone, Copy, PartialEq, Eq)]
enum CodePage {
    Utf8,
    Gbk,
    Windows1252,
}

fn decode(bytes: &[u8], page: CodePage) -> String {
    let enc = match page {
        CodePage::Utf8 => encoding_rs::UTF_8,
        CodePage::Gbk => encoding_rs::GBK,
        CodePage::Windows1252 => encoding_rs::WINDOWS_1252,
    };
    let (text, _, _) = enc.decode(bytes);
    text.into_owned()
}

fn encoding_name(page: CodePage) -> &'static str {
    match page {
        CodePage::Utf8 => "utf-8",
        CodePage::Gbk => "gbk",
        CodePage::Windows1252 => "windows-1252",
    }
}

/// 需要整组丢弃的目的地：字体表、颜色表、样式表、文档信息、图片、对象、域。
const SKIPPED_DESTINATIONS: &[&str] = &[
    "fonttbl",
    "colortbl",
    "stylesheet",
    "info",
    "pict",
    "object",
    "fldinst",
    "header",
    "footer",
    "footnote",
    "themedata",
    "datastore",
    "latentstyles",
    "listtable",
    "listoverridetable",
    "rsidtbl",
    "generator",
];

fn strip(raw: &[u8]) -> (String, CodePage) {
    /*
     * 输出分两个通道：普通字节按 `\ansicpg` 指定的码页解码，
     * 而 `\uN` 是真正的 Unicode 码点。混在一起再统一解码会把后者的
     * UTF-8 字节当成码页字节二次解码，所以按事件顺序分段 flush。
     */
    let mut out = String::new();
    let mut pending: Vec<u8> = Vec::with_capacity(raw.len() / 2);
    let mut page = CodePage::Windows1252;
    // 每个组一层：忽略标记 + 剩余要跳过的字符数（\uN 之后跳过替代字符）
    let mut stack: Vec<bool> = vec![false];
    let mut skip_chars = 0usize;
    let mut uc_skip = 1usize;

    let mut i = 0usize;
    let ignoring = |stack: &Vec<bool>| stack.last().copied().unwrap_or(false);

    while i < raw.len() {
        let b = raw[i];

        if skip_chars > 0 {
            skip_chars -= 1;
            i += 1;
            continue;
        }

        match b {
            b'{' => {
                stack.push(ignoring(&stack));
                i += 1;
            }
            b'}' => {
                if stack.len() > 1 {
                    stack.pop();
                }
                i += 1;
            }
            b'\\' => {
                i += 1;
                if i >= raw.len() {
                    break;
                }
                let next = raw[i];
                match next {
                    b'\\' | b'{' | b'}' => {
                        if !ignoring(&stack) {
                            pending.push(next);
                        }
                        i += 1;
                    }
                    b'\'' => {
                        // \'hh：当前码页的一个字节
                        if i + 2 < raw.len() {
                            let hex = &raw[i + 1..i + 3];
                            if let Ok(s) = std::str::from_utf8(hex) {
                                if let Ok(v) = u8::from_str_radix(s, 16) {
                                    if !ignoring(&stack) {
                                        pending.push(v);
                                    }
                                }
                            }
                        }
                        i += 3;
                    }
                    b'*' => {
                        // \* 标记本组是「可忽略目的地」，整组跳过
                        if let Some(last) = stack.last_mut() {
                            *last = true;
                        }
                        i += 1;
                    }
                    _ => {
                        // 控制字：字母串 + 可选数字参数 + 可选一个空格
                        let start = i;
                        while i < raw.len() && raw[i].is_ascii_alphabetic() {
                            i += 1;
                        }
                        let word = std::str::from_utf8(&raw[start..i]).unwrap_or("");
                        let num_start = i;
                        if i < raw.len() && (raw[i] == b'-' || raw[i].is_ascii_digit()) {
                            i += 1;
                            while i < raw.len() && raw[i].is_ascii_digit() {
                                i += 1;
                            }
                        }
                        let param: Option<i32> =
                            std::str::from_utf8(&raw[num_start..i]).ok().and_then(|s| s.parse().ok());
                        if i < raw.len() && raw[i] == b' ' {
                            i += 1;
                        }

                        if ignoring(&stack) {
                            continue;
                        }

                        match word {
                            "par" | "line" | "sect" | "page" => pending.push(b'\n'),
                            "tab" => pending.push(b'\t'),
                            "ansicpg" => {
                                page = match param {
                                    Some(936) | Some(54936) => CodePage::Gbk,
                                    Some(65001) => CodePage::Utf8,
                                    _ => CodePage::Windows1252,
                                }
                            }
                            "uc" => uc_skip = param.unwrap_or(1).max(0) as usize,
                            "u" => {
                                // \uN：N 是 UTF-16 码元，负数要加 65536
                                let mut code = param.unwrap_or(0);
                                if code < 0 {
                                    code += 65536;
                                }
                                if let Some(ch) = char::from_u32(code as u32) {
                                    flush(&mut out, &mut pending, page);
                                    out.push(ch);
                                }
                                skip_chars = uc_skip;
                            }
                            // \b0 \i0 这类开关与其余控制字对纯文本无意义
                            _ => {
                                if SKIPPED_DESTINATIONS.contains(&word) {
                                    if let Some(last) = stack.last_mut() {
                                        *last = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            b'\r' | b'\n' => {
                i += 1;
            }
            _ => {
                if !ignoring(&stack) {
                    pending.push(b);
                }
                i += 1;
            }
        }
    }

    flush(&mut out, &mut pending, page);
    (out, page)
}

/// 把累积的码页字节解码进字符串（码页以当前 \ansicpg 为准）。
fn flush(out: &mut String, pending: &mut Vec<u8>, page: CodePage) {
    if pending.is_empty() {
        return;
    }
    out.push_str(&decode(pending, page));
    pending.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_control_words_and_keeps_paragraphs() {
        let rtf = br"{\rtf1\ansi\ansicpg1252{\fonttbl{\f0 Arial;}}\f0 Hello\par World\tab end\par}";
        let (text, _) = strip(rtf);
        assert!(text.contains("Hello\nWorld\tend"), "got: {text:?}");
        assert!(!text.contains("Arial"), "字体表应整组丢弃");
    }

    #[test]
    fn decodes_gbk_bytes() {
        // 「中文」的 GBK 编码
        let rtf = b"{\\rtf1\\ansi\\ansicpg936 \\'d6\\'d0\\'ce\\'c4\\par}";
        let (text, _) = strip(rtf);
        assert_eq!(text.trim(), "中文");
    }

    #[test]
    fn handles_unicode_control_word() {
        let rtf = br"{\rtf1 \u20013?\u25991?\par}";
        let (text, _) = strip(rtf);
        assert_eq!(text.trim(), "中文");
    }
}
