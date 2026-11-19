# 发帖文案

配套 `cenro-poster.png`（方图，含二维码）与 `cenro-banner@2x.png`（横图）。
所有数字取自 v1.0.0 实际能力，不写能力范围外的东西。

---

## 通用版（论坛 / 博客 / 社区长帖）

> **岑序 CENRO v1.0.0**
>
> 本地优先的多格式阅读器。小说、漫画、PDF 收进同一个书架 —— 不联网，不要账号，
> 内容与阅读进度全部留在本机的一个 SQLite 文件里。
>
> 起因很简单：小说在 A 软件、漫画在 B 软件、PDF 在浏览器里，进度三份、书签三套、封面三处。
> 所以它只有一个书架，一本书只归一个分类。
>
> 能读：EPUB、MOBI、AZW3、FB2、TXT、Markdown、HTML、DOCX、RTF、PDF、OFD，
> 漫画走 CBZ / CBR / CBT / CB7 / ZIP / 图片文件夹。书签覆盖全部格式，
> 划词高亮与笔记覆盖文字类，标注能导出 Markdown / CSV / JSON，JSON 还能导回来。
>
> Windows 安装版 / 免安装版、Android arm64 都已放出，GPL-3.0 开源。
>
> 详情与下载 → https://lingmeng.net.cn/apps/cenro/
> 源码 → https://github.com/Lumivox-wiz/Cenro

---

## 酷安 / 应用推荐向（口语，第一人称）

> 做了个阅读器，叫岑序。
>
> 一直有个很具体的烦：小说在阅读软件、漫画在图库、PDF 在浏览器，
> 三份进度、三套书签，换台设备还得重新找位置。
>
> 所以它只做一件事 —— 把这三样塞进同一个书架，进度存在本机。
> 不联网、不要账号、不推书，断网照用。备份是一个普通 zip，
> 解压能看到 `cenro.db`，数据真的是你的。
>
> 书签覆盖所有格式；划词高亮和笔记覆盖文字类，能导出也能导回。
> PDF 的文字层能选中、能搜，缩放和单双页切换后高亮不会画偏。
>
> 详情和下载在 https://lingmeng.net.cn/apps/cenro/
> 开源，GPL-3.0，代码在 GitHub。

---

## 小红书 / 朋友圈（短，配方图）

> 把小说、漫画和 PDF 收进同一个书架。
>
> 不联网，不要账号，不推书。
> 进度、书签、划线全存在本机，断网也能读完一整本。
>
> 支持 EPUB / MOBI / AZW3 / TXT / PDF / CBZ / CBR 等十余种格式，
> Windows 和 Android 都能装。
>
> 自己做的小工具，开源。扫码或搜「岑序 CENRO」。

---

## V2EX / 技术向

> **岑序 CENRO：一个本地优先的多格式阅读器（Tauri 2 + React 19）**
>
> 自用项目，做到 v1.0.0 决定放出来。
>
> 技术上的几个取舍：
>
> - **Tauri 2 + React 19**，外壳 ~15MB，启动快；Rust 侧负责扫描、解压、封面、SQLite 与全部格式解析。
> - **所有格式解析自己写**，没有套现成解析库：MOBI/AZW3 是 PDB + PalmDOC，CBT 手写 ustar、CBR 用 unrar-rs 按名解单页、CB7 首次整包解压到缓存。
> - **PDF 选 pdf.js 而不是 pdfium**，实测 720 页 / 103MB 扫描件首屏 995ms、单页渲染 7–13ms、JS 堆稳定 30MB，省掉三平台各带一份动态库。
> - **标注锚点是「章内字符区间」**（UTF-16 码元），改字号、行高、分页、字体都不漂；绘制前用原文校验，对不上就不画。
> - **进度不舍近求远**：TXT 存字符偏移 + 章节，EPUB 用 CFI，漫画与 PDF 共用页码坐标，不硬套一个统一模型。
>
> 未做：在线书源、云同步、TTS、DRM。移动端只出 arm64-v8a。
>
> 详情 → https://lingmeng.net.cn/apps/cenro/
> 源码 → https://github.com/Lumivox-wiz/Cenro

---

## 一句话版（评论区 / 简介字段）

- 本地优先的多格式阅读器，小说、漫画、PDF 一个书架，不联网也能读完。
- 三种内容，一座书架。不联网，不要账号，进度只在你自己机器上。
- 把散在硬盘各处的书收进一个书架，还顺手记住你读到了哪一页。

---

## 配图用法

| 场景 | 用哪张 |
|---|---|
| 论坛 / 博客正文头图 | `cenro-banner@2x.png` |
| 小红书 / 朋友圈 / 酷安 | `cenro-poster.png`（方图，带二维码，扫码直达站点） |
| GitHub README | `cenro-banner@2x.png` |
| 仓库社交预览 | `cenro-social-preview.png` |

二维码指向 `https://lingmeng.net.cn/apps/cenro/`，**站点改路径的话要重新生成二维码**（`docs/promo/README.md` 里有命令）。
