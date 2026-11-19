# Koodo Reader 的多格式支持是怎么做的

研究对象：`koodo-reader/koodo-reader` v2.4.8（Electron + Vite + React 19）。
读的是公开仓库里的 `package.json`、`vite.config.mts`、`AGENTS.md`、`src/router/index.tsx`、
`src/containers/viewer/component.tsx`、`src/utils/file/cajUtil.ts`、`public/lib/` 目录清单。

---

## 一、一张图看懂它的分层

仓库自带的 `AGENTS.md` 写得很直白，它就是四层：

| 层 | 位置 | 职责 |
|---|---|---|
| Electron 主进程 | `main.js` | IPC、SQLite、云同步、原生集成 |
| React 渲染进程 | `src/` | UI、Zustand 状态、书架与阅读页 |
| **阅读引擎** | `src/assets/lib/kookit-extra.min.mjs` | **闭源 ESM：所有格式解析、渲染** |
| Go HTTP | `httpserver/` | OPDS / KOReader 同步 |

关键结论：**格式解析不在开源代码里**。仓库里的 `kookit-extra.min.mjs`、`kookit.min.js` 是混淆产物，
`AGENTS.md` 甚至明确写「不要尝试读取这些文件」。开源部分只负责「拿到文件 → 调引擎 → 渲染」。

而 `src/router/index.tsx` 里 30 个格式路由（`/epub/* /mobi/* /cbr/* /cb7/* /pptx/* /xps/* /djvu/* /ofd/* /caj/* …）
全部指向**同一个** `<HtmlReader />` 组件——格式差异完全被引擎吃掉了。

---

## 二、它实际用的三条路径

### 路径 A：WASM / 纯 JS 解码器（装在 `public/lib/` 与 `node_modules` 里）

`public/lib/` 的实际内容：`7z-wasm`、`libunrar`、`caj2pdf-rust`、`pdfjs`、`sqljs-wasm`、
`tesseractjs`、`onnxruntime-web`、`pdf-lib`、`esearch-ocr`，外加一堆排版 CSS。

`package.json` 里能对上的：`chmlib-ts`（CHM）、`liteofd`（OFD）、`mammoth`（DOCX）、
`mhtml2html`（MHTML）、`js-untar` / `tar-stream`（CBT）、`lzma1`（7z）、`jszip` / `yauzl` / `fflate`（zip 系）、
`@web-ppt/core`（PPTX）、`chardet`（编码探测）。

也就是说：**它把「需要 C 库」的格式都换成了 WASM 或纯 JS**。CHM 用 TypeScript 移植版而不是 chmlib C，
RAR 用 libunrar 的 wasm 而不是原生库，7z 同理。

### 路径 B：导入时转换（CAJ）

`src/utils/file/cajUtil.ts` 是唯一在开源代码里能看到的完整格式处理逻辑：

- CAJ → PDF，用 `caj2pdf-rust` 的 **wasm 构建**，跑在 Web Worker 里（UI 不卡）；
- 转换器从文件头自行判断格式，失败就干净报错；
- 有一处针对知网导出文件的特判：TOC 记录数在 `0x110`、记录从 `0x114` 起每条 308 字节，
  如果计数大到超出文件长度（说明那个区域其实是别的表），就把计数清零再转；
- 转换结果直接交给 PDF 管线，下游只认 PDF，不认 `.caj`。

这是「**不支持的格式 → 转成我们已支持的格式**」的范式，比硬写一个 CAJ 渲染器省得多。

### 路径 C：引擎内部自研（闭源）

MOBI / AZW3 / KF8、DjVu、XPS / OXPS 在 `public/lib` 和依赖里都找不到对应库，
只能是在 `kookit-extra` 里用 TypeScript 实现的解码器（DjVu 的 IW44 小波、XPS 的固定页 XAML 等）。

---

## 三、逐格式对照

| 格式 | Koodo 的做法 | 载体 |
|---|---|---|
| EPUB | 自研 / epub.js 式 rendition，章节 XHTML 进 iframe | 引擎 + iframe |
| PDF | pdf.js，扫描版再走 OCR（tesseract / paddle / onnx） | `public/lib/pdfjs` |
| MOBI / AZW3 / AZW | 引擎内自研 PDB/KF8 解码 | 闭源 |
| FB2 | 引擎内 XML → HTML | 闭源 |
| TXT / MD / HTML / XML / XHTML | 按规则切章 + 正则清洗，转 HTML | 引擎 + `parserRegex` |
| CBZ / ZIP | `getZipEntries` / `getZipBuffer` 由宿主注入，按图渲染 | 回调进引擎 |
| CBT | `getTarEntries` / `getTarBuffer` 同上 | 回调进引擎 |
| CBR | libunrar 的 wasm | `public/lib/libunrar` |
| CB7 | `7z-wasm` + `lzma1` | `public/lib/7z-wasm` |
| CHM | `chmlib-ts`（CHMLib 的 TS 移植） | npm |
| OFD | `liteofd` | npm |
| PPTX / PPT | `@web-ppt/core` | npm |
| DOCX / DOC | `mammoth`（DOCX）；DOC 走引擎 | npm + 闭源 |
| RTF | 引擎内解析 | 闭源 |
| MHTML | `mhtml2html` 转 HTML | npm |
| XPS / OXPS | 引擎内自研固定页渲染 | 闭源 |
| DjVu / DJV | 引擎内自研（IW44 解码 + 逐页位图） | 闭源 |
| CAJ | caj2pdf-rust wasm，**导入即转 PDF** | `public/lib/caj2pdf-rust` |

---

## 四、它踩过、我们也踩过的坑（对照）

| 问题 | Koodo 的解法 | 我们的现状 |
|---|---|---|
| C 库在 Windows 上编译失败（CHM） | 一律用 WASM/TS 移植，不编 C | 我们 `chmlib-sys` 实测 `cl.exe` 失败 → 放弃 CHM |
| 大文件解析卡 UI | 解析进 Worker，渲染进 iframe | 我们在 Rust 侧做，主线程不卡；但 WASM 方案要 Worker |
| 重复解析浪费 | `cache-<key>.zip` 缓存，命中后按 CACHE 格式读 | 我们有 `comic_cache` 与封面缓存，思路一致 |
| 固定版式格式（XPS/OFD/DjVu）没有文字流 | 当图片逐页渲染，不追求重排 | 我们 DjVu 也可照此做（`djvu-rs` 渲染成 PNG） |
| 编码不明的 TXT | `chardet` 探测 | 我们用 `encoding_rs` 的 BOM→UTF-8→GB18030 顺序 |

---

## 五、对我们（Rust + Tauri）的三点启发

### 1. CHM 可以走 WASM 而不是绑 C 库

我们的 CHM 卡在 `chmlib-sys` 的 vendored C 在 MSVC 14.44 上编译失败。Koodo 用的是 `chmlib-ts`——
如果它能在 WebView 里跑，我们也一样能在 WebView 里跑：**前端拿到 chm 文件字节 → chmlib-ts 解出 HTML →
交给现有 HTML 管线**。这比维护一个 C 绑定干净。同理 `liteofd`（OFD）、`@web-ppt/core`（PPTX）。

代价：这些库都是为浏览器写的，取文件要走 Tauri 的 asset 协议或 `readFile` 后转 `ArrayBuffer`；
解析要放 Worker，否则大文件会卡住 UI 线程。

### 2. CAJ 用「导入即转换」，不要想着「直接读」

`caj2pdf-rust` 已经是 WASM 构建，思路是转成 PDF 再交给 PDF 阅读器。
我们的 PDF 阅读器（pdf.js）已经就绪，只需要一条转换管线：
`.caj` → 缓存里的 `.pdf` → 正常打开。副作用是缓存目录会多一份 PDF，需要纳入缓存清理。

### 3. 我们把一切降级成纯文本，它把一切归一成 HTML

这是最本质的差异：

| | Koodo | 我们 |
|---|---|---|
| 中间表示 | `HtmlBook`（章节 HTML + rendition） | `TextBook`（纯文本 + 字节偏移章节） |
| EPUB | 保留排版、图片、脚注 | 有独立 EpubViewer，保留排版 |
| FB2 / DOCX / RTF / MHTML | 转 HTML，保留粗体/标题层级 | 转纯文本，只保留段落 |
| 进度模型 | 文本指纹 + 章节 + 页 | 字节偏移 + 章内比例 |

我们选纯文本换来了「一条链路通吃、进度模型简单、性能可控」；代价是除 EPUB 外的格式丢排版。
如果哪天要补排版，正确做法不是给每个格式写渲染器，而是把 `TextBook` 升级成「章节 HTML」中间层——
这正是 Koodo 用 30 个路由指向同一个 Reader 的原因。

### 不建议照搬的地方

- **闭源引擎**：它的格式支持一半在混淆产物里，我们没法这么干，也没必要——Rust 侧可控性更好。
- **30 个格式路由**：路由区分格式对用户没意义，只会让「哪个格式归谁管」散在路由表里。
  我们按 `BookType`（novel/comic/pdf）分派阅读器更省心。
- **XPS / OFD / PPT 的「支持」**：实质是把固定版式当图片渲染，搜索、选字、重排全没有。
  与其做半吊子，不如明确不支持。

---

## 六、如果要动手，优先级建议

| 顺序 | 事项 | 做法 | 成本 |
|---|---|---|---|
| 1 | CAJ | `caj2pdf-rust` wasm + 导入转 PDF | 中（转换管线 + 缓存清理） |
| 2 | CHM | `chmlib-ts` 在 WebView 里解 → HTML 管线 | 中（前端解析 + 大文件 Worker） |
| 3 | DjVu | `djvu-rs`（Rust，MIT）逐页渲染成 PNG → 漫画链路 | 中高 |
| 4 | PPTX | `pptx-to-md`（Rust）→ Markdown 管线 | 低（但价值也低） |
| — | XPS / OFD / 旧 DOC | 不做 | — |

---

## 七、REA 还原后的引擎内部（2026-11-13 补充）

前六节基于公开仓库，只能看到「引擎是黑盒」。用 Wakaru 1.16 反混淆后
（`F:/REA/recovered-all/kookit.js`，51,726 行、140 个类名可读），黑盒打开了，
上面「引擎内自研」的说法要修正为「**有可读的 JS 参考实现**」。

### 7.1 渲染器继承树

```
EventEmitter
└── GeneralRender                 (2,677 行)
    ├── EpubRender 1,056 · MobiRender · TxtRender · MdRender · HtmlRender · Fb2Render
    ├── DocxRender 122 · DocRender · RtfRender · ChmRender(60) · CacheRender(24)
    ├── PdfRender 1,006 · PdfTextRender 435
    └── ComicRender 923            ← 图片型基类
        ├── FixedLayoutRender 755 · PptxRender 794
        ├── XpsRender 511 (+XpsFile 709)
        └── OfdRender 1,759 · DjvuRender 944
```

`ComicRender` 是图片型基类，五个固定版式全部继承它——这就是「PPTX / XPS / OFD / DjVu 都能读」
的真相：它们不是被当作文本重排，而是**解包 → 图片序列 → 多 iframe 分页**。
DjVu 的渲染器 944 行，因为要先解码成位图；PPTX/OFD 则主要靠 `@web-ppt/core` 与 `liteofd`。

### 7.2 各解码器的实际体量（按去混淆后的行数）

| 模块 | 类与行数 | 说明 |
|---|---|---|
| MOBI 家族 | `PDB` 28 · `MOBI` 327 · `MOBI6` 281 · `KF8` 373 | 三种压缩分支：不压缩 / PalmDOC / **HUFF** |
| HUFF 字典构造 | `kookit.js:20262-20330` | HUFF_HEADER(8/12 offset) + CDIC_HEADER(length/numEntries/codeLength) + 递归展开，约 70 行，逻辑与 Amazon 规范一致 |
| KF8 | `kookit.js:20807` FDST_HEADER | 按 FDST 把正文分片映射回页，再用 INDX/SKEL/FRAG 重组 |
| CHM | `ChmFile` 1,469 + `LZXState` 90 | LZX 解压只有 90 行，剩下是 ITSS 目录树、内容枚举与链接改写 |
| DjVu | `DjvuFile` 654 · `ZPageDecoder` 396 · `ZPCodec` 509 · `JB2Decoder` 671 · `IW44Codec` 293 · `IW44Decoder` 169 · `Jb2Bitmap` 109 · `DjvuRender` 944 | 完整 IW44 小波 + JB2 字典解码，合计 ~3.7k 行 |
| RTF | `RtfRender` 47 + 一整套移植（`Document`/`Renderer`/`DestinationFactory`/`FieldHyperlink` 623 …） | 目的地工厂族按 `\*` 分组分流 |
| EMF/WMF | `EMFRecords` 488 · `GDIContext` 599 · `WMFRecords` 524 · SVG 相关三件套 | 把 Office 元文件转 SVG，供 DOCX/PPTX 内嵌图使用 |
| 缓存 | `CacheRender` 24 + `BookHelper.preCache()` | 落成 zip：`toc.json` / `sections.json` / `chapters/{i}.html` / `imgs/{i}/` / `css/{i}/` |

### 7.3 这份参考实现改变了什么判断

| 判断 | 之前（仅看公开仓库） | 现在（有还原源码） |
|---|---|---|
| MOBI HUFF/CDIC | 缺失，只能报错 | 有 ~70 行可读实现；但我们改用 `mobi` crate（MIT），不必自己维护 |
| KF8 重组 | 完全未知 | 有 FDST/SKEL/FRAG 的处理顺序可参照 |
| CHM | `chmlib-sys` C 编译失败 → 放弃 | LZX 只有 90 行、目录树逻辑可读 → **Rust 移植可行**，不再受 MSVC 限制 |
| DjVu | 用 `djvu-rs` 即可 | 参考实现有 3.7k 行，自己重写不划算，`djvu-rs`（MIT，纯 Rust）仍是正解 |
| PPTX / OFD / XPS | 以为要自研渲染器 | 实质是「解包+图片序列」，依赖库（`@web-ppt/core`、`liteofd`）承担了主要工作 |

### 7.4 已落地的一处：MOBI HUFF/CDIC 兜底

`src-tauri/src/mobi.rs` 现在按 compression 分流：`1/2` 走自研 PalmDOC 解码，
`17480` 直接交给 `mobi` crate（MIT），正文解成 HTML 后仍复用 `html_to_text` + 章节切分。
失败时是明确报错，不会把乱码塞进阅读器。

**验证状态**：crate 本身在本机对真实 MOBI 验证过（书名/作者/正文可读），
但手上没有 HUFF 压缩的样本书，`17480` 分支只做了「路由正确 + 不 panic」的测试。
拿到真样本后需要复核。
