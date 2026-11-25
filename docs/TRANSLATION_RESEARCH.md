# 翻译服务嵌入可行性研究

日期：2026-11-22
范围：评估在 Cenro 里加入翻译能力（划词翻译 / 整章双语 / PDF 对照 / 漫画 OCR）的技术可行性、方案取舍与代价。
代码基线：v1.0.1（`package.json` / `Cargo.toml` / `tauri.conf.json` 三处均为 1.0.1）。

判定口径，沿用 `FORMAT_RESEARCH.md` 的三条，另加一条向下兼容，缺一条就不做：

1. **不破坏现有坐标**——划线锚点是「章内字符下标」（`highlight.ts`），译文插入后不能让它偏移；
2. **不破坏阅读进度**——双语模式不能把「上次读到哪」弄丢；
3. **隐私不倒退**——项目自我定位是「本地优先」，默认路径不能偷偷把全文发到云上；
4. **不破坏旧版可读性**——老库、老备份、以及「装回旧版」这三种情况都不能出事故（见第七节）。

> 结论先行：**技术上完全可行，且项目底子比预想的好**（`reqwest` / `sha2` / SQLite 迁移 / CSS 分栏全都现成）。
> 真正的难点不在「调不调得动翻译 API」，而在**中文排版与坐标体系**——这部分工作量占七成。
> 另有一条零依赖路径已用本机实测确认存在：Edge 内核内置的 `Translator` API。

---

## 一、结论总表

| 路线 | 质量 | 离线 | 平台覆盖 | 许可 / 成本 | 判定 |
|---|---|---|---|---|---|
| A. 系统内置 `Translator` API（WebView2） | 中上（专家模型） | ✅ 语言包下载后可离线 | 仅桌面 Win/macOS；Linux/Android 无 | 免费，无 key | **首选，零配置** |
| B. Bergamot 引擎（Mozilla 同源） | 中（COMET22 ≈0.87，低于 Google 0.90） | ✅ 完全离线 | 全平台（WASM） | MPL-2.0，与 GPL-3.0 兼容 | 跨平台兜底 |
| C. 本地 LLM（OpenAI 兼容） | 最好（上下文、语气） | ✅ 局域网/本机 | 全平台（要用户自备运行时） | 免费，需 6–8GB 显存 | 质量档，需引导 |
| D. 在线 API（微软 / DeepL / Google） | 好（DeepL 欧洲语最佳） | ❌ | 全平台 | 微软 200 万字/月免费；DeepL 50 万字符/月 | 可选加速 |
| E. 漫画 OCR + 翻译 | — | — | — | 需 OCR 引擎 | P3，本轮不做 |

一句话取舍：**A 做默认、C 做质量、D 做补充、B 做兜底**，四者共用一个 Provider 抽象，不是四套功能。

---

## 二、现状盘点（代码事实）

### 2.1 正文是怎么进到屏幕上的 —— 这决定了翻译怎么插

| 格式 | 入口 | 渲染方式 | 插入译文的自然位置 |
|---|---|---|---|
| TXT | `textApi.range` → `ReaderText` | `el.textContent = text`（`ReaderText.tsx:33`），纯文本 + `white-space: pre-wrap` | 写入后按 `\n` 切段，逐段插译文节点 |
| EPUB | `epubApi.chapter` → `sanitizeXhtml` → `rewriteImages` | `dangerouslySetInnerHTML`（`EpubViewer.tsx:818/851`）+ CSS `columns` 分页 | 清洗后、注入前，用 `DOMParser` 逐块插译文 |
| HTML/MD/DOCX/XLSX | 各自 `open` + `chapter` | 同上，复用 `HtmlViewer` | 同 EPUB |
| PDF | `pdfjs` 文本层（`lib/pdfText.ts`） | canvas 固定版式 | **不能重排**，只能做对照卡片 |
| 漫画 | `comicApi.pagePath` | 纯图片 | 无文字层，要 OCR |

关键：EPUB / HTML 走的是「整块 HTML → innerHTML」这条路，所以**翻译发生在字符串层，天然可以在注入前改写 DOM，不需要碰 React 的渲染**。这是最省事的一种情况。

### 2.2 已有的、可以直接复用的能力

- `reqwest 0.13`（`Cargo.toml`，桌面走 `native-tls`、移动走 `rustls`）——**在线翻译与模型下载都不用加依赖**；
- `sha2`——模型文件哈希校验现成；
- `rusqlite` + `db.rs` 的 `ALTER TABLE` 增量迁移——加 `translation_cache` 表不用重建库；
- `cache.rs`——模型 / 译文缓存目录的清理逻辑已经有骨架；
- `SelectionActions.tsx`——划词浮条已经在，加一个「译」按钮是最小改动点（`Highlighter` / `NotebookPen` 旁边第三个按钮）。

### 2.3 一个必须绕开的硬约束：CSP

`tauri.conf.json` 里 `connect-src` 只有 `'self' ipc: asset: data: blob:`。
**前端 `fetch` 任何外部 API 都会被 CSP 拦死**，翻译请求必须由 Rust 侧发起。

这不是坏事——反而强制了正确做法：API Key 存在 Rust 侧、不进 WebView、不出现在任何前端代码与 DevTools 里。

---

## 三、四条路线逐一说明

### A. 系统内置 `Translator` API —— 零依赖，已实测存在

Chrome 138+ / Edge 148+ 桌面版暴露 `window.Translator`，用设备本地专家模型翻译，语言包按需下载。

**本机实测**（Edge 158 内核，`--headless=new` 加载探针页）：

```
Translator in self: true
LanguageDetector: true
availability(en->zh): downloadable
create error: NotAllowedError / Requires a user gesture when availability is "downloadable"
```

三条结论：

1. 接口**真实存在**，且 `en → zh` 语言对**受支持**（状态 `downloadable`，即差一次下载）；
2. 语言包下载**强制要求用户手势**——所以必须由用户点按钮触发，不能在页面加载时静默初始化。这条正好和「划词后点『译』」的自然交互吻合；
3. 本机 WebView2 Runtime 为 **157.0.4341.60**，与实测的 158 同一 Blink 分支，**极大概率同样暴露该接口**——但 Tauri 内置 WebView2 是否禁用了 AI 组件，必须在 app 里点一次才知道（见第六节待验证项）。

**代价与边界**：

- 语言包体积与下载源由系统管理，我们**不打包、不控制版本**；首次使用要联网下载（约几十 MB 量级，具体随语言对变化）；
- **Linux（WebKitGTK）与 Android（WebView）不可用**——官方支持表明确写「Desktop only」。这两个平台必须回退到 B 或 D；
- 无法指定术语表 / 风格，长文本靠 `translateStreaming` 分段；
- 生成的译文质量约为「中上」，文学性弱于 7B 级 LLM。

> 判断：**作为 Windows/macOS 的默认 Provider 非常合适**——零配置、零 Key、零成本、可离线。但绝不能是唯一 Provider。

### B. Bergamot / Firefox Translations —— 跨平台离线兜底

Mozilla 的 Firefox 内置翻译引擎，C++/WASM 双形态，模型是对 Marian 蒸馏出的 student 模型。

- **模型**：14–38 MB / 语言对（中日韩方向约 44–49 MB），int8 量化，CPU 可跑，无需 GPU；
- **速度**：native 版每句 14–19 ms（MTranServer 实测数据）；WASM 版无 IntGEMM，明显更慢，量级需要本机实测；
- **许可**：引擎与模型均为 **MPL-2.0**。MPL 是文件级 copyleft，与 GPL-3.0 兼容，可随 GPL 项目分发；
- **接入形态**：官方只提供 C++ 库与 WASM 产物（`@browsermt/bergamot-translator`），**没有 Rust crate**。想在 Rust 侧跑，得自己写 C++ 绑定并编 emscripten 之外的 native target，成本不低。

> 判断：**不放进 P0/P1**。真正合理的用法是「Android 与 Linux 的离线兜底」，而这两端恰恰是 WASM 最慢、收益最低的地方。等 A 与 C 都跑通、且有明确的跨平台离线需求时再评估。

### C. 本地 LLM —— 质量最好，用户已有现成运行时

项目作者的既有环境是 koboldcpp + Qwen2.5-7B（`192.168.3.158:5001`），Ollama / LM Studio 也都是 OpenAI 兼容接口。

- **接口**：`POST /v1/chat/completions`，与在线 LLM 完全同构——**一个 Provider 实现同时覆盖「本地模型」与「云端 LLM」**；
- **质量**：文学翻译、语气、专有名词一致性明显优于 NMT；可以喂前文做上下文；
- **代价**：7B 在 4060 Laptop 8G 上约 30–50 tok/s，一段 200 字译文 3–6 秒；显存不足会掉到 CPU，速度再降一个数量级；
- **成本**：0 元，但要用户自己装运行时 + 拉模型——**这是产品化最大的摩擦点**，必须做成「填一个 Base URL + 模型名，点『测试连接』」的形态，不能内置。

> 判断：**P1 必做**，因为它是唯一能兼顾「隐私」与「质量」的路线，而且实现成本只有一个 HTTP Provider。

### D. 在线 API —— 可选，不是默认

| 厂商 | 免费额度 | 超出后 | 备注 |
|---|---|---|---|
| 微软 Azure Translator | 200 万字符/月 | $10 / 百万字符 | 三家最便宜，免费额度最大 |
| DeepL API | 50 万字符/月 | $25 / 百万字符 | 欧洲语质量最佳；亚洲语覆盖有限 |
| Google Cloud Translation | 50 万字符/月 | $20 / 百万字符 | 语言覆盖最广 |

按一本 30 万字的英文小说估算，微软方案每月免费额度约够 6 本。DeepL 只够 1.5 本。

> 判断：做成「自带 Key 的可选 Provider」。**不内置共享 Key**——GPL 开源项目的 Key 一旦进二进制就等于公开，且会把成本与滥用责任挂在作者身上。

---

## 四、真正的难点：排版与坐标，不是 API

这是本报告最需要读的一节。翻译 API 接起来是一天的事，下面四件事各要几天。

### 4.1 划线锚点会被译文污染（必修，改动小但必须改）

`highlight.ts` 的 `textLength()`（:45）与 `collectText()`（:120）都只做一件事：**遍历容器里所有文本节点，累加长度**。
译文一旦作为文本节点插进同一容器，锚点算出来的「章内字符下标」立刻全错——旧划线会画到别的句子上（`paintMarks` 的 excerpt 校验会兜住，表现为「划线全部消失」而不是画错，但仍然等于功能坏掉）。

**解法**：译文节点统一带 `data-cenro-tr` 标记，两个遍历函数加一句过滤（跳过 `[data-cenro-tr]` 子树）。命名与剥除规则见 7.2③。
改动约 10 行，但**所有「在正文里插东西」的功能都必须遵守这条约定**，要写进 `IMPLEMENTATION_NOTES.md`。

### 4.2 分页与进度：双语模式必须独立记进度

- 页数是靠 `scrollWidth / (pageWidth + GAP)` 算出来的（`EpubViewer.tsx:257`）。插入译文后**页数大约翻倍**，同一个 `progression` 会落到完全不同的位置；
- TXT 的进度存的是**原文字节偏移**（`ReaderShell.tsx:178`），不受译文影响，是安全的；
- EPUB 的进度存的是 `{ href, progression }`（章内比例），双语模式下语义会变。

**解法**：**单独存一份双语进度**（独立表或独立列），**绝对不要给 `Progress` 加新 variant**。
原因见第七节 7.1——`Progress` 是 serde 的 internally-tagged enum，加 variant 会让旧版整库读不出来，这是本功能最严重的一处兼容事故点。

注意 `docs/BLUEPRINT.md:31` 明确写过「不预留独立字段」，这一步等于修改数据模型承诺，要同步改蓝图。

### 4.3 段落对齐：请求单元 ≠ 显示单元

翻译要按请求单元切（受 API 单次长度限制，且太长质量下降），显示要按段落对齐（每段下面挂它的译文）。

难点有三个，都是实际会踩的：

1. **EPUB 章节里 `<p>` 与裸文本混排**——`sanitizeXhtml` 之后仍有直接挂在 `<div>` 下的文本节点，得先包一层再插；
2. **一句话被 `<span>` 拆开**（脚注引用、斜体、注音）——按 `textContent` 切会把 span 切断，必须按「块级元素」为最小单位，块内用 innerHTML 保留标签；
3. **中文译文长度与原文差异大**——同一段译完可能长 40%，分页与 `columnOf` 的定位都要重算。

### 4.4 PDF 与漫画：不要试图重排

- **PDF**：文字层是「每页若干 text item」（`lib/pdfText.ts` 的注释已经写清），没有段落结构，也没有重排能力。可行做法只有两种：
  （a）划词译文气泡（复用 `SelectionActions`，成本最低）；
  （b）右侧/底部对照面板，逐页列出原文段落与译文。
  **不要做「在页面原位覆盖译文」**——字号、换行、图表位置全都对不上，做出来一定难看。
- **漫画**：无文字层，必须 OCR。项目目前零 OCR 依赖，等于新开一个 8–12 人日的模块（引擎选型、竖排日文检测、气泡定位）。**P3，本轮明确不做。**

---

## 五、建议方案：分三步，每步都能单独交付

### P0 · 划词翻译（最小闭环，先验证链路）

- `SelectionActions` 加「译」按钮 → 选区文本 → Rust `translate_text` 命令 → 气泡显示译文；
- 两个 Provider：**A（系统内置，前端直调）** + **D（在线 API，Rust 侧发起）**；
- SQLite 加 `translation_cache(hash, src_lang, tgt_lang, provider, target, created_at)`，按 `sha256(原文)` 命中，跨书跨章节复用；
- 设置项：目标语言、Provider、Key、以及**每本书的「允许发送到云端」开关**（默认关）。

验收：选中一段英文 → 点「译」→ 3 秒内出中文；断网且语言包已下载时仍可用（A）；重复翻译同一句命中缓存不重复计费。

### P1 · 整章双语

- 段落切分 + 请求合并（按字符数装箱，参考 `CONTEXT` 那种小工具的做法）；
- 注入译文块：`<div class="cenro-tr" data-cenro-tr>` 紧跟原文块，样式走 CSS 变量（小一号字、次级色、可选虚线上边框）；
- 修正 `highlight.ts` 两处遍历、双语进度**用独立表或独立列承载**（不改 `Progress` enum，理由见 7.1）；
- 三种显示模式：`原文` / `双语` / `仅译文`（仅译文模式要保留原文 DOM 做锚点，只 `display:none`，**不能真删**）；
- 并发控制：可视区域优先（Bergamot 的 `priority` 参数就是这个思路），章节级取消。

验收：翻章不卡（首次进入 ≤1.5s 出首屏，其余段落渐进填充）；已有划线在双语模式下位置不变；退出再进，进度不跑偏。

### P2 · PDF 对照 + 可选本地 LLM

- PDF：划词气泡 + 逐页对照面板；
- C 路线：OpenAI 兼容 Provider，设置页填 Base URL / 模型名 / 温度，带「测试连接」；
- 提供提示词模板（译文风格：直译 / 通顺 / 文学），不做术语表（那是另一个量级的功能）。

---

## 六、风险与未验证项

| 项 | 状态 | 影响 | 处理 |
|---|---|---|---|
| WebView2 内是否真的暴露 `Translator` | **待实测** | A 路线成立与否 | 在 app 里加个临时按钮点一次，看 `availability()` 返回值 |
| 系统语言包体积与首次下载耗时 | 未知 | 首用体验 | 加下载进度 UI（`monitor` 回调） |
| 双语模式进度语义变化 | 确定会发生 | 用户丢进度 | P1 必做独立存储，不能省 |
| 整章重排性能（>1MB 章节） | 未压测 | 卡顿 | 先按 2000 段落分块注入，再测 |
| `docs/BLUEPRINT.md:31` 范围冲突 | 确定冲突 | 文档自相矛盾 | 需正式改蓝图：把「AI 不做」改为「翻译 P1 范围外→v2 纳入」 |
| 移动端能力缺口 | 确定 | Android 只能用云端或本地 LLM | 设置页明确标注「本设备不支持离线翻译」 |
| GPL 分发合规 | 可控 | 许可证问题 | 只分发自己的代码；模型按需下载不随包；MPL 模型可分发 |

工作量估算（单人 + AI 辅助，含验证与文档同步）：

| 阶段 | 代码量（估） | 人日 |
|---|---|---|
| P0 划词翻译 | ~800 行（Rust 300 / TS 500） | 3–5 |
| P1 整章双语 | ~1400 行 + CSS | 6–8 |
| P2 PDF 对照 + 本地 LLM | ~900 行 | 4–6 |
| P3 漫画 OCR | ~1500 行 + 引擎 | 8–12（不建议本轮） |

---

## 七、向下兼容：三条不能碰，三条必须做

这一节是硬约束。翻译功能本身是纯增量，但**只要动了下面三样东西中的任何一样，代价都不是"翻译坏了"，而是"用户的库打不开"**。

### 7.1 三条不能碰

**① 不许给 `Progress` 加 variant**

`models.rs:181` 是 `#[serde(tag = "kind", rename_all = "snake_case")]` 的 internally-tagged enum。
旧版（1.0.1）遇到 `{"kind":"bilingual", ...}` **反序列化直接失败**，而 `get_book` / `list_books` 的返回类型里带 `progress: Option<Progress>`——
失败的不是一本书的进度，而是**整个书架列表的 IPC 调用**。用户看到的是「库空了」，实际数据还在，但没人能接受这种表现。

- 双语进度 → 独立表（如 `book_progress_alt(book_id, mode, locator_json)`）或 books 上新增 `progress_bilingual_json` 列；
- `Anchor`（`models.rs:277`）加字段是安全的（有 `serde(default, skip_serializing_if)`），但**改字段类型不安全**；
- 通用规则：给 serde 结构**加字段**可以，**加 enum variant / 改类型**不行。

**② 不许动 `reader.prefs.v1` 这个 key**

`prefs.ts:132` 的 `KEY` 一改，所有老用户的设置归零（主题、字号、页宽、背景图、自定义字体路径全部重来）。翻译配置只能作为新字段挂在同一个对象里。

而且 `loadPrefs`（`prefs.ts:181`）只对 `background` / `monet` 做了嵌套逐层合并：
```ts
background: { ...DEFAULT_PREFS.background, ...(parsed.background ?? {}) },
monet: { ...DEFAULT_PREFS.monet, ...(parsed.monet ?? {}) },
```
新增 `translation: { provider, targetLang, ... }` 后**必须同时加进这两行旁边**，否则老用户 `prefs.translation.provider` 直接 `undefined` → 设置页读属性时抛错白屏。
这是本项目已经踩过一次的坑（注释里写着「只做顶层展开会得到 undefined」），别踩第二次。

**③ 不许提升 `BACKUP_FORMAT`**

`backup.rs:31` 当前是 `1`，`:324` 明确拒绝 `manifest.format > BACKUP_FORMAT` 的包（「比当前应用新，请先升级应用」）。
翻译只新增表、不改包结构 → **format 保持 1**。一旦顺手加一，老版本会**直接拒绝恢复**新备份，把「静默丢翻译缓存」升级成「完全不能恢复」。

### 7.2 三条必须做

**① 新表写进 `SCHEMA` 的 `CREATE TABLE IF NOT EXISTS`**

`db::init` 每次启动都跑（`lib.rs:228`），`restore` 解包后第 3 步还会再跑一遍（`backup.rs:346`，注释写明「老备份可能来自更早的版本，补列 / 放开 CHECK 一并跑一遍」）。
所以老库、老备份恢复到新版，`translation_cache` 会自动长出来，**不需要写任何迁移代码**。这是项目现有机制白送的好处。

**② 能力探测，不看版本号**

`minimumWebView2Version` 是 **109.0.1518.78**（`tauri.conf.json`），而 `Translator` 要 **148+**。中间 39 个版本的存量用户根本没这个 API。

- 只用 `typeof self.Translator?.availability === "function"` 判断，且整段包 `try/catch`（部分环境会抛 `SecurityError`）；
- 探测失败或 `availability === "unavailable"` → **静默置灰**该 Provider 并写一行「本机不支持」，不弹报警、不影响其他功能；
- Android（`minSdk = 26`，`build.gradle.kts:30`）与 Linux（WebKitGTK）一律视为无 A 路线；
- `availability === "downloadable"` 且 `navigator.onLine === false` → 提前提示「需联网下载一次语言包」，不要让用户面对一个 `NotAllowedError`。

**③ 注入标记不能与原文撞**

`sanitize.ts` 是**黑名单**式清洗（只删 `script/iframe/...` 标签、`on*` 属性、`javascript:` 协议），其余属性与 class **原样保留**。
所以 EPUB 原文里完全可能出现 `data-tr` 或 `class="tr"`。

→ 用带项目前缀的名字：属性 `data-cenro-tr`、类名 `.cenro-tr`；注入前先 `querySelectorAll("[data-cenro-tr]")` 把原文里的同名属性剥掉。

### 7.3 已自动成立的三件事（不用写代码，但必须验证）

- **历史划线在双语模式下位置天然正确**：锚点是「渲染后文本的下标」，而 `textLength` / `collectText` 一旦跳过译文节点，测量的就是同一套原文文本。锚点与测量同源，所以不需要迁移、不需要重算。
- **「仅译文」模式不能真删原文 DOM**：只 `display:none`。TreeWalker 不看样式，长度不变，锚点继续自洽；真删了锚点就全废。
- **书籍文件一个字节都不改**：翻译只写缓存表。这条是项目铁律，翻译不能破例。

### 7.4 兼容性回归清单

实现时逐条打勾，任何一条挂掉都不算完成：

| # | 场景 | 预期 |
|---|---|---|
| 1 | 1.0.1 建的库，装新版启动 | 不报错，书架 / 进度 / 划线全在 |
| 2 | 新版翻译过几章，回装 1.0.1 | 正常打开，无翻译入口，阅读数据完好 |
| 3 | 1.0.1 导出的备份，新版恢复 | 成功，且恢复后能翻译 |
| 4 | 新版导出备份，1.0.1 恢复 | 成功（format 未升），翻译缓存丢失属可接受 |
| 5 | 老 prefs（无 `translation` 键）打开设置页 | 不崩，取默认值 |
| 6 | WebView2 109–147 | A 路线置灰，其余 Provider 可用 |
| 7 | 断网 + 语言包未下载 | 明确提示「需联网一次」，不静默失败 |
| 8 | 双语模式打开老划线 | 位置不变 |
| 9 | 双语 → 单语 → 双语 来回切 | 进度不错乱、划线不错位 |
| 10 | Android 打开 | 不出现不可用的 Provider 入口 |

---

## 八、结论

1. **可以嵌**，而且不用为它新增任何 Rust 依赖——`reqwest`、`sha2`、SQLite 迁移、缓存目录都是现成的。
2. **不要做成「一个翻译功能」**，要做成「Provider 抽象 + 四个实现」。否则每加一个引擎都要改一遍 UI。
3. **默认必须是本地**：A（系统内置）覆盖桌面，C（本地 LLM）覆盖质量需求；云端 API 只在用户显式同意后启用，且按书粒度授权。
4. **最大的实现风险不在翻译，在坐标**：`highlight.ts` 的字符下标、EPUB 的 `progression`、CSS 分栏的页数，三者都会被译文破坏。P0 阶段就要把 `data-cenro-tr` 约定立起来，别等到 P1 再补。
5. **向下兼容的实质是「少动东西」，不是「多写迁移」**：只要不碰 `Progress` enum、`reader.prefs.v1`、`BACKUP_FORMAT`，翻译落在「新增表 + 新增 prefs 字段 + 新增 UI」上，老库 / 老备份 / 旧版回退的成本接近零——`db::init` 每次启动和每次恢复都会自动补表。反过来，一旦想「顺手把双语塞进 `Progress`」，代价是整个书架列表读不出来。
6. **先改文档再写代码**：`BLUEPRINT.md` 的范围表把 AI 标成「P1 不做」，这条不改，后面每个 PR 都站不住脚；同时要把第七节的「三条不能碰」写进 `IMPLEMENTATION_NOTES.md`，否则下一个人（或下一轮的我）一定会想给 `Progress` 加个 variant。

下一步建议：先花半天做那个「临时按钮 + `availability()`」的 spike。它决定 A 路线能不能当默认——结果只有两种，两种都会让方案更清楚。
