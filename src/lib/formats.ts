/**
 * 书库支持的扩展名。
 *
 * 与 Rust 侧 `scanner::classify` 保持一致：
 * 小说 txt / md / html / xhtml / epub / mobi / prc / azw3 / azw / fb2 / docx / rtf / mhtml；
 * 漫画 cbz / cbr / cbt / cb7 / 图片型 mobi / zip；文档 pdf / ofd / xlsx；
 * 以及「同层图片 ≥3 张」的文件夹。
 * 改这里时记得同步改那边。
 *
 * `.zip` / `.cbt` / `.cb7` 只有内部图片条目 ≥3 才会被收作漫画，普通压缩包会被扫描器忽略。
 */
/** 是否属于我们支持的书籍扩展名（手机端选完文件后自检用） */
export function isSupportedBook(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return BOOK_EXTENSIONS.includes(ext);
}

export const BOOK_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "html",
  "htm",
  "xhtml",
  "epub",
  "mobi",
  "prc",
  "azw3",
  "azw",
  "fb2",
  "docx",
  "rtf",
  "mhtml",
  "mht",
  "cbz",
  "cbt",
  "cb7",
  "cbr",
  "zip",
  "pdf",
  // 版式文档（中文公文标准）
  "ofd",
  // Excel（仅 xlsx，二进制 .xls 不支持）
  "xlsx",
];

/** 供 <input type="file" accept> 使用 */
export const BOOK_ACCEPT = BOOK_EXTENSIONS.map((ext) => `.${ext}`).join(",");

/**
 * 手机端 `accept` 必须额外放行 `application/octet-stream`。
 *
 * Android 的文件选择器只按系统 MIME 表匹配 `.ext`：`.ofd` 不在表里，
 * 系统把它报成「BIN 文件」/`application/octet-stream`，于是被 accept 过滤掉、显示成灰色不可选
 * （截图里 `测试.ofd` 就是灰的）。桌面端不依赖 accept，所以只有这一处要补。
 *
 * 代价是选择器会多显示一些二进制文件——挑选后仍会按扩展名校验，见 `isSupportedBook`。
 */
export const MOBILE_ACCEPT = [
  BOOK_ACCEPT,
  // 未知扩展名在 Android 上通常报成这个，放行才能选到 .ofd
  "application/octet-stream",
  // 少数文档提供方会给 ofd 自带 MIME，一并写出来省得到时候又灰掉
  "application/ofd",
  "application/x-ofd",
].join(",");

