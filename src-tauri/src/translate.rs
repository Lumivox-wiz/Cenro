//! 译文：把一批文本发给「OpenAI 兼容」的本地服务，按行取回。
//!
//! 为什么走 Rust 而不是前端 fetch：CSP 的 `connect-src` 只放行 `self` 与 ipc，
//! 页面里直接连 `127.0.0.1:5001` 会被拦掉；改 CSP 等于给整个前端开一个任意出网的口子。
//! 走 reqwest 还有个好处——安卓与桌面用的是同一份实现（依赖里已按平台分好 TLS）。
//!
//! 为什么默认本地而不是云：这是一款「不联网」的阅读器。默认端点指向本机常见的
//! 推理服务（koboldcpp / Ollama / LM Studio 都兼容 OpenAI 的 chat/completions），
//! 用户想接云端自己填端点，但默认不替他做决定。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};

/// 单次请求最多塞多少行。7B 级模型一次给太多行会开始「合并同类项」，
/// 20 行是实测里还能保持一一对应的上限。
const CHUNK: usize = 20;

#[derive(Debug, Clone, Deserialize)]
pub struct TranslateConfig {
    /// 完整的 chat/completions 地址，例如 http://127.0.0.1:5001/v1/chat/completions
    pub endpoint: String,
    /// 模型名。本地服务常忽略这个字段，但 OpenAI 兼容协议要求带上
    #[serde(default)]
    pub model: String,
    /// 目标语言的中文描述，直接写进提示词（「简体中文」「英语」）
    pub target: String,
    /// 可选 Bearer
    #[serde(default)]
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct TranslateOutcome {
    /// 与输入等长；某一行为空说明那行模型没给出来，前端保留原文即可
    pub texts: Vec<String>,
    /// 分几批发出（排查慢的原因时有用）
    pub batches: usize,
}

pub fn translate(cfg: &TranslateConfig, texts: &[String]) -> Result<TranslateOutcome> {
    if texts.is_empty() {
        return Ok(TranslateOutcome {
            texts: Vec::new(),
            batches: 0,
        });
    }
    if cfg.endpoint.trim().is_empty() {
        return Err(AppError::Other(
            "没有配置翻译服务：请在设置里填本地推理服务的地址".into(),
        ));
    }

    let mut out = Vec::with_capacity(texts.len());
    let mut batches = 0;

    for chunk in texts.chunks(CHUNK) {
        batches += 1;
        let prompt = build_prompt(chunk, &cfg.target);
        let raw = post(cfg, &prompt)?;
        let mut lines = parse_lines(&raw, chunk.len());
        // 数量对不上时按「缺的留空」，前端会退回原文——宁可不译，不要错位
        lines.resize(chunk.len(), String::new());
        out.extend(lines);
    }

    Ok(TranslateOutcome {
        texts: out,
        batches,
    })
}

/// 提示词要点：**只输出 JSON 数组**、与输入等长、不要解释。
/// 7B 模型最容易犯的错是擅自合并短句或补一句「以下是翻译」，用 JSON 数组能同时挡住这两种。
fn build_prompt(texts: &[String], target: &str) -> String {
    let body = texts
        .iter()
        .map(|t| json!(t).to_string())
        .collect::<Vec<_>>()
        .join(",\n");
    format!(
        "把下面 JSON 数组里的每一条翻译成{target}，保持条数、顺序完全一致。\n\
         只输出一个 JSON 字符串数组，不要任何解释、不要代码块标记。\n\
         这些是漫画气泡里的短句，译文要口语、简短。\n\n\
         [{body}]"
    )
}

fn post(cfg: &TranslateConfig, prompt: &str) -> Result<String> {
    let body = json!({
        "model": if cfg.model.trim().is_empty() { "local" } else { cfg.model.trim() },
        "messages": [{ "role": "user", "content": prompt }],
        "temperature": 0.2,
        "stream": false,
    });

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| AppError::Other(format!("HTTP 初始化失败：{e}")))?;

    // 不开 reqwest 的 `json` 特性（会多拉一套编解码），自己序列化 + 自声明 Content-Type
    let mut req = client
        .post(cfg.endpoint.trim())
        .header("Content-Type", "application/json; charset=utf-8")
        .body(serde_json::to_vec(&body)?);
    if !cfg.api_key.trim().is_empty() {
        req = req.bearer_auth(cfg.api_key.trim());
    }

    let resp = req
        .send()
        .map_err(|e| AppError::Other(format!("连不上翻译服务（{}）：{e}", cfg.endpoint)))?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "翻译服务返回 {}",
            resp.status().as_u16()
        )));
    }

    let body = resp
        .text()
        .map_err(|e| AppError::Other(format!("读取响应失败：{e}")))?;
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppError::Other(format!("翻译服务返回的不是 JSON：{e}")))?;

    // OpenAI 兼容：choices[0].message.content；少数实现把 content 拆成数组
    let content = v
        .pointer("/choices/0/message/content")
        .map(|c| match c {
            Value::String(s) => s.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        })
        .filter(|s| !s.trim().is_empty())
        // 兜底：有的服务只回 completion
        .or_else(|| {
            v.get("completion")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| AppError::Other("翻译服务的返回里没有文本".into()))?;

    Ok(content)
}

/// 从模型输出里抠出数组。先按 JSON 解析，失败再退回「按行切」。
///
/// 两道兜底不是为了宽容，是因为 7B 模型经常在 JSON 外面裹一层 ```json。
fn parse_lines(raw: &str, want: usize) -> Vec<String> {
    let trimmed = raw.trim();
    let stripped = trimmed
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(stripped) {
        let mut out = items
            .into_iter()
            .map(|v| match v {
                Value::String(s) => s,
                other => other.to_string(),
            })
            .collect::<Vec<_>>();
        if out.len() >= want {
            out.truncate(want);
            return out;
        }
    }

    // 退化路径：一行一条，去掉「1. 」这类序号
    raw.lines()
        .map(|l| {
            let l = l.trim();
            let l = l.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == '、');
            l.trim().trim_matches('"').to_string()
        })
        .filter(|l| !l.is_empty())
        .take(want)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_json_array() {
        let got = parse_lines(r#"["你好","再见"]"#, 2);
        assert_eq!(got, vec!["你好", "再见"]);
    }

    #[test]
    fn parses_json_in_code_fence() {
        let got = parse_lines("```json\n[\"a\",\"b\"]\n```", 2);
        assert_eq!(got, vec!["a", "b"]);
    }

    #[test]
    fn falls_back_to_lines_with_numbering() {
        let got = parse_lines("1. 你好\n2. 再见", 2);
        assert_eq!(got, vec!["你好", "再见"]);
    }

    #[test]
    fn truncates_extra_items() {
        let got = parse_lines(r#"["a","b","c"]"#, 2);
        assert_eq!(got, vec!["a", "b"]);
    }

    #[test]
    fn rejects_empty_endpoint() {
        let cfg = TranslateConfig {
            endpoint: "  ".into(),
            model: String::new(),
            target: "简体中文".into(),
            api_key: String::new(),
        };
        assert!(translate(&cfg, &["hi".into()]).is_err());
    }
}
