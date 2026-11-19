import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type {
  Book,
  EpubMeta,
  LibraryRoot,
  MonetSwatch,
  Progress,
  ScanReport,
  TextBook,
} from "./types";
export interface ExportBooksReport {
  copied: number;
  /** 其中因重名改了文件名的本数 */
  renamed: number;
  /** 文件不在本地的书名 */
  missing: string[];
  /** 复制失败的书名 */
  failed: string[];
  /** 隐私书未解锁而跳过的数量 */
  blocked: number;
  total: number;
}

export const api = {
  listRoots: () => invoke<LibraryRoot[]>("list_roots"),
  addRoot: (path: string) => invoke<LibraryRoot>("add_root", { path }),
  removeRoot: (id: number) => invoke<void>("remove_root", { id }),
  scanLibrary: () => invoke<ScanReport>("scan_library"),
  /** 打开前确认实际类型（MOBI 可能是图片型漫画），会顺带修正库里的记录 */
  bookKind: (id: string) => invoke<string>("book_kind", { id }),
  /** 手动修改书名与作者，会锁定书名不被扫描覆盖 */
  updateBookMeta: (id: string, title: string, author: string) =>
    invoke<void>("update_book_meta", { id, title, author }),
  /**
   * 移除书籍：deleteFile 为 true 时连同本地文件一起删除（移入回收站）。
   * `removed_copy` 为 true 表示顺带清掉了库内副本（应用自己复制进来的那份）。
   */
  removeBook: (id: string, deleteFile: boolean) =>
    invoke<{ file_trashed: boolean; pending: boolean; removed_copy: boolean }>("remove_book", {
      id,
      deleteFile,
    }),
  /** 重新定位：把记录指到新选的文件，保留阅读进度 */
  relocateBook: (id: string, path: string) => invoke<Book>("relocate_book", { id, path }),
  listBooks: (query?: string, kind?: string) =>
    invoke<Book[]>("list_books", { query: query ?? null, kind: kind ?? null }),
  getBook: (id: string) => invoke<Book | null>("get_book", { id }),
  /** 双击打开的书：挂载后取一次，取完即清 */
  takeStartupBook: () => invoke<string | null>("take_startup_book"),
  saveProgress: (id: string, progress: Progress) =>
    invoke<void>("save_progress", { id, progress }),
  stats: () => invoke<number>("library_stats"),
  /** 批量导出：把选中的书复制到目标目录，原文件不动 */
  exportBooks: (ids: string[], dir: string) =>
    invoke<ExportBooksReport>("export_books", { ids, dir }),
};

/** 本地文件 → webview 可用的 asset URL。封面与原图都走这条通道。 */
export function fileUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

/**
 * 莫奈取色（v1.9）。放后端而不是前端 canvas：
 * 背景图走 asset 协议是另一个 origin，画到 canvas 会被 taint，
 * `getImageData` 直接抛 SecurityError。
 */
export const monetApi = {
  extract: (path: string) => invoke<MonetSwatch>("monet_palette", { path }),
};

export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** TXT 专用：打开时解码全文并切章，正文按区间懒取。 */
export const textApi = {
  open: (id: string) => invoke<TextBook>("open_text_book", { id }),
  range: (id: string, start: number, end: number) =>
    invoke<string>("read_text_range", { id, start, end }),
};

/** 单文件 HTML：按标题切章，章节内容是原始 HTML（前端清理后渲染）。 */
export const htmlApi = {
  open: (id: string) => invoke<TextBook>("open_html_book", { id }),
  chapter: (id: string, start: number, end: number) =>
    invoke<string>("read_html_chapter", { id, start, end }),
};

/** Word / Excel：后端转成 HTML 后切章，复用 HTML 阅读器。 */
export const docxApi = {
  open: (id: string) => invoke<TextBook>("open_docx_book", { id }),
  chapter: (id: string, start: number, end: number) =>
    invoke<string>("read_docx_chapter", { id, start, end }),
};

export const xlsxApi = {
  open: (id: string) => invoke<TextBook>("open_xlsx_book", { id }),
  chapter: (id: string, start: number, end: number) =>
    invoke<string>("read_xlsx_chapter", { id, start, end }),
};

/** OFD：后端把每页转成 SVG，前端逐页显示。 */
export interface OfdMeta {
  title: string;
  pages: number;
  width: number;
  height: number;
}

export const ofdApi = {
  open: (id: string) => invoke<OfdMeta>("open_ofd", { id }),
  page: (id: string, index: number) => invoke<string>("ofd_page_svg", { id, index }),
};

/** Markdown：后端转成 HTML 后切章，前端复用 HTML 的渲染与清理。 */
export const mdApi = {
  open: (id: string) => invoke<TextBook>("open_md_book", { id }),
  chapter: (id: string, start: number, end: number) =>
    invoke<string>("read_md_chapter", { id, start, end }),
};

/** 漫画：先从页面名列表拿索引，再按需取本地路径（CBZ 首次访问会解压到缓存）。 */
export const comicApi = {
  listPages: (id: string) => invoke<string[]>("list_comic_pages", { id }),
  pagePath: (id: string, index: number, name: string) =>
    invoke<string>("comic_page_path", { id, index, name }),
};

/** EPUB：解析 spine 与 nav，正文按章拉取原始 XHTML。 */
export const epubApi = {
  open: (id: string) => invoke<EpubMeta>("open_epub", { id }),
  chapter: (id: string, href: string) =>
    invoke<string>("read_epub_chapter", { id, href }),
  resource: (id: string, href: string) =>
    invoke<string>("read_epub_resource", { id, href }),
};

export interface CacheReport {
  comic: number;
  epub: number;
  covers: number;
}

/** 缓存统计与清理。kind: comic | epub | covers | all */
export interface CoverReport {
  rebuilt: number;
  failed: number;
  placeholder: number;
}

export const cacheApi = {
  report: () => invoke<CacheReport>("cache_report"),
  clear: (kind: string) => invoke<number>("clear_cache", { kind }),
  /** 重新提取全部封面（清空后必须走这条，单纯清空不会自动重建） */
  rebuildCovers: () => invoke<CoverReport>("rebuild_covers"),
};

// ---------------- 备份 ----------------

export interface WebdavConfig {
  url: string;
  username: string;
  password: string;
  /** 远端子目录，相对 url */
  dir: string;
  /** 保留最近几份，0 = 不清理 */
  keep: number;
}

export interface BackupConfig {
  webdav: WebdavConfig;
  include_covers: boolean;
  last_local_at: number | null;
  last_webdav_at: number | null;
}

export interface BackupReport {
  path: string;
  bytes: number;
  books: number;
  covers: number;
  /** 包里带了几本隐私书（0 表示没有，或用户选择不备份） */
  private_books: number;
  created_at: number;
}

/** 备份前的范围：有隐私书时前端要问「是否一并备份」 */
export interface BackupScope {
  books: number;
  private_books: number;
}

export interface RestoreReport {
  from: string;
  books: number;
  covers: number;
  /** 恢复回来的书里有几本在隐私书架（不会出现在普通书架） */
  private_books: number;
  created_at: number;
}

export interface LocalBackup {
  path: string;
  name: string;
  bytes: number;
  created_at: number;
}

export interface RemoteBackup {
  name: string;
  bytes: number;
  modified: string;
}

// ---------------- 标注：书签 / 笔记 ----------------

export type AnnotationKind = "bookmark" | "highlight" | "note";

/** 章内字符区间，单位 UTF-16 码元（与 JS 字符串下标一致） */
export interface Anchor {
  start: number;
  len: number;
}

export interface Annotation {
  id: string;
  book_id: string;
  kind: AnnotationKind;
  /** 位置：与阅读进度同一套坐标，「跳到书签」与「跳到搜索结果」共用跳转逻辑 */
  locator: Progress;
  label: string | null;
  excerpt: string | null;
  /** 高亮 / 笔记的章内区间；书签没有 */
  anchor: Anchor | null;
  created_at: number;
  updated_at: number;
}

/** 书内搜索命中 */
export interface SearchHit {
  chapter: number;
  chapter_title: string;
  locator: Progress;
  excerpt: string;
  /** 命中词在 excerpt 里的字符区间，用来加粗 */
  match_start: number;
  match_end: number;
}

export interface ImportReport {
  imported: number;
  skipped: number;
  total: number;
  /** 文件里记的书名，与当前书不一致时提醒一句 */
  source_title: string;
}

export const annotationApi = {
  list: (id: string, kind?: AnnotationKind) =>
    invoke<Annotation[]>("list_annotations", { id, kind: kind ?? null }),
  /**
   * 新增标注：书签 / 高亮 / 笔记走同一个入口。
   * 书签只需要 locator 与备注；高亮要 anchor 与 excerpt；笔记再带正文。
   */
  add: (
    id: string,
    kind: AnnotationKind,
    locator: Progress,
    opts: { label?: string | null; excerpt?: string | null; anchor?: Anchor | null } = {},
  ) =>
    invoke<Annotation>("add_annotation", {
      id,
      kind,
      locator,
      label: opts.label ?? null,
      excerpt: opts.excerpt ?? null,
      anchor: opts.anchor ?? null,
    }),
  setLabel: (annotationId: string, label: string | null) =>
    invoke<void>("update_annotation_label", { annotationId, label }),
  remove: (annotationId: string) => invoke<void>("delete_annotation", { annotationId }),
  /**
   * 导出到指定文件；返回写入的条目数。
   * `json` 是唯一能回导的格式，Markdown / CSV 只给人看。
   */
  exportTo: (id: string, path: string, format: "markdown" | "csv" | "json") =>
    invoke<number>("export_annotations", { id, path, format }),
  /** 从 JSON 回导标注，按「类型 + 位置 + 锚点 + 备注 + 原文」去重 */
  importFrom: (id: string, path: string) =>
    invoke<ImportReport>("import_annotations", { id, path }),
  /** 只在有纯文本的格式上受支持，其余格式会明确报错 */
  search: (id: string, query: string) =>
    invoke<SearchHit[]>("search_book", { id, query }),
};

// ---------------- 标签 ----------------

export interface TagCount {
  name: string;
  /** 可见书架里挂了这个标签的书数；隐私书不计入 */
  count: number;
}

export const tagApi = {
  list: () => invoke<TagCount[]>("list_tags"),
  /** 全量取一次：`[book_id, tag]`，前端自己建 Map */
  assignments: () => invoke<Array<[string, string]>>("list_tag_assignments"),
  /** 全量替换一本书的标签，返回规范化后的结果 */
  setForBook: (id: string, tags: string[]) => invoke<string[]>("set_book_tags", { id, tags }),
  remove: (name: string) => invoke<void>("delete_tag", { name }),
};

/** 隐私书架：P1 只做可见性隔离，PIN 只挡界面 */
export interface PrivacyStatus {
  enabled: boolean;
  unlocked: boolean;
  lock_after_minutes: number;
  /** 锁定时恒为 0，连「有几本」都不给 */
  private_books: number;
}

export const privacyApi = {
  status: () => invoke<PrivacyStatus>("privacy_status"),
  enable: (pin: string, lockAfterMinutes: number) =>
    invoke<void>("privacy_enable", { pin, lockAfterMinutes }),
  unlock: (pin: string) => invoke<void>("privacy_unlock", { pin }),
  setLockAfter: (minutes: number) => invoke<void>("privacy_set_lock_after", { minutes }),
  lock: () => invoke<void>("privacy_lock"),
  disable: (pin: string) => invoke<void>("privacy_disable", { pin }),
  list: (query?: string) => invoke<Book[]>("privacy_list", { query: query ?? null }),
  move: (id: string) => invoke<void>("privacy_move", { id }),
  release: (id: string) => invoke<void>("privacy_release", { id }),
  /** 批量移入 / 移出；返回真正成功的本数 */
  // 参数名不能叫 private：TS 模块处于严格模式，它是保留字
  moveMany: (ids: string[], toPrivate: boolean) =>
    invoke<number>("privacy_move_many", { ids, private: toPrivate }),
};

export const backupApi = {
  config: () => invoke<BackupConfig>("backup_config"),
  saveConfig: (config: BackupConfig) => invoke<void>("save_backup_config", { config }),
  /** 备份范围：拿隐私书数量决定要不要先问一句 */
  scope: () => invoke<BackupScope>("backup_scope"),
  /** target 为空时落在应用数据目录下的 backups/（移动端没有另存为对话框） */
  export: (target: string | null, includeCovers: boolean, includePrivate: boolean) =>
    invoke<BackupReport>("backup_export", { target, includeCovers, includePrivate }),
  listLocal: () => invoke<LocalBackup[]>("backup_list_local"),
  /** 只允许删应用备份目录里的文件，后端会校验路径 */
  deleteLocal: (path: string) => invoke<void>("backup_delete_local", { path }),
  restore: (path: string) => invoke<RestoreReport>("backup_restore", { path }),

  test: (config: WebdavConfig) => invoke<string>("webdav_test", { config }),
  upload: (config: WebdavConfig, includeCovers: boolean, includePrivate: boolean) =>
    invoke<BackupReport>("webdav_upload", { config, includeCovers, includePrivate }),
  list: (config: WebdavConfig) => invoke<RemoteBackup[]>("webdav_list", { config }),
  remove: (config: WebdavConfig, name: string) =>
    invoke<void>("webdav_delete", { config, name }),
  restoreRemote: (config: WebdavConfig, name: string) =>
    invoke<RestoreReport>("webdav_restore", { config, name }),
};

export interface LicenseText {
  name: string;
  body: string;
}

export const licenseApi = {
  /**
   * 关于页「开源许可」。
   * 文本编在二进制里而不是读安装目录：portable 与 APK 没有「安装目录」，
   * 而 unrar-rs 的许可要求二进制分发必须随附全文。
   */
  all: () => invoke<LicenseText[]>("license_texts"),
};
