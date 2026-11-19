//! HUFF/CDIC 解压（compression = 17480）。
//!
//! Amazon 的 Huffman 压缩：HUFF 记录给两张码表，其后若干条 CDIC 记录给字典条目。
//! 实现参照 mobiunpack 的公开算法，与 Koodo 引擎（`kookit.js:20262`）的写法一致。
//!
//! 为什么不用现成 crate：`mobi` 0.8 的 HUFF 分支在真实样本上会 `max_code - code`
//! 下溢（debug 直接 panic），只能自己写。

use crate::error::{AppError, Result};

/// dict1 的一项：高位字节 → 码长与是否为终端节点
#[derive(Clone, Copy, Default)]
struct Entry {
    /// 终端节点：码长直接给出，不再查 dict2
    terminal: bool,
    code_len: u8,
    /// 该码长下的最大码字，用于反推字典下标
    max_code: u32,
}

pub(crate) struct HuffDecoder {
    dict1: [Entry; 256],
    /// dict2[len] = (min_code, max_code)，下标 0 不用
    dict2: [(u32, u32); 33],
    /// 字典条目：值 + 是否已是明文（未展开的条目递归解压后缓存）
    dictionary: Vec<Option<(Vec<u8>, bool)>>,
}

fn be_u32(data: &[u8], offset: usize) -> Result<u32> {
    let slice = data
        .get(offset..offset + 4)
        .ok_or_else(|| AppError::Other("HUFF 记录被截断".into()))?;
    Ok(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn be_u16(data: &[u8], offset: usize) -> Result<u16> {
    let slice = data
        .get(offset..offset + 2)
        .ok_or_else(|| AppError::Other("CDIC 记录被截断".into()))?;
    Ok(u16::from_be_bytes([slice[0], slice[1]]))
}

impl HuffDecoder {
    /// `huff` 是 HUFF 记录，`cdics` 是其后的 CDIC 记录（顺序不能乱）。
    pub fn new(huff: &[u8], cdics: &[&[u8]]) -> Result<Self> {
        if huff.get(0..4) != Some(b"HUFF") {
            return Err(AppError::Other("HUFF 记录标记不对".into()));
        }
        let off1 = be_u32(huff, 8)? as usize;
        let off2 = be_u32(huff, 12)? as usize;

        let mut dict1 = [Entry::default(); 256];
        for (i, slot) in dict1.iter_mut().enumerate() {
            let x = be_u32(huff, off1 + 4 * i)?;
            *slot = Entry {
                terminal: x & 0x80 != 0,
                code_len: (x & 0x1f) as u8,
                max_code: x >> 8,
            };
        }

        let mut dict2 = [(0u32, 0u32); 33];
        for len in 1..=32usize {
            let min = be_u32(huff, off2 + 8 * len)?;
            let max = be_u32(huff, off2 + 8 * len + 4)?;
            dict2[len] = (min, max);
        }

        let mut dictionary: Vec<Option<(Vec<u8>, bool)>> = Vec::new();
        for cdic in cdics {
            if cdic.get(0..4) != Some(b"CDIC") {
                return Err(AppError::Other("CDIC 记录标记不对".into()));
            }
            let data_start = be_u32(cdic, 4)? as usize;
            let num_entries = be_u32(cdic, 8)? as usize;
            let code_length = be_u32(cdic, 12)? as usize;

            // 每条 CDIC 覆盖 2^code_length 个下标，最后一条可能不满
            let count = (1usize << code_length.min(20)).min(num_entries.saturating_sub(dictionary.len()));
            for i in 0..count {
                let offset = be_u16(cdic, data_start + 2 * i)? as usize;
                let entry_at = data_start + offset;
                let x = be_u16(cdic, entry_at)?;
                let len = (x & 0x7fff) as usize;
                let unpacked = x & 0x8000 != 0;
                let value = cdic
                    .get(entry_at + 2..entry_at + 2 + len)
                    .ok_or_else(|| AppError::Other("CDIC 字典条目越界".into()))?;
                dictionary.push(Some((value.to_vec(), unpacked)));
            }
        }

        if dictionary.is_empty() {
            return Err(AppError::Other("HUFF 字典为空".into()));
        }

        Ok(Self {
            dict1,
            dict2,
            dictionary,
        })
    }

    /// 解压一段正文。字典条目会被就地展开并缓存，重复出现的词组不必再解。
    pub fn decompress(&mut self, data: &[u8]) -> Result<Vec<u8>> {
        let total_bits = data.len() * 8;
        let mut out: Vec<u8> = Vec::with_capacity(data.len() * 3);
        let mut pos = 0usize;

        while pos < total_bits {
            let bits = peek_u32(data, pos);
            let entry = self.dict1[(bits >> 24) as usize];
            let mut code_len = entry.code_len as usize;
            let mut max_code = entry.max_code;

            if !entry.terminal {
                // 码长从 dict1 给出的起点开始增长，直到落入 dict2 的区间
                while code_len < 32 {
                    let (min_code, _) = self.dict2[code_len];
                    if (bits >> (32 - code_len)) >= min_code {
                        break;
                    }
                    code_len += 1;
                }
                max_code = self.dict2[code_len].1;
            }

            // 码长 0 会让循环原地打转，视作损坏
            if code_len == 0 || code_len > 32 {
                return Err(AppError::Other("HUFF 码长非法".into()));
            }

            pos += code_len;
            if pos > total_bits {
                break;
            }

            let code = max_code.wrapping_sub(bits >> (32 - code_len)) as usize;
            // 先把条目取出来：它可能要先递归解压，期间不能再持有 dictionary 的可变借用
            let entry = self
                .dictionary
                .get_mut(code)
                .ok_or_else(|| AppError::Other("HUFF 字典下标越界".into()))?
                .take()
                .ok_or_else(|| AppError::Other("HUFF 字典条目重复引用".into()))?;

            let (slice, ready) = entry;
            let value = if ready {
                slice
            } else {
                // 未展开的条目本身也是 HUFF 流
                self.decompress(&slice)?
            };
            out.extend_from_slice(&value);
            self.dictionary[code] = Some((value, true));
        }

        Ok(out)
    }
}

/// 从 `bit_pos` 起取 32 位，越界部分补 0。
fn peek_u32(data: &[u8], bit_pos: usize) -> u32 {
    let byte = bit_pos / 8;
    let shift = (bit_pos % 8) as u32;

    let mut window: u64 = 0;
    for i in 0..5 {
        let b = data.get(byte + i).copied().unwrap_or(0) as u64;
        window = (window << 8) | b;
    }
    // window 是 40 位；丢掉起始字节里的前 shift 位，取高 32 位
    ((window >> (8 - shift)) & 0xFFFF_FFFF) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_magic() {
        assert!(HuffDecoder::new(b"NOPE", &[]).is_err());
        assert!(HuffDecoder::new(b"HUFF\0\0\0\0\0\0\0\0", &[b"NOPE"]).is_err());
    }

    #[test]
    fn peek_reads_across_byte_boundaries() {
        // 0b1010_1010 0b1100_1100 ... 从第 4 位起应当是 1010_1100_1100...
        let data = [0b1010_1010u8, 0b1100_1100, 0, 0, 0];
        assert_eq!(peek_u32(&data, 0), 0xAACC_0000);
        assert_eq!(peek_u32(&data, 4), 0xACC0_0000);
        // 越界补 0
        assert_eq!(peek_u32(&[0xFF], 0), 0xFF00_0000);
    }
}
