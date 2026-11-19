export type BookType = "novel" | "comic" | "pdf" | "doc";
export type BookFormat =
  | "txt"
  | "md"
  | "html"
  | "epub"
  | "mobi"
  | "azw3"
  | "fb2"
  | "docx"
  | "rtf"
  | "mhtml"
  | "cbz"
  | "zip"
  | "cbt"
  | "cb7"
  | "cbr"
  | "folder"
  | "pdf"
  | "ofd"
  | "xlsx";
export type CoverState = "pending" | "ready" | "placeholder" | "failed";
export type SpreadMode = "single" | "double" | "webtoon";

/**
 * 与 Rust 侧 models::Progress 一一对应。
 * 不做统一字符偏移：EPUB 在字号/页宽变化后偏移会失效。
 * 三种形态都带总长度，供 UI 计算百分比（UI_SPEC 5.4）。
 */
export type Progress =
  | { kind: "text"; offset: number; chapter: number; total: number }
  | { kind: "epub"; cfi: string | null; href: string; progression: number }
  | { kind: "paged"; page: number; total: number; zoom: number; spread: SpreadMode };

export interface Book {
  id: string;
  type: BookType;
  format: BookFormat;
  path: string;
  size: number;
  mtime: number;
  title: string;
  author: string | null;
  cover_path: string | null;
  cover_state: CoverState;
  /** 手动改过书名/作者，扫描不会用文件名覆盖 */
  meta_locked: boolean;
  /** 记录状态：ok 正常；pending 表示删除事务中断、等待用户处理 */
  status: "ok" | "pending";
  /** 属于隐私书架（备份默认排除） */
  private: boolean;
  /** 记录里的路径当前不存在（运行时判定，文件可能被外部移走） */
  missing: boolean;
  progress: Progress | null;
  metadata: Record<string, unknown> | null;
  added_at: number;
  last_read_at: number | null;
}

export interface LibraryRoot {
  id: number;
  path: string;
  added_at: number;
}

/** 扫描失败明细：只报数字等于让用户自己去猜哪本、为什么 */
export interface ScanFailure {
  path: string;
  message: string;
}

export interface ScanReport {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  failed: number;
  failures: ScanFailure[];
  elapsed_ms: number;
}

export const TYPE_LABEL: Record<BookType, string> = {
  novel: "小说",
  comic: "漫画",
  pdf: "PDF",
  doc: "文档",
};

export const FORMAT_LABEL: Record<BookFormat, string> = {
  txt: "TXT",
  md: "Markdown",
  html: "HTML",
  epub: "EPUB",
  mobi: "MOBI",
  azw3: "AZW3",
  fb2: "FB2",
  docx: "DOCX",
  rtf: "RTF",
  mhtml: "MHTML",
  cbz: "CBZ",
  zip: "ZIP",
  cbt: "CBT",
  cb7: "CB7",
  cbr: "CBR",
  folder: "图片集",
  pdf: "PDF",
  ofd: "OFD",
  xlsx: "Excel",
};

export interface Chapter {
  title: string;
  /** 字节偏移，前端只当不透明游标用 */
  start: number;
  end: number;
}

export interface TextBook {
  encoding: string;
  total_bytes: number;
  chapters: Chapter[];
}

export interface EpubChapter {
  /** zip 内规范化路径 */
  href: string;
  title: string;
}

export interface EpubMeta {
  title: string;
  author: string | null;
  chapters: EpubChapter[];
}

/**
 * 莫奈取色的采样结果（`monet_palette` 命令）。
 *
 * 后端只给「这张图是什么色相」，不直接给可用的强调色：
 * 同一个色相在亮色与暗色纸面上需要的明度不同，派生必须在前端按当前主题算。
 */
export interface MonetSwatch {
  /** 0~360 */
  hue: number;
  /** 0~1，有效像素的加权平均饱和度 */
  saturation: number;
  /** 0~1 */
  lightness: number;
  /** 整图平均明度，用来判断这张图会不会压住文字 */
  mean_lightness: number;
  /** 有效像素占比；低于 0.02 视为灰阶图，没有可用色调 */
  coverage: number;
}
