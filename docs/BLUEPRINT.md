# 岑序（CENRO）— 本地优先桌面阅读器

技术蓝图 v0.2（经评审修订）

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-11-10 | 初版：技术栈、三格式范围、P1/P2/P3 分期 |
| v0.2 | 2026-11-11 | 采纳评审 7 条：进度模型改 `progress_json`、封面策略按格式分治、EPUB 定 foliate.js + sandbox、PDF spike 前置、CBZ 管线规范、macOS 交付标准、扩展点收敛为两个 JSON 字段 |
| v0.3 | 2026-11-12 | 格式范围扩容：小说加 MOBI / Markdown / 单文件 HTML，漫画加 ZIP；MOBI 支持文字与图片两种形态并自动分流 |

---

## 1. 产品边界

**一句话**：一个本地优先、三格式统一的桌面阅读器，解决「必须开三个 app」。

| 维度 | 决策 | 状态 |
|---|---|---|
| 定位 | 自用 + 开源，GPL-3.0-or-later 许可 | 冻结 |
| 平台 | Windows / Linux / macOS | 冻结 |
| 小说 | TXT、EPUB、MOBI(PRC)、Markdown、单文件 HTML | v0.3 扩容 |
| 漫画 | CBZ、ZIP（内含 ≥3 张图）、图片文件夹、图片型 MOBI | v0.3 扩容 |
| 文档 | PDF | 冻结 |
| 书库 | P1 基础库 | 冻结 |
| 交互 | 按格式自动适配 | 冻结 |
| 在线书源 / RSS / 网络漫画源 | 不做 | 冻结 |
| 云同步 / TTS / AI / 批注 | P1 不做；**不预留独立字段**，仅保留两个 JSON 扩展点 | 冻结 |

---

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 外壳 | Tauri 2 | 包体积 ~15MB，启动快，MIT/Apache |
| 前端 | React 19 + TypeScript + Vite | 生态 |
| 状态 | Zustand + TanStack Query | 本地状态密集，比 Redux 轻 |
| DB | `rusqlite`（bundled） | 无外部 SQLite 依赖 |
| 扫描 | `walkdir` + 增量（mtime + size） | 大目录不全量重扫 |
| 编码 | `encoding_rs` | GBK/UTF-8/BOM 探测 |
| 解压 | `zip` crate，条目流式读取 | 不落盘解压 |
| 图像 | `image` crate + 后台队列生成缩略图 | 不阻塞 UI |
| EPUB | **foliate.js** | Readest 已验证；ESM、分页与 CFI 支持完整 |
| PDF | **pdf.js + canvas**（P1 默认），pdfium 为备选 | 三平台零额外二进制分发 |

> `pnpm` 未安装，统一用 `npm`。

---

## 3. 数据模型

### 3.1 books

```sql
CREATE TABLE books (
  id           TEXT PRIMARY KEY,           -- 稳定 id（path 的 hash）
  type         TEXT NOT NULL CHECK(type IN ('novel','comic','pdf')),
  format       TEXT NOT NULL,              -- txt|md|html|epub|mobi|cbz|zip|folder|pdf
  path         TEXT NOT NULL UNIQUE,       -- 绝对路径；folder 类型为目录
  size         INTEGER NOT NULL,
  mtime        INTEGER NOT NULL,           -- 增量扫描依据
  title        TEXT NOT NULL,
  author       TEXT,
  cover_path   TEXT,
  cover_state  TEXT NOT NULL DEFAULT 'pending',  -- pending|ready|placeholder|failed
  progress_json TEXT,                      -- 见 3.2，单一扩展点
  metadata_json TEXT,                      -- 作者/出版/系列等，单一扩展点
  added_at     INTEGER NOT NULL,
  last_read_at INTEGER
);

CREATE INDEX idx_books_type      ON books(type);
CREATE INDEX idx_books_last_read ON books(last_read_at DESC);
CREATE INDEX idx_books_mtime     ON books(path, mtime);
```

### 3.2 progress_json——按格式分态，不为格式加列

Rust 侧定义带 tag 的 enum，serde 序列化进同一个 TEXT 字段：

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Progress {
    /// TXT：字符偏移 + 章节索引
    Text { offset: u64, chapter: u32 },
    /// EPUB：CFI 优先，href + progression 兜底
    Epub { cfi: Option<String>, href: String, progression: f32 },
    /// 漫画与 PDF 共用
    Paged { page: u32, zoom: f32, spread: SpreadMode },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpreadMode { Single, Double, Webtoon }
```

**不采用 `chapter_index + char_offset` 统一模型**：EPUB 在字号、页宽、窗口变化后字符偏移失效，必须用 CFI 或 spine 相对位置。

### 3.3 library_roots

```sql
CREATE TABLE library_roots (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  path      TEXT NOT NULL UNIQUE,
  added_at  INTEGER NOT NULL
);
```

**扩展点收敛**：只有 `progress_json` 与 `metadata_json`。云同步、TTS、批注若将来要做，全部塞进这两个 JSON，不新增列，避免 schema 噪音与迁移。

---

## 4. 封面策略（按格式分治）

| 格式 | 提取方式 | P1 状态 |
|---|---|---|
| TXT | 无内嵌封面 → 生成文字封面（书名 + 渐变底） | `ready` |
| EPUB | 解析 OPF `cover-image` / `meta name="cover"`，兜底首张内嵌图 | `ready` |
| CBZ / 图片文件夹 | 首条目图 → `image` 缩略缓存 | `ready` |
| PDF | **P1 不做 Rust 侧渲染**。入库写 `placeholder`，书架可见；用户首次打开时前端 pdf.js 渲染首页，回写 `cover_path` 并置 `ready` | `placeholder → ready`（异步） |

明确不写「统一封面提取」——PDF 首页渲染依赖 PDF 引擎，P1 无 pdfium，Rust 侧仅靠元数据拿不到封面。

---

## 5. EPUB 渲染：foliate.js + 强制沙箱

- 引擎：`foliate.js`（ESM 引入，Readest 已验证）
- **EPUB 内容是可信度未知的 HTML，等同不可信输入**：
  - iframe 必须 `sandbox="allow-same-origin"`（不含 `allow-scripts`）
  - 全局禁用 JS，仅放行 CSS 与图片
  - 外链资源默认拦截，不走网络
- **样式覆盖限定层级**：只覆盖 `html/body` 与阅读器注入的 `.reader-*` 类，不触碰原书选择器。用户可调字号/行距/主题通过 CSS 变量注入，不写 `!important` 硬改原书规则，避免复杂排版书互相打架。

---

## 6. PDF Spike——前置，与 TXT 并行

不做完这个 spike，不写完整 PDF 模块。

### 验收项

| 项 | 标准 |
|---|---|
| pdf.js worker 加载 | Tauri 2 CSP 允许 `worker-src blob:`，worker 正常起 |
| 文件读取通道 | asset protocol 或 Rust 分块读取，支持按需取页 |
| 100MB 扫描图 PDF 首屏 | ≤ 1.5s |
| 滚动帧率 | ≥ 45fps |
| 内存峰值 | ≤ 800MB |
| 离屏 canvas | 销毁生效，不泄漏；可视区按需渲染有效 |

### 分流决策

- **通过** → P1 用 pdf.js 完整实现（缩放 / 单双页 / 按需渲染）
- **不通过** → 二选一：① 换 pdfium（接受三平台各带 ~6-8MB 动态库）；② 降级为「单页手动翻页 + 无连续滚动」

### 实测结论（2026-11-11，Windows 11 / WebView2）

样本：720 页扫描件，102.9 MB，每页独立 JPEG（DCTDecode）流。

| 项 | 实测 | 阈值 | 结论 |
|---|---|---|---|
| pdf.js worker 加载 | 正常 | 能起 | ✅ |
| asset protocol 读取 103MB | 正常 | 支持按需取页 | ✅ |
| 首屏（解析 + 首页绘制） | 995–1130 ms | ≤1500 ms | ✅ |
| 单页渲染 | 7–13 ms | ≤300 ms | ✅ |
| 连续 31 页基准 | 288 ms（均 7 ms，最慢 7 ms） | 每页 ≤16.7 ms | ✅ |
| JS 堆 | 30 MB 稳定，31 页后 +1.4 MB | ≤800 MB | ✅ |

**判定：采用 pdf.js，不引入 pdfium。** 渲染开销远低于一帧预算（16.7ms），三平台无需额外分发动态库。

滚动帧率与离屏 canvas 销毁两项由「31 页连续渲染堆仅 +1.4MB」间接验证；正式实现连续滚动时按 §6 复测。

---

## 7. 漫画管线规范

- **不整包解压到磁盘**：`zip` crate 按条目流式读取，直接解码到内存/缓存
- **自然排序**：`1, 2, 10` 而非 `1, 10, 2`，做 numeric-aware 比较
- **解码缓存有上限**：按总像素或总字节设 LRU 上限（建议 512MB），超限淘汰
- **缩略图后台队列**：入库只做轻量索引，缩略图异步生成，500 页 CBZ 首开不卡 UI
- **预加载窗口**：当前页前后各 3 页

---

## 8. 交付标准

| 平台 | P1 标准 | 签名 |
|---|---|---|
| Windows | `.msi` / `.exe` 可安装可运行 | 不签名 |
| Linux | AppImage | — |
| macOS | **未签名 `.app` / `.dmg`**，CI 产出即可，不保证 Gatekeeper 直接放行 | P2 再上 Apple Developer 证书与公证 |

GitHub Actions `matrix`：`windows-latest` / `ubuntu-22.04` / `macos-latest`。

---

## 9. 执行顺序（修订）

```
0. 脚手架 + SQLite schema + 目录扫描（walkdir 增量 + 编码探测骨架）
1. 书架 UI（封面异步管线 + 搜索过滤 + 继续阅读）
2. 并行 ┬ TXT 阅读器（编码探测 + 章节切分 + 分页/滚动切换）
        └ PDF spike（只验证 §6 六项，不完整实现）
3. 图片文件夹阅读器 → 验证图片管线 → 接入 CBZ
4. foliate.js 接入 EPUB（sandbox + CFI 进度）
5. PDF 按 spike 结论落地，或降级
```

**理由**：TXT 是最快的完整流程验证；PDF 是最大风险，必须最早暴露；图片文件夹比 CBZ 少一层解压，先验证管线能隔离变量。

---

## 10. 风险登记册

| 风险 | 影响 | 缓解 |
|---|---|---|
| pdf.js 在 Tauri WebView 渲染大扫描 PDF 卡顿 | P1 PDF 体验崩 | §6 spike 前置；备选 pdfium |
| Linux WebKitGTK 的 canvas / 滚动性能劣于 Windows | Linux 体验差 | CI 出包后实测，必要时 Linux 降级单页模式 |
| macOS 无真机，只能 CI 盲打 | 签名/公证阻塞 | P1 明确未签名，P2 处理 |
| 三格式均衡 = 三个渲染引擎 | 工作量≈三个小型阅读器 | 严格按 §9 顺序，不并行铺开 |
| 本地 EPUB 的 XSS | 安全 | §5 强制 sandbox + 禁 JS |
| 首次扫描大书库卡顿 | 首启体验 | 增量扫描 + 缩略图后台队列 + 分页入库 |
