# 未支持格式可行性研究

日期：2026-11-13
范围：对照 Calibre 支持的格式面，逐个评估「能不能读、读出来像不像书、许可证与编译代价」。

判定口径固定三条，缺一条就不做：

1. **能拿到正文**——不是靠 OCR，也不需要外部二进制（unrar.exe / djvulibre.dll 之类）；
2. **读出来是阅读形态**——固定版式的图表/公式允许丢，但文字顺序要能读；
3. **依赖可接受**——纯 Rust 优先；C/C++ 依赖要看许可证与在本机构建是否通过。

探针工程：`.workbuddy/tmp/fmtprobe`（临时 crate，只做 `cargo check` 与真实样本验证）。

另见：[KOODO_FORMAT_NOTES.md](KOODO_FORMAT_NOTES.md)——同类项目 Koodo Reader 的格式支持拆解，
它用 WASM/JS 轮子绕开了 C 库编译问题，CHM / CAJ / OFD 的接法可借鉴。

---

## 一、结论总表

| 格式 | 待办成本 | 依赖 / 许可证 | 编译实测 | 结论 |
|---|---|---|---|---|
| CBR（RAR 漫画） | 低 | `unrar-rs` 0.16，Apache-2.0 + UnRAR 条款 | ✅ 8.5 s，纯 Rust（`crypto-rust`） | **已实现**（本轮） |
| MOBI HUFF/CDIC | 已完成 | 自研（`mobi_huff.rs`），无第三方依赖 | ✅ 真实样本验证通过 | **已实现**，32,677 字样本解出正常正文 |
| KF8 AZW3 分片重组 | 中高 | 参考实现见 `F://REA//recovered-all//kookit.js:20807` | — | P2，需真实样本书 |
| DjVu | 中高 | `djvu-rs` 0.44，MIT，纯 Rust | ✅ 16.8 s | P2，做成图片型阅读器 |
| CAJ | 中高 | `rs-caj-ir` / `rs-caj-jbig` / `rs-caj-pdf` 0.1.0 | 未验证 | P2/P3，导入即转 PDF |
| CHM | 中 | 两条路：`chmlib-ts`（WASM）或按还原源码移植（LZX 仅 90 行） | ❌ chmlib-sys C 编译失败 | P2，改走 WASM 或移植 |
| 旧 DOC | 中高 | `rust-docx` 0.2（声称支持）、`cfb` 0.16 | 未验证 | P3 |
| PPT/PPTX | 中 | `pptx-to-md` 2.0，MIT/Apache | ✅ 16.8 s | P3，价值低 |
| XPS / OXPS | 高 | 无成熟 crate | — | 不做 |
| OFD | 高 | `ofd-rs` 0.2（很年轻） | 未验证 | 不做 |
| 纯 XML | — | — | — | 不做（口径问题） |

---

## 二、逐个说明

### CBR（RAR 打包的漫画）— 已实现

- **方案**：`unrar-rs` 0.16.1，纯 Rust 的 RAR 读解器，不依赖 WinRAR 或 libunrar。
  条目表读取不解压正文；取单页时按名定位后只解一条到缓存。
- **实测**：用本机真实 RAR5 文件验证——`len=1`、条目名/大小正确、`copy_to` 解出 4722 字节与原文一致。
- **许可证**：Apache-2.0，另加 UnRAR 原始条款——「可自由用于处理 RAR 归档，但不得用于开发 RAR 兼容压缩器」。
  只读用途完全覆盖；二进制分发需附该条款文本（已记录在 `Cargo.toml` 注释与本节）。
- **默认特性坑**：默认启用 `crypto-aws-lc`（会编 C 的 aws-lc-rs）。这里用 `default-features = false,
  features = ["crypto-rust"]`，保持纯 Rust，构建时间从「分钟级」降到 8.5 秒。
- **边界**：分卷 RAR（`.part1.rar`）只读第一只卷的头部；带密码的 CBR 会报错而不是乱码。

### MOBI 的 HUFF/CDIC 与 KF8（AZW3）

- **HUFF/CDIC 已实现并验证**：`mobi_huff.rs`（约 200 行）按 mobiunpack 的公开算法实现
  HUFF 表 + CDIC 字典 + 递归展开；`mobi.rs` 按 compression 分流（1/2 走 PalmDOC，17480 走 HUFF）。
  拿 libmobi 的 `sample-unicode-huffdic.mobi` 实测：32,677 字符、书名 `Libmobi`、作者 `Bartek Fabiszewski`，
  正文无替换字符。
- **踩坑记录**：先试了 `mobi` 0.8 crate，它在真实样本上 `max_code - code` 下溢（debug 直接 panic），
  源码里还留着调试 println，不可用，只能自己写。
- **顺带修的 bug**：MOBI 书名/作者按 MOBI 头 `0x44/0x48` 取（此前误用 `0x54`，真实文件上取到的是
  language 字段，一直静默回退到文件名）。
- **KF8（AZW3 专属）仍未支持**：KF8 正文是分片记录，要先按 FDST 映射，再用 INDX/SKEL/FRAG 重组，
  直接按记录顺序拼会得到乱序文本。可读参考实现见 `F://REA//recovered-all//kookit.js:20807`
  （`kookit.js` 里 `KF8` 类 373 行），移植到 Rust 约 400–500 行，需要真实 AZW3 样本验证。

### DjVu

- **方案**：`djvu-rs` 0.44，MIT，纯 Rust，`open()` / `page_count()` / 逐页渲染到 PNG 都具备。
  接法是把每页渲染进漫画缓存，当作「图片型漫画」读——DjVu 本来就是这个形态。
- **代价**：依赖树较大（`djvu-zp` / `djvu-iw44` / `djvu-jb2` 等），编译 +16 秒；渲染一页几十到几百毫秒，
  需要和 CB7 一样做「首次渲染缓存」。
- **价值**：中文扫描古籍/期刊里 DjVu 仍常见，但比 MOBI/PDF 少一个量级。
- **工作量**：中高（新格式 + 新渲染管线 + 缓存策略），约 1–2 天。

### CHM（编译的 HTML 帮助）

- **方案**：`chmlib` 1.0 绑定 CHMLib C 库，能列目录并解出内部 HTML，再走现有 HTML→文本链路。
- **实测失败**：`chmlib-sys` 自带的 `chm_lib.c` 在本机 MSVC 14.44 上 `cl.exe` 直接退出（code 2）。
  可以试着打补丁（多为老 C 的 `/W0` 与编码问题），但维护成本转移到我们这边。
- **许可证**：LGPL-2.1。静态链接进 Tauri 应用属于「分发含 LGPL 代码的二进制」，
  需要提供可重链接手段，对个人项目是负担。
- **结论**：不做。用户真要读 CHM，Calibre 转 EPUB 一次即可。

### XPS / OXPS

- 结构是 ZIP + 固定版式 XAML（`FixedPage`）。没有成熟 Rust 渲染器；
  自己解只能抽到文字，位置/图片/矢量全丢，读起来是一堆散句。
- **结论**：不做。需要时先用系统「打印到 PDF」。

### OFD（国标固定版式文档）

- `ofd-rs` 0.2.0 存在但极年轻（0.2 版本、单一维护者），OFD 同样是固定版式 + 自绘字形，
  抽文字会遇到嵌入字体子集缺 ToUnicode 的问题。
- **结论**：不做（P3 观察）。

### CAJ（知网）

- `rs-caj-ir` / `rs-caj-jbig` / `rs-caj-pdf` 0.1.0 是一组纯 Rust 实现：解析容器 → 解私有 JBIG → 输出 PDF。
- 接法不是「直接读」，而是**导入时转换**：`.caj` → PDF 落到缓存 → 交给 PDF 阅读器。
  需要一个转换管线（进度、失败态、原文件保留），且 0.1.0 的版本覆盖面未知。
- **结论**：P2/P3。对中文用户价值不低，但要先验证覆盖率再投入。

### 旧 DOC（Word 97-2003）

- 二进制 OLE/CFB 容器，正文在 `WordDocument` 流里，靠 FIB + piece table 定位；
  `rust-docx` 0.2 声称兼容 legacy doc，另可用 `cfb` 0.16 自己解（工作量大）。
- **结论**：P3。用户把 `.doc` 另存为 `.docx` 的成本远低于我们实现的成本。

### PPT / PPTX

- PPTX = ZIP + `ppt/slides/slideN.xml`，抽文字不难；`pptx-to-md` 2.0 编译通过，输出 Markdown，
  可直接复用现有 MD 链路。旧 `.ppt` 是 OLE 二进制，同 DOC 的难度。
- **结论**：P3。演示文稿当书读价值有限，收益不抵一个新入口的心智成本。

### 纯 XML

- 不接。`.xml` 在真实书库里更多是 OPDS 目录、阅读器配置、Calibre 元数据，收进书架只会制造噪音。
  `.xhtml` 已按 HTML 处理，够用。

---

## 三、建议的执行顺序

| 顺序 | 事项 | 理由 |
|---|---|---|
| 1 | ✅ CBR | 成本最低、收益最高（漫画格式里 RAR 占比仅次于 ZIP） |
| 2 | MOBI HUFF/CDIC 兜底 | 现有解析器覆盖不到的那部分 Kindle 书，一个 crate 能补；需样本 |
| 3 | DjVu | 纯 Rust、MIT、渲染路径清晰，但工作量大，放到有真实需求时 |
| 4 | CAJ | 中文场景有需求，先验证 `rs-caj` 的版本覆盖率再决定 |
| — | CHM / XPS / OFD / 旧 DOC / PPT | 不做，或等上游 crate 成熟 |

## 四、复现方法

```bash
# 探针工程（不污染主工程依赖）
cd .workbuddy/tmp/fmtprobe
# 逐个换成候选依赖后 cargo check，并跑真实样本
cargo run -- path/to/sample.rar
```
