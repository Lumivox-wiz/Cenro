# kookit 三文件 REA 逆向报告

> 分析对象：`kookit.min.js`、`kookit-extra-browser.min.js`、`kookit-extra.min.mjs`（Koodo Reader 渲染引擎 kookit v1.15.0）
> 工具：REA 6.8.0（`F:\REA`），`analyze_javascript_application` + Wakaru 1.16.0 反混淆
> 证据一（压缩原文）：`F:\REA\evidence-kookit`，123 MB，`ev_202f2579442a58c4a3679c699aa5f2b6745c80861a868d6c9b36e312e07b3b0e`
> 证据二（Wakaru 还原后）：`F:\REA\evidence-kookit-deob`，204 MB，`ev_fef49c8313de1b0a4f5876fe4a0a1b29c21a04434db7044b37f1518640b7958d`
> 配套：`KOOKIT_SYMBOLS.md`（140 个类名、服务映射、CACHE 格式）

## 0. 结论

三个文件是**同一构建产物的三套切片**，不是独立程序：

- 无 Electron 边界（`browser_windows` / `preload` / `ipc` 全为 0），说明它们是纯库，运行时由宿主注入。
- 3 个文件共 318,406 个 AST 节点，解析失败 0 次。
- 网络面被压缩成 **57 个唯一目标**，98 条调用观测，全部指向云存储与笔记服务。
- 混淆强度可量化：66,045 条语义关系里有 **33,229 条是 `aliases`**（局部重命名链），数据流断链 16,385 处。

---

## 1. 覆盖度：这份报告的边界

REA 的诚实之处在于把不确定性显式记账。本次分析：

| 指标 | 值 |
|---|---|
| 应用图 | 270 节点 / 309 边 |
| 语义图 | 58,598 节点 / 66,045 关系 |
| 函数指纹 | 5,115 |
| 未决项 | 36,109 |
| 应用图状态 | `partial`（未截断，受限） |
| 语义图状态 | `partial`（已截断） |

未决项按族分布：

| 族 | 数量 | 含义 |
|---|---|---|
| `data-flow` | 16,385 | 混淆别名导致 reaching definition 无法确定 |
| `object-flow` | 15,350 | 动态属性访问（`a[b]`）目标不明 |
| `call-flow` | 4,354 | 动态调用（`f[x]()`）无法静态解析 |
| `event` | 11 | EventEmitter 动态事件名 |
| `promise-ownership` | 7 | 非显式 Promise 构造 |
| `request` | 2 | 请求对象动态装配 |

**推论**：任何"某处一定会被执行"的结论都不能成立。本报告的每条结论都锚定在静态语法事实上，不宣称运行时可达性。

---

## 2. 结构证据

### 2.1 导出边界

| 文件 | 导出数 | 导出符号 |
|---|---|---|
| `kookit.min.js` | 21 | `BookHelper` `StyleHelper` `EpubRender` `MobiRender` `TxtRender` `MdRender` `HtmlRender` `Fb2Render` `DocxRender` `DocRender` `RtfRender` `PdfRender` `PdfTextRender` `ComicRender` `FixedLayoutRender` `PptxRender` `XpsRender` `OfdRender` `DjvuRender` `ChmRender` `CacheRender` |
| `kookit-extra-browser.min.js` | 16 | `CollectionUtil` `CommonTool` `ConfigService` `HighlightUtil` `KOReaderUtil` `KookitConfig` `LoginHelper` `NoteSyncManager` `ReaderRequest` `ReadingTimeUtil` `SqlStatement` `SyncHelper` `SyncUtil` `ThirdpartyRequest` `UserRequest` `WordSyncManager` |
| `kookit-extra.min.mjs` | 4 | `ConfigService` `SqlStatement` `SyncUtil` `ThirdpartyRequest` |

`PdfRender` / `PdfTextRender` 并存，对应原版 PDF 与 OCR 转文字两条路径。`CacheRender` 是私有预渲染缓存格式的读取器。

### 2.2 静态依赖（按文件归属）

| 文件 | 依赖 |
|---|---|
| `kookit.min.js` | `@web-ppt/core` `chardet` `fflate` `js-untar` `jszip` `liteofd` `mammoth` `marked` `mhtml2html` `rangy-core` `rangy-textrange` `underscore` |
| `kookit-extra-browser.min.js` | `@aws-sdk/client-s3` `axios` `buffer` `crypto-js` `megajs` `sse.js` `webdav/dist/web` |
| `kookit-extra.min.mjs` | `@aws-sdk/client-s3` `axios` `basic-ftp` `crypto` `electron-store` `form-data` `fs` `megajs` `os` `path` `sse.js` `ssh2-sftp-client` `stream` `util` `webdav` |

两套 extra 的依赖差就是平台差异：Node 版多 `fs` / `path` / `os` / `stream` / `util` / `basic-ftp` / `ssh2-sftp-client` / `electron-store`（本地文件、FTP、SFTP、配置落盘），Web 版多 `crypto-js` / `buffer` / `webdav/dist/web`（浏览器兼容层）。**同一份业务代码编译两次**。

---

## 3. 网络面：57 个唯一目标

REA 从 98 条调用观测里提取到的目标，按服务归类：

| 服务 | 端点 | 认证方式 |
|---|---|---|
| 阿里云盘 | `/adrive/v1.0/openFile/{create,complete,delete,get_by_path,getDownloadUrl,list,recyclebin/trash}`、`/adrive/v1.0/user/getDriveInfo` | `axios.post` |
| 百度网盘 | `pan.baidu.com/rest/2.0/xpan/file`、`xpan/multimedia`、`d.pcs.baidu.com/rest/2.0/pcs/file` | `axios.get` |
| Dropbox | `/2/files/list_folder`、`list_folder/continue`、`upload`、`delete_v2` | `axios.post` |
| Google Drive | `www.googleapis.com/drive/v3/files` | `axios.post` |
| Box | `api.box.com/2.0/folders`、`upload.box.com/api/2.0/files/content` | `axios.post` |
| Yandex Disk | `/v1/disk/resources`（`get`/`delete` 双向）、`/resources/download`、`/resources/upload` | `axios` |
| 语雀 | `/api/v2/repos/{ns}/docs`（GET/POST/PUT）、`/docs/{slug}` | `X-Auth-Token` |
| Readwise | `readwise.io/api/v2/highlights/` | `Authorization: Token` |
| 腾讯 ima | `ima.qq.com/openapi/note/v1/{import_doc,append_doc,search_note}` | `fetch` |
| Notion | `/v1/blocks/{id}/children`、`/v1/databases/{id}/query`、`/v1/pages` | `fetch` |
| 欧路词典 | `api.frdic.com/api/open/v1/studylist/word` | `axios.post` |
| 墨墨背单词 | `open.maimemo.com/open/api/v1/memo/notepads` | `axios.get`/`post` |
| 本地资源 | `./lib/7z-wasm/7zz.wasm` | `fetch` |

### 3.1 官方云同步是静态盲区

`cloud.koodoreader.com` / `cloud.koodoreader.cn` 通过常量 `C.cloudUrl` / `C.cloudCNUrl` 注入，再拼进类实例的 `baseUrl` 字段。REA 的 endpoint 提取器**没有捕获到任何 REST 路径**——因为路径是运行时拼接的，静态语法里不存在完整字面量。

同一常量块里还留着：

- `testUrl: https://cloudtestv2.960960.xyz`
- `devUrl: http://192.168.28.159:8000`（内网地址，开发残留）
- 10 个第三方 OAuth 公共客户端 ID（Google / Microsoft / Box / pCloud / Dropbox / Yandex / 115 / DUBOX / Apple / Facebook）与回调地址 `https://web.koodoreader.com/`

### 3.2 REA 的误报，要自己剔除

98 条网络观测里，**17 条不是网络调用**：

| 机制 | 目标 | 实际是什么 |
|---|---|---|
| `call:metadata.get` × 11 | `dc:title` `dc:creator` `dc:identifier` `dc:language` `dc:subject` `dc:description` `dc:publisher` `dc:contributor` `dc:rights` `dc:source` | EPUB/OPF 的 Dublin Core 元数据读取 |
| `call:lower.get` × 5 | `objinfo` `ole10native` `package` | OLE 复合文档（DOC）流名 |
| `call:lower.get` × 1 | `content` / `contents` | ZIP 内条目名 |

保留的 57 个唯一网络目标中，36 个是绝对 URL 或含 `${}` 的模板串，其余 21 个是变量名（`url` `bookUrl` `chapterUrl` `uploadUrl` 等），需回溯调用点才能确定指向。

---

## 4. 语义图：混淆的真实代价

| 关系 | 数量 |
|---|---|
| `aliases` | 33,229 |
| `reads` | 10,078 |
| `captures` | 8,668 |
| `defines` | 7,833 |
| `calls` | 1,140 |
| `returns-to-call` | 1,136 |
| `reads-property` | 1,099 |
| `argument-to-parameter` | 1,006 |
| `writes-property` | 982 |
| `writes` | 665 |
| `creates-promise` | 68 |
| `registers-listener` | 40 |
| `schedules-timer` | 22 |
| `else`（parses/destructures/coerces/chains/constructs-request/supplies-request-field/owns/detaches-task） | 52 |

半数关系是 `aliases`——rollup 单文件打包 + terser 重命名的典型产物：一个局部变量在多层闭包里被反复改名，形成长链。真正有语义价值的 `calls` 只有 1,140 条，与被 33,229 条别名稀释后，人工阅读的成本主要由别名链贡献。

`registers-listener` 40 条、`schedules-timer` 22 条、`creates-promise` 68 条，与阅读器的行为模型吻合：事件监听（翻页/触摸/滚动）+ 定时器（防抖、进度上报）+ Promise（章节懒加载）。

---

## 5. 未完成的部分

| 项 | 原因 | 补救 |
|---|---|---|
| 官方云同步 REST 路径 | 运行时字符串拼接 | 需动态抓包（`inspect-web-network-capture` 或 CDP） |
| 动态调用目标（4,354） | `f[x]()` 形式 | 需运行时观测对齐 |
| UI 层结构 | 三个文件只是引擎，无 React 组件 | 分析宿主 `koodoreader` 主仓库 |

~~`recover-javascript-sources` 失败~~ —— 已用原生 Windows Wakaru 绕过，见第 7 节。

## 6. 对岑序项目的可借鉴点

1. **渲染器分层方式**：`GeneralRender` 派生出 20 个子类；五个固定版式（XPS / OFD / PPTX / DJVU / FixedLayout）全部继承 `ComicRender`（图片型基类），共用「归档解包 → 图片序列 → 多 iframe 分页」。PDF 是独立分支，不走这条路。`src/` 目前按内容类型分阅读器，扩格式前值得先抽出这个图片型基类。
2. **位置追踪**：用 CFI 而非页码/百分比，跨排版模式（单页/双页/滚动）稳定。这是现在书架进度语义可以升级的方向。
3. **缓存格式**：`CacheRender` + `BookHelper.preCache()` 把已解析内容序列化成 zip（`toc.json` + `sections.json` + `chapters/{i}.html` + `imgs/{i}/`），二次打开跳过解析。对 PDF/漫画冷启动有明显收益。
4. **依赖取舍**：它同时打包 `jszip` 与 `fflate`、`js-untar` + `7z-wasm`，是为覆盖 CBZ/CBT/CB7 三种压缩格式付出的体积代价（主文件 1 MB）。岑序已有 CBR/CBT/CB7 支持，可对照其 wasm 加载策略。
5. **不要抄的部分**：AGPL-v3 传染性；10 个硬编码 OAuth 公共客户端 ID（且 `usePKCE: false`）；内网地址与测试域名残留。

## 7. Wakaru 恢复（补充轮）

REA 的 `recover_javascript_sources` 硬编码 `platform === "linux" && arch === "x64"`，并要求 util-linux `prlimit` 做内存隔离，Windows 上无法调用。改用原生 `F:\REA\wakaru.exe`（1.16.0）直接跑，再把产物交给 REA 二次分析：

```bash
wakaru.exe <input.js> -u strict -o <outdir> --provenance
```

### 7.1 还原效果

| 指标 | 压缩版 | 还原版 |
|---|---|---|
| 行数 | 1 | 51,726 |
| `!0` / `!1` | 393 / 421 | 0 / 0 |
| `void 0` | 119 | 0 |
| 可读类名 | 0 | **140** |

`-u strict` 只做格式化与语法糖还原，未拆模块（rollup 产物无模块工厂结构，`provenance.format = "unknown"`），也未做标识符语义化——`kookit-extra-*` 的类名仍是 `k`/`x`/`I`。但 `kookit.js` 的 140 个类全部带原名：`EPUB` `CFI` `MOBI6` `KF8` `ChmFile` `LZXState` `DjvuPageDecoder` `JB2Decoder` `IW44Decoder` `SVGPathBuilder` `EMFRecords` `WMF` `Dop` `DestinationFactory`……

### 7.2 二次 REA 分析的收益（量化）

| 语义关系 | 压缩版 | 还原版 | 变化 |
|---|---|---|---|
| `calls` | 1,140 | 3,780 | +232% |
| `returns-to-call` | 1,136 | 4,824 | +325% |
| `writes-property` | 982 | 4,640 | +372% |
| `argument-to-parameter` | 1,006 | 3,136 | +212% |
| `constructs-request` | 2 | 20 | ×10 |
| `supplies-request-field` | 5 | 54 | ×10.8 |
| `coerces` | 6 | 42 | ×7 |
| `spreads` | 0 | 28 | 新增 |

`coerces` 与 `spreads` 的增长直接对应 `!0`→`true` 与对象展开的还原——压缩版里这些语法事实被 minimifier 抹掉了。

**但端点数没有增加**：两轮都是 71 个唯一目标。说明 REA 的 endpoint 提取器在压缩版上已经做满了。Wakaru 的收益集中在**可读性与调用链密度**，不在发现新端点。

**未决项从 36,109 涨到 63,320**：不是变差，是语义节点撞到 100,000 上限后暴露了更多不确定。要公平比较需提高 `--max-semantic-nodes` 重跑。

### 7.3 新发现

还原后才看清的两件事（详见 `KOOKIT_SYMBOLS.md`）：

- **思源笔记 SiYuan** 同步器（`siyuanSyncConfig`，走本地 API 5 条路径：`query/sql`、`notebook/lsNotebooks`、`notebook/createNotebook`、`filetree/createDocWithMd`、`block/appendBlock`）——压缩版的域名扫描抓不到，因为是 `localhost`。
- **Anki** 同步器走 AnkiConnect（`127.0.0.1:8765`），同样对域名扫描隐形。
- Node 版（`kookit-extra.min.mjs`）**没有** Notion / 语雀 / Readwise / ima / SiYuan / Anki / 欧路 / 墨墨这 8 个笔记同步器，只有云存储。笔记外发是 Web 端独有能力。
