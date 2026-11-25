import type { Book, BookFormat } from "../types";

/**
 * 侧栏分类。
 *
 * 之前只有「小说 / 漫画 / PDF」三档，5 本小说里混着 txt、md、html、epub、mobi，
 * 想找电子书得在两处翻。现在按**格式族**划成互斥的几组：
 * 一本书只属于一个分类，计数加起来正好等于「全部」，不会出现「小说 5、电子书 2」
 * 这种同一本书被数两次的困惑。
 */
export type ShelfFilter =
  | "all"
  | "recent"
  | "text"
  | "ebook"
  | "doc"
  | "comic"
  | "pdf";

/** 文本族（txt / md / html / fb2）是 categoryOf 的兜底分支，不单独列表 */
const EBOOK: BookFormat[] = ["epub", "mobi", "azw3"];
const DOC: BookFormat[] = ["docx", "rtf", "mhtml", "ofd", "xlsx"];
const COMIC: BookFormat[] = ["cbz", "cbr", "cbt", "cb7", "zip", "folder"];

/**
 * 每个分类装哪些格式 —— **唯一一份**。
 *
 * 侧栏计数、卡片分类、关于页的「支持哪些格式」三处都从这里取。
 * 关于页原先手写了「小说 / 漫画 / 文档」三段，与侧栏的「文本 / 电子书 / 文档 /
 * 漫画 / PDF」是两套词，用户从侧栏点「电子书」找不到关于页说的「小说」。
 * 手写第三份的下场就是这样：各自成立，合起来自相矛盾。
 */
export const CATEGORY_FORMATS: Record<CategoryKey, BookFormat[]> = {
  text: ["txt", "md", "html", "fb2"],
  ebook: EBOOK,
  doc: DOC,
  comic: COMIC,
  pdf: ["pdf"],
};

/**
 * 一本书的唯一类别，与侧栏计数同一口径（互斥，加起来等于「全部」）。
 *
 * 顺序有讲究：漫画优先（图片型 MOBI 的 format 还是 mobi），
 * 其次是 doc 类型与文档族格式，再往后才是电子书与文本。
 */
export function categoryOf(book: Book): CategoryKey {
  if (book.format === "pdf") return "pdf";
  if (COMIC.includes(book.format) || book.type === "comic") return "comic";
  if (DOC.includes(book.format) || book.type === "doc") return "doc";
  if (EBOOK.includes(book.format)) return "ebook";
  return "text";
}

/**
 * 判断一本书是否落在某个分类里。
 *
 * 直接复用 `categoryOf`，不再各写一份规则：两套并行迟早会漂——
 * 旧写法里 `format === "pdf"` 与 `type === "comic"` 就同时成立，
 * 同一本书会被 PDF 和漫画各数一次，分类计数加起来大于「全部」。
 * 单一真相还顺带保证互斥性：一本书只属于一个类。
 */
export function matchesFilter(book: Book, filter: ShelfFilter): boolean {
  if (filter === "all") return true;
  // 「最近阅读」按有没有读过算，与排序里的最近阅读口径一致
  if (filter === "recent") return book.last_read_at != null;
  return categoryOf(book) === filter;
}

/** 侧栏五族，去掉 all / recent 后的部分 */
export type CategoryKey = Exclude<ShelfFilter, "all" | "recent">;

/** 类别词表：侧栏、卡片副行、列表「类别」列三处共用这一套 */
export const CATEGORY_LABEL: Record<CategoryKey, string> = {
  text: "文本",
  ebook: "电子书",
  doc: "文档",
  comic: "漫画",
  pdf: "PDF",
};
