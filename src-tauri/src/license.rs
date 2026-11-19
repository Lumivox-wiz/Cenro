//! 随二进制分发的许可文本。
//!
//! 为什么光有 `bundle.resources` 不够：那条只对安装包（NSIS / MSI）生效。
//! 免安装的裸 exe 与 Android APK 都没有「安装目录」，拿不到独立的资源文件；
//! 而 unrar-rs 的许可明确要求「A binary distribution must include this file」——
//! 恰恰 portable 和 APK 才是最典型的二进制分发形态。
//!
//! 编进二进制后三种形态同时满足，顺带给关于页一个可读入口：
//! 用户不用去翻安装目录找 txt。

use serde::Serialize;

/// 项目自身的许可：GPL-3.0 **原文**。
///
/// 引用仓库根目录那一份，避免出现两份互相漂移的副本。
/// 原文不带版权人与「or later」——那份声明放在下面的展示名与 README 里：
/// LICENSE 一旦加上自定义前导，GitHub 的识别器就判不出许可证了（踩过）。
const PROJECT: &str = include_str!("../../LICENSE");
/// unrar-rs（CBR 解压）：Apache-2.0 + UnRAR 附加条款
const UNRAR_RS: &str = include_str!("../resources/licenses/unrar-rs-LICENSE.txt");

#[derive(Serialize)]
pub struct LicenseText {
    /// 展示用名称，带上许可标识，用户一眼知道自己在看什么
    pub name: &'static str,
    pub body: &'static str,
}

/// 关于页「开源许可」入口的数据源，按展示顺序返回。
#[tauri::command]
pub fn license_texts() -> Vec<LicenseText> {
    vec![
        LicenseText {
            name: "岑序 · GNU GPL v3.0 or later · © 2026 Lumivox",
            body: PROJECT,
        },
        LicenseText {
            name: "unrar-rs · Apache-2.0 + UnRAR 附加条款",
            body: UNRAR_RS,
        },
    ]
}
