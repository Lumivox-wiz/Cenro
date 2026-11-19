**把小说、漫画、PDF 收进同一个书架的本机阅读器。** 不联网、不要账号、不推书——书是你的文件，阅读记录是本机的一个 SQLite 文件。

## 下载哪个

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows 安装版 | `Cenro_1.0.0_x64-setup.exe` | 装到当前用户目录，不需要管理员 |
| Windows 免安装 | `Cenro-1.0.0-win-x64-portable.exe` | 双击即用 |
| Android | `Cenro-1.0.0-android-arm64.apk` | 需要 8.0+，只含 arm64-v8a |

Windows 需要 WebView2：Win11 自带，Win10 缺失时装一次 Evergreen Runtime。
若打开后黑屏或画面错乱（少数 Intel 核显、远程桌面、虚拟机会遇到），
下载 `Cenro-1.0.0-compat-mode.bat` 放到 exe 同目录，双击它启动即可。

## 这一版有什么

- **12 种格式一个书架**：EPUB / MOBI / AZW3 / PDF / CBZ 漫画 / TXT / MD / DOCX / XLSX / OFD …
- **PDF 能划线与批注**：文字版 PDF 可像网页一样选字，缩放、切单双页都不画偏
- **标注可带走**：导出 Markdown / CSV / JSON，JSON 能导回，换台机器接着读
- **书内搜索到文字版 PDF**：被排版拆开的字、全角数字都能搜到
- **书架标签**：与格式分类正交、可叠加筛选；多选可批量导出到文件夹
- 脚注就地弹窗、自定义中英文字体、隐私书架、WebDAV 备份

完整的能读什么、数据放在哪、怎么从源码构建，见仓库 README；逐版本变更见 CHANGELOG。

源码同步自 [GitHub](https://github.com/Lumivox-wiz/Cenro)，本仓库为国内镜像。
