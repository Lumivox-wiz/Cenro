# 实现登记与偏离记录

> 本文件汇总开发过程中对规范的实现登记（规范要求：未覆盖场景先登记再实现，不得静默偏离）。
>
> **注意**：以下条目是基于 **UI v1.2 / UX v1.1** 写的。规范已于 2026-11-12 升级到
> **UI v1.3 / UX v1.2**，这些条目的“是否符合规范”需要按新版本重新核对，
> 未核对前只能当作实现现状记录，不能当作合规证明。

---

## 一、UI 实现登记（原 UI_SPEC.md 附录 A）

## A（P1 首轮落地）

规范 12.11 要求：未覆盖场景先登记再实现，不得静默发挥。以下为实际实现与规范的映射及偏离。

### A-1 新增 Token（规范未定义，此处登记）

| Token | 暗色 | 亮色 | 用途 |
|---|---|---|---|
| `--c-cover-novel-bg` | `rgba(91,141,239,0.12)` | `rgba(47,111,235,0.08)` | 小说占位封面底色（5.4 要求格式占位图，未给色值） |
| `--c-cover-comic-bg` | `rgba(63,185,80,0.12)` | `rgba(26,127,55,0.08)` | 漫画占位封面底色 |
| `--c-cover-pdf-bg` | `rgba(210,153,34,0.12)` | `rgba(154,103,0,0.08)` | PDF 占位封面底色 |
| `--sidebar-w` | `240px` | 同 | 4.2 侧栏标准宽，提取为布局常量 |
| `--sidebar-w-collapsed` | `64px` | 同 | 4.1 紧凑断点图标栏宽 |
| `--topbar-h` | `56px` | 同 | 4.2 顶栏高，等同 `--sp-14` 但语义更明确 |
| `--content-max` | `1440px` | 同 | 4.1 书架内容区最大宽 |
| `--ease-flip` | `cubic-bezier(0.05,0.7,0.1,1)` | 同 | 翻页位移缓动（快起慢收）。原 `--ease-out` 的 P1/P2 两端切线均水平，实为双端缓动，无法表达「由快到慢」 |

### A-2 实现偏离与理由

1. **样式组织**：采用集中式 `styles/components.css` + 命名空间前缀，未使用 CSS Modules。理由：当前组件 11 个，拆 11 个近乎空的 `.module.css` 文件收益低于维护成本。规范 11「优先 CSS Modules 或 Tailwind」为倾向性条款，此处显式登记偏离。
2. **字号落盘**：`--fs-*` 直接以 rem 落盘（如 `--fs-13: 0.8125rem`），等效于规范 2.2 的「构建时 px ÷ 16 转换」，未引入构建插件。注释保留原始 px 值。
3. **搜索**：内存过滤（一次取全量书目后前端过滤），未走后端 LIKE 与前缀匹配。P1 书库规模下单次 invoke 足够；超 5000 本后再切后端分页检索。
4. **侧栏折叠状态**：存入 prefs（`auto | expanded | collapsed`），`auto` 交给 CSS 断点（<1200px 自动折叠），手动选择通过 `data-sidebar` 覆盖断点。

### A-3 P1 已实现

| 规范条目 | 状态 |
|---|---|
| 2.x Design Token 全量 | ✅ 暗色 / 亮色双套完整 |
| 3.x 主题机制（system 解析、data-theme） | ✅ 阅读主题变量已定义，待阅读页消费 |
| 4.1 断点与列数（4/5/6/7） | ✅ |
| 4.2 顶栏 / 侧栏 / 网格 / 列表 | ✅ |
| 4.4 设置抽屉（阅读 / 主题 / 快捷键 / 书库 / 关于） | ✅ |
| 5.1 组件七态 | ✅（Loading 用骨架，Error 用 Toast + 边框） |
| 5.2 按钮 / 5.3 搜索 | ✅ |
| 5.4 书架卡片、占位封面、进度细条 | ✅（右键菜单未做） |
| 5.7 空状态 | ✅ |
| 5.8 Toast / 对话框 | ✅（对话框组件已就绪，删除确认待 10.1） |
| 5.9 SegmentedControl / Skeleton | ✅ |
| 5.10 图标（Lucide，2px 描边，四档尺寸） | ✅ |
| 7.1 快捷键 Ctrl+F / Ctrl+O / Ctrl+, / Ctrl+\ | ✅ |
| 9 骨架屏、lazy、显式宽高 | ✅（虚拟滚动未做） |

### A-4 P1 待办（阅读器接入时一并完成）

- 4.3 阅读页沉浸式布局、工具栏显隐规则
- 5.5 阅读器工具栏、5.6 目录抽屉
- 6.1–6.5 三格式交互差异（翻页热区、RTL、双页配对、条漫、PDF 模式锁定）
- 7.2 Esc 优先级栈、7.1 剩余快捷键
- 5.4 右键菜单与 10.1 两种移除操作（需 Rust 侧新增 reveal / trash 命令）
- 5.9 Tooltip 组件（当前用原生 title 降级）
- 9 虚拟滚动（>200 项）

### A-5 验收清单执行情况（第 13 章）

视觉与交互项已在代码层逐条对齐；可访问性项（aria-label、Tab 可达、焦点环、prefers-reduced-motion）已实现。尚未执行真实屏幕对比度实测与四种阅读主题观感校准 —— 属 14 章「P1 必须完成」的实测项，待应用可运行后补。

### A-6 EPUB 渲染方式的偏离

规范 5 章要求 EPUB 内容放入 `iframe sandbox` 且默认禁 JS。实现改为 **DOMParser 清理 + 直接渲染**，理由与代价：

| 项 | 说明 |
|---|---|
| 原因 | 分页需要与 TXT 共用同一套 CSS `columns` 测量（`scrollWidth / 列宽`），跨 iframe 拿不到真实列宽；若走 iframe 就要另写一套基于 iframe 内测量的分页器 |
| 清理范围 | 移除 `script / iframe / object / embed / link / meta`；剔除所有 `on*` 事件属性；剥离 `javascript:` 协议；`<style>` 中的 `@import` 与外部 `url()` |
| 保留 | 行内样式、章节自身 `<style>`（仅内联声明）、语义标签 |
| 剩余风险 | 依靠清理白名单而非浏览器级隔离；后续若接入不可信来源的 EPUB，应改回 iframe sandbox |

### A-7 EPUB 待补

- 章节内图片资源：`<img src>` 指向 zip 内相对路径，当前未解压重写，图片不显示
- 滚动模式（当前仅分页）
- CFI 精确定位（现在用 `href + progression`，字号变化后位置会有轻微漂移）

### A-8 双页配对的偏离（用户偏好优先）

规范 6.3 规定「第 1 页（封面）单独显示在右侧 / 左侧」，实现保留「单独一屏」，但**封面改为居中**：

| 位置 | 分组与对齐 |
|---|---|
| 首页（封面） | 单独一屏，半宽**居中** |
| 正文 | (2,3) (4,5) (6,7) … 两两成组 |
| 末页单张 | 按方向靠边：日漫靠右、西漫靠左 |

理由：封面单独一屏能明确「这是封面」，但靠边会显得偏斜；居中更稳。正文仍保持两页节奏，末页单张靠边以维持翻页方向感。该规则经用户两轮实测确认。

### A-9 新增格式的渲染方式（2026-11-12）

规范只覆盖 TXT / EPUB / CBZ / PDF 四种。新增的 Markdown、单文件 HTML、ZIP 三种按下列方式接入，
均**复用 TXT 的阅读外壳**（分页、滚动、目录、进度、快捷键、快捷键说明），不新增视图。

| 格式 | 处理 | 章节来源 |
|---|---|---|
| Markdown (`.md` `.markdown`) | 去标记保留文字：标题去 `#`、强调符号去掉、链接留文字、图片丢弃、列表转 `· `、代码块内容原样保留 | `#` / `##` / `###` 标题行，未命中时回退按「第X章」或固定字节切分 |
| HTML (`.html` `.htm` `.xhtml`) | 去标签、解实体，跳过 `head` / `script` / `style`，`<p>` `<br>` `<div>` 转换行 | 同 TXT（无结构化标题时按固定字节兜底） |
| ZIP (`.zip`) | 与 CBZ 完全一致：条目名自然排序、按需解压单页到缓存、首图作封面 | 与 CBZ 相同（页列表） |

ZIP 的收录条件是**内部图片条目 ≥ 3 个**，否则扫描阶段直接忽略 —— 避免把代码包、备份包
这类普通压缩包塞进书架。判定只读条目名，不解压。

**刻意的取舍**：Markdown 不做语法渲染（没有加粗、表格对齐、脚注）。项目的定位是阅读长文，
把 `## 标题` 渲染成 28px 加粗标题会破坏分页节奏；转成纯文本后，四种文本格式共享同一套排版参数
（字号、行高、版心、主题），行为一致。


---

## 二、UX 实现登记（原 UX_SPEC.md 附录 A/B）

## 附录 A：Android 版实现偏离（2026-11-11）

规范适用一栏写明「桌面端」，移动端为附加目标，以下偏离在此登记，不视为实现遗漏。

| 规范条目 | 原文要求 | 移动端实现 | 原因 |
|---|---|---|---|
| §5.1 首次启动 | 主按钮「导入文件」+ 次按钮「导入文件夹」 | 仅「选择文件导入」，无文件夹入口 | Android 无系统文件夹选择器，`dialog.open({directory:true})` 直接抛 “Folder picker is not implemented on mobile”。设置抽屉内「添加目录」一并隐藏，避免留下点了就报错的按钮 |
| §5.2 导入流程 | 立即插入占位卡片 → 后台逐个解析 | 先复制文件到应用私有目录，再统一扫描刷新 | 系统选择器返回 `content://` URI，扫描器基于 `std::fs` 无法读取，且 URI 末段不是文件名。改为 WebView 文件选择拿到 `File`（含真实文件名与字节），写入 `$APPDATA/books` 后作为书库根复用桌面端扫描链路 |
| §5.2 图片文件夹 | 一个图片文件夹对应一本漫画 | 不支持 | 文件选择器只能选单张图片，无法构成「同层 ≥3 张」的目录；强行支持只会产生一堆 1 页的假书籍，故移动端 accept 列表不含图片扩展名 |
| §5.2 拖拽导入 | 窗口任意位置可接收拖拽 | 无 | 触屏无拖拽语义 |
| §4.3 状态记忆 · 窗口尺寸 | 跨会话记忆窗口尺寸 | 无 | 移动端由系统管理窗口 |

### 移动端返回键映射（新增，对应 §5.5 退出）

Android 实体返回键与 Esc 共用同一套层级语义：

| 当前状态 | 返回键行为 |
|---|---|
| 设置抽屉打开 | 关闭抽屉 |
| 阅读页内 | 交给阅读页自身的 Esc 栈：帮助浮层 → 目录抽屉 → 隐藏工具栏 → 返回书架 |
| 书架且有搜索词 | 清空搜索 |
| 书架根级 | 退出应用 |

实现说明：Tauri 的 `AppPlugin` 只有在 JS 未注册 `back-button` 监听时才会自行结束 Activity；
一旦注册就必须自己处理栈底退出，否则返回键会完全失效。

### 移动端专属约束

- 导入的文件位于应用私有目录，**卸载应用即一并删除**；设置页「书库」分组已就此给出提示。
- 同名文件自动加 `(1)`、`(2)` 后缀，不覆盖已有书籍。
- `content://` 相关逻辑全部未使用，`tauri-plugin-fs` 仅用于写 `$APPDATA`，权限限定为 `fs:allow-app-*`（应用私有目录），未放开任意路径读写。

### 尚未实现（两种平台共同）

| 条目 | 状态 |
|---|---|
| §5.2 占位卡片 + 逐条失败隔离 | 未做，当前为扫描后一次性刷新 |
| §10 从书架移除 / 删除本地文件 / 右键菜单 | ✅ 已完成（2026-11-11），含编辑信息 |
| §13 翻页 aria-live 播报 | ✅ 已完成（2026-11-12），节流 500 ms |
| §8.2 键盘路径（含 Shift+F10 右键菜单） | ✅ 第 5 步已通；`F6` 顶栏/底栏循环已补（2026-11-12） |

---

## 附录 B：右键菜单的实现补充（2026-11-11）

规范 §10.1 只定义了「书籍卡片」的右键菜单。以下几项为规范未覆盖的实现，按 §0.2 在此登记。

### B.1 书架空白处右键菜单（新增）

在书架内容区的空白处（卡片间隙、卡片下方、空状态区域）右键，弹出应用级菜单：

```
导入文件
导入文件夹          ← 仅桌面端；移动端无系统文件夹选择器
───────────
重新扫描
设置
```

分组沿用 §10.1 的原则：导入属于「文件操作」，扫描与设置单独成组。扫描进行中时「重新扫描」置灰。

**为什么需要**：屏蔽 WebView 默认菜单后，空白处右键若完全没有反馈，会被误认为功能损坏；而且「导入 / 扫描」是书架层面的高频操作，比走顶栏更顺手。

### B.2 屏蔽 WebView 默认右键菜单（新增）

未命中上述任一菜单时（顶栏、侧栏、卡片外空白已覆盖、抽屉内等），右键不弹任何菜单。

保留两类原生菜单，否则会打断正常操作：

| 场景 | 保留原因 |
|---|---|
| 输入框 / 可编辑区域 | 没有系统菜单无法粘贴 |
| 存在非空文字选区 | 阅读页选中一段文字后要复制 |

实现：`src/lib/useContextMenuGuard.ts`，在 `window` 捕获阶段 `preventDefault()`，不 `stopPropagation`（保证卡片自己的菜单仍能渲染）。

### B.3 §8.2 键盘路径第 5 步已补齐

规范要求「Shift+F10 打开右键菜单 → 选择从书架移除」仅用键盘完成。实现：

- 卡片获得焦点后按 `Shift+F10` 或键盘菜单键唤出菜单，锚点在卡片左上角
- 菜单打开即聚焦第一个可选项，`↑` `↓` 在可用项间循环
- `Esc` 关闭，`Tab` 不逃出菜单

### B.4 编辑信息（规范 §10.1 第一组第三项，原文标 P2，已实现）

菜单第三项「编辑信息」打开对话框，可改书名与作者。

**关键点：手动编辑后必须锁住书名**。否则下次文件变动（甚至只是重新扫描）时，
扫描会用「从文件名推导的标题」覆盖掉用户的修改。为此新增 `books.meta_locked`
（旧库用 `ALTER TABLE` 平滑补列），置位后 `ingest` 不再覆盖 `title`。

| 行为 | 说明 |
|---|---|
| 书名 | 必填，为空时拒绝保存并提示 |
| 作者 | 可留空（写入 NULL），支持从有到无 |
| 影响范围 | 只改书库显示，**不修改文件名、也不写回文件内嵌的元数据** |
| 正文 | 与书名无关，文件更新时正文照常刷新 |

### B.5 菜单关闭后的焦点归还

键盘唤出菜单（卡片已聚焦）时，关闭后焦点回到该卡片；鼠标右键唤出则不抢占焦点。
若菜单项打开了对话框，焦点交给对话框的输入框，不再回卡片。
卡片已被「从书架移除」时（DOM 断开）不做归还。


---

## 三、2026-11-12 新增登记（基于 UI v1.3 / UX v1.2）

### 3.1 双页封面对齐可配置

规范 §6.3 要求封面单独显示在右侧（日漫）/ 左侧（西漫）。实现改为用户可选：

- `prefs.spreadCover: "center" | "edge"`，**默认 center**
- 设置 → 阅读 → 双页封面，两档即时生效
- 末页单张始终按阅读方向靠边，不受该选项影响

默认值取 center 的依据：用户在此前两轮实测中明确要求居中；规范允许用户手动选择优先于自动判断。
选 edge 即完全符合 §6.3。

### 3.2 顶栏排序下拉的位置

UX §6.3 要求提供排序（最近打开 / 添加时间 / 标题），未规定入口位置。
实现放在顶栏、搜索框右侧；**窄屏（<768px）隐藏**，移动端保持默认排序，
避免与筛选下拉、导入、设置挤在同一行。

### 3.3 导入占位卡片的边界

已实现：选完文件立即插入占位卡片、逐条状态更新、失败隔离、汇总 Toast。

未实现（留待后续）：
- 批量导入的「取消」按钮（UX §5.2 第 7 条）
- 失败卡片点开查看原因 +「重试 / 移除」
- 重复导入的「查看并处理」入口
- 单文件 >50MB 时的解析进度脉冲条

### 3.4 单双页与 PDF 模式的「自动」语义

规范给了两个阈值，但没说「用户手动选过之后」怎么回到自动。实现约定：

| 控件 | 行为 |
|---|---|
| 设置 → 阅读 → 单双页 | 三档：自动 / 单页 / 双页，直接写偏好 |
| 漫画底栏单 / 双 | 点即写具体值（锁定），要回自动需去设置 |
| PDF 底栏翻页 / 滚动 | 点即锁定；**再点一次同一个按钮回到自动**，与「直到用户解除锁定」对应 |
| 快捷键 `D` | 循环 单页 ⇄ 双页，等同手动选择（锁定） |

阈值判定用的是 `window.innerWidth`，不是阅读舞台宽度 —— 舞台已减去左右内边距，
用舞台宽会让 ≥1440 的条件永远差 48px 不成立。

PDF 的 `relZoom` 定义为「相对适合宽度的倍率」（`fitWidth` 时为 1），
自动切换按此计算，与工具栏显示的百分比语义一致。

---

## 附录 C：卡片异常态与阅读器无障碍（2026-11-12）

本批对齐 UI v1.3 §5.4、UX v1.2 §7.3 / §10.2。以下是规范未写死、由实现决定的细节。

### C.1 「待恢复」优先于「文件已丢失」

两个状态在数据上会同时成立：删除事务中断时，文件已被移进回收站，
`status = pending` 且路径确实不存在。卡片只能显示一个角标，实现选择 `pending` 优先——
它解释了「为什么文件不见了」，比单纯说「找不到」信息量更大。视觉上仍按规范分两档：
待恢复 `opacity: 0.6` + `--c-warning`，文件已丢失 `opacity: 0.5` + `--c-text-tertiary`。

### C.2 `missing` 落库与否

`books.status` 会落库（只有 `ok` / `pending`），`missing` 不落库，每次查询用
`Path::exists()` 现算。原因：文件被挪走又挪回来是常态，写进数据库会留下过期结论，
而且没有任何事件能可靠地触发回写。代价是 `list_books` 每本书多一次 stat，
几百本的规模在毫秒级，可接受。

### C.3 重新定位的语义边界

`relocate_book` 只做四件事：改 `path` / `size` / `mtime`、必要时按新文件名重推 `title`、
重算 `type` / `format`、把 `status` 复位为 `ok` 并清空旧封面。

不碰 `progress_json`、`added_at`、`last_read_at`。用户点「重新定位」是想找回这本书，
不是想重新入库，进度和加入时间被清掉会显得比丢文件还糟。

`meta_locked` 为真时保留原标题：用户既然手动定过名，就不该因为换了个文件位置被改掉。

### C.4 删除事务补偿的诚实做法

`remove_book(delete_file = true)` 的顺序是「先移文件、再删记录」。第二步失败时，
`trash` crate 没有跨平台的恢复接口（Windows 回收站可以，Linux 回收站视实现而定），
所以不做「假装能撤销」，直接把记录置为 `pending` 并返回 `RemoveReport.pending = true`，
前端如实提示「文件已移入回收站，但书库记录未能同步」。

### C.5 播报与 F6

- 播报走 `src/lib/useAnnounce.ts`，500 ms 节流。分页报「第 X 页，共 Y 页」，
  滚动报「章节名，百分比」（章节名超过 14 字截断，否则语音要念很久）。
  标点按 UX §4.1 的分工用逗号，视觉呈现仍是间隔点。
- `F6` 走 `src/lib/a11y.ts` 的选择器实现，四个阅读器共用。一个容易漏的点：
  F6 的判定必须放在「焦点在输入框就 return」之前，否则焦点落到进度条
  （`input[type=range]`）上之后就再也切不回顶栏。
- 工具栏内元素获得键盘焦点时暂停自动隐藏（UI §4.3）。之前只在鼠标进入时暂停，
  键盘用户按 Tab 进工具栏后 3 秒会被收走。

### C.6 移动端不展示键位清单

设置页的「快捷键」分组与阅读页 `?` 面板的「键盘」段，在移动端整体不渲染。
手机与平板没有物理键盘，这两块纯占屏——设置页那 7 行会挤掉「书库」「缓存」的分组标题，
阅读页的浮层也会盖住正文。

`?` 面板只保留「工具栏」段（讲哪个按钮在哪），触屏下反而更需要。

顺带修了设置抽屉底部：`.drawer-body` 的 `padding-bottom` 之前没加 `--safe-bottom`，
最后一项会贴着手势条。

---

## 附录 D：无封面书籍改用文字封面（2026-11-12）

**这一条与 UI v1.3 §5.4 的字面要求不同**，按 §0.2「未覆盖场景先登记」的原则记录。

规范原文：缺失封面时「显示格式占位图（小说/漫画/PDF 三种图标 + 底色），不要灰色方块」。

实现改为按书名生成文字封面（`src/components/shelf/TitleCover.tsx`）：

| 方面 | 做法 |
|---|---|
| 配色 | 书名哈希 → 色相，`hsl(h, 28%, 38%) → hsl(h, 32%, 21%)` 的 158° 渐变；同一本书恒定，重建封面不变色 |
| 书名 | 宋体（`--font-reader`），三行截断，按字数分六档字号（26 → 11px） |
| 作者 | 12px、白 60%，单行省略；无作者则不占位 |
| 格式 | 右下角 9px 小字（TXT / EPUB / PDF…），白 42% |
| 书脊 | 左缘 5px 压暗 + 提亮，加 7px 内衬细框，让它像书而不像卡片 |
| 列表缩略图 | 40×60 放不下书名，退成首字；书脊收窄到 3px、去掉内框 |
| 导入占位 | 同样走文字封面，文件名去掉扩展名后取色，导入完成后颜色不跳变 |

理由：

1. 三种图标在真实书架里信息量为零——用户认的是书名，不是「这是 TXT 还是 PDF」。
   格式仍然可见（右下角小字 + 卡片元信息行）。
2. 深底近白字在亮暗两套主题下对比度都在 10:1 以上，不需要为两套主题各写一版配色。
3. 纯 DOM，不引模型、不联网、不产生缓存文件，符合本地优先的定位。

随之删除：`.card-cover-placeholder` 三条规则、`--c-cover-novel-bg` / `--c-cover-comic-bg` /
`--c-cover-pdf-bg` 六个 token 定义（亮暗各一套）。`rebuild_covers` 返回的 `placeholder`
字段语义不变（「本来就没有封图的书」），提示语由「N 本无封面」改为「N 本按书名生成」。

---

## 附录 E：正文让位随工具栏显隐（2026-11-12）

现状问题：顶栏与底栏是 `position: absolute` 的浮层，不占流，但正文区一直留着
`48 + 40` 的上下让位。工具栏收起后那 88px 就白空着——等于把版心上下各切掉一截，
滚动模式下尤其明显。

改为让位跟着 `data-chrome` 走：

| 状态 | padding-top | padding-bottom | 正文可视高度 |
|---|---|---|---|
| 工具栏收起 `off` | `--sp-4` + safe-top | `--sp-3` + safe-bottom | 多出约 60px |
| 工具栏呼出 `on` | `--sp-12` + safe-top | `--sp-10` + safe-bottom | 原值 |

上下各留一点而不是贴边：状态栏与手势条仍然存在，首行不能顶到屏幕边缘。

### E.1 连带处理的两个问题

**分页重排**。列高按视口高度取整到行高倍数，视口一变就必须重算，否则会按旧列高分列
（底部空一截或末行被切）。但重算会改变每页内容，页序不变而读者被甩到别处——
所以重算前先记下「当前页 / 总页数」作为章内比例，重算后按比例落回（复用换章的
`pendingRatio` 机制）。过渡带 160ms，ResizeObserver 会连报十几帧，高度更新做了
120ms 防抖，只取最后一帧。

**滚动位置补偿**。滚动容器随 padding 整体位移，`scrollTop` 是绝对像素值，
容器上移 32px 而 scrollTop 不变，眼前的文字就会往上跳 32px。给滚动容器挂
ResizeObserver，按 `getBoundingClientRect().top` 的变化量反向补偿 `scrollTop`。

TXT 与 EPUB 两条链路都做了（`useTextReader.ts` / `EpubViewer.tsx`）。漫画与 PDF 未改：
PDF 工具栏常驻不收起，漫画的 stage padding 本来就只有 24px。

---

## 附录 F：设置页两级重构（2026-11-12）

抽屉从「六段平铺一屏滚」改为「分类菜单 → 子页」，`SettingsDrawer.tsx` 拆成外壳 +
五个子页组件（`ReadingSettings` / `ThemeSettings` / `LibrarySettings` / `ShortcutsSettings` /
`AboutSettings`，常量在 `shared.ts`）。

### F.1 分组与规范的对齐

首页恰好是 UI §4.4 的五组：阅读 / 主题 / 书库 / 快捷键 / 关于。
原先规范外的「缓存」独立分组并入「书库」子页——缓存本来就是书库的本机数据
（解压产物、封面缩略图），语义上比「关于」更近。规范外扩展在 SPEC_AUDIT §四 重新登记。

移动端不渲染「快捷键」入口（沿用 C.6 的决定），菜单剩四项。

### F.2 菜单项带状态摘要

每项右侧一行 12px 摘要（如「18px · 行高 1.75」「2 个目录 · 已用 128 MB」），
让首页不只是导航，也能当仪表盘看。摘要与子页共用同一份数据源（缓存统计在抽屉外壳取一次）。

### F.3 交互细节

- **Esc 栈**：子页 → 菜单 → 关抽屉。二次确认对话框开着时 Esc 归对话框
  （抽屉的监听先注册先执行，但遇到 `confirmReset` 直接 return 不拦）。
- **Android 返回键**：`App.tsx` 不再直接 `closeSettings()`，改为合成一次 Esc
  派发给抽屉，让它按自己的栈逐级退——否则在子页按一下返回键会直接飞回书架。
- **焦点**：进子页落标题（`tabIndex={-1}`，读屏念出新分类名；非交互元素不画焦点环），
  返回时把焦点还给进来时点的那一项。`:focus-visible` 启发式保证鼠标用户不会看到闪环。
- **方向**：进分类从右滑入、返回从左滑入（`data-dir`），换页即滚回顶部。

### F.4 恢复默认（UX §8.2 的补课）

阅读 / 主题子页底部有「恢复默认」，二次确认后只重置该组的键（`RESET_PATCH` 表驱动）。
书库 / 快捷键 / 关于没有可回退的偏好，按「有键才有按钮」处理，不渲染空按钮。
`DEFAULT_PREFS` 是唯一默认值来源，不出现第二份默认值常量。

---

## 附录 G：关于页重构与子页动效（2026-11-12）

### G.1 关于页

从两段平铺改为参考通用范式的「居中 hero + 圆角卡片分组」：

- **Hero**：渐变圆角图标（`--c-accent → --c-accent-text`，亮暗主题各自成立）+ 名称 +
  slogan「本地优先的阅读器」+ 版本胶囊。
- **卡片**：可跳转行（书库与缓存 / 阅读设置）带右箭头，点击后走 `open()` 的进场动画直接切子页；
  信息行（支持格式、隐私说明）无箭头不可点——两种行同构，靠 chevron 区分可交互性。
- **「检查更新」不做入口**：应用不联网，一行「请手动下载新版本」比一个点了报错的按钮诚实。

### G.2 子页动效（针对「太生硬」的反馈）

| 动效 | 实现 |
|---|---|
| 页面过渡 | 进/退方向滑入改为轻微回弹缓动 `cubic-bezier(0.34, 1.3, 0.64, 1)`，220ms |
| 块级错峰 | 子页每个直接子块（hero/卡片/分组）`translateY(10px) → 0` 上浮，块间延迟 40ms，最多 6 块 |
| 菜单错峰 | 分类菜单行间延迟 30ms |
| 滑块 | 轨道按 `--fill` 填充强调色（JS 由当前值算百分比），悬停拇指 ×1.15、按下 ×1.3 |
| 分段按钮 | `:active` 缩放 0.96，100ms |

**约束**：滑块填充样式限定为 `.settings-page .slider`——阅读页进度条复用 `.slider` 类
但没设 `--fill`，不限定会全局错成半填充。全部动效受 `prefers-reduced-motion` 约束，
且都低于 UX §2 对非必要动效的时长上限（≤300ms）。

关于页卡片行与页脚也参与错峰（它们是子页的直接子块，无需单独处理）。

## 附录 H：底栏进度语义、方向提示、空态与焦点陷阱（2026-11-12）

### H.1 小说底栏「第 X 章 · Y%」（UX §4.1）

TXT / MOBI / MD（ReaderShell）与 EPUB（EpubViewer）的底栏指示器从
「章内页码 / 章内总页数」改为「第 X 章 · Y%」；aria-live 播报同步为
「第 X 章，Y%」（播报用逗号、视觉用间隔点，§4.1 / §7.3）。

- TXT 章节切分失败的兜底是后端 `split_fixed` 的单章「全文」（或「第 N 节」分段），
  前端用 `chapters.length === 1 && title === "全文"` 判定降级为「位置 Y%」（§4.1 降级条款）。
- EPUB 的 spine 至少一项，`chapters.length <= 1` 视为无章节语义，同样降级。
- 分页模式下章内页码不再展示——规范明确底栏是「百分比 + 位置描述」，
  精确页内定位交给进度条拖动（字节偏移插值）。

### H.2 漫画首次方向提示（UX §4.2）

ComicViewer 挂载时检查 `localStorage["reader.hint.comic-dir"]`，
未弹过且偏好开启时在底栏上方显示「日漫模式：← 下一页」（西漫为「→ 下一页」），
3 秒后卸载。文案在挂载瞬间按当时的 `rtl` 定死，提示期间切方向文字不漂移。
偏好键 `comicDirHint`（默认开）放在设置 → 阅读 → 漫画与 PDF 组，
纳入阅读组 `RESET_PATCH`。

### H.3 空状态对齐 §11.3

EmptyState 文案改为规范表逐项：书架空态说明「导入本地文件，或拖拽文件夹到这里」
（移动端「从手机里选择文件导入」，不承诺拖拽）；搜索无结果补主按钮「清空搜索」、
筛选无结果改标题「这个分类还没有书」+ 按钮「查看全部」。二者共用 `no-match`
变体，按 `hasQuery` 分流。

### H.4 抽屉焦点陷阱（UX §8.1）

新 hook `src/lib/useFocusTrap.ts`：Tab / Shift+Tab 在抽屉内首尾循环，
挂载时焦点收进抽屉（优先输入框），卸载时还给触发元素。接入四处：
设置抽屉、ReaderShell / EpubViewer / PdfViewer 的目录抽屉。

- 抽屉都是条件渲染，hook 直接以 `active=true` 挂载，卸载即还焦点；
- 设置抽屉的二次确认对话框打开时 `active` 置 false——对话框自己接管 Esc，
  陷阱若还拦 Tab 会把焦点拽回抽屉，键盘用户就到不了对话框按钮。

## 附录 I：格式扩展（2026-11-12）

对照 Calibre 支持面，把能「无损降级为纯文本」的格式补齐；需要专用引擎的不硬做。

| 格式 | 做法 | 读取路径 |
|---|---|---|
| FB2 | roxmltree 解析 XML：`<section>` 成章（嵌套节递归展开，标题不重复进正文）、`<p>` 成段；`<binary>` base64 解出封面；`title-info` 的书名作者在首次打开时回写库 | 复用 TXT 链路 |
| DOCX | zip 取 `word/document.xml`：`<w:t>` 拼文字、`<w:tab/>`/`<w:br/>` 还原排版符；`pStyle` 以 Heading / 标题 开头的段落切章，无标题则退回「第X章」扫描；`word/media/` 首图当封面 | 复用 TXT 链路 |
| RTF | 自写词法：组栈记录「整组丢弃」（`\*`、fonttbl、colortbl、pict…），`\par/\line/\tab` 转排版符，`\'hh` 按 `\ansicpg` 解、`\uN` 直接出码点 | 复用 TXT 链路 |
| MHTML | 按 boundary 切 MIME 段，取第一个 `text/html`，解码 base64 / quoted-printable 后走 HTML 去标签 | 复用 TXT 链路 |
| AZW3 / AZW | 与 MOBI 同 PDB 容器：分类、图片探测、正文解析、封面全复用 `mobi` 模块 | 复用 MOBI 链路 |
| CBR | `unrar-rs`（纯 Rust，Apache-2.0 + UnRAR 只读条款）列条目、按名解单页；分卷只看第一卷 | 漫画链路 |
| CBT | 手写 ustar 解析（512 字节头、前缀名、GNU `L` 长名、pax `path=`），按需 seek 取单页 | 漫画链路 |
| CB7 | sevenz-rust 首次整包解到 `<comic_cache>/<id>/`，写 `.extracted` 标记，之后按目录读 | 漫画链路 |

**已知边界（有意不做）**：CHM（需 chmlib）、XPS / OXPS / OFD（固定版式，需渲染引擎）、
DjVu（需 djvulibre）、CAJ（私有格式，官方只提供转 PDF）、PPT / PPTX（演示文稿不是阅读形态）。
这些文件扫描时直接忽略，不会在书架上留下「打不开」的记录。

**取舍**：

- RTF 的 `\uN` 是 Unicode 码点，而 `\'hh` 是码页字节，混在一个缓冲区里统一解码会二次转码成乱码。
  改为「字节进 pending、`\uN` 前先按当前码页 flush」，这是本轮唯一踩到并修掉的编码坑。
- CB7 的条目表在压缩块里，没有「只读名字」的便宜通道，所以扫描阶段用 `SevenZReader` 读条目表计数，
  打开时再整包解压；解压用 `<id>.tmp` 临时目录 + 改名，避免中断留下半个包。

## 附录 J：HTML 富文本阅读（2026-11-13）

在此之前所有「文字类」格式都被 `html_to_text` 拍平成纯文本：`<h1>` 和正文同字号、
`<strong>` 不加粗、`<a>` 只是普通文字。HTML 是最容易补回排版的格式，先做它。

### J.1 后端：按标题切章

`src-tauri/src/html.rs`：

- 扫 `<h1>` / `<h2>`（h3 以下多是段内小标题，切碎反而难读）找章节起点；
- 每章的区间是**原始文件里的字节偏移**，`read_html_chapter(start, end)` 直接切原始 HTML；
- 首个标题之前若有正文，单独成「前言」一章（`<head>` 里的 `<title>`/`<style>` 会被 `html_to_text`
  跳过，因此不会因为标题文字误判出空章）；
- 完全没有标题时整篇一章，章名取 `<title>`，没有就留空由前端显示文件名。

**踩坑**：`format!("</h{level}")` 里 `level` 是 `u8`（`b'1'` = 49），直接插值拼出 `</h49`，
闭合标签永远找不到，导致全部退化成单章。必须 `level as char`。

### J.2 前端：复用 EPUB 的渲染骨架

`src/components/reader/HtmlViewer.tsx` 以 `EpubViewer` 为骨架：同一个 `reader-text epub-content`
容器、同一套分页测量 / 滚动补偿 / 工具栏 / `aria-live` 播报。差异只有三处：

| 项 | EPUB | HTML |
|---|---|---|
| 数据源 | `open_epub` → `href` | `open_html_book` → `{start,end}` 字节区间 |
| 章节内容 | `read_epub_chapter(href)` + 图片重写 | `read_html_chapter(start,end)` |
| 进度 | `kind: "epub"`（href + progression） | `kind: "text"`（offset + chapter + total） |

清理仍走 `sanitizeXhtml`：脚本、`iframe`/`object`/`embed`、`on*` 事件属性、`javascript:` 链接全部移除。

### J.3 已知边界

- 相对路径的 `<img src="...">` 暂不重写，图片会显示为破图——下一步按 EPUB 的
  `rewriteImages` 思路，用 asset 协议指向书籍所在目录。
- FB2 / DOCX / RTF / MHTML 仍是纯文本。它们的解析结果本来就是「段落 + 文本」，
  要上富文本得先各自产出 HTML，工作量比 HTML 大，留给后续。

### J.4 链接可点（v0.4.1）

富文本上线的当天就发现链接点不动：阅读页用三块透明热区铺在正文上做翻页分区，
点击落在热区而不是 `<a>` 上，中间那块还会顺手把工具栏呼出来。

改法：去掉热区，点击统一挂在 `.reader-stage` 上按坐标判定（左 25% / 右 25% / 中 50%），
判定顺序是「链接 → 交互元素 → 分区」：

- `a[href]`：`#id` 走章内锚点（滚动模式 `scrollIntoView`，分页模式按元素横坐标换页）；
  `http(s):` / `mailto:` 交给系统浏览器（`@tauri-apps/plugin-opener`），**绝不能应用内导航**；
- `button` / `input` 等：交给元素自己处理，不参与翻页；
- 其余：`clickIfNotDrag` 仍然拦拖选与长按，只有轻点才翻页。

同一处理也移植到了 `EpubViewer`——EPUB 的脚注与外链此前一样点不到。

## 附录 K：Windows 安装向导（2026-11-13）

### K.1 语言跟随系统

`bundle.windows.nsis.languages = ["SimpChinese", "TradChinese", "English"]`，
`displayLanguageSelector: false`。NSIS 的 MUI 在启动时按系统区域匹配语言包，
匹配不到才退回**列表第一条**（所以第一条是简体中文）。

构建后可从产物脚本确认：`src-tauri/target/release/nsis/x64/installer.nsi` 末尾有三条
`!insertmacro MUI_LANGUAGE`，且同目录下有对应 `SimpChinese.nsh` / `TradChinese.nsh` / `English.nsh`。
语言包由 Tauri CLI 自带，不需要自己写 `LangString`。

### K.2 其它向导设置

| 设置 | 值 | 原因 |
|---|---|---|
| `installMode` | `currentUser` | 生成 `RequestExecutionLevel user`，不弹 UAC，装到 `%LOCALAPPDATA%\Programs\Reader` |
| `installerIcon` / `uninstallerIcon` | `icons/icon.ico` | 之前用 NSIS 默认图标，和应用的 exe 图标不一致 |
| `startMenuFolder` | `Reader` | 不设这一项时模板会**跳过**开始菜单页且 `$AppStartMenuFolder` 为空，快捷方式会直接丢在开始菜单根目录 |

向导页序（当前版本）：欢迎 → 〔升级时〕维护选项 → 安装目录 → 开始菜单 → 安装 → 完成
（完成页含「创建桌面快捷方式」勾选项，默认勾选；`MUI_FINISHPAGE_RUN` 提供直接启动）。

**注意**：Tauri v2 的 NSIS 模板没有 `oneClick` 开关了，只能是这种分步向导；
想进一步减页只能靠 `installerHooks` 或自定义 `template`。

### K.3 升级直接覆盖（v0.4.3）

上游模板在「已安装」时插一页维护选项：

| 场景 | 第一项（默认） | 第二项 |
|---|---|---|
| 同版本 | 重新安装组件（本身就是覆盖） | 卸载 |
| 升级 / 降级 | **卸载后安装** | 不卸载 |

也就是说升级时默认会先跑一遍旧版卸载器（`ExecWait uninstall.exe _?=目录`），
再装新文件——多一次磁盘写入与注册表往返，快捷方式还会被删了重建；卸载失败则整个安装中断。

改法用到 Tauri 的 `bundle.windows.nsis.template`，模板来自 `tauri-bundler` crate 源码
（`src/bundle/windows/nsis/installer.nsi`），复制到 `src-tauri/nsis/installer.nsi` 后改两处：

1. `PageReinstall` 里把默认勾选从「第一项」改成「$R0 = 0 时第一项，否则第二项」；
2. 升级（`$R0 = 1` 且非 WiX 迁移）时直接 `Abort` 跳过整页——页面被跳过时
   `PageLeaveReinstall` 不执行，自然不会调用旧版卸载器，新文件覆盖到原目录。

同版本（想修复安装）与降级仍保留这一页，让用户自己决定。

**维护提醒**：这是**分叉**的模板，`package.json` 里 `@tauri-apps/cli` 目前是 `^2`，
CLI 升级后模板可能多出/缺少占位符。构建时 `makensis` 或 handlebars 会报错（不会静默错），
届时用新版 crate 的模板重新复制、把上面两处改动再打一次即可；升级前也可先比对
`cargo add tauri-bundler` 拉到的 `installer.nsi` 与本地副本的差异。

**验证口径**：本地只做了静态校验（生成的 `target/release/nsis/x64/installer.nsi` 里能看到
两处补丁、三条 `MUI_LANGUAGE`、图标与开始菜单 define）。真机升级路径需要人工点一次确认。

## 附录 L：界面视觉优化（v0.5.0）

三份外部评审的共性结论：骨架没问题，问题是「层次太弱、状态表达不统一」。
本轮只改视觉与组件，不动交互逻辑。

### L.1 占位封面按格式族取色

原先写死「书名哈希 → 随机色相」，紫色、红色、青绿色随机出现，颜色占了封面最大面积却不携带信息；
同一族（小说 / 漫画 / PDF）反而颜色各异。改为：

| 族 | 格式 | 底色 | 版式元素 |
|---|---|---|---|
| novel | txt / md / fb2 / html | 墨蓝 | 书脊 + 内衬框 + 书名横线 |
| ebook | epub / mobi / azw3 | 深青 | 同上 |
| comic | cbz / cbr / cbt / cb7 / zip / 文件夹 | 绛红 | 左下角斜切色带 |
| doc | docx / rtf / mhtml | 暖褐 | 顶端「文档行」 |
| pdf | pdf | 纸白（浅底深字） | 红色书名线 |

族内按书名做 ±6° 色相微差，避免整排一模一样。判定入口 `coverFamily(format, kind)`——
`kind` 参与是因为图片型 MOBI 与文字型 MOBI 该分到不同族。

### L.2 卡片信息只表达一次

原状：封面底部 2px 细线 + 元信息里的百分比各说一遍；PDF 卡片显示「PDF · PDF」。
现在：书名 / 副标题（作者 · 类型 · 格式，同名去重）/ 进度行（4px 轨道 + 百分比），
进度只在进度行出现，`metaLine()` 不再拼百分比。

### L.3 状态与层次

- 选中态：`--c-accent` 实底 + `--c-text-on-accent` 反白（原先浅蓝底配蓝字实测 3.5–3.9:1）；
  侧栏另加 3px 左竖条。
- 分层：1px `#E3E5E8` 描边在白底上只有 1.26:1，改用阴影承担层次；卡片悬停上浮 2px。
- 分组：`.section-title` 12px→13px/700，`.drawer-section + .drawer-section` 加分隔线。
- 网格：`repeat(auto-fill, minmax(148px, 1fr))`，上限 1680px。

### L.4 踩坑

`.shelf-body` 是 `display: flex`（行向），`.shelf-grid` 作为 flex 子项默认按内容宽度收缩——
换成 `auto-fill` 后直接缩成一列。补 `flex: 1; min-width: 0` 才恢复。

## 附录 M：界面与交互细化（v0.6.0）

依据外部评审 `建议1`（2026-11-13）逐条落地。核心判断：骨架不动，缺点集中在
「层次靠描边、信息重复、悬停没有反馈、设置分组混在一起」。

### M.1 卡片从「浮在灰面上的封面」变成「白色实体卡」

| 项 | 之前 | 现在 |
|---|---|---|
| 卡面 | 透明，封面 + 文字直接压在页面底色上 | 独立白面（暗色 `#1b1d21`），圆角 12，内边距 8 |
| 层次 | 1px 描边（白底上 1.26:1，等于没画） | 底色差 + `--shadow-card` |
| 悬停 | 封面平移 2px | 卡片上浮 2px、底色转浅灰蓝、封面放大 1.025 |
| 信息 | 书名 / 作者·类型·格式 / 进度条 | 书名 / 作者·类型 / 进度条；格式改为封面左下角标签 |
| 缺失信息 | 无 | 悬停遮罩显示「上次阅读 · 今天」 |

**结构上的坑**：卡面原本是一个 `<button>`。要加右上角「更多」就只能再塞一个按钮进去，
而按钮里放按钮是非法嵌套——浏览器会把内层拆到外面，点击行为随之随机失效。
现在卡片是 `<div>` 外壳，`<button class="card-target">`（打开）与
`<button class="card-more">`（菜单）是**兄弟节点**，后者绝对定位盖在前者之上。

「更多」与右键调的是同一个 `onMenu`，菜单项完全相同——评审明确要求两处入口不要给两套功能。

### M.2 占位封面补细节

- 纸纹：`repeating-linear-gradient` 极细斜线（漫画换角度、PDF 换横向），避免大面积纯色像塑料板；
- PDF：顶部三道 2px 灰线模拟正文，书名下移 12%，读作「一页文档」而不是「一块米色」；
- 文档族：顶部装饰从 10px 高的粗条改成 5px 细线，原来像一条胶片；
- 格式角标从占位封面右下角移到**卡片层**的统一标签（真实封面也有），避免两套位置。

### M.3 阅读设置分组与滑块

- 三组：**正文排版**（字号 / 行高 / 版心）、**漫画**（阅读布局 / 双页封面 / 方向提示）、
  **PDF**（阅读模式）。分组即「影响哪类内容」的答案。
- 组标题右侧「恢复默认」只重置本组，未改动时置灰；单个滑块偏离默认值时行内出现恢复图标。
- 数值本身是按钮，点击变输入框：回车提交、Esc 取消、失焦提交，超量程自动夹紧并吸附步长。
- 页脚改为「恢复全部」，旁边写明只影响当前页，确认框补一句「书架内容、阅读进度与本地文件都不受影响」。

**踩到的坑**：手机断点里有一条 `.field-value { max-width: 55% }`，本意是防止只读文本溢出，
现在数值变成按钮，被裁成「18…」，一按还得猜原值。改成只作用于 `.field-row .field-value`。

### M.4 桌面级细节

| 项 | 做法 |
|---|---|
| Tooltip | `[data-tip]::after` 纯 CSS，240ms 延迟；用 `data-tip` 就不再挂 `title`，否则双提示 |
| Toast | 移到右下角（居中的会压住最后一排卡片），圆角 8px，撤销逻辑不变 |
| 拖拽导入 | `getCurrentWebview().onDragDropEvent`，文件与文件夹同一条路径（`addRoot` + 扫描） |
| 投放层 | 全窗口虚线框，而非只高亮书架区——只点亮一块会让人以为别处不能放 |
| 空状态 | 书堆 SVG 插画，颜色取 `--c-accent` / `--c-text-primary`，两套主题自动适配 |
| 右键菜单 | 宽度 208→216、圆角 10、图标弱化、危险项用 `color-mix` 红底 |

**为什么不用 HTML5 的 drop**：Tauri 拦截了原生拖放，页面收不到 `dragover` / `drop`，
只有 `onDragDropEvent` 能拿到真实文件路径。

## 附录 N：移动端交互修复（v0.6.1）

两条来自真机截图的问题，都属于「桌面能力被带上手机」和「WebView 默认行为」。

### N.1 桌面专属 API 混进手机菜单

`@tauri-apps/plugin-opener` 的 `revealItemInDir` 只有桌面实现，Android 上直接抛
`API not supported on the current platform`。菜单项改为移动端不渲染；
`handleReveal` 里再留一道 `IS_MOBILE` 兜底，防止将来别的入口又调进来。

**顺带发现并修掉同类问题**：菜单里的「重新定位」走 `dialog.open`，
而 Android 上 dialog 插件的 `open` 没有实现，且系统选择器返回 `content://` URI，
`std::fs` 读不到。移动端改为「`<input type=file>` 选文件 → 复制进应用目录 →
`relocate_book` 回填路径」，与导入共用 `saveFilesToLibrary`（其返回值新增 `paths`）。

### N.2 长按触发文本选择，悬停态粘住

- **选择手柄**：长按封面时 WebView 把这 450ms 当成「选文字」，弹出系统选择框盖住封面。
  书架、侧栏、顶栏、菜单与选项组统一 `user-select: none` + `-webkit-touch-callout: none`；
  阅读正文不在这些容器内，选词不受影响。
- **hover 粘住**：触屏没有真正的 hover，点过一次之后 `:hover` 会一直生效，卡片停在
  「上浮 + 继续阅读」。新增 `@media (hover: none)` 把卡片上浮、封面放大、遮罩与
  「更多」按钮全部收回；手机端操作入口仍是长按。
- **计时器漏停**：手指划动触发滚动时浏览器发 `pointercancel`，长按计时器原本没有监听，
  会继续计时并在滚动后弹菜单。补上 `onPointerCancel`。

## 附录 O：正式更名「岑序 / CENRO」（v0.7.0）

品牌：中文名岑序，英文名 CENRO，标语 `A SPACE OF YOUR OWN.`，
理念「在有序的空间里，自由地阅读与探索」。显示名先于 logo 落地，图标仍沿用旧稿。

### O.1 改名清单

| 位置 | 之前 | 现在 |
|---|---|---|
| 产品名 / 窗口标题 | Reader / Reader | `Cenro` / `岑序 · 本地阅读器` |
| 开始菜单、安装目录 | `Reader` | `岑序` / `Programs\Cenro` |
| 包标识 | `com.lumviox.reader` | `com.lumviox.cenro` |
| Rust crate / lib | `reader` / `reader_lib` | `cenro` / `cenro_lib` |
| 可执行文件 | `reader.exe` | `cenro.exe` |
| 数据库 | `reader.db` | `cenro.db` |
| Android 包与主题 | `com.lumviox.reader` / `Theme.reader` | `com.lumviox.cenro` / `Theme.cenro` |
| 产物命名 | `Reader_x.y.z_x64-setup.exe` | `Cenro_x.y.z_x64-setup.exe` |

### O.2 数据迁移

`app_data_dir()` 跟着 identifier 走，改标识等于换目录。桌面端在 `lib.rs` 里加了一次性迁移：
新目录没有 `cenro.db` 且旧的 `com.lumviox.reader` 目录存在时，复制数据库与 `covers/`
（封面文件名是 `{book_id}.jpg` 的平铺结构，不需要递归）。书籍文件本身没有移动，
`books.path` 里的绝对路径仍然有效，**老用户的书架与进度不会丢**。

移动端做不到：Android 的私有目录按包名隔离，新包访问不到旧沙箱。安装新 APK 后需重新导入；
旧版应用可并行存在，确认无误后再卸载。

### O.3 构建上的坑

改 crate 名后 Android 产物从 20MB 涨到 37MB——`jniLibs/arm64-v8a/` 里同时留着
`libreader_lib.so` 与 `libcenro_lib.so`，两个 17MB 的 .so 一起被打进 APK。
Gradle 只做增量复制，不会清理旧名字的库。处理：删掉旧 `.so` 与
`gen/android/app/build`，再重打。**换 crate 名之后必须清一次 Android 构建产物。**

## 附录 P：Markdown 富文本（v0.8.0）

之前 `.md` 走 `md.rs` 的 `to_text`：去掉标记、把列表压成 `·`，再喂给 TXT 链路。
结果是 `*斜体*` 带着星号显示、`行内代码` 带反引号、`#` 标题和正文同字号——用户看到的就是
「格式缺失」。HTML 在 0.4.0 已经有富文本链路，Markdown 转 HTML 是同一套的自然延伸。

### P.1 链路

```
.md 文件 → pulldown-cmark → HTML 字符串 → html::chapters_from_html（按 h1/h2 切）
                                        → 前端 HtmlViewer（sanitizeXhtml 后渲染）
```

| 层 | 新增/改动 |
|---|---|
| `md.rs` | `to_html()`（pulldown-cmark 0.13，MIT）、`open_html()`、`chapter_html()` |
| `html.rs` | 抽出 `book_from_html()` / `chapters_from_html()` / `slice_html()`，HTML 与 MD 共用 |
| `commands.rs` | `open_md_book` / `read_md_chapter` |
| `HtmlViewer.tsx` | 新增 `source` 参数（默认 `htmlApi`），Markdown 传 `mdApi` |
| `reader.css` | `code` / `pre` / `table` / `hr` / 列表间距 |

切章仍按 h1/h2：Markdown 里 `#` 与 `##` 是章节，`###` 以下留作段内小标题，
与 HTML 阅读器的判定一致，进度仍是 `Progress::Text`（字节偏移），没有新增进度模型。

### P.2 取舍

- **不透传原始 HTML**：pulldown 默认转义行内 HTML，避免 Markdown 里塞 `<script>` 绕过清理；
- **不启用脚注**：脚注编号会打乱正文节奏，阅读器里没有弹层承接；
- **不缓存转换结果**：`to_html` 是纯函数，百 KB 文档约十几毫秒，按章按需重算比维护缓存简单。

### P.3 验证

- 单测 3 项：行内/块级标记转换、代码块里的 `*` 不当强调、Markdown 按 h1 切章并切片；
- 用真实 `笔记.md` 的结构做了样式探针：标题、粗斜体、行内代码、链接、嵌套列表、引用、
  代码块、表格、分隔线均正常。

## 附录 Q：侧栏分类与顶栏 Tooltip（v0.8.1）

### Q.1 分类从「三条」变成「两组七项」

原来是 `全部 / 小说 / 漫画 / PDF / 最近阅读`。问题是「小说」把 TXT、MD、HTML、EPUB、MOBI
全裹在一起，五本书同一格，找电子书只能靠肉眼扫封面角标。

现在按**容器族互斥**划分，五个格式分类的计数之和等于「全部」：

| 分类 | 格式 |
|---|---|
| 文本 | txt · md · html · fb2 |
| 电子书 | epub · mobi · azw3（图片型 MOBI 归漫画） |
| 文档 | docx · rtf · mhtml |
| 漫画 | cbz · cbr · cbt · cb7 · zip · 图片文件夹 |
| PDF | pdf |

两组之间加分隔线与「格式」小标题（折叠态隐藏）。判定集中在 `src/lib/filters.ts` 的
`matchesFilter()`，侧栏计数与顶部下拉共用同一函数——之前 `App.tsx` 里 `counts` 和 `visible`
各写一遍口径，改一处忘一处就会错位。

### Q.2 两个 CSS 缺陷

1. **Tooltip 被侧栏盖住**：气泡是 `.topbar` 里按钮的伪元素，`z-index: 100` 只在最近的
   层叠上下文里算数，而 `.topbar` 没有建立上下文，后出现的 `.shelf-body` 直接盖上去。
   给 `.topbar` 加 `position: relative; z-index: 2`。
2. **气泡越过窗口左缘**：默认 `left: 50%` + `translateX(-50%)`，最左侧那颗按钮的中心
   只有 26px，120px 宽的气泡左侧落到 -34px。该按钮改为左对齐。
3. 顺带发现 `.sidebar { padding-left: var(--safe-left) }` 写在媒体查询外：桌面 safe-left 为 0，
   于是基础内边距被一起覆盖成 0，条目贴死窗口左缘（截图里能看到图标紧贴 0）。
   改成 `max(var(--sp-2), var(--safe-left))`。

## 附录 R：OFD / Word / Excel（v0.9.0）

三个格式共用一条思路：**先把排版还原成浏览器认识的东西**，再复用已有的阅读器。
Word 与 Excel 转 HTML 走 `HtmlViewer`；OFD 版式固定，转 SVG。

### R.1 OFD（`ofd.rs`）

OFD 是 zip：`OFD.xml` → `Doc_N/Document.xml` → `Pages/Page_x/Content.xml`，坐标单位毫米。

- **文字**：`TextObject` 有 `Boundary`（页内包围盒）、`Size`（字号）、`Font`，
  `TextCode` 给出 `X/Y`（相对包围盒）与 `DeltaX`（逐字步进）。
  把每个字的 x 算出来写进一个 `<text x="x1 x2 …">`，位置来自文件本身，
  不依赖字体度量——缺字体、字宽不同都不会串行。
- **`DeltaX` 的 `g n`**：表示「前一个增量共出现 n 次」，即再补 n−1 个。
  用 19 字标题校准过：展开后正好 18 个间隔。
- **路径**：`AbbreviatedData` 是 PDF 风格的 `M/L/C/Q/Z`，坐标是对象内坐标，
  按 `Boundary` 平移后转成 `<path>`。遇到未实现的指令（弧线）整段放弃，
  宁可少画一条线，也不画一条错位的线。
- **页面尺寸**：页面可以有自己的 `PhysicalBox`（横排页常见），优先于文档的 `PageArea`。
- **字体**：`PublicRes` 的 `FontName` 映射到 CSS 族，仿宋/楷体/宋体/黑体各给一个回退。

未做：旋转对象、扫描件里的图像对象、数字签名校验。

### R.2 Word（`docx.rs::to_html`）

从「抽文字」改为「转 HTML」：

| 保留项 | 来源 |
|---|---|
| 对齐（居中/右/两端） | `w:jc` |
| 首行缩进 | `w:ind/@firstLine`（twips → px） |
| 字号 | `w:sz`（半磅 → px） |
| 粗体 / 斜体 / 下划线 / 颜色 | `w:b` `w:i` `w:u` `w:color` |
| 表格 + 横向合并 | `w:tbl` / `w:gridSpan` |
| 内嵌图片 | `a:blip/@r:embed` → `word/media/*` → base64 data URL |
| 标题 | `pStyle` = Title / Heading1–3 |

两个坑：

1. `r:embed` 是**带命名空间**的属性，`node.attribute("embed")` 查不到，必须按本地名扫 `attributes()`。
2. 图片常被 `mc:AlternateContent` 包着（Word 的兼容性包装），直接子节点是 `mc:Choice` 而不是 `drawing`。
3. Word 用空格排封面，HTML 会折叠连续空格 → 外层 `.docx-body { white-space: pre-wrap }`。

### R.3 Excel（`xlsx.rs`）

`xl/workbook.xml` 列表，`xl/_rels/workbook.xml.rels` 给路径，`xl/sharedStrings.xml` 存共享串。
每张表输出 `<h2>` + `<table>`：首行当表头，单元格按 `r="B3"` 还原列号，缺的列补空单元格
（否则后面的值会左移）。取 `<v>` 的缓存值，不计算公式。

限制：单表最多渲染 2000 行；不支持 `.xls`（旧二进制格式）。

### R.4 前端

- `HtmlViewer` 的 `source` 参数从 2 种扩到 4 种（HTML / Markdown / Word / Excel）。
- OFD 单独一个 `OfdViewer`：顶部页码、底部上一页/下一页 + 滑块，`←/→/空格/PageUp/PageDown`，
  进度写 `Progress::Paged`。SVG 直接内联（本地生成，文本已转义，不含脚本）。

## 附录 S：为什么 OFD / Excel 导入失败（v0.9.1）

0.9.0 发布后，导入 OFD 与 xlsx 得到的是「导入完成 · 新增 0 本 · 失败 3 个」，
没有任何原因。两条独立的问题叠在一起。

### S.1 根因：旧库的 `type` 上还留着 CHECK

```sql
type TEXT NOT NULL CHECK(type IN ('novel','comic','pdf'))   -- 建库时的约束
```

`CREATE TABLE IF NOT EXISTS` 只在表不存在时生效，所以 0.9.0 给 `BookType` 加了 `Doc` 之后，
**老用户的库仍然只接受三种类型**。`upsert_book` 写入 `type='doc'` 直接被 SQLite 拒绝：

```
数据库错误: CHECK constraint failed: type IN ('novel','comic','pdf')
```

SQLite 不能就地修改 CHECK，只能重建表。`db::init` 里新增 `migrate_relax_type_check`：
读 `sqlite_master.sql`，发现带 `CHECK(type IN` 就建新表、搬数据、删旧表、改名，再补回三个索引。

两个细节：

- **必须写显式列名**。老库的 `meta_locked` / `status` 是历史 ALTER 加上去的，排在表尾，
  `INSERT INTO new SELECT * FROM old` 会串列。
- **新库不再有这条 CHECK**。类型合法性由 Rust 的枚举与 `as_str()` 保证；
  留着 CHECK 意味着每加一个格式类型都得再重建一次表，而且失败点藏在扫描器里，很难发现。

### S.2 为什么「失败 3 个」里有两个是同一个文件

`library_roots` 里同时有 `...\library`（目录）和 `...\library\测试ofd.ofd`（文件）。
导入单本文件时会把它登记成一条独立根，而这个文件本来就在目录根里 —— 于是被扫两次，
失败也记两次。

`db::add_root` 现在先看新路径是否已落在某条根之下（`Path::starts_with` 按路径分量比较，
不会把 `library2` 误判进 `library`），是就返回已有的根。

### S.3 扫描失败不再只报数字

`ScanReport` 增加 `failures: Vec<ScanFailure { path, message }>`，扫描器三处
`Err(_) => failed += 1` 全部改成记录 `error.to_string()`。明细留前 20 条——
选错书库根（例如选中整个磁盘）时失败可能上万条，全塞进 IPC 会让界面卡住。

前端把「失败 N 个」的 Toast 变成可点的「查看原因」，点开是逐条列出文件名、原因、完整路径的
对话框；「重新扫描」的提示同样带这个入口。

**验证**：拿用户真实库的副本跑完整扫描，迁移前 `failed=2`（ofd / xlsx 各一条 CHECK 报错），
迁移后 `added=2 skipped=8 failed=0`。迁移单测覆盖「旧库带 CHECK → init → 能写入 type=doc」，
并断言三个索引在重建后仍在。

## 附录 T：阅读页被书架顶栏盖住（v0.9.2）

「进书籍后无法返回」不是路由问题，而是层叠顺序问题。

### T.1 两处改动的叠加

| 版本 | 改动 | 后果 |
|---|---|---|
| v0.8.1 | `.topbar { position: relative; z-index: 2 }`（为修 Tooltip 被侧栏遮挡） | 书架顶栏建立了独立层叠上下文，级别 2 |
| 一直如此 | `--z-reader: 0` | 阅读页整层（`.reader-transition` / `.reader-shell`）级别 0 |

同级层叠上下文按 `z-index` 比较，2 > 0，所以书架顶栏压在阅读页顶栏之上。
阅读页自己的顶栏（`返回书架` / 书名 / 目录）高度 48px，正好被 56px 的书架顶栏完全覆盖，
用户看到的是「书能打开，但没有返回按钮」。

### T.2 修法

`--z-reader: 0 → 60`。取值考虑：

- 必须 > 顶栏的 2，否则问题依旧；
- 必须 < `--z-dropdown: 100`，否则阅读页里的下拉（目录浮层等）会被压住；
- 抽屉 200 / 对话框 300 / Toast 400 本来就要盖住阅读页，不受影响。

没有选择「把顶栏的 z-index 去掉」：Tooltip 遮挡的根因是侧栏是后续兄弟节点，
去掉 z-index 会让 Tooltip 重新被侧栏盖住。两个需求只能靠层级顺序同时满足。

### T.3 验证

用真实 class + 打包后的 CSS 搭了一个最小复现页（书架壳 + 阅读页壳），
在返回按钮的几何中心调 `document.elementFromPoint`：

| reader z-index | 命中元素 |
|---|---|
| 0（修复前） | `topbar-brand`（书架顶栏） |
| 60（修复后） | `back`（返回按钮） |

截图对照也一致：修复前左上角是搜索框与「导入」，修复后是「← 书名 目录」。

## 附录 U：Markdown 只滚动 + OFD 叠字（v0.10.0）

### U.1 Markdown 不分页

`HtmlViewer` 增加 `scrollOnly` 参数：初值直接是 `scroll`，工具栏不再渲染「分页 / 滚动」切换，
其余分页逻辑原样保留（HTML / Word / Excel 仍可切换）。

理由不是「滚动更好看」，而是分页对笔记类文档结构性不友好：长代码块、宽表格被页边界切断后，
下半截要翻页才能看到，读者还要自己在脑中拼回去。

顺带补了滚动模式的换章：滚到底再滚一下 = 下一章，滚到顶再滚一下 = 上一章。
原本滚动模式滚到章末就卡住了，只能去点目录或按方向键。整章一屏能放下时，
滚轮直接翻章（否则永远滚不动）。

### U.2 OFD 叠字：`g` 的两种写法

`DeltaX` 的 `g` 有两种互相矛盾的实现约定：

| 写法 | 含义 | 出处 |
|---|---|---|
| `g <n> <v>` | 数值 v 重复 n 次 | GB/T 33190，WPS 导出的公文 |
| `<v> g <n>` | 前一个值再重复 n 次 | 早期实现的理解 |

旧代码只实现了第二种，且「没有前值时补 0」。于是 `DeltaX="g 2 5.7572"`（「第一章」）
被展开成 `[0, 5.7572]` —— 长度刚好等于「字数−1」，看起来是对的，实际把第一、二个字
放在了同一个 x 上。截图里「第 条」「国有赀置」的叠字就是这个。

现在 `pick_deltas(raw, expected)` 同时按两种规则展开，选长度正好等于 `expected`（字数−1）的那个。
这是个外部约束：字数来自 `TextCode` 的文本本身，不受解析方式影响。

两种都对不上（数据坏了）时返回空表，调用方退回**段落级排版**：整段一个 `<text>`，
不给逐字 x，让字体自己排。字距会与原件有出入，但绝不会叠字——叠字比字距不齐严重得多。

### U.3 OFD 翻页

- 点击：左 30% 上一页、右 30% 下一页；中间留空，避免误翻。
  选完字松手也会触发 click，所以有选区时直接忽略。
- 滚轮：页面比视口高时先滚到底，到底之后再翻页；260ms 去抖（触控板一次滑动会连发几十个 wheel）。
- 键盘：原有 `←/→/PgUp/PgDn/Space`，补 `Home` / `End`。

### U.4 验证

| 项 | 结果 |
|---|---|
| `DeltaX` 单测 | 5 项（含 `g 2 5.7572` → `[5.7572, 5.7572]`、中间夹 `g` 的写法、长度对不上返回空表） |
| 真实公文第 1 / 2 / 6 页 | 红头、文号、标题、「第一条」到「第四条」全部正常，无叠字 |
| `解析.md`（6.4KB，7 章） | 转 HTML 后按滚动布局渲染，标题层级、表格、行内代码、代码块均正常 |

## 附录 V：Markdown 真的只该是一篇（v0.10.1）

0.10.0 把 Markdown 的默认模式改成了滚动，但正文仍按 h1/h2 切成多章：
滚到章末要再滚一下才进下一章，中间还会闪一下。用户看到的就是「还是被分割了」。

### V.1 改法：后端返回一篇

`md::open_html` 不再走 `html::book_from_html`（那会按标题切章），直接返回单个区间
`[0, html.len())`，标题取第一个 `<h1>` 的纯文本。

`noChapters = chapters.length <= 1` 这条既有分支因此自动生效：底栏显示「位置 Y%」而不是
「第 N 章 · Y%」，进度按整篇字节偏移存，恢复时按 `offset / total` 换算。

### V.2 目录：从渲染结果里提取

不切章就没有章节目录了。补法是前端在正文渲染完成后扫一遍 `<h1>/<h2>`：

- 按顺序补 `id="sec-N"`，把标题文本存进 `outline`；
- 目录抽屉用 `outline` 而不是 `chapters`（仅 `scrollOnly` 分支）；
- 点击按 id `scrollIntoView`；滚动时取「顶端已越过视口上沿」的最后一节做高亮；
- 整篇没有标题时不渲染目录按钮——点开一个空抽屉比没有入口更像 bug。

### V.3 验证

| 项 | 结果 |
|---|---|
| `笔记.md`（用户截图那份，h1 + h2） | 后端 `chapters=1`，渲染后三段在同一页连续流动 |
| `解析.md`（7 个 h1/h2） | `chapters=1`，滚动到底不再中断 |
| 单测 | `markdown_book_is_a_single_document`：断言 1 章、区间覆盖全文、两节内容都在 |

## 附录 W：手机端选不中 `.ofd`（v0.10.2）

截图里 `测试.ofd` 是灰的、描述写着「BIN 文件」——不是扫描器不认，是**文件选择器压根不让选**。

### W.1 原因

移动端导入走 `<input type="file" accept=".txt,.md,…,.ofd,.xlsx">`。
Chrome / Android WebView 会把 `accept` 里的扩展名逐个查系统 `MimeTypeMap` 转成 MIME：

- `.xlsx` 查得到 → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` ✅
- `.md` 查得到 ✅
- **`.ofd` 查不到** → 该条被丢弃，过滤列表里没有它的类型

系统对 `.ofd` 的判定是「未知二进制」= `application/octet-stream`（界面显示 BIN 文件），
不在过滤列表里，于是置灰不可选。桌面端用 `dialog.open` 的 `filters`，不走这条链路，所以一直正常。

### W.2 修法

新增 `MOBILE_ACCEPT`，在扩展名之外显式放行三种 MIME：

```
application/octet-stream   // 未知扩展名在 Android 上的默认判定
application/ofd            // 少数文档提供方自带
application/x-ofd
```

**代价**：选择器会多显示一些二进制文件。所以加了 `isSupportedBook(name)`：
选中后先按扩展名收口，不支持的直接进失败明细（原因写着「不支持的格式」），
不会静默复制进书库目录。

移动端失败项也顺势从「统一一句复制失败」改成逐项带原因（格式不支持 / 写入失败 / 具体 IO 错误）。

### W.3 未被这条覆盖的情况

- 第三方文件管理器（如某些 ROM 自带「文件」）用自己的 MIME 判定，可能仍灰。届时改用
  `accept="*/*"` 是最后的兜底，但会把图片视频一起列出来，先不做。
- 从「分享到」进入应用的路径不存在（我们没有注册 SEND intent），只能走应用内导入。

## 附录 X：OFD 在手机上的「偏移」（v0.10.3）

真机截图里整页看起来往左靠、右边多出一截。本地用真实页面 + 打包 CSS 在手机视口复现后发现，
问题不在 SVG 的定位（`TextCode` 的 x 是文件里的绝对坐标，误差在 0.01mm 级），而在**外层盒子**。

### X.1 三个会让整页位移的因素

| 因素 | 机制 | 处理 |
|---|---|---|
| flex 居中 + 子项超宽 | `display:flex; justify-content:center` 在滚动容器里遇上超宽子项时，**左溢出部分不可滚动**，只能看到右侧多出的那一截 | 改成块级流 + `margin:0 auto`，并给页面盒补 `min-width:0` |
| 经典滚动条占宽 | 部分 Android WebView 用占布局宽度的 15px 滚动条，出现时内容整体左移 | `.ofd-stage` 的滚动条隐藏（翻页有滚轮与点击，滚动条无信息价值） |
| 贴边内边距 | 手机断点里左右只有 12px，视觉上像「靠边」 | 提到 16px |

### X.2 顺带修的字体回退

`css_family` 原来只写 Windows 族名（`Microsoft YaHei` / `KaiTi` / serif）。
Android 上这些都不存在，会落到系统默认无衬线——**字宽与原件不同**，逐字定位虽然不错位，
但每行视觉长度会变，居中标题看起来就会「偏」。

现在按族补 Android 真实存在的名字：

| 原件字体 | 回退链 |
|---|---|
| 黑体 / 雅黑 | `Microsoft YaHei → Noto Sans CJK SC → Source Han Sans SC → Droid Sans Fallback → sans-serif` |
| 楷体 | `KaiTi → Kaiti SC → Noto Serif CJK SC → serif` |
| 仿宋 | `FangSong → FangSong_GB2312 → STFangsong → Noto Serif CJK SC → serif` |
| 宋体 | `SimSun → Songti SC → Noto Serif CJK SC → serif` |

### X.3 验证

- 手机视口（430×900，DPR 2.4）实测：页面 `x=16 … 466`，舞台 `0…482`，左右各 16px 对称；
  `scrollWidth == clientWidth`，无横向溢出。
- SVG 由 210×297 的 viewBox 渲染为 450×637，比例 1.414，与实际纸张一致。

> 备注：headless 截图在 `--window-size` 小于 WebView 最小宽度时会被裁切，
> 直接用像素数算边距会得出「右边没留白」的错误结论——以 `getBoundingClientRect` 为准。

### X.4 复诊：真机像素给出了真凶（v0.10.4）

v0.10.3 的三条加固把边距修对了（真机左右各 53/54px），但「偏上 + 下面大留白」还在。
这次直接量用户截图：**1224×2700，白页 1117×1429，宽高比 0.782**——A4 应该是 0.707。

页面被压扁 10%，所以：

- 内容在纸内的相对位置全部上移 → 顶部看着像被截；
- 页面盒比正常 A4 矮 → 下方剩一大块背景色。

原因：SVG 同时带 `width="210mm" height="297mm"` 与 CSS `width:100%`。
Android WebView 按本机 DPI 把 `297mm` 解析成一个**固定 px 高度**，宽度却被 CSS 拉满，
两者比例对不上，`preserveAspectRatio` 只能把图形 letterbox 进这个比例错误的盒子。

修法：SVG **只输出 `viewBox`**，不写 `width`/`height`。没有固有尺寸时，
`width:100%; height:auto` 会按 viewBox 的 210:297 计算高度，任何引擎结果一致。

配套两处：

1. `.ofd-stage` 改为纵向 flex + `.ofd-page { margin: auto }` —— 安全居中：
   放得下时上下留白相等；放不下时 auto 边距归零、从顶部显示，不会被裁掉顶端。
2. `.ofd-page { line-height: 0 }`，容器高度与 SVG 严格相等。

实测（Edge，DSE 2.7）：

| 视口高 | 页面 | 比例 | 上/下留白 | 滚动 |
|---|---|---|---|---|
| 807 | 449×635 | 0.707 | 90 / 82 | 807/807 不滚 |
| 467 | 449×635 | 0.707 | 40 / −208 | 707/467 可滚，顶部完整 |

文字横向位置也复核过：正文 TextObject 最小 x = 30.86mm，渲染后左边距 70px / 右边距 61px
（449px 宽页面），与原件一致——之前看起来「偏」是压扁带来的错觉。

## 附录 Y：本地备份与 WebDAV（v0.11.0）

### 包格式

一个普通 zip，丢到任何解压软件里都能看：

```text
manifest.json    app / format / version / created_at / books / covers / platform
cenro.db         SQLite 快照
covers/*.jpg     封面缩略图（可选）
```

`manifest.json` 不是为了好看才放的：恢复入口允许用户选任意 zip，
没有格式标识的话，随手选一本书的 cbz 也能「恢复成功」，然后把真书库覆盖成空。

### 为什么不用「复制 cenro.db」

库开着 WAL，最新一次阅读进度可能还躺在 `-wal` 里。裸拷 `cenro.db` 拿到的是
旧快照，运气差还会拷到写了一半的页。所以导出用 SQLite 的 online backup API：

```rust
conn.backup("main", &tmp_db, None::<fn(Progress)>)?;
```

恢复同理，`conn.restore("main", &tmp_db, ..)` 写回**当前打开的连接**。
换成「删文件 + 复制 + 重开」的做法要先关连接——`Mutex<Connection>` 里拿着它，
Windows 上还删不掉被占用的文件，绕的路比这一行多得多。

### 恢复之后的三件事

1. `db::init()` 再跑一遍：老备份来自更早的版本，可能缺 `meta_locked` / `status` 列，
   或者 `type` 上还挂着旧的 `CHECK (type IN ('novel','comic','pdf'))`。
2. 封面重指：备份里的 `cover_path` 是**备份那台机器**的绝对路径，换机后全是死链。
   判据只有一条——本机 `covers/<book_id>.jpg` 在不在。不在就置 `pending`，
   留着旧路径只会得到一排裂图。
3. 清 `text_cache`：缓存的是旧书的全文，恢复后 book_id 可能指向完全不同的文件。

### WebDAV 的 TLS 选择

| 平台 | 后端 | 原因 |
|---|---|---|
| 桌面 | native-tls（Windows = schannel） | 读系统证书store，抓包 / 加速工具注入的根证书也能过 |
| Android | rustls + webpki-roots | 没有 schannel；平台校验器在 Android 上要额外的 JVM 初始化 |

桌面不用 rustls 的原因很具体：它只认内置根列表，遇到 Steam++ 这类本地 MITM
会直接 `UnknownIssuer`——这个坑本项目在 GitHub 下载上已经踩过一次。
移动端也不用 reqwest 的 `rustls` 特性：那会拉 aws-lc-rs，需要 cmake / nasm。

### 交互

- 确认框是「覆盖」级别，所以一律走 `danger`，并把「本地书籍文件不会被删除」
  写进正文——用户最怕的是恢复把书也删了。
- 备份子页里开确认框时通过 `onModal` 告诉抽屉：抽屉让出 Esc 与焦点陷阱。
  否则两个 `keydown` 监听都会处理 Esc，按一下会同时关掉对话框和设置页。
- 删除本地备份包先 `canonicalize` 再比前缀，只允许删应用备份目录内的文件。
  这条命令的名字叫「删除备份」，不该变成一个凭字符串删任意路径的入口。

## 附录 Z：备份与隐私书架（v0.11.1）

### 为什么排除动作发生在快照上

`Connection::backup` 是整库复制，没有「按行导出」。所以 `export` 的顺序是：

1. `conn.backup("main", tmp_db)` —— 拍一份完整快照
2. 在**快照**上 `DELETE FROM books WHERE private = 1`
3. 从快照里读 `COUNT(*)` 与 `id` 列表，据此挑封面
4. 压缩

标题、数量、封面三者都取自同一个副本，不会出现「包里 3 本、封面 4 张」这种对不上的情况。
原始库全程只读。

### 默认值的取向

`include_private` 的默认值是 `false`，而且**前端在没有隐私书时也不会问**：

```text
点「备份」→ backup_scope()
  ├─ private_books == 0 → 直接备份（不含隐私书，等价）
  └─ private_books > 0  → 弹确认框
         只备份普通书架（主按钮 / 默认）
         一并备份（次按钮）
         取消（不发起任何操作）
```

「取消」不发起备份——三按钮容易写成「取消也走一遍默认分支」，这里单独一条 `closeAsk`
就是为了不把「取消」变成「按默认执行」。

### 一个必须记住的坑：`upsert_book` 不能写 private

扫描器每本书都先 `new_book(...)`，那里 `private: false`。如果 `upsert_book` 的
`ON CONFLICT` 带上 `private = excluded.private`，一次「重新扫描」就把隐私书搬回公开书架，
而且没有任何提示。现在 `upsert_book` 只更新 6 个随文件走的字段，`private` 只由
`set_private` 改，扫描器**没有**任何路径能碰它。

写单测时同样踩了一次：用 `upsert_book(private: true)` 造样本，读回来是 0。
正确做法是 upsert 之后单独 `set_private`。

### 临时文件命名

`cenro-snapshot-{pid}` 在测试里并行跑会互相踩——一个测试把另一个正在写的快照删掉，
报错是 `attempt to write a readonly database`，看起来像权限问题。
改成 `{pid}-{自增序号}`（`temp_path`）后 4 个失败用例同时转绿。

## 附录 AA：隐私书架 P1（v0.12.0）

### 边界先写在最前面

P1 = 可见性隔离。**不做加密**，所以在「关于 / 隐私」两处都写清了：
书还在磁盘上、标题还是文件名。这不是保守，是怕用户以为自己已经安全了。

### fail-closed 的入口

```sql
CREATE VIEW books_visible AS SELECT * FROM books WHERE private = 0;
CREATE VIEW books_private AS SELECT * FROM books WHERE private = 1;
```

列表、搜索、计数全部改查视图。视图不可写，所以写操作仍然对着 `books` 表——
这反而拦住了「以为往视图 INSERT 就能加书」的误解。

`library_stats` 单独改 `count_visible`：如果它还报全量，
「库里 30 本 / 书架显示 27 本」就把隐私书的存在性卖了一次。

### 守卫只做一件事：让隐私书和「不存在」长得一模一样

```rust
fn visible_book(state, id) -> Result<Book> {
    let book = db::get_book(conn, id)?.ok_or(不存在)?;
    if book.private && !state.unlocked() { return Err(不存在); }
    Ok(book)
}
```

所有按 id 取书的命令（`open_*`、`get_book`、`book_kind`、`save_progress`、
`remove_book`、`relocate_book`、`update_book_meta`）都改走它。
不返回 403 是刻意的：`id = sha256(path)[..8]`，知道路径就能算，
403 等于「这本书在，但我不给你看」。

**注意**：P1 的 PIN 只挡界面，挡不住任何能读磁盘或能调起 devtools 的人——
后者可以直接 `invoke("privacy_lock")` 之外的一切都试一遍。P2 才有密码学意义。

### 封面必须跟着走

`privacy_move` = 打标记 + 把 `covers/{id}.jpg` 搬到 `private_covers/{id}.jpg` + 改 `cover_path`。
搬运用 `rename`，跨设备失败时退回复制。关键不在于「藏」，而在于
**公开目录里不能有那张缩略图**——它是 L1 里唯一「一眼就能看到内容」的泄露点。

所以扫描器必须配合：

```rust
if existing.as_ref().map(|b| b.private).unwrap_or(false) {
    return Ok(Ingest::Skipped);
}
```

少这一行，`cover_missing` 分支会把缩略图重新生成到公开的 `covers/` 里，
标记没丢、封面已经泄露。这条有专门单测（`rescan_keeps_private_books_private`）。

### PIN 的存法

Argon2id + 随机盐 → PHC 字符串 → `privacy.json`（Unix 权限 600）。
6 位数字离线爆破本来就不难，所以目标不是「抗暴力」，而是「别把 PIN 明文留在磁盘上」。

失败退避：前 4 次不罚（打错很正常），之后 2^n 秒、封顶 30 秒。
**不锁死**——本地应用没有找回通道，锁死只伤用户；真正的攻击者面对的是磁盘上的哈希。

解锁态只存 `Instant` 在内存里，进程退出即失效。自动上锁按「最后一次解锁」算，
不是「最后一次操作」算，实现简单也不会有心跳开销。

### 没做但记下来的

- Windows Hello / 生物识别（P3）
- 切后台立即锁（`window blur`）
- 拖拽入隐私书架（现在是右键「移入隐私书架」，只在解锁后出现）
- 隐私书的阅读进度隔离（现在进度正常保存，只是锁定时读不到记录）

### 补一条：没启用 PIN 时，会话算「解锁」

```rust
if !enabled { return true; }   // unlocked()
```

初版把「未启用」也当作锁定，结果造出一个死局：忘了 PIN → 删掉 `privacy.json` →
`enabled=false` 但书还标着 `private=1` → 隐私书架进不去（要 PIN）、书架也看不见它们
（视图过滤），只能改数据库才能捞回来。

现在：没有 PIN 就没有可挡的东西，视为解锁。隐私书架会直接列出那几本并给「移出」，
隐藏空态换成「当前没有设置 PIN，这些书暂时可见」。这个恢复路径也写进了设置页的说明里。

## 附录 Z：面板化外壳与侧栏三块（v0.13.0）

用户线框稿：窗口四周留底 → 顶栏通栏面板 / 左侧三块抽屉面板 / 右侧一块内容面板。
方向确认后按「只改容器，不动信息架构」实现。

### 结构

```html
<div class="app-shell">          <!-- padding: 8px，露出 app 底色 -->
  <header class="topbar">        <!-- 圆角 + 1px 描边 -->
  <div class="shelf-body">       <!-- gap: 8px -->
    <nav class="sidebar">        <!-- 透明容器，三块 .side-panel -->
      <section>视图</section>
      <section class="side-panel-grow">格式 + .side-panel-foot(添加目录)</section>
      <section>工具</section>
    </nav>
    <main class="content">       <!-- 圆角 + 描边，底色 = app -->
  </div>
</div>
```

### 三个取色判断

1. **内容面板用 `--c-bg-app` 而不是 surface**。亮色下 surface 与卡片同为 `#ffffff`，
   面板一旦用 surface，卡片只剩阴影能区分（`--shadow-card` 在白底上很弱）。
   用 app 等于给内容区挖一个凹槽，卡片继续浮着。
2. **面板不加阴影，只加 1px `--c-border-subtle`**。窗口 / 面板 / 卡片三层都带阴影会显脏；
   规范也要求阅读区禁止常驻阴影，书架层靠底色差表达层次。
3. **侧栏面板用 surface**（亮色白、暗色 `#1b1d21`），与内容凹槽形成一凸一凹。

### 实测踩到的：`flex: 1` 会把格式面板撑成空盒子

首版给 `.side-panel-grow { flex: 1 }`，理由是「格式项多时让列表滚动」。
1440×900 下渲染出来：5 个条目只占 150px，面板被拉到 500px 高，
「添加目录」固定在底部，中间留近 350px 纯空。

只有 5 个格式项，撑满没有意义。改为：

```css
.side-panel-grow { flex: 0 1 auto; min-height: 0; }
.side-panel-scroll { flex: 0 1 auto; min-height: 0; overflow-y: auto; }
```

内容少时贴合内容；窗口变矮时 shrink 生效，由面板内列表滚动消化。
以后格式族变多（比如加「表格」「网页」），这条也不用改。

### 折叠态必须退化

侧栏有两个折叠来源：手动（`data-sidebar="collapsed"`）和窗口 768–1199px 自动。
64px 里再放 8px 内边距 + 描边 + 三层圆角，等于三个空盒子套三个图标。

做法：面板观感走 CSS 变量，折叠时整组置透明——

```css
.sidebar { --panel-bg: ...; --panel-line: ...; --panel-pad: ...; }
.app-shell[data-sidebar="collapsed"] .sidebar,
@media (min-width:768px) and (max-width:1199px) .sidebar {
  --panel-bg: transparent; --panel-line: transparent; --panel-pad: var(--sp-1);
}
```

同时隐掉 `.side-panel-foot` 的上边框与内边距，否则「添加目录」上方会留一条凭空的分隔线。

### 偏离登记：顶栏去掉设置按钮

UI_SPEC §4.2 顶栏示意图是「☰ | Logo | 搜索 | 视图切换 | 导入 | 设置」。
本版把设置移到侧栏底部（第三块面板），顶栏在 ≥768px 不再显示设置图标。

理由：线框稿的顶栏右侧是空的；设置是低频只读入口，挂在侧栏底部比挤在写操作旁更合理，
也让「导入」这个唯一的 Primary 更突出。

**不是删除功能**：手机（<768px）侧栏整块隐藏，顶栏设置图标保留；`Ctrl/Cmd + ,` 两端都可用。
若要回到规范原样，只需删掉 `@media (min-width:768px){ .topbar-settings{display:none} }` 这一条。

### 「添加目录」为什么放在格式面板底部

它原先只出现在两个地方：设置 → 书库、书架空白处右键菜单。后者几乎没人会发现，
而它是新用户第一个要做的动作。挂在侧栏底部后常驻可见，且与设置 → 书库调的是同一个
`handleImportFolder`，行为完全一致（0.7.1 修过的那个接线错误不会在这里复现）。

### 未做

- 「列表 / 面板」样式开关：判断依据还在攒，先只留一套，避免两套都要维护。
- 三块面板的展开收起：内容量不足以需要折叠，加了只是多一个状态。
- 手机端：不启用（<768px），侧栏隐藏，四周留白只会让窄屏更挤。

## 附录 AB：书签与书内搜索（0.16 目标）

### 一张表，两种坐标

标注（书签 / 高亮 / 笔记）共用 `annotations`，位置存 `Progress` 的 JSON——
和阅读进度**完全同一套坐标**。好处是「跳到书签」与「跳到搜索结果」是同一段代码，
续读逻辑也不用另写一份。

`ON DELETE CASCADE` 让删书时自动清掉标注；`PRAGMA foreign_keys` 本来就开着，
所以不用在删除逻辑里再手动补一刀。

### 搜索扫什么

| 族 | 扫的对象 | 为什么 |
|---|---|---|
| txt / mobi / fb2 / rtf / mhtml | `load_plain_text` 解出的正文 | 与阅读器同一个字符串，章节偏移天然对齐 |
| html / md / docx / xlsx | **HTML 本身**（先剥标签） | 阅读器的章节偏移基于 HTML，换成纯文本就对不上 |
| EPUB / PDF / 漫画 | 暂不支持 | 正文按章节 / 页面懒加载，需要分批扫 + 另一套定位 |

剥标签用的是「把 `<...>` 替换成等长空格」：字节长度不变 → 偏移不变；
替换后天然没有标签 → 片段直接可显示。用 `regex` 删标签会改变长度，位置全错。

大小写只折叠 ASCII：`to_lowercase()` 对某些字符会改变字节长度，
一旦长度变了，所有偏移作废。

### 跳转的两个坑

1. **HtmlViewer 的 `jumpToPercent` 是按章节数均分的**（每章等宽），
   章节长短不一时会落到别的章。所以书签跳转不走百分比，直接按字节偏移定位章节 + 章内比例。
2. ReaderShell 的 `percent` 本来就是 `offset / total_bytes`，反推偏移是精确的，
   这里可以直接换算。

### 未做

- EPUB / PDF / 漫画的书签与搜索（面板已支持 `searchable={false}` 的降级文案）
- 高亮（区间型锚点）：`kind` 与表结构已留好，缺的是选区 UI

---

## 包标识再次变更（0.21.0）

`com.lumviox.cenro` → `com.lumivox.cenro`。原因是作者名在早期版本里被写错成 `Lumviox`，
包标识跟着错了。上表记录的是历史事实，不回改；本次变更的实际影响：

| 影响面 | 变化 |
|---|---|
| Windows 数据目录 | `%APPDATA%\com.lumviox.cenro` → `%APPDATA%\com.lumivox.cenro`，启动时自动整目录迁移 |
| Android 包名 | 新包 = 新应用，旧 APK 需卸载；沙箱数据不跨包，书要重新导入 |
| 文件关联 | 安装包按新标识重新注册；旧键由旧版卸载程序带走 |
