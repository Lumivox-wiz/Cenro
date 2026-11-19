# kookit 可读源码符号地图

> 来源：Wakaru 1.16.0（`F:\REA\wakaru.exe`）对三个压缩包的反混淆还原
> 产物：`F:\REA\recovered-all\`（kookit.js 51,726 行 / kookit-extra-browser.js 13,848 行 / kookit-extra.js 5,886 行）
> 二次分析证据：`F:\REA\evidence-kookit-deob`（204 MB），`ev_fef49c8313de1b0a4f5876fe4a0a1b29c21a04434db7044b37f1518640b7958d`

## 1. 还原效果

`wakaru -u strict --provenance` 对 rollup 单文件产物：

| 指标 | 压缩版 | 还原版 |
|---|---|---|
| 行数 | 1 | 51,726 |
| 字符 | 1,017,218 | 1,689,563 |
| `!0` / `!1` | 393 / 421 | 0 / 0 |
| `void 0` | 119 | 0 |
| 可读类名 | 0 | 140 |

`-u strict` 只做了格式化与语法糖还原（`!0`→`true`、逗号表达式展开、括号树重建），**没有拆成多模块**——`provenance.json` 记录 `format: "unknown"`、单条 range `[0, 1053598]`，因为 rollup 产物没有 webpack/browserify/esbuild 的模块工厂结构。这也意味着**标识符语义化没有发生**：`kookit-extra-*.js` 里的类名仍是 `k`/`x`/`I`/`F` 这类单字母。

## 2. 渲染器继承树

```
EventEmitter
└── GeneralRender
    ├── EpubRender        ├── MobiRender      ├── TxtRender
    ├── MdRender          ├── HtmlRender      ├── Fb2Render
    ├── DocxRender        ├── DocRender       ├── RtfRender
    ├── ChmRender         ├── CacheRender
    ├── PdfRender         ├── PdfTextRender
    └── ComicRender
        ├── FixedLayoutRender   ├── PptxRender
        ├── XpsRender           ├── OfdRender
        └── DjvuRender
```

**关键修正**：`ComicRender` 是图片型基类，五个固定版式（FixedLayout / Pptx / Xps / Ofd / Djvu）全部继承它，共享「归档解包 → 图片序列 → 多 iframe 分页」这条链路。`FixedLayoutRender` 是 `ComicRender` 的具体子类，不是基类。

`ComicRender` 支持的图片扩展名：`jpg jpeg png gif webp svg bmp tif tiff jfif jpe heic avif heif`。

## 3. kookit.js：140 个类，按职责分组

### 渲染器（21）
见上树。方法数最多的是 `CacheRender`（21）、`DocRender`（21）、`Fb2Render`（20）、`ChmRender`（20）、`DocxRender`（19）。

### 阅读辅助（13）
| 类 | 方法 | 职责 |
|---|---|---|
| `CFI` | 15 | `epubcfi(...)` 解析/生成，支持 range，跨文档 range 直接抛错 |
| `SpeedReadingManager` | 8 | 速读模式 |
| `ReadingRulerManager` | 9 | 阅读尺 |
| `ParagraphModeManager` | 12 | 段落聚焦模式 |
| `AnnotationManager` | 7 | 批注 |
| `GeneralParser` | 7 | `book` 抽象 → chapter / chapterDoc / metadata |
| `PageParser` | 11 | 分页估算 |
| `Resources` | 10 | EPUB 资源解析 |
| `Loader` | 9 | 资源加载 |
| `Encryption` | 10 | EPUB `META-INF/encryption.xml` |
| `Book` / `BookHelper` / `StyleHelper` | 2/1/2 | 门面 |

`GeneralRender` 的能力开关（构造参数）：`isBionic`（仿生阅读）、`isSpeedReading`、`isReadingRuler`、`isParagraphMode`、`isShowTotalPage`、`animation: "mimical"`（仿真翻页）、`revertDirection`、`fullTranslationMode`、`platform`。当后三种阅读模式任一开启时，`readerMode: "scroll"` 被强制回落为 `"single"`。

### MOBI 家族（5）
`PDB`（PalmDB 容器）← `MOBI`；`MOBI6`（旧格式）与 `KF8`（新格式）独立实现。

### DjVu 解码链（8）
`ByteView` → `ZPCodecDecoder` → `IW44Map` / `IW44Codec` / `IW44Decoder` → `JB2Decoder` → `Jb2Bitmap` → `DjvuPageDecoder`。完整的 IW44 小波与 JB2 位图字典解码器。

### CHM（6）
`ChmFile` + `LZXState`（LZX 解压）+ `BufferReader` / `BitReader` / `ByteSink` / `InflateError`。

### EMF / WMF（三套独立移植）
`vendor/emf.js` 与 `vendor/wmf.js` 各带自己的 `Helper` / `Blob` / `PointS` / `Obj` / `BitmapInfoHeader` / `DIBitmap` / `ColorRef` / `Font` / `Brush` / `Pen` / `Region` / `Scan` / `GDIContext`。EMF 侧多出 `SVG`（21）/ `SVGPathBuilder`（26）/ `SVGFilters`（23）——把 EMF 记录转成 SVG。

### RTF（一套完整移植）
`Document` / `Renderer` / `RenderChp` / `RenderPap` / `Chp` / `Pap` / `Sep` / `Dop` / `State` / `GlobalState` / `PlainText` / `HexText` + 目的地工厂族（`DestinationFactory` → `RequiredDestinationFactory` / `MetaPropertyDestinationFactory` / `MetaPropertyTimeDestinationFactory` / `PictGroupDestinationFactory`）+ `FieldBase` → `FieldHyperlink` + `Parser`。

### XPS
`XpsFile`（8）+ `XpsRender extends ComicRender`（10）。

## 4. kookit-extra-browser.js：39 类 → 服务映射

标识符未语义化，但类体内的域名、`[Tag]` 日志前缀、`API_BASE` 引用足以定位：

### 云存储（基类 ← 具体实现）

| 服务 | 类 | 依据 |
|---|---|---|
| 阿里云盘 | `x` ← `I` | `openapi.alipan.com` |
| Box | `F` ← `O` | `api.box.com`, `upload.box.com` |
| Dropbox | `R` ← `M` | `api.dropboxapi.com`, `content.dropboxapi.com` |
| Yandex Disk | `_` | `cloud-api.yandex.net` |
| Google Drive | `U` ← `B` | `www.googleapis.com/drive` |
| OneDrive | `z` | `graph.microsoft.com` |
| pCloud | `K` | `api/eapi/my.pcloud.com` |
| 百度网盘 | `q` ← `Q` | `pan.baidu.com`, `d.pcs.baidu.com` |
| 115 | `Y` | `passportapi.115.com`, `proapi.115.com` |
| OAuth 通用 | `k` | `account.box.com`, `accounts.google.com` |
| 登录 | `fe` | Google / Microsoft / GitHub 回调 |

**规律**：除 Yandex / OneDrive / pCloud / 115 外，每个服务都是「抽象基类 + 派生实现」两段式，基类管 token 与请求封装，子类管分页与字段差异。

### 笔记 / 单词同步（9）

| 服务 | 类 | 配置键 | 端点 |
|---|---|---|---|
| Notion | `Ye` | — | `api.notion.com/v1/{pages,blocks,databases}` |
| 语雀 | `Xe` | — | `www.yuque.com/api/v2`，`X-Auth-Token` |
| Readwise | `Ve` | — | `readwise.io/api/v2/highlights/`，`Token` |
| 腾讯 ima | `Ze` | — | `ima.qq.com/openapi/note/v1` |
| **思源笔记 SiYuan** | `et` | `siyuanSyncConfig` | 本地 API，`Authorization: Token ...` |
| Anki | `it` | `ankiSyncConfig` | `http://{host \|\| 127.0.0.1}:{port \|\| 8765}`（AnkiConnect） |
| 欧路词典 Eudic | `it` | `eudicSyncConfig` | `api.frdic.com/api/open/v1/studylist/word` |
| 墨墨背单词 MaiMemo | `it` | `maimemoSyncConfig` | `open.maimemo.com/open/api/v1/memo/notepads` |
| Markdown 导出 | `at` | — | 无网络 |

`it` 一个类装了三家（Anki / Eudic / MaiMemo），靠 `[Anki]` `[Eudic]` `[MaiMemo]` 三个日志前缀分支。

### 调度层

- `tt` = **NoteSync**：遍历所有已注册同步器，`Promise.allSettled` 逐一 `sync(book, ...)`，单个失败不影响其余；失败日志统一 `[NoteSync] {name} sync returned false for book "..."`
- `xe` = `KOReaderSyncError`
- `He`（25 方法）/ `Je`（24）是最大的两个类，承担 SqlStatement 与同步状态机

## 5. kookit-extra.js：33 类（Node 版）

与 browser 版**云存储一一对应**（`D`/`Q` Dropbox、`M` OneDrive、`N`/`K` Google Drive、`X`/`G` Yandex、`te`/`ie` Box、`se`/`ne` 阿里云盘、`ae` pCloud、`le`/`ue` 百度、`ge` 115），外加：

- `w`：官方云（`cloud.koodoreader.com` / `cloud.koodoreader.cn` / `web.koodoreader.cn`）
- `ee` / `te`：基础请求与配置
- `oe` / `re`、`ve`、`ke`、`Ie`：同步与工具

**结论**：Node 版**没有** Notion / 语雀 / Readwise / ima / SiYuan / Anki / 欧路 / 墨墨 这 8 个笔记同步器。桌面端只做云存储同步，笔记外发是 Web 端独有能力。

## 6. CACHE 格式（`CacheRender` + `getCache`）

`BookHelper.preCache()` → `getCache(book)` → JSZip 包，结构：

```
toc.json                  # 目录树
sections.json             # [{ href, label }]
chapters/{i}.html         # 已解析章节 HTML
imgs/{i}/{j}.{ext}        # 章节内图片，按 mimetype 反查扩展名
css/{i}/...               # 章节内样式
```

打包时把章节 DOM 里的 `src` / `xlink:href` 就地改写成 `imgs/{i}/{j}.{ext}` 相对路径，图片 blob 直接写入。读取端 `makeCacheBook()` 反向组装成 `{ sections, toc, getCover }` 的伪 book 对象，交给 `GeneralParser`——**跳过全部格式解析**。

每个 Render 子类都实现 `preCache()`，即 EPUB/MOBI/TXT/…任意格式都能落成 CACHE。

## 7. 端点全表（71 唯一）

绝对 URL 与服务基址：

| 服务 | 端点 |
|---|---|
| 阿里云盘 | `/adrive/v1.0/openFile/{create,complete,get_by_path,getDownloadUrl,list,delete}`、`/recyclebin/trash`、`/adrive/v1.0/user/getDriveInfo` |
| 百度网盘 | `pan.baidu.com/rest/2.0/xpan/{file,multimedia}`、`d.pcs.baidu.com/rest/2.0/pcs/file` |
| Dropbox | `/2/files/{list_folder,list_folder/continue,upload,delete_v2}` |
| Google Drive | `www.googleapis.com/drive/v3/files` |
| Box | `api.box.com/2.0/folders`、`upload.box.com/api/2.0/files/content` |
| Yandex | `/v1/disk/resources`、`/resources/{download,upload}` |
| 语雀 | `{API_BASE}/repos/{ns}/docs`（GET/POST/PUT）、`/docs/{slug}` |
| Readwise | `{API_BASE}/highlights/` |
| 腾讯 ima | `{API_BASE}/{import_doc,append_doc,search_note}` |
| Notion | `/v1/pages`、`/v1/blocks/{id}/children`、`/v1/databases/{id}/query` |
| 欧路 | `api.frdic.com/api/open/v1/studylist/word` |
| 墨墨 | `open.maimemo.com/open/api/v1/memo/notepads` |
| 思源 | `${host}/api/{query/sql,notebook/lsNotebooks,notebook/createNotebook,filetree/createDocWithMd,block/appendBlock}` |
| 本地 | `./lib/7z-wasm/7zz.wasm` |

思源那 5 条路径是还原后才看清的——压缩版里 `e` 是变量，看不出指向本地 6806。
